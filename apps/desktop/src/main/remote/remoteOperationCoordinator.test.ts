import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyAction,
  cloneState,
  createInitialState,
  type AppState,
  type RemoteTargetBinding
} from "@kmux/core";
import {
  applyMainRemoteOperationFact,
  type MainRemoteOperationFact
} from "@kmux/core/main";
import { uint64 } from "@kmux/proto";

import {
  createDurableRemoteOperationStore,
  type DurableRemoteOperationStore
} from "./durableRemoteOperationStore";
import {
  createRemoteOperationCoordinator,
  decodeRemoteOperationAdmissionCommand,
  type RemoteOperationAdmissionCommand
} from "./remoteOperationCoordinator";

const resultDigest = "f".repeat(64);

describe("RemoteOperationCoordinator", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "kmux-coordinator-"));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("persists admission before pending projection and result before terminal projection", () => {
    const fixture = createRemoteFixture();
    const events: string[] = [];
    const underlying = createDurableRemoteOperationStore(join(sandbox, "ops"));
    const store = instrumentStore(underlying, events);
    const coordinator = createCoordinator(fixture.state, store, events);

    const operation = coordinator.admit(
      terminateCommand(fixture.workspaceId, fixture.sessionId)
    );
    expect(events.slice(0, 2)).toEqual(["store.admit", "fact.pending"]);
    expect(
      fixture.state.remoteOperations[operation.intent.operationId].state
    ).toBe("termination-pending");

    coordinator.recordAuthoritativeResult(operation.intent.operationId, {
      status: "succeeded",
      remoteResourceRevision: uint64(1n),
      resultDigest,
      completedAt: "2026-07-17T00:00:01.000Z"
    });
    expect(events.slice(-2)).toEqual(["store.result", "fact.succeeded"]);
    expect(
      fixture.state.remoteOperations[operation.intent.operationId].state
    ).toBe("succeeded");
  });

  it("rejects an authoritative result conflict before it can poison recovery", () => {
    const fixture = createRemoteFixture();
    const store = createDurableRemoteOperationStore(join(sandbox, "ops"));
    const coordinator = createRemoteOperationCoordinator(
      coordinatorOptions(fixture.state, store)
    );
    const operation = coordinator.admit(
      terminateCommand(fixture.workspaceId, fixture.sessionId)
    );

    expect(() =>
      coordinator.recordAuthoritativeResult(operation.intent.operationId, {
        status: "succeeded",
        remoteResourceRevision: uint64(2n),
        resultDigest,
        completedAt: "2026-07-17T00:00:01.000Z"
      })
    ).toThrow(/revision does not match/);

    expect(store.get(operation.intent.operationId)?.result).toBeUndefined();
    expect(
      fixture.state.remoteOperations[operation.intent.operationId].state
    ).toBe("termination-pending");
  });

  it("recovers an admission and a result when projection crashes after persistence", () => {
    const fixture = createRemoteFixture();
    const beforeAdmission = cloneState(fixture.state);
    const store = createDurableRemoteOperationStore(join(sandbox, "ops"));
    const crashingAdmission = createRemoteOperationCoordinator({
      ...coordinatorOptions(fixture.state, store),
      dispatchFact: () => {
        throw new Error("injected pending projection crash");
      }
    });

    expect(() =>
      crashingAdmission.admit(
        terminateCommand(fixture.workspaceId, fixture.sessionId)
      )
    ).toThrow(/pending projection crash/);
    const [persisted] = store.loadAll();
    expect(persisted.result).toBeUndefined();

    const recoveredState = cloneState(beforeAdmission);
    const recovering = createRemoteOperationCoordinator(
      coordinatorOptions(recoveredState, store)
    );
    recovering.recover();
    expect(
      recoveredState.remoteOperations[persisted.intent.operationId].state
    ).toBe("termination-pending");

    const crashingResult = createRemoteOperationCoordinator({
      ...coordinatorOptions(recoveredState, store),
      dispatchFact: (fact) => {
        if (fact.type === "remote-operation.succeeded") {
          throw new Error("injected result projection crash");
        }
        applyMainRemoteOperationFact(recoveredState, fact);
      }
    });
    expect(() =>
      crashingResult.recordAuthoritativeResult(persisted.intent.operationId, {
        status: "succeeded",
        remoteResourceRevision: uint64(1n),
        resultDigest,
        completedAt: "2026-07-17T00:00:01.000Z"
      })
    ).toThrow(/result projection crash/);
    expect(store.get(persisted.intent.operationId)?.result).toBeDefined();
    expect(
      recoveredState.remoteOperations[persisted.intent.operationId].state
    ).toBe("termination-pending");

    createRemoteOperationCoordinator(
      coordinatorOptions(recoveredState, store)
    ).recover();
    expect(
      recoveredState.remoteOperations[persisted.intent.operationId].state
    ).toBe("succeeded");
  });

  it("topologically replays dependent facts when hashed record order is reversed", () => {
    const fixture = createRemoteFixture();
    const beforeAdmission = cloneState(fixture.state);
    const store = createDurableRemoteOperationStore(join(sandbox, "ops"));
    let operationNumber = 0;
    const coordinator = createRemoteOperationCoordinator({
      ...coordinatorOptions(fixture.state, store),
      makeOperationId: () => `operation_${++operationNumber}`
    });
    const first = coordinator.admit(
      terminateCommand(fixture.workspaceId, fixture.sessionId)
    );
    coordinator.recordAuthoritativeResult(first.intent.operationId, {
      status: "succeeded",
      remoteResourceRevision: uint64(1n),
      resultDigest,
      completedAt: "2026-07-17T00:00:01.000Z"
    });
    const second = coordinator.admit({
      type: "remote-operation.command",
      workspaceId: fixture.workspaceId,
      expectedRemoteResourceRevision: uint64(1n),
      payload: {
        kind: "launch-input",
        sessionId: fixture.sessionId,
        input: "echo ready\n"
      }
    });
    expect(store.loadAll().map((record) => record.intent.operationId)).toEqual([
      second.intent.operationId,
      first.intent.operationId
    ]);

    const recoveredState = cloneState(beforeAdmission);
    createRemoteOperationCoordinator(
      coordinatorOptions(recoveredState, store)
    ).recover();

    expect(
      recoveredState.remoteOperations[first.intent.operationId].state
    ).toBe("succeeded");
    expect(
      recoveredState.remoteOperations[second.intent.operationId].state
    ).toBe("pending");
  });

  it("keeps timeout and thrown execution outcomes pending", async () => {
    const fixture = createRemoteFixture();
    const store = createDurableRemoteOperationStore(join(sandbox, "ops"));
    const coordinator = createRemoteOperationCoordinator(
      coordinatorOptions(fixture.state, store)
    );
    const operation = coordinator.admit(
      terminateCommand(fixture.workspaceId, fixture.sessionId)
    );

    await expect(
      coordinator.execute(operation.intent.operationId, async () => ({
        status: "pending",
        reason: "timeout"
      }))
    ).resolves.toEqual({ status: "pending", reason: "timeout" });
    await expect(
      coordinator.execute(operation.intent.operationId, async () => {
        throw new Error("connection reset after write");
      })
    ).resolves.toEqual({ status: "pending", reason: "ambiguous" });
    expect(store.get(operation.intent.operationId)?.result).toBeUndefined();
    expect(
      fixture.state.remoteOperations[operation.intent.operationId].state
    ).toBe("termination-pending");
  });

  it("serializes mutations by desktop, target, and workspace resource key", async () => {
    const fixture = createRemoteFixture();
    const store = createDurableRemoteOperationStore(join(sandbox, "ops"));
    let operationNumber = 0;
    const coordinator = createRemoteOperationCoordinator({
      ...coordinatorOptions(fixture.state, store),
      makeOperationId: () => `operation_${++operationNumber}`
    });
    const first = coordinator.admit(
      terminateCommand(fixture.workspaceId, fixture.sessionId)
    );
    const second = coordinator.admit({
      type: "remote-operation.command",
      workspaceId: fixture.workspaceId,
      expectedRemoteResourceRevision: uint64(1n),
      payload: {
        kind: "launch-input",
        sessionId: fixture.sessionId,
        input: "echo ready\n"
      }
    });
    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const firstRun = coordinator.execute(first.intent.operationId, async () => {
      started.push("first");
      await firstGate;
      return { status: "pending", reason: "offline" };
    });
    const secondRun = coordinator.execute(
      second.intent.operationId,
      async () => {
        started.push("second");
        return { status: "pending", reason: "offline" };
      }
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["first"]);

    releaseFirst();
    await Promise.all([firstRun, secondRun]);
    expect(started).toEqual(["first", "second"]);
  });

  it("accepts only the external command shape and bigint sequence values", () => {
    const fixture = createRemoteFixture();
    expect(
      decodeRemoteOperationAdmissionCommand(
        terminateCommand(fixture.workspaceId, fixture.sessionId)
      )
    ).toMatchObject({
      type: "remote-operation.command",
      expectedRemoteResourceRevision: 0n
    });
    expect(() =>
      decodeRemoteOperationAdmissionCommand({
        type: "remote-operation.succeeded",
        operationId: "operation_forged"
      })
    ).toThrow(/not allowlisted|unexpected/);
    expect(() =>
      decodeRemoteOperationAdmissionCommand({
        ...terminateCommand(fixture.workspaceId, fixture.sessionId),
        expectedRemoteResourceRevision: 0
      })
    ).toThrow(/bigint/);
  });

  it("fails closed without the exact verified target binding", () => {
    const fixture = createRemoteFixture();
    const store = createDurableRemoteOperationStore(join(sandbox, "ops"));
    const coordinator = createRemoteOperationCoordinator({
      ...coordinatorOptions(fixture.state, store),
      getTargetBinding: () => undefined
    });

    expect(() =>
      coordinator.admit(
        terminateCommand(fixture.workspaceId, fixture.sessionId)
      )
    ).toThrow(/binding/);
    expect(store.loadAll()).toEqual([]);
  });

  it("re-verifies the target binding immediately before executing an effect", async () => {
    const fixture = createRemoteFixture();
    const store = createDurableRemoteOperationStore(join(sandbox, "ops"));
    let bindingAvailable = true;
    const executor = vi.fn(async () => ({
      status: "pending" as const,
      reason: "offline" as const
    }));
    const coordinator = createRemoteOperationCoordinator({
      ...coordinatorOptions(fixture.state, store),
      getTargetBinding: () => (bindingAvailable ? targetBinding() : undefined)
    });
    const operation = coordinator.admit(
      terminateCommand(fixture.workspaceId, fixture.sessionId)
    );
    bindingAvailable = false;

    await expect(
      coordinator.execute(operation.intent.operationId, executor)
    ).rejects.toThrow(/binding/);
    expect(executor).not.toHaveBeenCalled();
    expect(store.get(operation.intent.operationId)?.result).toBeUndefined();
  });

  it("rejects another desktop installation's durable records before replay", () => {
    const fixture = createRemoteFixture();
    const beforeAdmission = cloneState(fixture.state);
    const store = createDurableRemoteOperationStore(join(sandbox, "ops"));
    createRemoteOperationCoordinator(
      coordinatorOptions(fixture.state, store)
    ).admit(terminateCommand(fixture.workspaceId, fixture.sessionId));

    const recoveredState = cloneState(beforeAdmission);
    const recovering = createRemoteOperationCoordinator({
      ...coordinatorOptions(recoveredState, store),
      desktopInstallationId: "desktop_other"
    });
    expect(() => recovering.recover()).toThrow(/another desktop installation/);
    expect(recoveredState.remoteOperations).toEqual({});
  });
});

