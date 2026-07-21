import { requireTerminalSurfaceContent } from "@kmux/core";

import { applyAction, createInitialState, type AppState } from "@kmux/core";
import { applyMainRemoteSessionObservationFact } from "@kmux/core/main";
import { uint64 } from "@kmux/proto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRetainedSessionInventoryStore } from "./retainedSessionInventory";
import {
  createRemoteReconciler,
  type RemoteObservedState
} from "./remoteReconciler";

describe("RemoteReconciler observations", () => {
  it("keeps process and ownership intact when transport observation is unknown", () => {
    const fixture = createRemoteFixture();
    const session = fixture.state.sessions[fixture.sessionId];
    session.runtimeStatus = {
      processState: "running",
      observationState: "observed",
      attachmentState: "failed"
    };
    const sessionCount = Object.keys(fixture.state.sessions).length;
    const reconciler = createReconciler(fixture.state);

    reconciler.observe({
      targetId: "target_1",
      targetStatus: "offline",
      inventoryComplete: false,
      keepers: []
    });

    expect(session.runtimeStatus).toEqual({
      processState: "running",
      observationState: "unknown",
      attachmentState: "failed"
    });
    expect(Object.keys(fixture.state.sessions)).toHaveLength(sessionCount);
    expect(
      fixture.state.workspaces[fixture.workspaceId].location.target
    ).toEqual({ kind: "ssh", targetId: "target_1" });
  });

  it("does not infer absence from a partial ready inventory", () => {
    const fixture = createRemoteFixture();
    const session = fixture.state.sessions[fixture.sessionId];
    session.runtimeStatus = {
      processState: "running",
      observationState: "observed",
      attachmentState: "detached"
    };

    createReconciler(fixture.state).observe({
      targetId: "target_1",
      targetStatus: "ready",
      persistenceLevel: "ssh-disconnect",
      inventoryComplete: false,
      keepers: [],
      lastObservedAt: "2026-07-17T00:00:00.000Z"
    });

    expect(session.runtimeStatus.processState).toBe("running");
    expect(session.runtimeStatus.observationState).toBe("unknown");
  });

  it("applies only a complete authoritative inventory and never creates a replacement", () => {
    const fixture = createRemoteFixture();
    const beforeSessionIds = Object.keys(fixture.state.sessions);
    const reconciler = createReconciler(fixture.state);

    reconciler.observe(authoritativeInventory([]));

    expect(
      fixture.state.sessions[fixture.sessionId].runtimeStatus
    ).toMatchObject({
      processState: "exited",
      observationState: "observed"
    });
    expect(Object.keys(fixture.state.sessions)).toEqual(beforeSessionIds);
    expect(
      fixture.state.workspaces[fixture.workspaceId].location.target
    ).toEqual({ kind: "ssh", targetId: "target_1" });
  });

  it("observes a matching keeper and rejects a cross-authority snapshot before mutation", () => {
    const fixture = createRemoteFixture();
    const reconciler = createReconciler(fixture.state);
    const keeper = observedKeeper(fixture.workspaceId, fixture.sessionId);

    reconciler.observe(authoritativeInventory([keeper]));
    expect(
      fixture.state.sessions[fixture.sessionId].runtimeStatus
    ).toMatchObject({
      processState: "running",
      observationState: "observed"
    });

    fixture.state.sessions[fixture.sessionId].runtimeStatus.observationState =
      "unknown";
    expect(() =>
      reconciler.observe(
        authoritativeInventory([
          keeper,
          observedKeeper("retained_workspace", "retained_session", {
            desktopInstallationId: "desktop_other"
          })
        ])
      )
    ).toThrow(/outside the reconciler authority/);
    expect(
      fixture.state.sessions[fixture.sessionId].runtimeStatus.observationState
    ).toBe("unknown");
  });

  it("preflights every reducer fact before applying a multi-session snapshot", () => {
    const fixture = createRemoteFixture();
    const workspace = fixture.state.workspaces[fixture.workspaceId];
    applyAction(fixture.state, {
      type: "pane.split",
      paneId: workspace.activePaneId,
      direction: "right"
    });
    const sessionIds = Object.values(fixture.state.panes)
      .filter((pane) => pane.workspaceId === fixture.workspaceId)
      .map(
        (pane) =>
          requireTerminalSurfaceContent(
            fixture.state.surfaces[pane.activeSurfaceId]
          ).sessionId
      )
      .sort();
    const [firstSessionId, staleSessionId] = sessionIds;
    if (!firstSessionId || !staleSessionId) {
      throw new Error("two remote sessions were not created");
    }
    const firstSession = fixture.state.sessions[firstSessionId];
    const staleSession = fixture.state.sessions[staleSessionId];
    firstSession.runtimeStatus.observationState = "unknown";
    firstSession.remoteRuntime = {
      keeperGeneration: "generation_1",
      remoteResourceRevision: uint64(1n)
    };
    staleSession.runtimeStatus.observationState = "unknown";
    staleSession.remoteRuntime = {
      keeperGeneration: "generation_2",
      remoteResourceRevision: uint64(2n)
    };
    const reconciler = createReconciler(fixture.state);

    expect(() =>
      reconciler.observe(
        authoritativeInventory([
          observedKeeper(fixture.workspaceId, firstSessionId),
          {
            ...observedKeeper(fixture.workspaceId, staleSessionId),
            generation: "generation_2",
            remoteResourceRevision: uint64(1n)
          }
        ])
      )
    ).toThrow(/regressed its resource revision/);

    expect(firstSession.runtimeStatus.observationState).toBe("unknown");
    expect(staleSession.runtimeStatus.observationState).toBe("unknown");
    expect(reconciler.getObservedState("target_1")).toBeNull();
  });

  it("atomically retains cached descriptors for workspace close and restore-disabled shutdown", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-reconciler-retained-"));
    try {
      const fixture = createRemoteFixture();
      const inventory = createRetainedSessionInventoryStore(
        join(sandbox, "retained.json"),
        { now: () => "2026-07-18T00:00:01.000Z" }
      );
      const reconciler = createReconciler(fixture.state, inventory);
      const keeper = observedKeeper(fixture.workspaceId, fixture.sessionId);

      reconciler.observe(authoritativeInventory([keeper]));
      expect(reconciler.listRetainedSessions()).toEqual([]);

      expect(reconciler.retainOwnedForRestoreDisabled().retained).toMatchObject(
        [{ reason: "restore-disabled" }]
      );
      expect(reconciler.listRetainedSessions()).toMatchObject([
        { reason: "restore-disabled" }
      ]);

      // A later explicit close is a distinct lifecycle reason.
      inventory.cacheOwned(keeper, "2026-07-18T00:00:02.000Z");
      expect(
        reconciler.retainWorkspace(fixture.workspaceId, "workspace-close")
      ).toMatchObject([{ reason: "workspace-close" }]);
      applyAction(fixture.state, {
        type: "workspace.close",
        workspaceId: fixture.workspaceId
      });
      reconciler.observe(authoritativeInventory([keeper]));
      expect(reconciler.listRetainedSessions()).toMatchObject([
        { reason: "workspace-close", ownership: "retained" }
      ]);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("does not resurrect a checkpointed explicit termination as retained", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-reconciler-tombstone-"));
    try {
      const fixture = createRemoteFixture();
      const inventory = createRetainedSessionInventoryStore(
        join(sandbox, "retained.json")
      );
      const reconciler = createReconciler(fixture.state, inventory);
      const keeper = {
        ...observedKeeper(fixture.workspaceId, fixture.sessionId),
        descriptorState: "terminated" as const,
        processState: "exited" as const,
        exitCode: 0
      };
      applyAction(fixture.state, {
        type: "workspace.close",
        workspaceId: fixture.workspaceId
      });

      reconciler.observe(authoritativeInventory([keeper]));

      expect(reconciler.listRetainedSessions()).toEqual([]);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("keeps an offline termination retained until the matching durable tombstone is observed", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-reconciler-terminate-"));
    try {
      const fixture = createRemoteFixture();
      const inventory = createRetainedSessionInventoryStore(
        join(sandbox, "retained.json")
      );
      const reconciler = createReconciler(fixture.state, inventory);
      const keeper = observedKeeper(fixture.workspaceId, fixture.sessionId);
      const payloadHash = "d".repeat(64);
      fixture.state.remoteOperations.terminate_1 = {
        operationId: "terminate_1",
        kind: "session.terminate",
        resourceKey: keeper.resourceKey,
        expectedWorkspaceRevision: "f".repeat(64),
        expectedRemoteResourceRevision: uint64(1n),
        nextRemoteResourceRevision: uint64(2n),
        canonicalPayloadHash: payloadHash,
        pendingProduct: {
          kind: "session.terminate",
          sessionId: fixture.sessionId
        },
        state: "termination-pending",
        createdAt: "2026-07-18T00:00:00.000Z"
      };

      reconciler.observe(authoritativeInventory([keeper]));
      reconciler.observe({
        targetId: "target_1",
        targetStatus: "offline",
        inventoryComplete: false,
        keepers: []
      });
      expect(reconciler.listRetainedSessions()).toMatchObject([
        {
          reason: "termination-pending",
          termination: { operationId: "terminate_1" }
        }
      ]);

      Object.assign(fixture.state.remoteOperations.terminate_1, {
        state: "succeeded" as const,
        completedAt: "2026-07-18T00:00:02.000Z",
        resultDigest: "e".repeat(64)
      });
      reconciler.observe(
        authoritativeInventory([
          {
            ...keeper,
            processState: "exited",
            exitCode: 0,
            remoteResourceRevision: uint64(2n),
            descriptor: {
              ...keeper.descriptor!,
              lastOperationId: "terminate_1",
              lastOperationPayloadHash: payloadHash,
              lastResultDigest: "e".repeat(64)
            }
          }
        ])
      );
      expect(reconciler.listRetainedSessions()).toEqual([]);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("accepts an exact successful tombstone without requiring an intermediate pending observation", () => {
    const sandbox = mkdtempSync(
      join(tmpdir(), "kmux-reconciler-fast-terminate-")
    );
    try {
      const fixture = createRemoteFixture();
      const inventory = createRetainedSessionInventoryStore(
        join(sandbox, "retained.json")
      );
      const reconciler = createReconciler(fixture.state, inventory);
      const keeper = observedKeeper(fixture.workspaceId, fixture.sessionId);
      const payloadHash = "d".repeat(64);
      const resultDigest = "e".repeat(64);

      reconciler.observe(authoritativeInventory([keeper]));
      fixture.state.remoteOperations.terminate_1 = {
        operationId: "terminate_1",
        kind: "session.terminate",
        resourceKey: keeper.resourceKey,
        expectedWorkspaceRevision: "f".repeat(64),
        expectedRemoteResourceRevision: uint64(1n),
        nextRemoteResourceRevision: uint64(2n),
        canonicalPayloadHash: payloadHash,
        pendingProduct: {
          kind: "session.terminate",
          sessionId: fixture.sessionId
        },
        state: "succeeded",
        createdAt: "2026-07-18T00:00:00.000Z",
        completedAt: "2026-07-18T00:00:01.000Z",
        resultDigest
      };

      expect(() =>
        reconciler.observe(
          authoritativeInventory([
            {
              ...keeper,
              processState: "exited",
              exitCode: 0,
              remoteResourceRevision: uint64(2n),
              descriptor: {
                ...keeper.descriptor!,
                lastOperationId: "terminate_1",
                lastOperationPayloadHash: payloadHash,
                lastResultDigest: resultDigest
              }
            }
          ])
        )
      ).not.toThrow();
      expect(inventory.listRetained()).toEqual([]);

      fixture.state.sessions[fixture.sessionId].runtimeStatus = {
        processState: "running",
        observationState: "unknown",
        attachmentState: "detached"
      };
      fixture.state.sessions[fixture.sessionId].remoteRuntime = {
        keeperGeneration: "generation_2",
        remoteResourceRevision: uint64(3n)
      };
      expect(() =>
        reconciler.observe(
          authoritativeInventory([
            {
              ...keeper,
              generation: "generation_2",
              remoteResourceRevision: uint64(3n),
              descriptor: {
                ...keeper.descriptor!,
                lastOperationId: "restart_1",
                lastOperationPayloadHash: "1".repeat(64),
                lastResultDigest: "2".repeat(64)
              }
            }
          ])
        )
      ).not.toThrow();
      expect(inventory.loadAll()).toMatchObject([
        {
          ownership: "owned-cache",
          keeperGeneration: "generation_2",
          remoteResourceRevision: 3n,
          processState: "running"
        }
      ]);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

function createRemoteFixture(): {
  state: AppState;
  workspaceId: string;
  sessionId: string;
} {
  const state = createInitialState("/bin/zsh");
  const existing = new Set(Object.keys(state.workspaces));
  applyAction(state, {
    type: "workspace.create",
    target: { kind: "ssh", targetId: "target_1" },
    cwd: "/srv/app"
  });
  const workspaceId = Object.keys(state.workspaces).find(
    (id) => !existing.has(id)
  )!;
  const pane = state.panes[state.workspaces[workspaceId].activePaneId];
  const sessionId = requireTerminalSurfaceContent(
    state.surfaces[pane.activeSurfaceId]
  ).sessionId;
  return { state, workspaceId, sessionId };
}

function createReconciler(
  state: AppState,
  retainedInventory?: ReturnType<typeof createRetainedSessionInventoryStore>
) {
  return createRemoteReconciler({
    desktopInstallationId: "desktop_1",
    getState: () => state,
    dispatchFact: (fact) => {
      applyMainRemoteSessionObservationFact(state, fact);
    },
    ...(retainedInventory === undefined ? {} : { retainedInventory })
  });
}

function authoritativeInventory(
  keepers: RemoteObservedState["keepers"]
): RemoteObservedState {
  return {
    targetId: "target_1",
    targetStatus: "ready",
    persistenceLevel: "ssh-disconnect",
    inventoryComplete: true,
    bridgeGeneration: "bridge_1",
    keepers,
    lastObservedAt: "2026-07-17T00:00:00.000Z"
  };
}

function observedKeeper(
  workspaceId: string,
  sessionId: string,
  overrides: { desktopInstallationId?: string } = {}
): RemoteObservedState["keepers"][number] {
  return {
    resourceKey: {
      desktopInstallationId: overrides.desktopInstallationId ?? "desktop_1",
      targetId: "target_1",
      workspaceId,
      sessionId
    },
    generation: "generation_1",
    processState: "running",
    persistenceLevel: "ssh-disconnect",
    remoteResourceRevision: uint64(1n),
    storageStatus: {
      state: "normal",
      journalAdmitted: uint64(1n),
      journalSynced: uint64(1n),
      emergencyBytes: 0
    },
    checkpointAvailable: false,
    retainedRangeTruncated: false,
    descriptor: {
      createOperationId: `create_${sessionId}`,
      canonicalCreatePayloadHash: "a".repeat(64),
      lastOperationId: `create_${sessionId}`,
      lastOperationPayloadHash: "a".repeat(64),
      lastResultDigest: "b".repeat(64),
      launch: { cwd: "/srv/app", shell: "/bin/sh" },
      lifecycleState: "committed",
      everGrantedWriterLease: false
    }
  };
}
