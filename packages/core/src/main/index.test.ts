import { createHash } from "node:crypto";

import {
  applyAction,
  canonicalizeRemoteOperationPayload,
  cloneState,
  createInitialState,
  encodeLocatedPathDto,
  type AppState,
  type RemoteOperationIntent,
  type RemoteOperationPayloadDto
} from "../index";
import { uint64 } from "@kmux/proto";

import {
  MainFactConflictError,
  applyMainRemoteOperationCheckpointFact,
  applyMainRemoteOperationFact,
  applyMainRemoteSessionCursorFact,
  applyMainRemoteSessionObservationFact,
  applySshWorkspaceAdditionPatch,
  applySshWorkspaceReplacementPatch,
  computeWorkspaceRevision,
  createSshWorkspaceAdditionPatch,
  createSshWorkspaceReplacementPatch,
  createRemoteOperationPendingFact,
  decodeSshWorkspaceReplacementPatch,
  decodeMainRemoteOperationFact,
  encodeMainRemoteOperationFact
} from "./index";

describe("Main-only SSH workspace replacement patch", () => {
  it("preserves only conversion-whitelisted product fields and applies idempotently", () => {
    const state = createInitialState("/bin/zsh");
    const workspaceId = Object.keys(state.workspaces)[0]!;
    const workspace = state.workspaces[workspaceId];
    workspace.name = "hand-named project";
    workspace.nameLocked = true;
    workspace.pinned = true;
    workspace.ports = [3000];
    workspace.statusText = "busy";
    workspace.logs = [
      {
        id: "log_1",
        level: "info",
        message: "old",
        createdAt: "2026-07-18T00:00:00.000Z"
      }
    ];
    applyAction(state, {
      type: "pane.split",
      paneId: workspace.activePaneId,
      direction: "right"
    });
    const sourceSessionIds = Object.values(state.sessions)
      .map((session) => session.id)
      .sort();
    const sourceRevision = computeWorkspaceRevision(state, workspaceId);

    const patch = createSshWorkspaceReplacementPatch(state, {
      workspaceId,
      targetId: "target_1",
      connectionName: "devbox",
      defaultCwd: "/srv/project",
      paneId: "pane_converted",
      nodeId: "node_converted",
      surfaceId: "surface_converted",
      sessionId: "session_converted",
      authToken: "auth_converted",
      keeperGeneration: "keeper_converted",
      remoteResourceRevision: uint64(1n),
      launch: { cwd: "/srv/project" }
    });

    expect(computeWorkspaceRevision(state, workspaceId)).toBe(sourceRevision);
    expect(patch.sourceSessionIds).toEqual(sourceSessionIds);
    expect(applySshWorkspaceReplacementPatch(state, patch).applied).toBe(true);
    expect(state.workspaces[workspaceId]).toMatchObject({
      id: workspaceId,
      windowId: workspace.windowId,
      name: "hand-named project",
      nameLocked: true,
      pinned: true,
      location: { target: { kind: "ssh", targetId: "target_1" } },
      activePaneId: "pane_converted",
      ports: [],
      statusEntries: {},
      logs: []
    });
    expect(state.workspaces[workspaceId].worktree).toBeUndefined();
    expect(state.workspaces[workspaceId].detectedWorktree).toBeUndefined();
    expect(state.workspaces[workspaceId].statusText).toBeUndefined();
    expect(Object.keys(state.panes)).toEqual(["pane_converted"]);
    expect(Object.keys(state.surfaces)).toEqual(["surface_converted"]);
    expect(Object.keys(state.sessions)).toEqual(["session_converted"]);
    expect(state.sessions.session_converted).toMatchObject({
      remoteRuntime: {
        keeperGeneration: "keeper_converted",
        remoteResourceRevision: 1n
      },
      runtimeStatus: {
        processState: "running",
        observationState: "observed",
        attachmentState: "detached"
      }
    });
    expect(state.sessions.session_converted.launch.shell).toBeUndefined();
    expect(state.sessions.session_converted.shellInputReady).toBe(true);
    expect(
      encodeLocatedPathDto(state.sessions.session_converted.launch.cwd)
    ).toEqual({
      kind: "ssh",
      targetId: "target_1",
      path: "/srv/project"
    });
    expect(computeWorkspaceRevision(state, workspaceId)).toBe(
      patch.replacementWorkspaceRevision
    );
    expect(applySshWorkspaceReplacementPatch(state, patch).applied).toBe(false);
  });

  it("rejects a stale or identity-tampered replacement without partial mutation", () => {
    const state = createInitialState("/bin/zsh");
    const workspaceId = Object.keys(state.workspaces)[0]!;
    const patch = createSshWorkspaceReplacementPatch(state, {
      workspaceId,
      targetId: "target_1",
      connectionName: "devbox",
      defaultCwd: "/srv/project",
      paneId: "pane_converted",
      nodeId: "node_converted",
      surfaceId: "surface_converted",
      sessionId: "session_converted",
      authToken: "auth_converted",
      keeperGeneration: "keeper_converted",
      remoteResourceRevision: uint64(1n),
      launch: { cwd: "/srv/project" }
    });
    state.workspaces[workspaceId].name = "changed after prepare";
    const before = cloneState(state);

    expectConflict(
      () => applySshWorkspaceReplacementPatch(state, patch),
      "workspace-revision-conflict"
    );
    expect(state).toEqual(before);
    expect(() =>
      decodeSshWorkspaceReplacementPatch({
        ...patch,
        surface: { ...patch.surface, paneId: "pane_other" }
      })
    ).toThrow(/identities/u);
  });
});

