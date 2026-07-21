import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UtilityProcess } from "electron";

import {
  applyAction,
  createInitialState,
  type AppState,
  type RemoteTargetBinding
} from "@kmux/core";
import { applyMainFact } from "@kmux/core/main";
import { uint64 } from "@kmux/proto";
import type { RemoteSpoolEventDto } from "@kmux/proto";

import { RemoteHostManager } from "../remoteHost";
import { createDurableRemoteOperationStore } from "./durableRemoteOperationStore";
import { routeRendererAppAction } from "./rendererCommandAuthorization";
import { createRetainedSessionInventoryStore } from "./retainedSessionInventory";
import {
  createRemoteEventReceiptStore,
  type RemoteEventReceiptStore
} from "./remoteEventReceiptStore";
import {
  compareRemoteOperationRetryOrder,
  RemoteLifecycleRuntime,
  selectVerifiedRemoteRuntimeArtifact
} from "./remoteLifecycleRuntime";

describe("RemoteLifecycleRuntime", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "kmux-remote-lifecycle-"));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("accepts exactly the four native remote runtime artifact tuples", () => {
    const supported: Parameters<typeof selectVerifiedRemoteRuntimeArtifact>[0] =
      {
        ...hello(),
        capabilities: ["terminal-v1"]
      };
    expect(selectVerifiedRemoteRuntimeArtifact(supported)).toBe(
      "linux-x64-musl"
    );
    expect(
      selectVerifiedRemoteRuntimeArtifact({
        ...supported,
        platform: "macos",
        arch: "aarch64",
        abi: "native"
      })
    ).toBe("darwin-arm64");
    expect(
      selectVerifiedRemoteRuntimeArtifact({
        ...supported,
        arch: "aarch64"
      })
    ).toBe("linux-arm64-musl");
    expect(() =>
      selectVerifiedRemoteRuntimeArtifact({
        ...supported,
        abi: "gnu"
      })
    ).toThrow(/unsupported remote runtime/u);
  });

  it("keeps local-only startup lazy and durably admits offline commands", async () => {
    const fixture = remoteFixture();
    const fork = vi.fn();
    const host = new RemoteHostManager(fork);
    host.on("error", vi.fn());
    const runtime = createRuntime(fixture.state, host, binding(), sandbox);

    runtime.recover();
    expect(fork).not.toHaveBeenCalled();

    const result = await runtime.executeCommand({
      type: "remote-operation.command",
      workspaceId: fixture.workspaceId,
      expectedRemoteResourceRevision: uint64(0n),
      payload: {
        kind: "session.terminate",
        sessionId: fixture.initialSessionId
      }
    });

    expect(result.outcome).toEqual({ status: "pending", reason: "offline" });
    expect(fixture.state.remoteOperations[result.operationId].state).toBe(
      "termination-pending"
    );
    expect(fork).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("keeps an offline retained termination durable and retries the same operation through an exact tombstone", async () => {
    const fixture = remoteFixture();
    const resourceKey = {
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      workspaceId: fixture.workspaceId,
      sessionId: fixture.initialSessionId
    };
    const inventory = createRetainedSessionInventoryStore(
      join(sandbox, "retained.json")
    );
    inventory.retain(
      {
        resourceKey,
        generation: `keeper_${fixture.initialSessionId}`,
        processState: "running",
        persistenceLevel: "ssh-disconnect",
        remoteResourceRevision: uint64(1n),
        storageStatus: normalStorageStatus(),
        checkpointAvailable: false,
        retainedRangeTruncated: false,
        descriptor: {
          createOperationId: `create_${fixture.initialSessionId}`,
          canonicalCreatePayloadHash: "a".repeat(64),
          lastOperationId: `last_${fixture.initialSessionId}`,
          lastOperationPayloadHash: "b".repeat(64),
          lastResultDigest: "c".repeat(64),
          launch: { cwd: "/srv/app" },
          lifecycleState: "committed",
          everGrantedWriterLease: true
        }
      },
      "workspace-close",
      "2026-07-17T00:00:00.000Z"
    );
    const keepers = new Map<string, ScriptedKeeper>([
      [
        fixture.initialSessionId,
        {
          resourceKey,
          keeperGeneration: `keeper_${fixture.initialSessionId}`,
          remoteResourceRevision: "1"
        }
      ]
    ]);
    const child = new ScriptedUtilityProcess(keepers);
    const fork = vi.fn(() => child as unknown as UtilityProcess);
    const host = new RemoteHostManager(fork);
    host.on("error", vi.fn());
    const runtime = createRuntime(
      fixture.state,
      host,
      binding(),
      sandbox,
      [],
      inventory
    );
    runtime.recover();

    const offline = await runtime.terminateRetainedSession(resourceKey);
    expect(offline.outcome).toEqual({ status: "pending", reason: "offline" });
    expect(fork).not.toHaveBeenCalled();
    expect(inventory.listRetained()).toMatchObject([
      {
        reason: "termination-pending",
        termination: { operationId: offline.operationId }
      }
    ]);
    expect(
      inventory.listRetained()[0]?.termination?.resultDigest
    ).toBeUndefined();

    await runtime.connectTarget(connection());
    const executions = child.messages.filter(
      (message) => message.type === "operation.execute"
    );
    expect(executions).toHaveLength(1);
    expect((executions[0].intent as { operationId: string }).operationId).toBe(
      offline.operationId
    );
    expect(inventory.listRetained()).toEqual([]);

    await runtime.stop();
  });

  it("durably projects and acknowledges replayed hook notifications once", async () => {
    const fixture = remoteFixture();
    const surface =
      fixture.state.surfaces[
        fixture.state.sessions[fixture.initialSessionId].surfaceId
      ];
    const resourceKey = {
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      workspaceId: fixture.workspaceId,
      sessionId: fixture.initialSessionId
    };
    const keeperGeneration = `keeper_${fixture.initialSessionId}`;
    const event = remoteNotificationEvent({
      resourceKey,
      surfaceId: surface.id,
      keeperGeneration
    });
    const child = new ScriptedUtilityProcess(
      new Map([
        [
          fixture.initialSessionId,
          {
            resourceKey,
            keeperGeneration,
            remoteResourceRevision: "1"
          }
        ]
      ]),
      hello(),
      false,
      [event]
    );
    const host = new RemoteHostManager(
      () => child as unknown as UtilityProcess
    );
    host.on("error", vi.fn());
    const receiptStore = createRemoteEventReceiptStore(
      join(sandbox, "event-receipts")
    );
    const persist = vi.fn();
    const runtime = createRuntime(
      fixture.state,
      host,
      binding(),
      sandbox,
      [],
      undefined,
      undefined,
      undefined,
      { receiptStore, persist }
    );
    runtime.recover();

    await runtime.connectTarget(connection());
    expect(fixture.state.notifications).toMatchObject([
      { title: "Done", message: "Ready", surfaceId: surface.id }
    ]);
    expect(fixture.state.remoteEventReceipts.target_1).toEqual({
      throughSequence: 1n,
      recentEventIds: ["event_1"]
    });
    const receipt = receiptStore.load("desktop_1", "target_1");
    expect(receipt.appliedThrough).toBe(1n);
    expect(receipt.pending).toBeUndefined();
    expect(child.acknowledgedThrough).toBe(1n);
    expect(persist).toHaveBeenCalled();

    await runtime.disconnectTarget("target_1");
    await runtime.connectTarget(connection());
    expect(fixture.state.notifications).toHaveLength(1);
    await runtime.stop();
  });

  it("projects detached OSC notifications while acknowledging BEL without a notification item", async () => {
    const fixture = remoteFixture();
    const surface =
      fixture.state.surfaces[
        fixture.state.sessions[fixture.initialSessionId].surfaceId
      ];
    const resourceKey = {
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      workspaceId: fixture.workspaceId,
      sessionId: fixture.initialSessionId
    };
    const keeperGeneration = `keeper_${fixture.initialSessionId}`;
    const oscEvent: RemoteSpoolEventDto = {
      ...remoteNotificationEvent({
        resourceKey,
        surfaceId: surface.id,
        keeperGeneration
      }),
      kind: "osc-notification",
      name: "terminal.osc.777",
      payload: { protocol: 777, title: "Build", message: "Done" }
    };
    const bellEvent: RemoteSpoolEventDto = {
      ...oscEvent,
      sequence: "2",
      eventId: "event_2",
      kind: "notification",
      name: "terminal.bell",
      payload: { kind: "bell", mutationSequence: "9", actionIndex: 0 }
    };
    const child = new ScriptedUtilityProcess(
      new Map([
        [
          fixture.initialSessionId,
          { resourceKey, keeperGeneration, remoteResourceRevision: "1" }
        ]
      ]),
      hello(),
      false,
      [oscEvent, bellEvent]
    );
    const host = new RemoteHostManager(
      () => child as unknown as UtilityProcess
    );
    host.on("error", vi.fn());
    const receiptStore = createRemoteEventReceiptStore(
      join(sandbox, "event-receipts")
    );
    const runtime = createRuntime(
      fixture.state,
      host,
      binding(),
      sandbox,
      [],
      undefined,
      undefined,
      undefined,
      { receiptStore, persist: vi.fn() }
    );
    runtime.recover();

    await runtime.connectTarget(connection());
    expect(fixture.state.notifications).toMatchObject([
      {
        title: "Build",
        message: "Done",
        source: "terminal",
        surfaceId: surface.id
      }
    ]);
    expect(fixture.state.remoteEventReceipts.target_1).toEqual({
      throughSequence: 2n,
      recentEventIds: ["event_1", "event_2"]
    });
    expect(child.acknowledgedThrough).toBe(2n);
    await runtime.stop();
  });

  it("recovers the crash window after product snapshot but before cursor completion", async () => {
    const fixture = remoteFixture();
    const surface =
      fixture.state.surfaces[
        fixture.state.sessions[fixture.initialSessionId].surfaceId
      ];
    const resourceKey = {
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      workspaceId: fixture.workspaceId,
      sessionId: fixture.initialSessionId
    };
    const keeperGeneration = `keeper_${fixture.initialSessionId}`;
    const event = remoteNotificationEvent({
      resourceKey,
      surfaceId: surface.id,
      keeperGeneration
    });
    const receiptStore = createRemoteEventReceiptStore(
      join(sandbox, "event-receipts")
    );
    receiptStore.stage(event);
    applyAction(fixture.state, {
      type: "remote.event.apply",
      targetId: "target_1",
      sequence: uint64(1n),
      eventId: "event_1",
      productAction: {
        type: "notification.create",
        workspaceId: fixture.workspaceId,
        paneId: fixture.paneId,
        surfaceId: surface.id,
        title: "Done",
        message: "Ready",
        source: "agent"
      }
    });
    const child = new ScriptedUtilityProcess(
      new Map([
        [
          fixture.initialSessionId,
          {
            resourceKey,
            keeperGeneration,
            remoteResourceRevision: "1"
          }
        ]
      ]),
      hello(),
      false,
      [event]
    );
    const host = new RemoteHostManager(
      () => child as unknown as UtilityProcess
    );
    host.on("error", vi.fn());
    const runtime = createRuntime(
      fixture.state,
      host,
      binding(),
      sandbox,
      [],
      undefined,
      undefined,
      undefined,
      { receiptStore, persist: vi.fn() }
    );
    runtime.recover();

    await runtime.connectTarget(connection());
    expect(fixture.state.notifications).toHaveLength(1);
    const receipt = receiptStore.load("desktop_1", "target_1");
    expect(receipt.appliedThrough).toBe(1n);
    expect(receipt.pending).toBeUndefined();
    expect(child.acknowledgedThrough).toBe(1n);
    await runtime.stop();
  });

  it("fails closed when a completed event receipt has no durable product projection", async () => {
    const fixture = remoteFixture();
    const surface =
      fixture.state.surfaces[
        fixture.state.sessions[fixture.initialSessionId].surfaceId
      ];
    const resourceKey = {
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      workspaceId: fixture.workspaceId,
      sessionId: fixture.initialSessionId
    };
    const keeperGeneration = `keeper_${fixture.initialSessionId}`;
    const event = remoteNotificationEvent({
      resourceKey,
      surfaceId: surface.id,
      keeperGeneration
    });
    const receiptStore = createRemoteEventReceiptStore(
      join(sandbox, "event-receipts")
    );
    receiptStore.stage(event);
    receiptStore.complete(event);
    const child = new ScriptedUtilityProcess(
      new Map([
        [
          fixture.initialSessionId,
          { resourceKey, keeperGeneration, remoteResourceRevision: "1" }
        ]
      ]),
      hello(),
      false,
      [event]
    );
    const host = new RemoteHostManager(
      () => child as unknown as UtilityProcess
    );
    host.on("error", vi.fn());
    const runtime = createRuntime(
      fixture.state,
      host,
      binding(),
      sandbox,
      [],
      undefined,
      undefined,
      undefined,
      { receiptStore, persist: vi.fn() }
    );
    runtime.recover();

    await expect(runtime.connectTarget(connection())).rejects.toThrow(
      /receipt advanced beyond the durable product snapshot/u
    );
    expect(fixture.state.notifications).toEqual([]);
    await runtime.stop();
  });

  it("retains every remote descriptor before close-others removes any workspace", async () => {
    const fixture = remoteFixture();
    const state = fixture.state;
    const localWorkspaceId = Object.values(state.workspaces).find(
      (workspace) => workspace.location.target.kind === "local"
    )!.id;
    applyAction(state, {
      type: "workspace.create",
      target: { kind: "ssh", targetId: "target_1" },
      cwd: "/srv/second",
      name: "remote second"
    });
    const remoteWorkspaceIds = Object.values(state.workspaces)
      .filter((workspace) => workspace.location.target.kind === "ssh")
      .map((workspace) => workspace.id)
      .sort();
    const inventory = createRetainedSessionInventoryStore(
      join(sandbox, "retained.json")
    );
    const cacheWorkspace = (workspaceId: string): void => {
      const pane = state.panes[state.workspaces[workspaceId].activePaneId];
      const surface = state.surfaces[pane.activeSurfaceId];
      inventory.cacheOwned(
        {
          resourceKey: {
            desktopInstallationId: "desktop_1",
            targetId: "target_1",
            workspaceId,
            sessionId: surface.content.sessionId
          },
          generation: `keeper_${surface.content.sessionId}`,
          processState: "running",
          persistenceLevel: "ssh-disconnect",
          remoteResourceRevision: uint64(1n),
          storageStatus: normalStorageStatus(),
          checkpointAvailable: false,
          retainedRangeTruncated: false,
          descriptor: {
            createOperationId: `create_${surface.content.sessionId}`,
            canonicalCreatePayloadHash: "a".repeat(64),
            lastOperationId: `create_${surface.content.sessionId}`,
            lastOperationPayloadHash: "a".repeat(64),
            lastResultDigest: "b".repeat(64),
            launch: { cwd: "/srv/app" },
            lifecycleState: "committed",
            everGrantedWriterLease: true
          }
        },
        "2026-07-18T00:00:00.000Z"
      );
    };
    cacheWorkspace(remoteWorkspaceIds[0]);
    const host = new RemoteHostManager(vi.fn());
    host.on("error", vi.fn());
    const runtime = createRuntime(
      state,
      host,
      binding(),
      sandbox,
      [],
      inventory
    );

    expect(() =>
      runtime.closeOtherWorkspacesRetained(localWorkspaceId)
    ).toThrow(/no authoritative remote descriptor/u);
    expect(
      remoteWorkspaceIds.every((workspaceId) => state.workspaces[workspaceId])
    ).toBe(true);
    expect(inventory.listRetained()).toEqual([]);

    cacheWorkspace(remoteWorkspaceIds[1]);
    expect(runtime.closeOtherWorkspacesRetained(localWorkspaceId)).toHaveLength(
      2
    );
    expect(
      remoteWorkspaceIds.every(
        (workspaceId) => state.workspaces[workspaceId] === undefined
      )
    ).toBe(true);
    expect(inventory.listRetained()).toHaveLength(2);

    await runtime.stop();
  });

  it("does not retain the last workspace when product close is a no-op", async () => {
    const fixture = remoteFixture();
    const state = fixture.state;
    const localWorkspaceId = Object.values(state.workspaces).find(
      (workspace) => workspace.location.target.kind === "local"
    )!.id;
    applyAction(state, {
      type: "workspace.close",
      workspaceId: localWorkspaceId
    });
    const inventory = createRetainedSessionInventoryStore(
      join(sandbox, "retained.json")
    );
    const pane =
      state.panes[state.workspaces[fixture.workspaceId].activePaneId];
    const surface = state.surfaces[pane.activeSurfaceId];
    inventory.cacheOwned(
      {
        resourceKey: {
          desktopInstallationId: "desktop_1",
          targetId: "target_1",
          workspaceId: fixture.workspaceId,
          sessionId: surface.content.sessionId
        },
        generation: `keeper_${surface.content.sessionId}`,
        processState: "running",
        persistenceLevel: "ssh-disconnect",
        remoteResourceRevision: uint64(1n),
        storageStatus: normalStorageStatus(),
        checkpointAvailable: false,
        retainedRangeTruncated: false,
        descriptor: {
          createOperationId: `create_${surface.content.sessionId}`,
          canonicalCreatePayloadHash: "a".repeat(64),
          lastOperationId: `create_${surface.content.sessionId}`,
          lastOperationPayloadHash: "a".repeat(64),
          lastResultDigest: "b".repeat(64),
          launch: { cwd: "/srv/app" },
          lifecycleState: "committed",
          everGrantedWriterLease: true
        }
      },
      "2026-07-18T00:00:00.000Z"
    );
    const host = new RemoteHostManager(vi.fn());
    host.on("error", vi.fn());
    const runtime = createRuntime(
      state,
      host,
      binding(),
      sandbox,
      [],
      inventory
    );

    expect(runtime.closeWorkspaceRetained(fixture.workspaceId)).toEqual([]);
    expect(state.workspaces[fixture.workspaceId]).toBeDefined();
    expect(inventory.listRetained()).toEqual([]);

    await runtime.stop();
  });

  it("composes verified connect, durable create, observation, cursor, attach routing, and crash recovery", async () => {
    const fixture = remoteFixture();
    const keepers = new Map<string, ScriptedKeeper>();
    const children: ScriptedUtilityProcess[] = [];
    const host = new RemoteHostManager(() => {
      const child = new ScriptedUtilityProcess(keepers);
      children.push(child);
      return child as unknown as UtilityProcess;
    });
    host.on("error", vi.fn());
    const errors: Error[] = [];
    const observedBindings: RemoteTargetBinding[] = [];
    const runtime = createRuntime(
      fixture.state,
      host,
      binding(),
      sandbox,
      errors,
      undefined,
      undefined,
      undefined,
      undefined,
      observedBindings
    );
    runtime.recover();

    await runtime.connectTarget(connection());
    expect(children).toHaveLength(1);
    expect(runtime.isTargetConnected("target_1")).toBe(true);
    expect(observedBindings).toHaveLength(1);
    expect(observedBindings[0]).toMatchObject({
      id: "target_1",
      observation: {
        platform: "linux",
        arch: "x86_64",
        abi: "musl",
        runtimeVersion: "0.1.0",
        capabilities: ["terminal-v1"],
        persistenceLevel: "ssh-disconnect"
      }
    });

    const created = await runtime.executeCommand({
      type: "remote-operation.command",
      workspaceId: fixture.workspaceId,
      expectedRemoteResourceRevision: uint64(0n),
      payload: {
        kind: "session.create",
        sessionId: "session_created",
        surfaceId: "surface_created",
        paneId: fixture.paneId,
        launch: { cwd: "/srv/app", shell: "/bin/sh" }
      }
    });
    expect(created.outcome).toMatchObject({
      status: "succeeded",
      keeperGeneration: "keeper_session_created",
      remoteResourceRevision: 1n
    });
    expect(
      runtime.getRemoteTerminal("surface_created", "session_created")
    ).toMatchObject({
      resourceKey: {
        desktopInstallationId: "desktop_1",
        targetId: "target_1",
        workspaceId: fixture.workspaceId,
        sessionId: "session_created"
      },
      keeperGeneration: "keeper_session_created"
    });

    children[0].emit("message", {
      type: "terminal.cursor",
      targetId: "target_1",
      resourceKey: {
        desktopInstallationId: "desktop_1",
        targetId: "target_1",
        workspaceId: fixture.workspaceId,
        sessionId: "session_created"
      },
      keeperGeneration: "keeper_session_created",
      sequence: 7n
    });
    expect(
      fixture.state.sessions.session_created.remoteRuntime
        ?.lastAcknowledgedMutationSequence
    ).toBe(7n);

    children[0].crash();
    await eventually(
      () =>
        children.length === 2 &&
        runtime.isTargetConnected("target_1") &&
        fixture.state.sessions.session_created.runtimeStatus
          .observationState === "observed"
    );
    expect(
      fixture.state.sessions.session_created.runtimeStatus.processState
    ).toBe("running");
    expect(fixture.state.sessions.session_created.remoteRuntime).toMatchObject({
      keeperGeneration: "keeper_session_created",
      remoteResourceRevision: 1n,
      lastAcknowledgedMutationSequence: 7n
    });
    expect(errors).toEqual([]);

    await runtime.stop();
  });

  it("backs off repeated remote-host crashes instead of spinning UtilityProcess restarts", async () => {
    vi.useFakeTimers();
    const fixture = remoteFixture();
    const children: ScriptedUtilityProcess[] = [];
    let runtime: RemoteLifecycleRuntime | undefined;
    try {
      const host = new RemoteHostManager(() => {
        const child = new ScriptedUtilityProcess(new Map());
        const index = children.push(child) - 1;
        if (index === 1) queueMicrotask(() => child.crash());
        return child as unknown as UtilityProcess;
      });
      host.on("error", vi.fn());
      runtime = createRuntime(fixture.state, host, binding(), sandbox);
      runtime.recover();
      await runtime.connectTarget(connection());

      children[0].crash();
      await vi.advanceTimersByTimeAsync(0);
      expect(children).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(249);
      expect(children).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(children).toHaveLength(3);

      for (let attempt = 0; attempt < 20; attempt += 1) {
        await Promise.resolve();
      }
      expect(runtime.isTargetConnected("target_1")).toBe(true);
    } finally {
      await runtime?.stop();
      vi.useRealTimers();
    }
  });

  it("orders an offline create before its separately durable launch input", async () => {
    const fixture = remoteFixture();
    const host = new RemoteHostManager(vi.fn());
    host.on("error", vi.fn());
    const runtime = createRuntime(fixture.state, host, binding(), sandbox);
    runtime.recover();

    await runtime.executeRendererLifecycleAction({
      type: "surface.create",
      paneId: fixture.paneId,
      launch: { cwd: "/srv/offline", initialInput: "codex\r" }
    });

    const operations = Object.values(fixture.state.remoteOperations).sort(
      compareRemoteOperationRetryOrder
    );
    expect(operations.map((operation) => operation.kind)).toEqual([
      "session.create",
      "launch-input"
    ]);
    expect(
      operations.map((operation) => [
        operation.expectedRemoteResourceRevision,
        operation.nextRemoteResourceRevision
      ])
    ).toEqual([
      [0n, 1n],
      [1n, 2n]
    ]);
    const createdSurfaceId = fixture.state.panes[
      fixture.paneId
    ].surfaceIds.find(
      (surfaceId) =>
        fixture.state.surfaces[surfaceId].content.sessionId !==
        fixture.initialSessionId
    )!;
    const created =
      fixture.state.sessions[
        fixture.state.surfaces[createdSurfaceId].content.sessionId
      ];
    expect(created?.launch.initialInput).toBe("codex\r");
    expect(() =>
      routeRendererAppAction(
        {
          type: "surface.moveToSplit",
          surfaceId: createdSurfaceId,
          targetPaneId: fixture.paneId,
          direction: "right"
        },
        fixture.state
      )
    ).toThrow(/pending SSH surface cannot move/u);

    await runtime.stop();
  });

  it("routes renderer create, restart, and close through durable remote operations", async () => {
    const fixture = remoteFixture();
    const initialSurfaceId =
      fixture.state.panes[fixture.paneId].activeSurfaceId;
    const resourceKey = {
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      workspaceId: fixture.workspaceId,
      sessionId: fixture.initialSessionId
    };
    fixture.state.sessions[fixture.initialSessionId].runtimeStatus = {
      processState: "running",
      observationState: "observed",
      attachmentState: "detached"
    };
    fixture.state.sessions[fixture.initialSessionId].remoteRuntime = {
      keeperGeneration: `keeper_${fixture.initialSessionId}`,
      remoteResourceRevision: uint64(1n)
    };
    const keepers = new Map<string, ScriptedKeeper>([
      [
        fixture.initialSessionId,
        {
          resourceKey,
          keeperGeneration: `keeper_${fixture.initialSessionId}`,
          remoteResourceRevision: "1"
        }
      ]
    ]);
    const child = new ScriptedUtilityProcess(keepers);
    const host = new RemoteHostManager(
      () => child as unknown as UtilityProcess
    );
    host.on("error", vi.fn());
    const errors: Error[] = [];
    const operationStore = createDurableRemoteOperationStore(
      join(sandbox, "operations")
    );
    const runtime = createRuntime(
      fixture.state,
      host,
      binding(),
      sandbox,
      errors,
      undefined,
      operationStore,
      vi.fn()
    );
    runtime.recover();
    await runtime.connectTarget(connection());

    await runtime.executeRendererLifecycleAction({
      type: "surface.close",
      surfaceId: initialSurfaceId
    });
    expect(fixture.state.surfaces[initialSurfaceId]).toBeDefined();
    expect(
      child.messages.filter((message) => message.type === "operation.execute")
    ).toHaveLength(0);

    await runtime.executeRendererLifecycleAction({
      type: "surface.create",
      paneId: fixture.paneId,
      launch: {
        cwd: "/srv/tool",
        initialInput: "echo ready\r",
        title: "remote tool"
      }
    });
    const createdSurfaceId = fixture.state.panes[
      fixture.paneId
    ].surfaceIds.find((surfaceId) => surfaceId !== initialSurfaceId)!;
    const createdSessionId =
      fixture.state.surfaces[createdSurfaceId].content.sessionId;
    expect(fixture.state.sessions[createdSessionId]).toMatchObject({
      launch: { cwd: { kind: "ssh" }, initialInput: "echo ready\r" },
      remoteRuntime: { remoteResourceRevision: 2n }
    });

    await runtime.executeRendererLifecycleAction({
      type: "surface.restartSession",
      surfaceId: createdSurfaceId
    });
    expect(
      fixture.state.sessions[createdSessionId].remoteRuntime
        ?.remoteResourceRevision
    ).toBe(4n);

    await runtime.executeRendererLifecycleAction({
      type: "surface.close",
      surfaceId: createdSurfaceId
    });
    expect(fixture.state.surfaces[createdSurfaceId]).toBeUndefined();
    expect(fixture.state.sessions[createdSessionId]).toBeUndefined();
    expect(fixture.state.panes[fixture.paneId]).toMatchObject({
      surfaceIds: [initialSurfaceId],
      activeSurfaceId: initialSurfaceId
    });
    expect(operationStore.loadAll()).toEqual([]);
    expect(errors).toEqual([]);
    await runtime.reconcileTarget("target_1");
    expect(runtime.listRetainedSessions()).toEqual([]);
    expect(
      child.messages
        .filter((message) => message.type === "operation.execute")
        .map((message) => (message.payload as { kind: string }).kind)
    ).toEqual([
      "session.create",
      "launch-input",
      "session.restart",
      "launch-input",
      "session.terminate"
    ]);
    await runtime.stop();
  });

  it("compacts a terminal operation only after its product state and exact remote receipt are durably checkpointed", async () => {
    const fixture = remoteFixture();
    const resourceKey = {
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      workspaceId: fixture.workspaceId,
      sessionId: fixture.initialSessionId
    };
    const keepers = new Map<string, ScriptedKeeper>([
      [
        fixture.initialSessionId,
        {
          resourceKey,
          keeperGeneration: `keeper_${fixture.initialSessionId}`,
          remoteResourceRevision: "1"
        }
      ]
    ]);
    const child = new ScriptedUtilityProcess(keepers);
    const host = new RemoteHostManager(
      () => child as unknown as UtilityProcess
    );
    host.on("error", vi.fn());
    const operationStore = createDurableRemoteOperationStore(
      join(sandbox, "operations")
    );
    const persistDurableProductSnapshot = vi.fn();
    const runtime = createRuntime(
      fixture.state,
      host,
      binding(),
      sandbox,
      [],
      undefined,
      operationStore,
      persistDurableProductSnapshot
    );
    runtime.recover();
    await runtime.connectTarget(connection());

    const result = await runtime.executeCommand({
      type: "remote-operation.command",
      workspaceId: fixture.workspaceId,
      expectedRemoteResourceRevision: uint64(1n),
      payload: {
        kind: "session.terminate",
        sessionId: fixture.initialSessionId
      }
    });

    expect(result.outcome.status).toBe("succeeded");
    expect(persistDurableProductSnapshot).toHaveBeenCalledTimes(2);
    expect(fixture.state.remoteOperations[result.operationId]).toBeUndefined();
    expect(operationStore.get(result.operationId)).toBeNull();
    expect(operationStore.listResourceReceipts()).toEqual([]);

    await runtime.stop();
  });

  it("fails closed when the handshake authority differs from the persisted binding", async () => {
    const fixture = remoteFixture();
    const child = new ScriptedUtilityProcess(
      new Map(),
      hello({ executionNodeId: "33333333-3333-4333-8333-333333333333" })
    );
    const host = new RemoteHostManager(
      () => child as unknown as UtilityProcess
    );
    host.on("error", vi.fn());
    const runtime = createRuntime(fixture.state, host, binding(), sandbox);
    runtime.recover();

    await expect(runtime.connectTarget(connection())).rejects.toThrow(
      /authority does not match/u
    );
    expect(runtime.isTargetConnected("target_1")).toBe(false);
    expect(
      child.messages.some(
        (message) => message.type === "target.verification-discard"
      )
    ).toBe(true);
    expect(
      fixture.state.sessions[fixture.initialSessionId].runtimeStatus
        .observationState
    ).toBe("unknown");

    await runtime.stop();
  });

  it("preserves the Main-selected verification timestamp during promotion", async () => {
    const fixture = remoteFixture();
    const child = new ScriptedUtilityProcess(new Map());
    const host = new RemoteHostManager(
      () => child as unknown as UtilityProcess
    );
    host.on("error", vi.fn());
    const candidate = {
      ...binding(),
      locator: {
        ...binding().locator,
        lastVerifiedAt: "2099-01-01T00:00:00.000Z"
      }
    };
    const observedBindings: RemoteTargetBinding[] = [];
    const runtime = createRuntime(
      fixture.state,
      host,
      candidate,
      sandbox,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      observedBindings
    );
    runtime.recover();

    await runtime.promoteVerifiedTarget({
      verificationId: "verification_1",
      binding: candidate,
      connection: connection(),
      token: "b".repeat(64)
    });

    expect(observedBindings[0]?.locator.lastVerifiedAt).toBe(
      candidate.locator.lastVerifiedAt
    );
    await runtime.stop();
  });

  it("marks one lost SSH target unknown and reconnects it without restarting remote-host", async () => {
    const fixture = remoteFixture();
    const children: ScriptedUtilityProcess[] = [];
    const host = new RemoteHostManager(() => {
      const child = new ScriptedUtilityProcess(new Map());
      children.push(child);
      return child as unknown as UtilityProcess;
    });
    host.on("error", vi.fn());
    const errors: Error[] = [];
    const runtime = createRuntime(
      fixture.state,
      host,
      binding(),
      sandbox,
      errors
    );
    runtime.recover();
    await runtime.connectTarget(connection());

    children[0].emit("message", {
      type: "target.lost",
      targetId: "target_1",
      masterGeneration: "master_1",
      code: "master-closed",
      message: "injected assigned master loss"
    });
    expect(runtime.isTargetConnected("target_1")).toBe(false);
    expect(
      fixture.state.sessions[fixture.initialSessionId].runtimeStatus
        .observationState
    ).toBe("unknown");

    await eventually(
      () =>
        runtime.isTargetConnected("target_1") &&
        children[0].messages.filter(
          (message) => message.type === "target.verify"
        ).length === 2
    );
    expect(children).toHaveLength(1);
    expect(
      fixture.state.sessions[fixture.initialSessionId].runtimeStatus
        .observationState
    ).toBe("observed");
    expect(errors).toEqual([]);

    await runtime.stop();
  });

  it("disconnects and forgets a target whose initial reconciliation fails", async () => {
    const fixture = remoteFixture();
    const children: ScriptedUtilityProcess[] = [];
    const host = new RemoteHostManager(() => {
      const child = new ScriptedUtilityProcess(new Map(), hello(), true);
      children.push(child);
      return child as unknown as UtilityProcess;
    });
    host.on("error", vi.fn());
    const runtime = createRuntime(fixture.state, host, binding(), sandbox);
    runtime.recover();

    await expect(runtime.connectTarget(connection())).rejects.toThrow(
      /injected observation failure/u
    );
    expect(runtime.isTargetConnected("target_1")).toBe(false);
    expect(
      children[0].messages.map((message) => message.type).filter(Boolean)
    ).toEqual([
      "target.verify",
      "target.promote",
      "target.observe",
      "target.disconnect"
    ]);

    children[0].crash();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(children).toHaveLength(1);

    await runtime.stop();
  });

  it("serializes disconnect after an in-flight connect without stale connected state", async () => {
    const fixture = remoteFixture();
    const child = new ScriptedUtilityProcess(new Map());
    const host = new RemoteHostManager(
      () => child as unknown as UtilityProcess
    );
    host.on("error", vi.fn());
    const runtime = createRuntime(fixture.state, host, binding(), sandbox);
    runtime.recover();

    const connecting = runtime.connectTarget(connection());
    const disconnecting = runtime.disconnectTarget("target_1");
    await Promise.all([connecting, disconnecting]);

    expect(runtime.isTargetConnected("target_1")).toBe(false);
    expect(
      child.messages.map((message) => message.type).filter(Boolean)
    ).toEqual([
      "target.verify",
      "target.promote",
      "target.observe",
      "target.observe",
      "target.disconnect"
    ]);
    expect(
      fixture.state.sessions[fixture.initialSessionId].runtimeStatus
        .observationState
    ).toBe("unknown");

    await runtime.stop();
  });

  it("keeps clean connected but atomically forgets the target route before runtime reset", async () => {
    const fixture = remoteFixture();
    const child = new ScriptedUtilityProcess(new Map());
    const host = new RemoteHostManager(
      () => child as unknown as UtilityProcess
    );
    host.on("error", vi.fn());
    const runtime = createRuntime(fixture.state, host, binding(), sandbox);
    runtime.recover();
    await runtime.connectTarget(connection());

    await expect(runtime.cleanTargetRuntime("target_1")).resolves.toMatchObject(
      {
        inspected: 1,
        removed: [],
        live: []
      }
    );
    expect(runtime.isTargetConnected("target_1")).toBe(true);
    expect(runtime.getTargetRuntimeRoots("target_1")).toEqual(
      connection().roots
    );

    await expect(runtime.resetTargetRuntime("target_1")).resolves.toEqual({
      generation: `1+${"c".repeat(64)}`,
      status: "reset"
    });
    expect(runtime.isTargetConnected("target_1")).toBe(false);
    expect(runtime.getTargetRuntimeRoots("target_1")).toBeNull();
    expect(
      fixture.state.sessions[fixture.initialSessionId].runtimeStatus
        .observationState
    ).toBe("unknown");
    expect(
      child.messages.map((message) => message.type).filter(Boolean)
    ).toEqual([
      "target.verify",
      "target.promote",
      "target.observe",
      "target.observe",
      "target.runtime-clean",
      "target.runtime-reset"
    ]);

    await runtime.stop();
  });
});

