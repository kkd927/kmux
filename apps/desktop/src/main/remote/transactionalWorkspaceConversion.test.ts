import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyAction,
  cloneState,
  createInitialState,
  type RemoteTargetBinding
} from "@kmux/core";

import { createConversionWalStore } from "./conversionWal";
import {
  createTransactionalWorkspaceConversionRuntime,
  decodeStartWorkspaceConversionRequest,
  desktopSnapshotHash,
  type ConversionFaultPoint,
  type ConversionRemoteGateway
} from "./transactionalWorkspaceConversion";

const FAULT_POINTS: ConversionFaultPoint[] = [
  "preparing-persisted",
  "remote-prepare-returned",
  "remote-created-persisted",
  "commit-decided-persisted",
  "desktop-snapshot-forced",
  "desktop-state-installed",
  "remote-promoted",
  "committed-persisted",
  "local-cleanup-acknowledged",
  "cleanup-complete-persisted"
];

describe("transactional workspace conversion", () => {
  const policyHash = "a".repeat(64);
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "kmux-conversion-runtime-"));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("strictly decodes the bounded renderer conversion command", () => {
    const request = {
      workspaceId: "workspace_1",
      targetId: "target_1",
      effectiveConnectionPolicyHash: policyHash,
      connectionName: "dev",
      defaultCwd: "/srv/app",
      launch: {
        shell: "/bin/sh",
        args: ["-l"],
        env: { TERM: "xterm-256color" }
      }
    };
    expect(decodeStartWorkspaceConversionRequest(request)).toEqual(request);
    expect(() =>
      decodeStartWorkspaceConversionRequest({ ...request, surprise: true })
    ).toThrow(/unexpected conversion request field/u);
    expect(() =>
      decodeStartWorkspaceConversionRequest({
        ...request,
        launch: { ...request.launch, args: Array(257).fill("x") }
      })
    ).toThrow(/launch args are invalid/u);
    expect(() =>
      decodeStartWorkspaceConversionRequest({
        ...request,
        effectiveConnectionPolicyHash: "A".repeat(64)
      })
    ).toThrow(/lowercase SHA-256/u);
  });

  for (const faultPoint of FAULT_POINTS) {
    it(`recovers the same transaction after forced termination at ${faultPoint}`, async () => {
      const fixture = createFixture(sandbox);
      let armed = true;
      const first = fixture.createRuntime((point) => {
        if (armed && point === faultPoint) {
          armed = false;
          throw new Error(`injected crash at ${point}`);
        }
      });

      await expect(
        first.start({
          workspaceId: fixture.workspaceId,
          targetId: "target_1",
          effectiveConnectionPolicyHash: policyHash,
          connectionName: "devbox",
          defaultCwd: "/srv/project",
          launch: { shell: "/bin/sh" }
        })
      ).rejects.toThrow(/injected crash/u);

      const interrupted = fixture.wal.get("conversion_1");
      expect(interrupted).not.toBeNull();
      if (
        interrupted?.state !== "committed" &&
        interrupted?.state !== "cleanup-complete"
      ) {
        expect(fixture.uniqueLocalTerminations.size).toBe(0);
      }
      expect(fixture.remote.createdKeeperCount).toBeLessThanOrEqual(1);

      fixture.simulateDesktopRestart();
      const recovered = await fixture.createRuntime().recover();
      expect(recovered).toHaveLength(1);
      expect(recovered[0].state).toBe("cleanup-complete");
      expect(fixture.remote.createdKeeperCount).toBe(1);
      expect(fixture.remote.state).toBe("committed");
      expect(fixture.uniqueLocalTerminations).toEqual(
        new Set(fixture.sourceSessionIds)
      );
      expect(
        fixture.currentState().workspaces[fixture.workspaceId].location.target
      ).toEqual({ kind: "ssh", targetId: "target_1" });
      expect(fixture.currentState().workspaces[fixture.workspaceId].name).toBe(
        "SSH: devbox"
      );
      expect(Object.keys(fixture.currentState().sessions)).toHaveLength(1);
      expect(fixture.wal.get("conversion_1")?.state).toBe("cleanup-complete");
    });
  }

  it("keeps every local generation alive when remote preparation fails", async () => {
    const fixture = createFixture(sandbox);
    fixture.remote.failPrepare = true;
    const before = cloneState(fixture.currentState());

    await expect(
      fixture.createRuntime().start({
        workspaceId: fixture.workspaceId,
        targetId: "target_1",
        effectiveConnectionPolicyHash: policyHash,
        connectionName: "devbox",
        defaultCwd: "/srv/project"
      })
    ).rejects.toThrow(/prepare failure/u);

    expect(fixture.currentState()).toEqual(before);
    expect(fixture.uniqueLocalTerminations.size).toBe(0);
    expect(fixture.wal.get("conversion_1")?.state).toBe("preparing");
  });

  it("creates a separate SSH workspace and recovers without touching local sessions", async () => {
    const fixture = createFixture(sandbox);
    const sourceBefore = cloneState(fixture.currentState()).workspaces[
      fixture.workspaceId
    ];
    await expect(
      fixture
        .createRuntime((point) => {
          if (point === "desktop-state-installed") {
            throw new Error("injected creation crash");
          }
        })
        .start({
          workspaceId: fixture.workspaceId,
          targetId: "target_1",
          effectiveConnectionPolicyHash: policyHash,
          connectionName: "devbox",
          defaultCwd: "/srv/project",
          continuation: "create",
          launch: { shell: "/bin/sh" }
        })
    ).rejects.toThrow(/injected creation crash/u);

    fixture.simulateDesktopRestart();
    const [record] = await fixture.createRuntime().recover();
    expect(record?.state).toBe("cleanup-complete");
    expect(record?.continuation).toBe("create");
    expect(fixture.currentState().workspaces[fixture.workspaceId]).toEqual(
      sourceBefore
    );
    const createdWorkspaceId = record!.workspaceResourceKey.workspaceId;
    expect(createdWorkspaceId).not.toBe(fixture.workspaceId);
    expect(fixture.currentState().workspaces[createdWorkspaceId]).toMatchObject(
      {
        name: "SSH: devbox",
        location: { target: { kind: "ssh", targetId: "target_1" } }
      }
    );
    expect(fixture.uniqueLocalTerminations).toEqual(new Set());
    expect(fixture.remote.createdKeeperCount).toBe(1);
    expect(Object.keys(fixture.currentState().sessions)).toHaveLength(
      fixture.sourceSessionIds.length + 1
    );
  });

  it("leaves the current workspace unchanged when new-workspace preparation fails", async () => {
    const fixture = createFixture(sandbox);
    fixture.remote.failPrepare = true;
    const before = cloneState(fixture.currentState());

    await expect(
      fixture.createRuntime().start({
        workspaceId: fixture.workspaceId,
        targetId: "target_1",
        effectiveConnectionPolicyHash: policyHash,
        connectionName: "devbox",
        defaultCwd: "/srv/project",
        continuation: "create"
      })
    ).rejects.toThrow(/prepare failure/u);

    expect(fixture.currentState()).toEqual(before);
    expect(fixture.uniqueLocalTerminations).toEqual(new Set());
  });

  it("rejects conversion before WAL admission when a live local generation cannot be fenced", async () => {
    const fixture = createFixture(sandbox);
    fixture.forgetRuntimeEpoch(fixture.sourceSessionIds[0]!);

    await expect(
      fixture.createRuntime().start({
        workspaceId: fixture.workspaceId,
        targetId: "target_1",
        effectiveConnectionPolicyHash: policyHash,
        connectionName: "devbox",
        defaultCwd: "/srv/project"
      })
    ).rejects.toThrow(/without a fenced local runtime generation/u);
    expect(fixture.wal.loadAll()).toEqual([]);
    expect(fixture.remote.createdKeeperCount).toBe(0);
  });

  it("rejects a second conversion while the source workspace has an unfinished transaction", async () => {
    const fixture = createFixture(sandbox);
    await expect(
      fixture
        .createRuntime((point) => {
          if (point === "preparing-persisted") {
            throw new Error("injected admission crash");
          }
        })
        .start({
          workspaceId: fixture.workspaceId,
          targetId: "target_1",
          effectiveConnectionPolicyHash: policyHash,
          connectionName: "devbox",
          defaultCwd: "/srv/project"
        })
    ).rejects.toThrow(/injected admission crash/u);

    await expect(
      fixture.createRuntime().start({
        workspaceId: fixture.workspaceId,
        targetId: "target_1",
        effectiveConnectionPolicyHash: policyHash,
        connectionName: "other",
        defaultCwd: "/srv/other"
      })
    ).rejects.toThrow(/unfinished transaction/u);
    expect(fixture.wal.loadAll()).toHaveLength(1);
    expect(fixture.remote.createdKeeperCount).toBe(0);
  });

  it("rechecks the prepared connection policy before writing the WAL", async () => {
    const fixture = createFixture(sandbox);
    fixture.binding.locator.effectiveConnectionPolicyHash = "9".repeat(64);

    await expect(
      fixture.createRuntime().start({
        workspaceId: fixture.workspaceId,
        targetId: "target_1",
        effectiveConnectionPolicyHash: policyHash,
        connectionName: "devbox",
        defaultCwd: "/srv/project"
      })
    ).rejects.toThrow(/connection policy changed/u);
    expect(fixture.wal.loadAll()).toHaveLength(0);
    expect(fixture.remote.createdKeeperCount).toBe(0);
  });

  it("fails recovery closed when the verified connection policy changed", async () => {
    const fixture = createFixture(sandbox);
    await expect(
      fixture
        .createRuntime((point) => {
          if (point === "remote-created-persisted") {
            throw new Error("injected crash");
          }
        })
        .start({
          workspaceId: fixture.workspaceId,
          targetId: "target_1",
          effectiveConnectionPolicyHash: policyHash,
          connectionName: "devbox",
          defaultCwd: "/srv/project"
        })
    ).rejects.toThrow(/injected crash/u);
    fixture.binding.locator.effectiveConnectionPolicyHash = "9".repeat(64);

    await expect(fixture.createRuntime().recover()).rejects.toThrow(
      /connection policy changed/u
    );
    expect(fixture.uniqueLocalTerminations.size).toBe(0);
    expect(fixture.wal.get("conversion_1")?.state).toBe("remote-created");
  });
});