describe("Main-only SSH workspace addition patch", () => {
  it("adds one ordinary remote surface without changing the source workspace", () => {
    const state = createInitialState("/bin/zsh");
    const sourceWorkspaceId = Object.keys(state.workspaces)[0]!;
    const sourceBefore = cloneState(state).workspaces[sourceWorkspaceId];
    const patch = createSshWorkspaceAdditionPatch(state, {
      sourceWorkspaceId,
      workspaceId: "workspace_remote",
      targetId: "target_1",
      connectionName: "devbox",
      defaultCwd: "/srv/project",
      paneId: "pane_remote",
      nodeId: "node_remote",
      surfaceId: "surface_remote",
      sessionId: "session_remote",
      authToken: "auth_remote",
      keeperGeneration: "keeper_remote",
      remoteResourceRevision: uint64(1n),
      launch: { cwd: "/srv/project" }
    });

    expect(applySshWorkspaceAdditionPatch(state, patch).applied).toBe(true);
    expect(state.workspaces[sourceWorkspaceId]).toEqual(sourceBefore);
    expect(state.workspaces.workspace_remote).toMatchObject({
      name: "SSH: devbox",
      location: { target: { kind: "ssh", targetId: "target_1" } },
      activePaneId: "pane_remote"
    });
    expect(state.sessions.session_remote).toMatchObject({
      surfaceId: "surface_remote",
      remoteRuntime: {
        keeperGeneration: "keeper_remote",
        remoteResourceRevision: 1n
      }
    });
    expect(state.sessions.session_remote.launch.shell).toBeUndefined();
    expect(state.sessions.session_remote.shellInputReady).toBe(true);
    expect(
      encodeLocatedPathDto(state.sessions.session_remote.launch.cwd)
    ).toEqual({
      kind: "ssh",
      targetId: "target_1",
      path: "/srv/project"
    });
    const window = state.windows[state.activeWindowId];
    expect(window.workspaceOrder.at(-1)).toBe("workspace_remote");
    expect(window.activeWorkspaceId).toBe("workspace_remote");
    expect(applySshWorkspaceAdditionPatch(state, patch).applied).toBe(false);
  });

  it("rejects creation when the source changes before the decision applies", () => {
    const state = createInitialState("/bin/zsh");
    const sourceWorkspaceId = Object.keys(state.workspaces)[0]!;
    const patch = createSshWorkspaceAdditionPatch(state, {
      sourceWorkspaceId,
      workspaceId: "workspace_remote",
      targetId: "target_1",
      connectionName: "devbox",
      defaultCwd: "/srv/project",
      paneId: "pane_remote",
      nodeId: "node_remote",
      surfaceId: "surface_remote",
      sessionId: "session_remote",
      authToken: "auth_remote",
      keeperGeneration: "keeper_remote",
      remoteResourceRevision: uint64(1n),
      launch: { cwd: "/srv/project" }
    });
    state.workspaces[sourceWorkspaceId].name = "changed";
    const before = cloneState(state);

    expectConflict(
      () => applySshWorkspaceAdditionPatch(state, patch),
      "workspace-revision-conflict"
    );
    expect(state).toEqual(before);
  });
});