function createRuntime(
  state: AppState,
  host: RemoteHostManager,
  targetBinding: RemoteTargetBinding,
  sandbox: string,
  errors: Error[] = [],
  retainedInventory = createRetainedSessionInventoryStore(
    join(sandbox, "retained.json")
  ),
  operationStore = createDurableRemoteOperationStore(
    join(sandbox, "operations")
  ),
  persistDurableProductSnapshot?: (state: AppState) => void,
  phase6?: {
    receiptStore: RemoteEventReceiptStore;
    persist: (state: AppState) => void;
  },
  observedBindings: RemoteTargetBinding[] = []
): RemoteLifecycleRuntime {
  return new RemoteLifecycleRuntime({
    desktopInstallationId: "desktop_1",
    operationStore,
    host,
    hostEnv: { PATH: "/usr/bin" },
    getState: () => state,
    getTargetBinding: (targetId) =>
      targetId === targetBinding.id ? targetBinding : undefined,
    replaceTargetBinding: (binding) => observedBindings.push(binding),
    dispatchFact: (fact) => {
      applyMainFact(state, fact);
    },
    ...(phase6 === undefined
      ? {}
      : {
          dispatchAppAction: (action: Parameters<typeof applyAction>[1]) => {
            applyAction(state, action);
          },
          eventReceiptStore: phase6.receiptStore
        }),
    retainedInventory,
    closeWorkspaceProduct: (workspaceId) => {
      applyAction(state, { type: "workspace.close", workspaceId });
    },
    ...(phase6 !== undefined
      ? { persistDurableProductSnapshot: phase6.persist }
      : persistDurableProductSnapshot === undefined
        ? {}
        : { persistDurableProductSnapshot }),
    reportError: (error) => errors.push(error)
  });
}