function createFixture(sandbox: string) {
  let state = createInitialState("/bin/zsh");
  const workspaceId = Object.keys(state.workspaces)[0]!;
  const workspace = state.workspaces[workspaceId];
  applyAction(state, {
    type: "pane.split",
    paneId: workspace.activePaneId,
    direction: "right"
  });
  const sourceSessions = Object.values(state.sessions).sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  const sourceSessionIds = sourceSessions.map((session) => session.id);
  const epochs = new Map(
    sourceSessions.map((session, index) => [session.id, `epoch_${index + 1}`])
  );
  let durableState = cloneState(state);
  const wal = createConversionWalStore(join(sandbox, "wal"));
  const remote = new FakeConversionRemote();
  const uniqueLocalTerminations = new Set<string>();
  const binding = remoteBinding();

  const createRuntime = (faultPoint?: (point: ConversionFaultPoint) => void) =>
    createTransactionalWorkspaceConversionRuntime({
      desktopInstallationId: "desktop_1",
      wal,
      remote,
      getState: () => state,
      getTargetBinding: (targetId) =>
        targetId === binding.id ? structuredClone(binding) : undefined,
      getLocalRuntimeEpoch: (_surfaceId, sessionId) =>
        epochs.get(sessionId) ?? null,
      forceDesktopSnapshot: (candidate, expectedHash) => {
        expect(desktopSnapshotHash(candidate)).toBe(expectedHash);
        durableState = cloneState(candidate);
        return expectedHash;
      },
      installDesktopState: (candidate) => {
        state = cloneState(candidate);
      },
      terminateLocalSession: async (target) => {
        const first = !uniqueLocalTerminations.has(target.sessionId);
        uniqueLocalTerminations.add(target.sessionId);
        return {
          ...target,
          outcome: first ? "terminated" : "already-exited"
        };
      },
      makeTransactionId: () => "conversion_1",
      now: monotonicClock(),
      ...(faultPoint === undefined
        ? {}
        : { faultPoint: (point: ConversionFaultPoint) => faultPoint(point) })
    });

  return {
    workspaceId,
    sourceSessionIds,
    wal,
    remote,
    binding,
    uniqueLocalTerminations,
    forgetRuntimeEpoch: (sessionId: string) => epochs.delete(sessionId),
    createRuntime,
    currentState: () => state,
    simulateDesktopRestart: () => {
      state = cloneState(durableState);
    }
  };
}