describe("Main-only remote operation facts", () => {
  it("projects the exact pending session product and binds the authoritative keeper", () => {
    const { state, workspaceId } = createRemoteState();
    const paneId = state.workspaces[workspaceId].activePaneId;
    const payload = {
      kind: "session.create" as const,
      sessionId: "session_created",
      surfaceId: "surface_created",
      paneId,
      launch: {
        cwd: "/srv/created",
        shell: "/bin/sh",
        title: "remote agent"
      }
    };
    const intent = createIntent(state, workspaceId, payload, 0n, "create_1");
    const pending = createRemoteOperationPendingFact(
      state,
      intent,
      payload,
      "codex resume remote-session\r"
    );

    applyMainRemoteOperationFact(state, pending);
    expect(state.sessions[payload.sessionId]).toMatchObject({
      surfaceId: payload.surfaceId,
      authToken:
        pending.projection.pendingProduct?.kind === "session.create"
          ? pending.projection.pendingProduct.product.authToken
          : undefined,
      runtimeStatus: {
        processState: "pending",
        observationState: "unknown",
        attachmentState: "detached"
      },
      launch: { initialInput: "codex resume remote-session\r" }
    });
    expect(state.surfaces[payload.surfaceId]).toMatchObject({
      paneId,
      title: "remote agent"
    });
    expect(
      decodeMainRemoteOperationFact(encodeMainRemoteOperationFact(pending))
    ).toEqual(pending);

    expect(() =>
      applyMainRemoteOperationFact(state, {
        type: "remote-operation.succeeded",
        operationId: intent.operationId,
        remoteResourceRevision: uint64(1n),
        resultDigest: "d".repeat(64),
        completedAt: "2026-07-17T00:00:01.000Z"
      })
    ).toThrow(/keeper generation/);
    expect(state.remoteOperations[intent.operationId].state).toBe("pending");

    applyMainRemoteOperationFact(state, {
      type: "remote-operation.succeeded",
      operationId: intent.operationId,
      remoteResourceRevision: uint64(1n),
      resultDigest: "d".repeat(64),
      completedAt: "2026-07-17T00:00:01.000Z",
      keeperGeneration: "keeper_created"
    });
    expect(state.sessions[payload.sessionId]).toMatchObject({
      runtimeStatus: {
        processState: "running",
        observationState: "observed",
        attachmentState: "detached"
      },
      remoteRuntime: {
        keeperGeneration: "keeper_created",
        remoteResourceRevision: 1n
      },
      shellInputReady: true
    });

    const resourceKey = intent.resourceKey as typeof intent.resourceKey & {
      sessionId: string;
    };
    expect(
      applyMainRemoteSessionCursorFact(state, {
        type: "remote-session.cursor",
        resourceKey,
        keeperGeneration: "keeper_created",
        sequence: uint64(7n)
      }).applied
    ).toBe(true);
    expect(
      applyMainRemoteSessionCursorFact(state, {
        type: "remote-session.cursor",
        resourceKey,
        keeperGeneration: "keeper_created",
        sequence: uint64(6n)
      }).applied
    ).toBe(false);
    expectConflict(
      () =>
        applyMainRemoteSessionCursorFact(state, {
          type: "remote-session.cursor",
          resourceKey,
          keeperGeneration: "keeper_stale",
          sequence: uint64(8n)
        }),
      "remote-revision-conflict"
    );

    const launchPayload = {
      kind: "launch-input" as const,
      sessionId: payload.sessionId,
      input: "echo ready\n"
    };
    const launchIntent = createIntent(
      state,
      workspaceId,
      launchPayload,
      1n,
      "launch_1"
    );
    applyMainRemoteOperationFact(
      state,
      createRemoteOperationPendingFact(state, launchIntent, launchPayload)
    );
    applyMainRemoteOperationFact(state, {
      type: "remote-operation.succeeded",
      operationId: launchIntent.operationId,
      remoteResourceRevision: uint64(2n),
      resultDigest: "f".repeat(64),
      completedAt: "2026-07-17T00:00:02.000Z",
      keeperGeneration: "keeper_created"
    });
    expect(state.sessions[payload.sessionId].remoteRuntime).toEqual({
      keeperGeneration: "keeper_created",
      remoteResourceRevision: 2n,
      lastAcknowledgedMutationSequence: 7n
    });
  });

  it("rolls back an exact pending split when creation authoritatively fails", () => {
    const { state, workspaceId } = createRemoteState();
    const workspace = state.workspaces[workspaceId];
    const paneId = workspace.activePaneId;
    const priorRoot = workspace.rootNodeId;
    const priorPaneCount = Object.values(state.panes).filter(
      (pane) => pane.workspaceId === workspaceId
    ).length;
    const payload = {
      kind: "session.create" as const,
      sessionId: "session_split",
      surfaceId: "surface_split",
      paneId,
      direction: "right" as const,
      launch: { cwd: "/srv/split" }
    };
    const intent = createIntent(state, workspaceId, payload, 0n, "split_1");
    const pending = createRemoteOperationPendingFact(state, intent, payload);
    applyMainRemoteOperationFact(state, pending);
    const product = pending.projection.pendingProduct;
    expect(product?.kind).toBe("session.create");
    if (product?.kind !== "session.create") throw new Error("missing product");
    expect(workspace.activePaneId).toBe(product.product.projectedPaneId);
    expect(workspace.rootNodeId).not.toBe(priorRoot);
    expect(computeWorkspaceRevision(state, workspaceId)).toMatch(
      /^[a-f0-9]{64}$/
    );

    applyMainRemoteOperationFact(state, {
      type: "remote-operation.failed",
      operationId: intent.operationId,
      resultDigest: "e".repeat(64),
      code: "spawn-failed",
      message: "shell did not start",
      completedAt: "2026-07-17T00:00:01.000Z"
    });
    expect(state.sessions[payload.sessionId]).toBeUndefined();
    expect(state.surfaces[payload.surfaceId]).toBeUndefined();
    expect(state.panes[product.product.projectedPaneId]).toBeUndefined();
    expect(workspace.rootNodeId).toBe(priorRoot);
    expect(workspace.activePaneId).toBe(paneId);
    expect(
      Object.values(state.panes).filter(
        (pane) => pane.workspaceId === workspaceId
      )
    ).toHaveLength(priorPaneCount);
  });

  it("creates retained-session product ownership only after verified adoption", () => {
    const { state, workspaceId } = createRemoteState();
    const workspace = state.workspaces[workspaceId];
    const pane = state.panes[workspace.activePaneId];
    const previousSurfaceId = pane.activeSurfaceId;
    const payload = {
      kind: "session.adopt" as const,
      sessionId: "session_retained",
      surfaceId: "surface_adopted",
      paneId: pane.id,
      launch: {
        cwd: "/srv/retained",
        shell: "/bin/sh",
        title: "retained agent"
      }
    };
    const intent = createIntent(state, workspaceId, payload, 4n, "adopt_1");
    const pending = createRemoteOperationPendingFact(state, intent, payload);

    applyMainRemoteOperationFact(state, pending);
    expect(pending.projection.pendingProduct).toMatchObject({
      kind: "session.adopt",
      product: {
        projectedPaneId: pane.id,
        previousActiveSurfaceId: previousSurfaceId
      }
    });
    expect(state.sessions[payload.sessionId]).toBeUndefined();
    expect(state.surfaces[payload.surfaceId]).toBeUndefined();
    expect(pane).toMatchObject({
      surfaceIds: [previousSurfaceId],
      activeSurfaceId: previousSurfaceId
    });
    expect(
      decodeMainRemoteOperationFact(encodeMainRemoteOperationFact(pending))
    ).toEqual(pending);

    applyMainRemoteOperationFact(state, {
      type: "remote-operation.succeeded",
      operationId: intent.operationId,
      remoteResourceRevision: uint64(5n),
      resultDigest: "a".repeat(64),
      completedAt: "2026-07-17T00:00:01.000Z",
      keeperGeneration: "keeper_retained"
    });
    expect(state.sessions[payload.sessionId]).toMatchObject({
      surfaceId: payload.surfaceId,
      authToken: expect.stringMatching(/^auth_[a-f0-9]{32}$/),
      launch: {
        shell: "/bin/sh",
        title: "retained agent"
      }
    });
    expect(
      encodeLocatedPathDto(state.sessions[payload.sessionId].launch.cwd)
    ).toEqual({
      kind: "ssh",
      targetId: "target_1",
      path: "/srv/retained"
    });
    expect(pane).toMatchObject({
      surfaceIds: [previousSurfaceId, payload.surfaceId],
      activeSurfaceId: payload.surfaceId
    });
    expect(state.sessions[payload.sessionId]).toMatchObject({
      runtimeStatus: {
        processState: "running",
        observationState: "observed",
        attachmentState: "detached"
      },
      remoteRuntime: {
        keeperGeneration: "keeper_retained",
        remoteResourceRevision: 5n
      }
    });
  });

  it("keeps layout unchanged when retained session adoption fails", () => {
    const { state, workspaceId } = createRemoteState();
    const workspace = state.workspaces[workspaceId];
    const pane = state.panes[workspace.activePaneId];
    const previousSurfaceId = pane.activeSurfaceId;
    const payload = {
      kind: "session.adopt" as const,
      sessionId: "session_retained_failed",
      surfaceId: "surface_adopted_failed",
      paneId: pane.id,
      launch: { cwd: "/srv/retained" }
    };
    const intent = createIntent(
      state,
      workspaceId,
      payload,
      4n,
      "adopt_failed_1"
    );
    applyMainRemoteOperationFact(
      state,
      createRemoteOperationPendingFact(state, intent, payload)
    );
    expect(state.sessions[payload.sessionId]).toBeUndefined();
    expect(state.surfaces[payload.surfaceId]).toBeUndefined();

    applyMainRemoteOperationFact(state, {
      type: "remote-operation.failed",
      operationId: intent.operationId,
      resultDigest: "b".repeat(64),
      code: "adopt-launch-mismatch",
      message: "retained session launch descriptor does not match",
      completedAt: "2026-07-17T00:00:01.000Z"
    });

    expect(state.sessions[payload.sessionId]).toBeUndefined();
    expect(state.surfaces[payload.surfaceId]).toBeUndefined();
    expect(pane).toMatchObject({
      surfaceIds: [previousSurfaceId],
      activeSurfaceId: previousSurfaceId
    });
    expect(workspace.activePaneId).toBe(pane.id);
    expect(state.remoteOperations[intent.operationId]).toMatchObject({
      state: "failed",
      failure: { code: "adopt-launch-mismatch" }
    });
  });

  it("durably projects exact worktree ownership and clears only the matching worktree", () => {
    const { state, workspaceId } = createRemoteState();
    const surfaceCount = Object.keys(state.surfaces).length;
    const worktree = {
      name: "app-remote",
      path: "/srv/worktrees/app-remote",
      repoRoot: "/srv/app",
      commonGitDir: "/srv/app/.git",
      baseRef: "main",
      branch: "kmux/app-remote",
      createdByKmux: true
    };
    const createPayload = {
      kind: "worktree.create" as const,
      workspaceId,
      cwd: "/srv/app",
      path: worktree.path,
      baseRef: worktree.baseRef,
      branch: worktree.branch
    };
    const createOperationIntent = createIntent(
      state,
      workspaceId,
      createPayload,
      0n,
      "worktree_create_1"
    );
    const createPending = createRemoteOperationPendingFact(
      state,
      createOperationIntent,
      createPayload,
      undefined,
      { kind: "worktree.create", worktree }
    );

    applyMainRemoteOperationFact(state, createPending);
    expect(state.workspaces[workspaceId].worktree).toBeUndefined();
    expect(
      decodeMainRemoteOperationFact(
        encodeMainRemoteOperationFact(createPending)
      )
    ).toEqual(createPending);

    applyMainRemoteOperationFact(state, {
      type: "remote-operation.succeeded",
      operationId: createOperationIntent.operationId,
      remoteResourceRevision: uint64(1n),
      resultDigest: "7".repeat(64),
      completedAt: "2026-07-17T00:00:01.000Z"
    });
    const stored = state.workspaces[workspaceId].worktree!;
    expect(stored).toMatchObject({
      name: worktree.name,
      baseRef: worktree.baseRef,
      branch: worktree.branch,
      createdByKmux: true
    });
    expect(encodeLocatedPathDto(stored.path)).toEqual({
      kind: "ssh",
      targetId: "target_1",
      path: worktree.path
    });
    expect(Object.keys(state.surfaces)).toHaveLength(surfaceCount);
    expect(state.workspaces[workspaceId].remoteResourceRevision).toBe(1n);

    const removePayload = {
      kind: "worktree.remove" as const,
      workspaceId,
      cwd: worktree.repoRoot,
      path: worktree.path,
      force: false,
      expectedBranch: worktree.branch,
      expectedCommonGitDir: worktree.commonGitDir
    };
    const removeIntent = createIntent(
      state,
      workspaceId,
      removePayload,
      1n,
      "worktree_remove_1"
    );
    applyMainRemoteOperationFact(
      state,
      createRemoteOperationPendingFact(
        state,
        removeIntent,
        removePayload,
        undefined,
        { kind: "worktree.remove", expectedWorktree: worktree }
      )
    );

    stored.branch = "changed-after-admission";
    expectConflict(
      () =>
        applyMainRemoteOperationFact(state, {
          type: "remote-operation.succeeded",
          operationId: removeIntent.operationId,
          remoteResourceRevision: uint64(2n),
          resultDigest: "8".repeat(64),
          completedAt: "2026-07-17T00:00:02.000Z"
        }),
      "workspace-revision-conflict"
    );
    stored.branch = worktree.branch;
    applyMainRemoteOperationFact(state, {
      type: "remote-operation.succeeded",
      operationId: removeIntent.operationId,
      remoteResourceRevision: uint64(2n),
      resultDigest: "8".repeat(64),
      completedAt: "2026-07-17T00:00:02.000Z"
    });
    expect(state.workspaces[workspaceId].worktree).toBeUndefined();
    expect(state.workspaces[workspaceId].remoteResourceRevision).toBe(2n);
    applyMainRemoteOperationCheckpointFact(state, {
      type: "remote-operation.checkpointed",
      operationId: createOperationIntent.operationId,
      resultDigest: "7".repeat(64)
    });
    applyMainRemoteOperationCheckpointFact(state, {
      type: "remote-operation.checkpointed",
      operationId: removeIntent.operationId,
      resultDigest: "8".repeat(64)
    });
    expect(state.remoteOperations).toEqual({});
  });

  it("projects a durably constructed pending fact and an authoritative result", () => {
    const { state, workspaceId, sessionId } = createRemoteState();
    const intent = createTerminateIntent(state, workspaceId, sessionId);
    const pending = createPendingTerminateFact(state, intent);

    expect(applyMainRemoteOperationFact(state, pending)).toMatchObject({
      applied: true,
      effects: [{ type: "persist" }]
    });
    expect(state.remoteOperations[intent.operationId]).toMatchObject({
      state: "termination-pending",
      resourceKey: { workspaceId, sessionId }
    });

    const success = {
      type: "remote-operation.succeeded" as const,
      operationId: intent.operationId,
      remoteResourceRevision: uint64(8n),
      resultDigest: "c".repeat(64),
      completedAt: "2026-07-17T00:00:01.000Z"
    };
    applyMainRemoteOperationFact(state, success);
    expect(state.remoteOperations[intent.operationId]).toMatchObject({
      state: "succeeded",
      resultDigest: "c".repeat(64)
    });

    expect(applyMainRemoteOperationFact(state, pending).applied).toBe(false);
    expect(applyMainRemoteOperationFact(state, success).applied).toBe(false);
    expect(cloneState(state)).toEqual(state);
  });

  it("removes a closed remote surface only after termination succeeds", () => {
    const { state, workspaceId } = createRemoteState();
    const paneId = state.workspaces[workspaceId].activePaneId;
    const retainedSurfaceId = state.panes[paneId].activeSurfaceId;
    applyAction(state, { type: "surface.create", paneId });
    const closingSurfaceId = state.panes[paneId].activeSurfaceId;
    const closingSessionId = state.surfaces[closingSurfaceId].content.sessionId;
    state.sessions[closingSessionId].remoteRuntime = {
      keeperGeneration: "keeper_closing",
      remoteResourceRevision: uint64(7n)
    };
    const intent = createTerminateIntent(state, workspaceId, closingSessionId);

    applyMainRemoteOperationFact(
      state,
      createRemoteOperationPendingFact(state, intent, {
        kind: "session.terminate",
        sessionId: closingSessionId
      })
    );
    expect(state.surfaces[closingSurfaceId]).toBeDefined();

    applyMainRemoteOperationFact(state, {
      type: "remote-operation.succeeded",
      operationId: intent.operationId,
      remoteResourceRevision: uint64(8n),
      resultDigest: "e".repeat(64),
      completedAt: "2026-07-17T00:00:01.000Z"
    });

    expect(state.surfaces[closingSurfaceId]).toBeUndefined();
    expect(state.sessions[closingSessionId]).toBeUndefined();
    expect(state.panes[paneId]).toMatchObject({
      surfaceIds: [retainedSurfaceId],
      activeSurfaceId: retainedSurfaceId
    });
  });

  it("rejects stale workspace facts, cross-target facts, and skipped revisions", () => {
    const { state, workspaceId, sessionId } = createRemoteState();
    const intent = createTerminateIntent(state, workspaceId, sessionId);
    applyAction(state, { type: "workspace.rename", workspaceId, name: "new" });

    expectConflict(
      () =>
        applyMainRemoteOperationFact(
          state,
          createPendingTerminateFact(state, intent)
        ),
      "workspace-revision-conflict"
    );

    const current = createTerminateIntent(state, workspaceId, sessionId);
    expectConflict(
      () =>
        applyMainRemoteOperationFact(state, {
          ...createPendingTerminateFact(state, current),
          projection: {
            ...createPendingTerminateFact(state, current).projection,
            resourceKey: {
              ...current.resourceKey,
              targetId: "target_other"
            }
          }
        }),
      "target-mismatch"
    );
    expectConflict(
      () =>
        applyMainRemoteOperationFact(state, {
          ...createPendingTerminateFact(state, current),
          projection: {
            ...createPendingTerminateFact(state, current).projection,
            nextRemoteResourceRevision: uint64(99n)
          }
        }),
      "remote-revision-conflict"
    );
  });

  it("keeps Main fact codecs outside AppAction and losslessly serializes bigint", () => {
    const { state, workspaceId, sessionId } = createRemoteState();
    const fact = createPendingTerminateFact(
      state,
      createTerminateIntent(state, workspaceId, sessionId)
    );
    const dto = encodeMainRemoteOperationFact(fact);

    expect(dto).toMatchObject({
      type: "remote-operation.pending",
      projection: {
        expectedRemoteResourceRevision: "7",
        nextRemoteResourceRevision: "8"
      }
    });
    expect(decodeMainRemoteOperationFact(dto)).toEqual(fact);
  });
});