function remoteFixture(): {
  state: AppState;
  workspaceId: string;
  paneId: string;
  initialSessionId: string;
} {
  const state = createInitialState("/bin/zsh");
  const before = new Set(Object.keys(state.workspaces));
  applyAction(state, {
    type: "workspace.create",
    target: { kind: "ssh", targetId: "target_1" },
    cwd: "/srv/app",
    name: "remote"
  });
  const workspaceId = Object.keys(state.workspaces).find(
    (id) => !before.has(id)
  )!;
  const paneId = state.workspaces[workspaceId].activePaneId;
  const initialSurfaceId = state.panes[paneId].activeSurfaceId;
  return {
    state,
    workspaceId,
    paneId,
    initialSessionId: state.surfaces[initialSurfaceId].content.sessionId
  };
}

function binding(): RemoteTargetBinding {
  return {
    id: "target_1",
    authority: {
      remoteInstallationId: "11111111-1111-4111-8111-111111111111",
      executionNodeId: "22222222-2222-4222-8222-222222222222",
      authenticatedPrincipal: { uid: 1000, accountName: "kmux" }
    },
    locator: {
      profileId: "profile_1",
      effectiveConnectionPolicyHash: "a".repeat(64),
      lastVerifiedAt: "2026-07-17T00:00:00.000Z"
    },
    firstVerifiedAt: "2026-07-17T00:00:00.000Z"
  };
}

