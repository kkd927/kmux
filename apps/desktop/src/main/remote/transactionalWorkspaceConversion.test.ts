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
  "product-installed-persisted",
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
      kind: "convert-existing" as const,
      sourceWorkspaceId: "workspace_1",
      targetId: "target_1",
      effectiveConnectionPolicyHash: policyHash,
      initialWorkspaceName: "kmux@dev",
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
    const createRequest = {
      ...request,
      kind: "create-new" as const,
      destinationWindowId: "window_1"
    };
    delete (createRequest as { sourceWorkspaceId?: string }).sourceWorkspaceId;
    expect(decodeStartWorkspaceConversionRequest(createRequest)).toEqual(
      createRequest
    );
    expect(() =>
      decodeStartWorkspaceConversionRequest({
        ...createRequest,
        sourceWorkspaceId: "workspace_1"
      })
    ).toThrow(/unexpected conversion request field/u);
  });

  it("keeps product placement and naming out of the v3 remote snapshot", async () => {
    const fixture = createFixture(sandbox);

    await fixture.createRuntime().start({
      kind: "convert-existing",
      sourceWorkspaceId: fixture.workspaceId,
      targetId: "target_1",
      effectiveConnectionPolicyHash: policyHash,
      initialWorkspaceName: "kmux@devbox",
      defaultCwd: "/srv/project"
    });

    const remoteSnapshot = JSON.parse(
      fixture.remote.remoteSnapshot ?? "null"
    ) as Record<string, unknown> | null;
    expect(remoteSnapshot).toMatchObject({
      version: 3
    });
    expect(remoteSnapshot).not.toHaveProperty("productIntent");
    expect(remoteSnapshot).not.toHaveProperty("initialWorkspaceName");
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
          kind: "convert-existing",
          sourceWorkspaceId: fixture.workspaceId,
          targetId: "target_1",
          effectiveConnectionPolicyHash: policyHash,
          initialWorkspaceName: "kmux@devbox",
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
        "kmux@devbox"
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
        kind: "convert-existing",
        sourceWorkspaceId: fixture.workspaceId,
        targetId: "target_1",
        effectiveConnectionPolicyHash: policyHash,
        initialWorkspaceName: "kmux@devbox",
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
          kind: "create-new",
          destinationWindowId: fixture.currentState().activeWindowId,
          targetId: "target_1",
          effectiveConnectionPolicyHash: policyHash,
          initialWorkspaceName: "kmux@devbox",
          defaultCwd: "/srv/project",
          launch: { shell: "/bin/sh" }
        })
    ).rejects.toThrow(/injected creation crash/u);

    fixture.simulateDesktopRestart();
    const [record] = await fixture.createRuntime().recover();
    expect(record?.state).toBe("cleanup-complete");
    expect(record?.productIntent.kind).toBe("create-new");
    expect(fixture.currentState().workspaces[fixture.workspaceId]).toEqual(
      sourceBefore
    );
    const createdWorkspaceId = record!.workspaceResourceKey.workspaceId;
    expect(createdWorkspaceId).not.toBe(fixture.workspaceId);
    expect(fixture.currentState().workspaces[createdWorkspaceId]).toMatchObject(
      {
        name: "kmux@devbox",
        location: { target: { kind: "ssh", targetId: "target_1" } }
      }
    );
    expect(fixture.uniqueLocalTerminations).toEqual(new Set());
    expect(fixture.remote.createdKeeperCount).toBe(1);
    expect(Object.keys(fixture.currentState().sessions)).toHaveLength(
      fixture.sourceSessionIds.length + 1
    );
  });

  it("commits session identity while delivering launch input inline", async () => {
    const fixture = createFixture(sandbox);
    const record = await fixture.createRuntime().start({
      kind: "create-new",
      destinationWindowId: fixture.currentState().activeWindowId,
      targetId: "target_1",
      effectiveConnectionPolicyHash: policyHash,
      initialWorkspaceName: "remote agent",
      defaultCwd: "/srv/history",
      launch: { cwd: "/srv/history", shell: "/bin/zsh" },
      agentSessionRef: {
        vendor: "codex",
        externalKey: "ssh:target_1:codex:session-1",
        sessionId: "session-1"
      },
      initialInput: "codex resume session-1\r"
    });

    expect(record).toMatchObject({
      version: 4,
      state: "cleanup-complete",
      initialInputOutcome: "outcome-unknown",
      launch: { initialInput: "codex resume session-1\r" },
      agentSessionRef: {
        vendor: "codex",
        externalKey: "ssh:target_1:codex:session-1",
        sessionId: "session-1"
      }
    });
    expect(record).not.toHaveProperty("initialInput");
    const remoteSnapshot = JSON.parse(
      fixture.remote.remoteSnapshot ?? "null"
    ) as { launch?: Record<string, unknown> };
    expect(remoteSnapshot.launch?.initialInput).toBe(
      "codex resume session-1\r"
    );
    expect(remoteSnapshot).not.toHaveProperty("agentSessionRef");
    const session =
      fixture.currentState().sessions[record.sessionResourceKey.sessionId];
    expect(session.launch.initialInput).toBe("codex resume session-1\r");
    expect(session.agentSessionRef).toMatchObject({
      vendor: "codex",
      id: "session-1",
      targetId: "target_1"
    });
  });

  it("persists the conversion initial input outcome without changing remote revision", async () => {
    const fixture = createFixture(sandbox);
    fixture.remote.initialInputOutcome = "outcome-unknown";

    const record = await fixture.createRuntime().start({
      kind: "create-new",
      destinationWindowId: fixture.currentState().activeWindowId,
      targetId: "target_1",
      effectiveConnectionPolicyHash: policyHash,
      initialWorkspaceName: "remote agent",
      defaultCwd: "/srv/history",
      initialInput: "codex resume session-1\r"
    });

    expect(record).toMatchObject({
      state: "cleanup-complete",
      remoteResourceRevision: "1",
      initialInputOutcome: "outcome-unknown"
    });
    expect(fixture.wal.get(record.transactionId)).toMatchObject({
      initialInputOutcome: "outcome-unknown"
    });
  });

  it("prepares two history resumes in parallel and installs them in same-window admission order", async () => {
    const fixture = createConcurrentFixture(sandbox);
    const destinationWindowId = fixture.currentState().activeWindowId;
    const first = fixture.runtime.start({
      kind: "create-new",
      destinationWindowId,
      targetId: "target_1",
      effectiveConnectionPolicyHash: policyHash,
      initialWorkspaceName: "first history",
      defaultCwd: "/srv/first",
      agentSessionRef: {
        vendor: "codex",
        externalKey: "ssh:target_1:codex:first",
        sessionId: "first"
      },
      initialInput: "codex resume first\r"
    });
    const second = fixture.runtime.start({
      kind: "create-new",
      destinationWindowId,
      targetId: "target_1",
      effectiveConnectionPolicyHash: policyHash,
      initialWorkspaceName: "second history",
      defaultCwd: "/srv/second",
      agentSessionRef: {
        vendor: "claude",
        externalKey: "ssh:target_1:claude:second",
        sessionId: "second"
      },
      initialInput: "claude --resume second\r"
    });

    await vi.waitFor(() => {
      expect(fixture.remote.prepareCalls).toEqual([
        "transaction_1",
        "transaction_2"
      ]);
    });
    fixture.remote.resolvePrepare("transaction_2");
    await Promise.resolve();
    expect(fixture.productInstallOrder).toEqual([]);

    fixture.remote.resolvePrepare("transaction_1");
    const [firstRecord, secondRecord] = await Promise.all([first, second]);

    expect(fixture.productInstallOrder).toEqual([
      firstRecord.workspaceResourceKey.workspaceId,
      secondRecord.workspaceResourceKey.workspaceId
    ]);
    expect(firstRecord.workspaceResourceKey.workspaceId).not.toBe(
      secondRecord.workspaceResourceKey.workspaceId
    );
    expect(firstRecord.sessionResourceKey.sessionId).not.toBe(
      secondRecord.sessionResourceKey.sessionId
    );
    expect(
      fixture
        .currentState()
        .windows[destinationWindowId].workspaceOrder.slice(-2)
    ).toEqual([
      firstRecord.workspaceResourceKey.workspaceId,
      secondRecord.workspaceResourceKey.workspaceId
    ]);
    expect(firstRecord.launch.initialInput).toBe("codex resume first\r");
    expect(secondRecord.launch.initialInput).toBe("claude --resume second\r");
    expect(new Set(fixture.remote.promoteCalls)).toEqual(
      new Set(["transaction_1", "transaction_2"])
    );
  });

  it("orders convert-existing before create-new in the same window without sharing cleanup", async () => {
    const fixture = createConcurrentFixture(sandbox);
    const destinationWindowId = fixture.currentState().activeWindowId;
    const convert = fixture.runtime.start({
      kind: "convert-existing",
      sourceWorkspaceId: fixture.sourceWorkspaceId,
      targetId: "target_1",
      effectiveConnectionPolicyHash: policyHash,
      initialWorkspaceName: "converted",
      defaultCwd: "/srv/converted"
    });
    const create = fixture.runtime.start({
      kind: "create-new",
      destinationWindowId,
      targetId: "target_1",
      effectiveConnectionPolicyHash: policyHash,
      initialWorkspaceName: "created",
      defaultCwd: "/srv/created"
    });

    await vi.waitFor(() => expect(fixture.remote.prepareCalls).toHaveLength(2));
    fixture.remote.resolvePrepare("transaction_2");
    await Promise.resolve();
    expect(fixture.productInstallOrder).toEqual([]);
    fixture.remote.resolvePrepare("transaction_1");
    const [converted, created] = await Promise.all([convert, create]);

    expect(fixture.productInstallOrder).toEqual([
      fixture.sourceWorkspaceId,
      created.workspaceResourceKey.workspaceId
    ]);
    expect(converted.productIntent.kind).toBe("convert-existing");
    expect(created.productIntent.kind).toBe("create-new");
    expect(
      fixture.currentState().workspaces[fixture.sourceWorkspaceId].location
        .target
    ).toEqual({ kind: "ssh", targetId: "target_1" });
    expect(fixture.terminatedSessions).toEqual(
      new Set(fixture.sourceSessionIds)
    );
  });

  it("allows different windows to commit by readiness while serializing global snapshots", async () => {
    const fixture = createConcurrentFixture(sandbox, { secondWindow: true });
    const [firstWindowId, secondWindowId] = fixture.windowIds;
    const first = fixture.runtime.start({
      kind: "create-new",
      destinationWindowId: firstWindowId!,
      targetId: "target_1",
      effectiveConnectionPolicyHash: policyHash,
      initialWorkspaceName: "first window",
      defaultCwd: "/srv/first"
    });
    const second = fixture.runtime.start({
      kind: "create-new",
      destinationWindowId: secondWindowId!,
      targetId: "target_1",
      effectiveConnectionPolicyHash: policyHash,
      initialWorkspaceName: "second window",
      defaultCwd: "/srv/second"
    });

    await vi.waitFor(() => expect(fixture.remote.prepareCalls).toHaveLength(2));
    fixture.remote.resolvePrepare("transaction_2");
    await vi.waitFor(() => expect(fixture.productInstallOrder).toHaveLength(1));
    fixture.remote.resolvePrepare("transaction_1");
    const [firstRecord, secondRecord] = await Promise.all([first, second]);

    expect(fixture.productInstallOrder).toEqual([
      secondRecord.workspaceResourceKey.workspaceId,
      firstRecord.workspaceResourceKey.workspaceId
    ]);
    expect(fixture.maxConcurrentSnapshots()).toBe(1);
    expect(
      fixture.currentState().workspaces[
        firstRecord.workspaceResourceKey.workspaceId
      ].windowId
    ).toBe(firstWindowId);
    expect(
      fixture.currentState().workspaces[
        secondRecord.workspaceResourceKey.workspaceId
      ].windowId
    ).toBe(secondWindowId);
  });

  it("fails with a transaction conflict instead of falling back when the destination window disappears", async () => {
    const fixture = createConcurrentFixture(sandbox);
    const destinationWindowId = fixture.currentState().activeWindowId;
    const creating = fixture.runtime.start({
      kind: "create-new",
      destinationWindowId,
      targetId: "target_1",
      effectiveConnectionPolicyHash: policyHash,
      initialWorkspaceName: "orphaned destination",
      defaultCwd: "/srv/project"
    });

    await vi.waitFor(() => expect(fixture.remote.prepareCalls).toHaveLength(1));
    delete fixture.currentState().windows[destinationWindowId];
    fixture.remote.resolvePrepare("transaction_1");

    await expect(creating).rejects.toThrow(
      /transaction conflict: destination window no longer exists/u
    );
    expect(fixture.productInstallOrder).toEqual([]);
    expect(fixture.wal.get("transaction_1")?.state).toBe("remote-created");
  });

  it("reconstructs same-window FIFO from preparedAt and transactionId during recovery", async () => {
    const fixture = createConcurrentFixture(sandbox);
    const destinationWindowId = fixture.currentState().activeWindowId;
    const crashing = fixture.createRuntime((point) => {
      if (point === "remote-created-persisted") {
        throw new Error("simulated process loss");
      }
    });
    const first = crashing.start({
      kind: "create-new",
      destinationWindowId,
      targetId: "target_1",
      effectiveConnectionPolicyHash: policyHash,
      initialWorkspaceName: "first recovered",
      defaultCwd: "/srv/first"
    });
    const second = crashing.start({
      kind: "create-new",
      destinationWindowId,
      targetId: "target_1",
      effectiveConnectionPolicyHash: policyHash,
      initialWorkspaceName: "second recovered",
      defaultCwd: "/srv/second"
    });

    await vi.waitFor(() => expect(fixture.remote.prepareCalls).toHaveLength(2));
    fixture.remote.resolvePrepare("transaction_2");
    fixture.remote.resolvePrepare("transaction_1");
    const interrupted = await Promise.allSettled([first, second]);
    expect(interrupted.every((result) => result.status === "rejected")).toBe(
      true
    );
    expect(
      fixture.wal
        .loadAll()
        .map((record) => record.state)
        .sort()
    ).toEqual(["remote-created", "remote-created"]);

    const recovered = await fixture.createRuntime().recover();
    expect(recovered).toHaveLength(2);
    expect(fixture.productInstallOrder).toEqual(
      recovered.map((record) => record.workspaceResourceKey.workspaceId)
    );
  });

  it("leaves the current workspace unchanged when new-workspace preparation fails", async () => {
    const fixture = createFixture(sandbox);
    fixture.remote.failPrepare = true;
    const before = cloneState(fixture.currentState());

    await expect(
      fixture.createRuntime().start({
        kind: "create-new",
        destinationWindowId: fixture.currentState().activeWindowId,
        targetId: "target_1",
        effectiveConnectionPolicyHash: policyHash,
        initialWorkspaceName: "kmux@devbox",
        defaultCwd: "/srv/project"
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
        kind: "convert-existing",
        sourceWorkspaceId: fixture.workspaceId,
        targetId: "target_1",
        effectiveConnectionPolicyHash: policyHash,
        initialWorkspaceName: "kmux@devbox",
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
          kind: "convert-existing",
          sourceWorkspaceId: fixture.workspaceId,
          targetId: "target_1",
          effectiveConnectionPolicyHash: policyHash,
          initialWorkspaceName: "kmux@devbox",
          defaultCwd: "/srv/project"
        })
    ).rejects.toThrow(/injected admission crash/u);

    await expect(
      fixture.createRuntime().start({
        kind: "convert-existing",
        sourceWorkspaceId: fixture.workspaceId,
        targetId: "target_1",
        effectiveConnectionPolicyHash: policyHash,
        initialWorkspaceName: "kmux@other",
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
        kind: "convert-existing",
        sourceWorkspaceId: fixture.workspaceId,
        targetId: "target_1",
        effectiveConnectionPolicyHash: policyHash,
        initialWorkspaceName: "kmux@devbox",
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
          kind: "convert-existing",
          sourceWorkspaceId: fixture.workspaceId,
          targetId: "target_1",
          effectiveConnectionPolicyHash: policyHash,
          initialWorkspaceName: "kmux@devbox",
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

function createConcurrentFixture(
  sandbox: string,
  options: { secondWindow?: boolean } = {}
) {
  let state = createInitialState("/bin/zsh");
  const windowIds = [state.activeWindowId];
  if (options.secondWindow) {
    const additional = createInitialState("/bin/zsh");
    windowIds.push(additional.activeWindowId);
    Object.assign(state.windows, additional.windows);
    Object.assign(state.workspaces, additional.workspaces);
    Object.assign(state.panes, additional.panes);
    Object.assign(state.surfaces, additional.surfaces);
    Object.assign(state.sessions, additional.sessions);
  }
  const sourceWorkspaceId =
    state.windows[state.activeWindowId].activeWorkspaceId;
  const sourceSessionIds = Object.values(state.sessions).map(
    (session) => session.id
  );
  const runtimeEpochs = new Map(
    sourceSessionIds.map((sessionId) => [sessionId, `epoch_${sessionId}`])
  );
  const wal = createConversionWalStore(join(sandbox, "wal-concurrent"));
  const remote = new ConcurrentConversionRemote();
  const transactionIds = ["transaction_1", "transaction_2"];
  const productInstallOrder: string[] = [];
  const installedRemoteWorkspaceIds = new Set<string>();
  const terminatedSessions = new Set<string>();
  let concurrentSnapshots = 0;
  let maxConcurrentSnapshots = 0;
  const now = monotonicClock();
  const createRuntime = (faultPoint?: (point: ConversionFaultPoint) => void) =>
    createTransactionalWorkspaceConversionRuntime({
      desktopInstallationId: "desktop_1",
      wal,
      remote,
      getState: () => state,
      getTargetBinding: (targetId) =>
        targetId === "target_1" ? remoteBinding() : undefined,
      getLocalRuntimeEpoch: (_surfaceId, sessionId) =>
        runtimeEpochs.get(sessionId) ?? null,
      forceDesktopSnapshot: async (_candidate, expectedHash) => {
        concurrentSnapshots += 1;
        maxConcurrentSnapshots = Math.max(
          maxConcurrentSnapshots,
          concurrentSnapshots
        );
        await Promise.resolve();
        concurrentSnapshots -= 1;
        return expectedHash;
      },
      installDesktopState: (candidate) => {
        state = cloneState(candidate);
        const installed = Object.values(state.workspaces).find(
          (workspace) =>
            workspace.location.target.kind === "ssh" &&
            !installedRemoteWorkspaceIds.has(workspace.id)
        );
        if (!installed) {
          throw new Error("product install did not add one SSH workspace");
        }
        installedRemoteWorkspaceIds.add(installed.id);
        productInstallOrder.push(installed.id);
      },
      terminateLocalSession: async (target) => {
        const first = !terminatedSessions.has(target.sessionId);
        terminatedSessions.add(target.sessionId);
        return {
          ...target,
          outcome: first ? "terminated" : "already-exited"
        };
      },
      makeTransactionId: () => {
        const transactionId = transactionIds.shift();
        if (!transactionId) throw new Error("transaction ID fixture exhausted");
        return transactionId;
      },
      now,
      ...(faultPoint === undefined
        ? {}
        : {
            faultPoint: (point: ConversionFaultPoint) => faultPoint(point)
          })
    });
  const runtime = createRuntime();
  return {
    runtime,
    createRuntime,
    wal,
    remote,
    sourceWorkspaceId,
    sourceSessionIds,
    windowIds,
    productInstallOrder,
    terminatedSessions,
    maxConcurrentSnapshots: () => maxConcurrentSnapshots,
    currentState: () => state
  };
}

function createFixture(
  sandbox: string,
  options: { capabilities?: string[] } = {}
) {
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
  const binding = remoteBinding(options.capabilities);

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
  remoteSnapshot?: string;
  initialInputOutcome?: "written" | "outcome-unknown";
  private transactionId?: string;
  private snapshotHash?: string;

  async prepare(request: Parameters<ConversionRemoteGateway["prepare"]>[0]) {
    if (this.failPrepare) throw new Error("injected remote prepare failure");
    if (this.state === "absent") {
      this.state = "provisional";
      this.transactionId = request.record.transactionId;
      this.snapshotHash = request.remoteSnapshotHash;
      this.remoteSnapshot = request.remoteSnapshot;
      this.createdKeeperCount += 1;
    }
    if (
      this.transactionId !== request.record.transactionId ||
      this.snapshotHash !== request.remoteSnapshotHash ||
      this.remoteSnapshot !== request.remoteSnapshot
    ) {
      throw new Error("fake remote idempotency conflict");
    }
    return {
      remoteSnapshotHash: request.remoteSnapshotHash,
      workspaceDescriptorHash: "b".repeat(64),
      sessionDescriptorHash: "c".repeat(64),
      keeperGeneration: "keeper_conversion_1",
      remoteResourceRevision: "1",
      remoteCreatedAt: "2026-07-18T00:00:10.000Z",
      ...(this.initialInputOutcome === undefined
        ? {}
        : { initialInputOutcome: this.initialInputOutcome })
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

class ConcurrentConversionRemote implements ConversionRemoteGateway {
  readonly prepareCalls: string[] = [];
  readonly promoteCalls: string[] = [];
  private readonly prepareGates = new Map<
    string,
    ReturnType<typeof deferred<void>>
  >();

  async prepare(request: Parameters<ConversionRemoteGateway["prepare"]>[0]) {
    const transactionId = request.record.transactionId;
    this.prepareCalls.push(transactionId);
    const gate = deferred<void>();
    this.prepareGates.set(transactionId, gate);
    await gate.promise;
    return {
      remoteSnapshotHash: request.remoteSnapshotHash,
      workspaceDescriptorHash: "b".repeat(64),
      sessionDescriptorHash: "c".repeat(64),
      keeperGeneration: `keeper_${transactionId}`,
      remoteResourceRevision: "1",
      remoteCreatedAt: "2026-07-18T00:00:10.000Z"
    };
  }

  resolvePrepare(transactionId: string): void {
    const gate = this.prepareGates.get(transactionId);
    if (!gate) throw new Error(`prepare gate ${transactionId} is absent`);
    gate.resolve();
  }

  async promote(record: Parameters<ConversionRemoteGateway["promote"]>[0]) {
    this.promoteCalls.push(record.transactionId);
    return {
      transactionId: record.transactionId,
      remoteSnapshotHash: record.remoteSnapshotHash,
      remotePromotionHash:
        record.transactionId === "transaction_1"
          ? "d".repeat(64)
          : "e".repeat(64)
    };
  }
}

function remoteBinding(capabilities?: string[]): RemoteTargetBinding {
  return {
    id: "target_1",
    ...(capabilities === undefined
      ? {}
      : {
          observation: {
            platform: "linux",
            arch: "x86_64",
            abi: "musl",
            runtimeVersion: "1.1.1",
            capabilities: [...capabilities],
            persistenceLevel: "ssh-disconnect" as const
          }
        }),
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}