describe("Main-only remote session observation facts", () => {
  it("marks observation unknown without inferring exit or removing ownership", () => {
    const { state, workspaceId, sessionId } = createRemoteState();
    const session = state.sessions[sessionId];
    session.runtimeStatus = {
      processState: "running",
      observationState: "observed",
      attachmentState: "failed"
    };
    const surfaceId = session.surfaceId;

    applyMainRemoteSessionObservationFact(state, {
      type: "remote-session.observation-unknown",
      resourceKey: {
        desktopInstallationId: "desktop_1",
        targetId: "target_1",
        workspaceId,
        sessionId
      }
    });

    expect(session.runtimeStatus).toEqual({
      processState: "running",
      observationState: "unknown",
      attachmentState: "failed"
    });
    expect(state.sessions[sessionId]).toBe(session);
    expect(state.surfaces[surfaceId]?.content.sessionId).toBe(sessionId);
    expect(state.workspaces[workspaceId]?.location.target).toEqual({
      kind: "ssh",
      targetId: "target_1"
    });
  });

  it("accepts authoritative liveness while rejecting cross-target observations", () => {
    const { state, workspaceId, sessionId } = createRemoteState();
    const resourceKey = {
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      workspaceId,
      sessionId
    };

    applyMainRemoteSessionObservationFact(state, {
      type: "remote-session.observed",
      resourceKey,
      processState: "exited",
      exitCode: 17,
      keeperGeneration: "keeper_1",
      remoteResourceRevision: uint64(1n),
      storageStatus: {
        state: "normal",
        journalAdmitted: uint64(1n),
        journalSynced: uint64(1n),
        emergencyBytes: 0
      },
      observedAt: "2026-07-17T00:00:01.000Z"
    });
    expect(state.sessions[sessionId]).toMatchObject({
      exitCode: 17,
      runtimeStatus: {
        processState: "exited",
        observationState: "observed"
      }
    });

    expectConflict(
      () =>
        applyMainRemoteSessionObservationFact(state, {
          type: "remote-session.observation-unknown",
          resourceKey: { ...resourceKey, targetId: "target_other" }
        }),
      "target-mismatch"
    );
  });

  it("projects authoritative remote liveness as input-ready without a local shell fallback", () => {
    const { state, workspaceId, sessionId } = createRemoteState();
    const session = state.sessions[sessionId];
    expect(session.launch.shell).toBeUndefined();
    session.shellInputReady = false;

    expect(
      applyMainRemoteSessionObservationFact(state, {
        type: "remote-session.observed",
        resourceKey: {
          desktopInstallationId: "desktop_1",
          targetId: "target_1",
          workspaceId,
          sessionId
        },
        processState: "running",
        keeperGeneration: "keeper_1",
        remoteResourceRevision: uint64(7n),
        storageStatus: {
          state: "normal",
          journalAdmitted: uint64(0n),
          journalSynced: uint64(0n),
          emergencyBytes: 0
        },
        observedAt: "2026-07-17T00:00:01.000Z"
      }).applied
    ).toBe(true);
    expect(session.shellInputReady).toBe(true);
  });
});