function createRemoteFixture(): {
  state: AppState;
  workspaceId: string;
  sessionId: string;
} {
  const state = createInitialState("/bin/zsh");
  const priorWorkspaceIds = new Set(Object.keys(state.workspaces));
  applyAction(state, {
    type: "workspace.create",
    target: { kind: "ssh", targetId: "target_1" },
    cwd: "/srv/app",
    name: "remote"
  });
  const workspaceId = Object.keys(state.workspaces).find(
    (id) => !priorWorkspaceIds.has(id)
  )!;
  const pane = state.panes[state.workspaces[workspaceId].activePaneId];
  return {
    state,
    workspaceId,
    sessionId: state.surfaces[pane.activeSurfaceId].sessionId
  };
}

function terminateCommand(
  workspaceId: string,
  sessionId: string
): RemoteOperationAdmissionCommand {
  return {
    type: "remote-operation.command",
    workspaceId,
    expectedRemoteResourceRevision: uint64(0n),
    payload: { kind: "session.terminate", sessionId }
  };
}

function createCoordinator(
  state: AppState,
  store: DurableRemoteOperationStore,
  events: string[]
) {
  return createRemoteOperationCoordinator({
    ...coordinatorOptions(state, store),
    dispatchFact: (fact) => {
      events.push(`fact.${fact.type.split(".").at(-1)}`);
      applyMainRemoteOperationFact(state, fact);
    }
  });
}