function normalStorageStatus() {
  return {
    state: "normal" as const,
    journalAdmitted: uint64(1n),
    journalSynced: uint64(1n),
    emergencyBytes: 0
  };
}

function normalStorageStatusDto() {
  return {
    state: "normal" as const,
    journalAdmitted: "1",
    journalSynced: "1",
    emergencyBytes: 0
  };
}

function connection() {
  return {
    desktopInstallationId: "desktop_1",
    targetId: "target_1",
    connectionAttemptId: "attempt_1",
    effectiveConnectionPolicyHash: "a".repeat(64),
    sshPath: "/usr/bin/ssh",
    configPath: "/tmp/ssh_config",
    host: "target-alias",
    roots: {
      installRoot: "/home/kmux/.local/share/kmux",
      authorityRoot: "/home/kmux/.local/state/kmux/authority",
      stateRoot: "/home/kmux/.local/state/kmux",
      runtimeRoot: "/home/kmux/.local/run/kmux"
    },
    token: "b".repeat(64)
  };
}

interface ScriptedKeeper {
  resourceKey: {
    desktopInstallationId: string;
    targetId: string;
    workspaceId: string;
    sessionId: string;
  };
  keeperGeneration: string;
  remoteResourceRevision: string;
  descriptorState?: "running" | "exited" | "terminated";
  processState?: "running" | "exited";
  exitCode?: number;
  createOperationId?: string;
  canonicalCreatePayloadHash?: string;
  lastOperationId?: string;
  lastOperationPayloadHash?: string;
  lastResultDigest?: string;
}