function createRemoteState(): {
  state: AppState;
  workspaceId: string;
  sessionId: string;
} {
  const state = createInitialState("/bin/zsh");
  const existing = new Set(Object.keys(state.workspaces));
  applyAction(state, {
    type: "workspace.create",
    target: { kind: "ssh", targetId: "target_1" },
    cwd: "/srv/app",
    name: "remote"
  });
  const workspaceId = Object.keys(state.workspaces).find(
    (id) => !existing.has(id)
  )!;
  const pane = state.panes[state.workspaces[workspaceId].activePaneId];
  const sessionId = state.surfaces[pane.activeSurfaceId].content.sessionId;
  return { state, workspaceId, sessionId };
}

function createTerminateIntent(
  state: AppState,
  workspaceId: string,
  sessionId: string
): RemoteOperationIntent {
  const payload: RemoteOperationPayloadDto = {
    kind: "session.terminate",
    sessionId
  };
  const canonical = canonicalizeRemoteOperationPayload(payload);
  return {
    operationId: "operation_1",
    kind: payload.kind,
    resourceKey: {
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      workspaceId,
      sessionId
    },
    expectedWorkspaceRevision: computeWorkspaceRevision(state, workspaceId),
    expectedRemoteResourceRevision: uint64(7n),
    nextRemoteResourceRevision: uint64(8n),
    canonicalPayloadHash: createHash("sha256")
      .update(canonical, "utf8")
      .digest("hex"),
    createdAt: "2026-07-17T00:00:00.000Z"
  };
}