function coordinatorOptions(
  state: AppState,
  store: DurableRemoteOperationStore
) {
  return {
    desktopInstallationId: "desktop_1",
    store,
    getState: () => state,
    getTargetBinding: (targetId: string) =>
      targetId === "target_1" ? targetBinding() : undefined,
    dispatchFact: (fact: MainRemoteOperationFact) => {
      applyMainRemoteOperationFact(state, fact);
    },
    makeOperationId: () => "operation_1",
    now: () => "2026-07-17T00:00:00.000Z"
  };
}

function targetBinding(): RemoteTargetBinding {
  return {
    id: "target_1",
    authority: {
      remoteInstallationId: "remote-installation_1",
      executionNodeId: "execution-node_1",
      authenticatedPrincipal: { uid: 1000, accountName: "developer" }
    },
    locator: {
      profileId: "profile_1",
      effectiveConnectionPolicyHash: "a".repeat(64),
      lastVerifiedAt: "2026-07-17T00:00:00.000Z"
    },
    firstVerifiedAt: "2026-07-17T00:00:00.000Z"
  };
}

function instrumentStore(
  store: DurableRemoteOperationStore,
  events: string[]
): DurableRemoteOperationStore {
  return {
    admit(record) {
      events.push("store.admit");
      return store.admit(record);
    },
    recordResult(operationId, result, fact) {
      events.push("store.result");
      return store.recordResult(operationId, result, fact);
    },
    get: store.get,
    loadAll: store.loadAll,
    recordResourceReceipt: store.recordResourceReceipt,
    getResourceReceipt: store.getResourceReceipt,
    listResourceReceipts: store.listResourceReceipts,
    removeResourceReceipts: store.removeResourceReceipts,
    compactAfterDurableSnapshot: store.compactAfterDurableSnapshot
  };
}