class ScriptedUtilityProcess extends EventEmitter {
  readonly messages: Array<Record<string, unknown>> = [];
  acknowledgedThrough = 0n;
  private exited = false;

  constructor(
    private readonly keepers: Map<string, ScriptedKeeper>,
    private readonly handshake = hello(),
    private readonly failObserve = false,
    private readonly events: RemoteSpoolEventDto[] = []
  ) {
    super();
  }

  postMessage(value: unknown): void {
    const message = value as Record<string, unknown>;
    this.messages.push(message);
    queueMicrotask(() => this.respond(message));
  }

  kill(): boolean {
    this.crash();
    return true;
  }

  crash(): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", 1);
  }

  private respond(message: Record<string, unknown>): void {
    if (this.exited) return;
    const requestId = message.requestId as string;
    switch (message.type) {
      case "target.verify": {
        const roots = message.rootOverrides as ReturnType<
          typeof connection
        >["roots"];
        const generation = `1+${"c".repeat(64)}`;
        this.ok(requestId, {
          type: "target.verified",
          verificationId: message.verificationId,
          effectiveConnectionPolicyHash: message.effectiveConnectionPolicyHash,
          generation,
          runtimePath: `${roots.installRoot}/bin/${generation}/kmuxd`,
          remoteHome: "/home/kmux",
          roots,
          doctor: {
            ...this.handshake.authority,
            platform: this.handshake.platform,
            arch: this.handshake.arch,
            abi: this.handshake.abi,
            ...roots
          }
        });
        return;
      }
      case "target.promote":
        this.ok(requestId, {
          type: "target.ready",
          targetId: message.targetId,
          hello: this.handshake
        });
        return;
      case "target.verification-discard":
        this.ok(requestId, {
          type: "target.verification-discarded",
          verificationId: message.verificationId
        });
        return;
      case "target.observe":
        if (this.failObserve) {
          this.error(
            requestId,
            "observe-failed",
            "injected observation failure"
          );
          return;
        }
        this.ok(requestId, {
          type: "target.observed",
          targetId: message.targetId,
          observed: {
            type: "observed",
            targetId: message.targetId,
            bridgeGeneration: "bridge_1",
            observedAt: "2026-07-17T00:00:01.000Z",
            keepers: [...this.keepers.values()].map((keeper) => ({
              resourceKey: keeper.resourceKey,
              keeperGeneration: keeper.keeperGeneration,
              descriptorState:
                keeper.descriptorState ??
                (keeper.processState === "exited" ? "exited" : "running"),
              processState: keeper.processState ?? "running",
              remoteResourceRevision: keeper.remoteResourceRevision,
              ...(keeper.exitCode === undefined
                ? {}
                : { exitCode: keeper.exitCode }),
              createOperationId:
                keeper.createOperationId ??
                `create_${keeper.resourceKey.sessionId}`,
              canonicalCreatePayloadHash:
                keeper.canonicalCreatePayloadHash ?? "a".repeat(64),
              lastOperationId:
                keeper.lastOperationId ??
                `last_${keeper.resourceKey.sessionId}`,
              lastOperationPayloadHash:
                keeper.lastOperationPayloadHash ?? "b".repeat(64),
              lastResultDigest: keeper.lastResultDigest ?? "c".repeat(64),
              launch: { cwd: "/srv/app" },
              lifecycleState: "committed",
              everGrantedWriterLease: false,
              checkpointAvailable: false,
              retainedRangeTruncated: false,
              storageStatus: normalStorageStatusDto()
            }))
          }
        });
        return;
      case "operation.execute": {
        const intent = message.intent as {
          operationId: string;
          resourceKey: ScriptedKeeper["resourceKey"];
          nextRemoteResourceRevision: string;
          canonicalPayloadHash: string;
        };
        const payload = message.payload as { kind: string; sessionId?: string };
        const existingKeeper = payload.sessionId
          ? this.keepers.get(payload.sessionId)
          : undefined;
        const keeperGeneration =
          payload.sessionId &&
          (payload.kind === "session.create" ||
            payload.kind === "session.restart" ||
            payload.kind === "session.adopt")
            ? `keeper_${payload.sessionId}`
            : payload.kind === "launch-input"
              ? existingKeeper?.keeperGeneration
              : undefined;
        if (payload.kind === "session.terminate" && payload.sessionId) {
          const existing = this.keepers.get(payload.sessionId);
          if (existing) {
            this.keepers.set(payload.sessionId, {
              ...existing,
              descriptorState: "terminated",
              processState: "exited",
              exitCode: 0,
              remoteResourceRevision: intent.nextRemoteResourceRevision,
              lastOperationId: intent.operationId,
              lastOperationPayloadHash: intent.canonicalPayloadHash,
              lastResultDigest: "f".repeat(64)
            });
          }
        } else if (
          payload.kind === "launch-input" &&
          payload.sessionId &&
          existingKeeper
        ) {
          this.keepers.set(payload.sessionId, {
            ...existingKeeper,
            remoteResourceRevision: intent.nextRemoteResourceRevision,
            lastOperationId: intent.operationId,
            lastOperationPayloadHash: intent.canonicalPayloadHash,
            lastResultDigest: "f".repeat(64)
          });
        } else if (payload.sessionId && keeperGeneration) {
          this.keepers.set(payload.sessionId, {
            resourceKey: {
              ...intent.resourceKey,
              sessionId: payload.sessionId
            },
            keeperGeneration,
            remoteResourceRevision: intent.nextRemoteResourceRevision,
            createOperationId:
              payload.kind === "session.create"
                ? intent.operationId
                : (existingKeeper?.createOperationId ??
                  `create_${payload.sessionId}`),
            canonicalCreatePayloadHash:
              payload.kind === "session.create"
                ? intent.canonicalPayloadHash
                : (existingKeeper?.canonicalCreatePayloadHash ??
                  "a".repeat(64)),
            lastOperationId: intent.operationId,
            lastOperationPayloadHash: intent.canonicalPayloadHash,
            lastResultDigest: "f".repeat(64)
          });
        }
        this.ok(requestId, {
          type: "operation.result",
          targetId: message.targetId,
          outcome: {
            status: "succeeded",
            operationId: intent.operationId,
            remoteResourceRevision: BigInt(intent.nextRemoteResourceRevision),
            resultDigest: "f".repeat(64),
            ...(keeperGeneration === undefined ? {} : { keeperGeneration })
          }
        });
        return;
      }
      case "events.replay": {
        const afterSequence = BigInt(message.afterSequence as string);
        const events = this.events.filter(
          (event) => BigInt(event.sequence) > afterSequence
        );
        this.ok(requestId, {
          type: "events.replayed",
          targetId: message.targetId,
          replay: {
            targetId: message.targetId,
            events,
            acknowledgedThrough: uint64(this.acknowledgedThrough),
            hasMore: false,
            admittedCount: uint64(BigInt(this.events.length)),
            droppedLowValueCount: uint64(0n)
          }
        });
        return;
      }
      case "events.ack":
        this.acknowledgedThrough = BigInt(message.throughSequence as string);
        this.ok(requestId, {
          type: "events.acknowledged",
          targetId: message.targetId,
          acknowledgedThrough: uint64(this.acknowledgedThrough)
        });
        return;
      case "target.runtime-clean":
        this.ok(requestId, {
          type: "target.runtime-cleaned",
          targetId: message.targetId,
          report: {
            inspected: 1,
            removed: [],
            live: [],
            incompleteOrCorrupt: []
          }
        });
        return;
      case "target.runtime-reset":
        this.ok(requestId, {
          type: "target.runtime-reset",
          targetId: message.targetId,
          report: {
            generation: `1+${"c".repeat(64)}`,
            status: "reset"
          }
        });
        return;
      case "target.disconnect":
        this.ok(requestId, {
          type: "target.disconnected",
          targetId: message.targetId
        });
        return;
      case "shutdown":
        this.ok(requestId, { type: "shutdown.complete" });
        queueMicrotask(() => {
          if (!this.exited) {
            this.exited = true;
            this.emit("exit", 0);
          }
        });
        return;
    }
  }

  private ok(requestId: string, body: unknown): void {
    this.emit("message", {
      type: "response",
      requestId,
      status: "ok",
      body
    });
  }

  private error(requestId: string, code: string, message: string): void {
    this.emit("message", {
      type: "response",
      requestId,
      status: "error",
      error: { code, message, retryable: true }
    });
  }
}