function createIntent(
  state: AppState,
  workspaceId: string,
  payload: RemoteOperationPayloadDto,
  expectedRemoteRevision: bigint,
  operationId: string
): RemoteOperationIntent {
  const workspace = state.workspaces[workspaceId];
  if (workspace.location.target.kind !== "ssh") {
    throw new Error("test workspace is not remote");
  }
  const canonical = canonicalizeRemoteOperationPayload(payload);
  return {
    operationId,
    kind: payload.kind,
    resourceKey: {
      desktopInstallationId: "desktop_1",
      targetId: workspace.location.target.targetId,
      workspaceId,
      ...("sessionId" in payload ? { sessionId: payload.sessionId } : {})
    },
    expectedWorkspaceRevision: computeWorkspaceRevision(state, workspaceId),
    expectedRemoteResourceRevision: uint64(expectedRemoteRevision),
    nextRemoteResourceRevision: uint64(expectedRemoteRevision + 1n),
    ...(payload.kind === "workspace.create" || payload.kind === "session.create"
      ? { createOperationId: operationId }
      : {}),
    canonicalPayloadHash: createHash("sha256")
      .update(canonical, "utf8")
      .digest("hex"),
    createdAt: "2026-07-17T00:00:00.000Z"
  };
}

function createPendingTerminateFact(
  state: AppState,
  intent: RemoteOperationIntent
): ReturnType<typeof createRemoteOperationPendingFact> {
  return createRemoteOperationPendingFact(state, intent, {
    kind: "session.terminate",
    sessionId: intent.resourceKey.sessionId!
  });
}

function expectConflict(
  operation: () => unknown,
  code: MainFactConflictError["code"]
): void {
  try {
    operation();
    throw new Error("expected a Main fact conflict");
  } catch (error) {
    expect(error).toBeInstanceOf(MainFactConflictError);
    expect((error as MainFactConflictError).code).toBe(code);
  }
}