class FakeConversionRemote implements ConversionRemoteGateway {
  state: "absent" | "provisional" | "committed" = "absent";
  createdKeeperCount = 0;
  failPrepare = false;
  private transactionId?: string;
  private snapshotHash?: string;

  async prepare(request: Parameters<ConversionRemoteGateway["prepare"]>[0]) {
    if (this.failPrepare) throw new Error("injected remote prepare failure");
    if (this.state === "absent") {
      this.state = "provisional";
      this.transactionId = request.record.transactionId;
      this.snapshotHash = request.remoteSnapshotHash;
      this.createdKeeperCount += 1;
    }
    if (
      this.transactionId !== request.record.transactionId ||
      this.snapshotHash !== request.remoteSnapshotHash
    ) {
      throw new Error("fake remote idempotency conflict");
    }
    return {
      remoteSnapshotHash: request.remoteSnapshotHash,
      workspaceDescriptorHash: "b".repeat(64),
      sessionDescriptorHash: "c".repeat(64),
      keeperGeneration: "keeper_conversion_1",
      remoteResourceRevision: "1",
      remoteCreatedAt: "2026-07-18T00:00:10.000Z"
    };
  }

  async promote(record: Parameters<ConversionRemoteGateway["promote"]>[0]) {
    if (
      this.state === "absent" ||
      this.transactionId !== record.transactionId ||
      this.snapshotHash !== record.remoteSnapshotHash
    ) {
      throw new Error("fake remote promotion identity mismatch");
    }
    this.state = "committed";
    return {
      transactionId: record.transactionId,
      remoteSnapshotHash: record.remoteSnapshotHash,
      remotePromotionHash: "d".repeat(64)
    };
  }
}

function remoteBinding(): RemoteTargetBinding {
  return {
    id: "target_1",
    authority: {
      remoteInstallationId: "installation_1",
      executionNodeId: "node_1",
      authenticatedPrincipal: { uid: 1000, accountName: "kmux" }
    },
    locator: {
      profileId: "profile_1",
      effectiveConnectionPolicyHash: "a".repeat(64),
      lastVerifiedAt: "2026-07-18T00:00:00.000Z"
    },
    firstVerifiedAt: "2026-07-18T00:00:00.000Z"
  };
}

function monotonicClock(): () => string {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 18, 0, 0, tick++)).toISOString();
}