function hello(authority: Partial<ReturnType<typeof baseAuthority>> = {}) {
  return {
    type: "hello",
    protocolVersion: 1,
    runtimeVersion: "0.1.0",
    bridgeGeneration: "bridge_1",
    capabilities: ["terminal-v1"],
    authority: { ...baseAuthority(), ...authority },
    platform: "linux",
    arch: "x86_64",
    abi: "musl",
    persistenceLevel: "ssh-disconnect"
  } as const;
}

function baseAuthority() {
  return {
    remoteInstallationId: "11111111-1111-4111-8111-111111111111",
    executionNodeId: "22222222-2222-4222-8222-222222222222",
    authenticatedPrincipal: { uid: 1000, accountName: "kmux" }
  };
}

function remoteNotificationEvent(options: {
  resourceKey: RemoteSpoolEventDto["resourceKey"] & { sessionId: string };
  surfaceId: string;
  keeperGeneration: string;
}): RemoteSpoolEventDto {
  return {
    version: 1,
    sequence: "1",
    eventId: "event_1",
    kind: "notification",
    name: "finished",
    resourceKey: options.resourceKey,
    surfaceId: options.surfaceId,
    keeperGeneration: options.keeperGeneration,
    createdAtUnixMs: "1",
    payload: { title: "Done", message: "Ready" }
  };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition did not become true");
}
