import { createHash } from "node:crypto";

import {
  applyAction,
  decodeAppStateDto,
  encodeAppStateDto,
  type AppEffect,
  type AppMutationSummary,
  type AppState
} from "../index";
import {
  createRemotePendingProductProjection,
  decodeRemoteOperationProjectionDto,
  encodeRemoteOperationProjectionDto,
  type RemoteOperationIntent,
  type RemoteOperationPayloadDto,
  type RemotePendingProductProjection,
  type RemoteOperationProjection,
  type RemoteOperationProjectionDto,
  type RemoteWorktreeProductMetadata
} from "../remoteOperation";
import type { RemoteResourceKey, RemoteSessionStorageStatus } from "../domain";
import {
  locatedPathForTarget,
  sameLocatedPath,
  workspaceLocation
} from "../domain";
import {
  formatUint64Decimal,
  incrementUint64,
  parseUint64Decimal,
  type SplitDirection,
  type Id,
  type Uint64
} from "@kmux/proto";

export type MainRemoteOperationFact =
  | {
      type: "remote-operation.pending";
      projection: RemoteOperationProjection;
    }
  | {
      type: "remote-operation.succeeded";
      operationId: Id;
      remoteResourceRevision: Uint64;
      resultDigest: string;
      completedAt: string;
      keeperGeneration?: Id;
    }
  | {
      type: "remote-operation.failed";
      operationId: Id;
      resultDigest: string;
      code: string;
      message: string;
      completedAt: string;
    };

export type MainRemoteSessionObservationFact =
  | {
      type: "remote-session.observation-unknown";
      resourceKey: RemoteResourceKey & { sessionId: Id };
    }
  | {
      type: "remote-session.observed";
      resourceKey: RemoteResourceKey & { sessionId: Id };
      processState: "running" | "exited";
      observedAt: string;
      keeperGeneration: Id;
      remoteResourceRevision: Uint64;
      storageStatus: RemoteSessionStorageStatus;
      exitCode?: number;
    }
  | {
      type: "remote-session.absent";
      resourceKey: RemoteResourceKey & { sessionId: Id };
      observedAt: string;
      expectedKeeperGeneration?: Id;
      expectedRemoteResourceRevision?: Uint64;
    };

export type MainRemoteSessionCursorFact = {
  type: "remote-session.cursor";
  resourceKey: RemoteResourceKey & { sessionId: Id };
  keeperGeneration: Id;
  sequence: Uint64;
};

export type MainRemoteOperationCheckpointFact = {
  type: "remote-operation.checkpointed";
  operationId: Id;
  resultDigest: string;
};

export type MainFact =
  | MainRemoteOperationFact
  | MainRemoteOperationCheckpointFact
  | MainRemoteSessionObservationFact
  | MainRemoteSessionCursorFact;

export type MainRemoteOperationFactDto =
  | {
      type: "remote-operation.pending";
      projection: RemoteOperationProjectionDto;
    }
  | {
      type: "remote-operation.succeeded";
      operationId: Id;
      remoteResourceRevision: string;
      resultDigest: string;
      completedAt: string;
      keeperGeneration?: Id;
    }
  | {
      type: "remote-operation.failed";
      operationId: Id;
      resultDigest: string;
      code: string;
      message: string;
      completedAt: string;
    };

export interface ApplyMainFactResult {
  effects: AppEffect[];
  mutation: AppMutationSummary;
  applied: boolean;
}

export type MainFactConflictCode =
  | "workspace-missing"
  | "target-mismatch"
  | "workspace-revision-conflict"
  | "remote-revision-conflict"
  | "operation-id-conflict"
  | "operation-missing"
  | "operation-terminal";

export class MainFactConflictError extends Error {
  constructor(
    readonly code: MainFactConflictCode,
    message: string
  ) {
    super(message);
    this.name = "MainFactConflictError";
  }
}

export function createRemoteOperationPendingFact(
  state: AppState | undefined,
  intent: RemoteOperationIntent,
  payload: RemoteOperationPayloadDto,
  productInitialInput?: string,
  worktreeProduct?: RemoteWorktreeProductMetadata
): Extract<MainRemoteOperationFact, { type: "remote-operation.pending" }> {
  if (intent.kind !== payload.kind) {
    throw new TypeError("remote operation intent and pending payload differ");
  }
  const pendingProduct = createRemotePendingProductProjection(
    payload,
    payload.kind === "session.create" || payload.kind === "session.adopt"
      ? createSessionProductProjection(
          requirePendingProjectionState(state),
          intent,
          payload,
          productInitialInput
        )
      : productInitialInput === undefined
        ? undefined
        : invalidProductInitialInput(payload.kind),
    worktreeProduct
  );
  return {
    type: "remote-operation.pending",
    projection: {
      operationId: intent.operationId,
      kind: intent.kind,
      resourceKey: structuredClone(intent.resourceKey),
      expectedWorkspaceRevision: intent.expectedWorkspaceRevision,
      expectedRemoteResourceRevision: intent.expectedRemoteResourceRevision,
      nextRemoteResourceRevision: intent.nextRemoteResourceRevision,
      canonicalPayloadHash: intent.canonicalPayloadHash,
      ...(pendingProduct === undefined ? {} : { pendingProduct }),
      state:
        intent.kind === "session.terminate" ||
        intent.kind === "workspace.terminate"
          ? "termination-pending"
          : "pending",
      createdAt: intent.createdAt
    }
  };
}

function requirePendingProjectionState(state: AppState | undefined): AppState {
  if (!state) {
    throw new TypeError(
      "session ownership projection requires current product state"
    );
  }
  return state;
}

export function computeWorkspaceRevision(
  state: AppState,
  workspaceId: Id
): string {
  const workspace = state.workspaces[workspaceId];
  if (!workspace) {
    throw new MainFactConflictError(
      "workspace-missing",
      `workspace ${workspaceId} does not exist`
    );
  }
  const snapshot = encodeAppStateDto(state) as Record<string, unknown>;
  const panes = entriesForWorkspace(state, workspaceId, snapshot.panes);
  const paneIds = new Set(Object.keys(panes));
  const surfaces = filterRecord(snapshot.surfaces, (value) => {
    const paneId = readStringProperty(value, "paneId");
    return paneId !== undefined && paneIds.has(paneId);
  });
  const surfaceIds = new Set(Object.keys(surfaces));
  const sessions = filterRecord(snapshot.sessions, (value) => {
    const surfaceId = readStringProperty(value, "surfaceId");
    return surfaceId !== undefined && surfaceIds.has(surfaceId);
  });
  const remoteOperations = filterRecord(snapshot.remoteOperations, (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const resourceKey = (value as Record<string, unknown>).resourceKey;
    return readStringProperty(resourceKey, "workspaceId") === workspaceId;
  });
  const revisionSource = {
    workspace: readRecord(snapshot.workspaces)[workspaceId],
    panes,
    surfaces,
    sessions,
    remoteOperations
  };
  return createHash("sha256")
    .update(canonicalJson(revisionSource), "utf8")
    .digest("hex");
}

export interface SshWorkspaceReplacementPatchDto {
  version: 1;
  workspaceId: Id;
  expectedSourceWorkspaceRevision: string;
  replacementWorkspaceRevision: string;
  sourcePaneIds: Id[];
  sourceSurfaceIds: Id[];
  sourceSessionIds: Id[];
  notificationIdsToRemove: Id[];
  workspace: Record<string, unknown>;
  pane: Record<string, unknown>;
  surface: Record<string, unknown>;
  session: Record<string, unknown>;
}

export interface SshWorkspaceAdditionPatchDto {
  version: 1;
  sourceWorkspaceId: Id;
  workspaceId: Id;
  windowId: Id;
  expectedSourceWorkspaceRevision: string;
  expectedWindowWorkspaceOrder: Id[];
  resultingWindowWorkspaceOrder: Id[];
  replacementWorkspaceRevision: string;
  workspace: Record<string, unknown>;
  pane: Record<string, unknown>;
  surface: Record<string, unknown>;
  session: Record<string, unknown>;
}

export interface CreateSshWorkspaceReplacementPatchOptions {
  workspaceId: Id;
  targetId: Id;
  connectionName: string;
  defaultCwd: string;
  paneId: Id;
  nodeId: Id;
  surfaceId: Id;
  sessionId: Id;
  authToken: Id;
  keeperGeneration: Id;
  remoteResourceRevision: Uint64;
  launch: {
    cwd: string;
    shell?: string;
    args?: string[];
    env?: Record<string, string>;
    title?: string;
  };
}

export interface CreateSshWorkspaceAdditionPatchOptions extends Omit<
  CreateSshWorkspaceReplacementPatchOptions,
  "workspaceId"
> {
  sourceWorkspaceId: Id;
  workspaceId: Id;
}

/**
 * Builds the immutable workspace-scoped product patch used by conversion WAL.
 * It deliberately contains no local-process cleanup effect; WAL recovery owns
 * that post-commit boundary separately.
 */
export function createSshWorkspaceReplacementPatch(
  state: AppState,
  options: CreateSshWorkspaceReplacementPatchOptions
): SshWorkspaceReplacementPatchDto {
  const source = state.workspaces[options.workspaceId];
  if (!source) {
    throw new MainFactConflictError(
      "workspace-missing",
      `workspace ${options.workspaceId} does not exist`
    );
  }
  if (source.location.target.kind !== "local") {
    throw new MainFactConflictError(
      "target-mismatch",
      "workspace conversion requires a local source workspace"
    );
  }
  const connectionName = requireConversionText(
    options.connectionName,
    "connectionName",
    4 * 1024
  );
  const target = { kind: "ssh" as const, targetId: options.targetId };
  const cwd = locatedPathForTarget(target, options.launch.cwd);
  const workspaceName = source.nameLocked
    ? source.name
    : `SSH: ${connectionName}`;
  const title = options.launch.title?.trim() || workspaceName;
  const graph = workspaceGraphIds(state, source.id);
  const notificationIdsToRemove = state.notifications
    .filter((notification) => notification.workspaceId === source.id)
    .map((notification) => notification.id)
    .sort();
  const replacementState = decodeAppStateDto(encodeAppStateDto(state));
  removeWorkspaceGraph(replacementState, graph);
  replacementState.notifications = replacementState.notifications.filter(
    (notification) => !notificationIdsToRemove.includes(notification.id)
  );
  replacementState.workspaces[source.id] = {
    id: source.id,
    windowId: source.windowId,
    name: workspaceName,
    ...(source.nameLocked ? { nameLocked: true } : {}),
    location: workspaceLocation(target, options.defaultCwd),
    rootNodeId: options.nodeId,
    nodeMap: {
      [options.nodeId]: {
        id: options.nodeId,
        kind: "leaf",
        paneId: options.paneId
      }
    },
    activePaneId: options.paneId,
    pinned: source.pinned,
    cwdSummary: options.defaultCwd,
    ports: [],
    statusEntries: {},
    logs: []
  };
  replacementState.panes[options.paneId] = {
    id: options.paneId,
    workspaceId: source.id,
    surfaceIds: [options.surfaceId],
    activeSurfaceId: options.surfaceId
  };
  replacementState.surfaces[options.surfaceId] = {
    id: options.surfaceId,
    paneId: options.paneId,
    title,
    titleLocked: Boolean(options.launch.title?.trim()),
    unreadCount: 0,
    attention: false,
    content: { kind: "terminal", sessionId: options.sessionId }
  };
  replacementState.sessions[options.sessionId] = {
    id: options.sessionId,
    surfaceId: options.surfaceId,
    launch: {
      cwd,
      ...(options.launch.shell === undefined
        ? {}
        : { shell: options.launch.shell }),
      ...(options.launch.args === undefined
        ? {}
        : { args: [...options.launch.args] }),
      ...(options.launch.env === undefined
        ? {}
        : { env: { ...options.launch.env } }),
      ...(options.launch.title === undefined
        ? {}
        : { title: options.launch.title })
    },
    authToken: options.authToken,
    runtimeStatus: {
      processState: "running",
      observationState: "observed",
      attachmentState: "detached"
    },
    remoteRuntime: {
      keeperGeneration: options.keeperGeneration,
      remoteResourceRevision: options.remoteResourceRevision
    },
    // Remote prepare returns only after the keeper child and health RPC are
    // ready. The current interactive adapter uses the explicit `none`
    // readiness strategy, so that authoritative boundary admits input.
    shellInputReady: true,
    runtimeMetadata: { cwd, ports: [] }
  };

  // Persist the sanitized form that apply/recovery will decode. Hashing a
  // pre-sanitized state while storing a sparse DTO can make the decided WAL
  // patch fail its own replacement digest after decode.
  const canonicalReplacementState = decodeAppStateDto(
    encodeAppStateDto(replacementState)
  );
  const encoded = encodeAppStateDto(canonicalReplacementState) as Record<
    string,
    unknown
  >;
  const workspaces = requireConversionRecord(encoded.workspaces, "workspaces");
  const panes = requireConversionRecord(encoded.panes, "panes");
  const surfaces = requireConversionRecord(encoded.surfaces, "surfaces");
  const sessions = requireConversionRecord(encoded.sessions, "sessions");
  return decodeSshWorkspaceReplacementPatch({
    version: 1,
    workspaceId: source.id,
    expectedSourceWorkspaceRevision: computeWorkspaceRevision(state, source.id),
    replacementWorkspaceRevision: computeWorkspaceRevision(
      canonicalReplacementState,
      source.id
    ),
    sourcePaneIds: graph.paneIds,
    sourceSurfaceIds: graph.surfaceIds,
    sourceSessionIds: graph.sessionIds,
    notificationIdsToRemove,
    workspace: requireConversionRecord(workspaces[source.id], "workspace"),
    pane: requireConversionRecord(panes[options.paneId], "pane"),
    surface: requireConversionRecord(surfaces[options.surfaceId], "surface"),
    session: requireConversionRecord(sessions[options.sessionId], "session")
  });
}

/**
 * Builds the decided product patch for `Create new SSH workspace`. The source
 * workspace is only a concurrency fence and is never modified by the patch.
 */
export function createSshWorkspaceAdditionPatch(
  state: AppState,
  options: CreateSshWorkspaceAdditionPatchOptions
): SshWorkspaceAdditionPatchDto {
  const source = state.workspaces[options.sourceWorkspaceId];
  if (!source) {
    throw new MainFactConflictError(
      "workspace-missing",
      `workspace ${options.sourceWorkspaceId} does not exist`
    );
  }
  if (state.workspaces[options.workspaceId]) {
    throw new MainFactConflictError(
      "operation-id-conflict",
      "SSH workspace creation ID already exists"
    );
  }
  const window = state.windows[source.windowId];
  if (!window || !window.workspaceOrder.includes(source.id)) {
    throw new MainFactConflictError(
      "workspace-revision-conflict",
      "SSH workspace creation source window changed"
    );
  }
  const connectionName = requireConversionText(
    options.connectionName,
    "connectionName",
    4 * 1024
  );
  const graphIds = [
    options.paneId,
    options.nodeId,
    options.surfaceId,
    options.sessionId
  ];
  if (
    new Set(graphIds).size !== graphIds.length ||
    state.panes[options.paneId] ||
    state.surfaces[options.surfaceId] ||
    state.sessions[options.sessionId]
  ) {
    throw new MainFactConflictError(
      "operation-id-conflict",
      "SSH workspace creation graph ID already exists"
    );
  }
  const target = { kind: "ssh" as const, targetId: options.targetId };
  const cwd = locatedPathForTarget(target, options.launch.cwd);
  const workspaceName = `SSH: ${connectionName}`;
  const title = options.launch.title?.trim() || workspaceName;
  const additionState = decodeAppStateDto(encodeAppStateDto(state));
  additionState.workspaces[options.workspaceId] = {
    id: options.workspaceId,
    windowId: source.windowId,
    name: workspaceName,
    location: workspaceLocation(target, options.defaultCwd),
    rootNodeId: options.nodeId,
    nodeMap: {
      [options.nodeId]: {
        id: options.nodeId,
        kind: "leaf",
        paneId: options.paneId
      }
    },
    activePaneId: options.paneId,
    pinned: false,
    cwdSummary: options.defaultCwd,
    ports: [],
    statusEntries: {},
    logs: []
  };
  additionState.panes[options.paneId] = {
    id: options.paneId,
    workspaceId: options.workspaceId,
    surfaceIds: [options.surfaceId],
    activeSurfaceId: options.surfaceId
  };
  additionState.surfaces[options.surfaceId] = {
    id: options.surfaceId,
    paneId: options.paneId,
    title,
    titleLocked: Boolean(options.launch.title?.trim()),
    unreadCount: 0,
    attention: false,
    content: { kind: "terminal", sessionId: options.sessionId }
  };
  additionState.sessions[options.sessionId] = {
    id: options.sessionId,
    surfaceId: options.surfaceId,
    launch: {
      cwd,
      ...(options.launch.shell === undefined
        ? {}
        : { shell: options.launch.shell }),
      ...(options.launch.args === undefined
        ? {}
        : { args: [...options.launch.args] }),
      ...(options.launch.env === undefined
        ? {}
        : { env: { ...options.launch.env } }),
      ...(options.launch.title === undefined
        ? {}
        : { title: options.launch.title })
    },
    authToken: options.authToken,
    runtimeStatus: {
      processState: "running",
      observationState: "observed",
      attachmentState: "detached"
    },
    remoteRuntime: {
      keeperGeneration: options.keeperGeneration,
      remoteResourceRevision: options.remoteResourceRevision
    },
    shellInputReady: true,
    runtimeMetadata: { cwd, ports: [] }
  };
  const expectedWindowWorkspaceOrder = [...window.workspaceOrder];
  const resultingWindowWorkspaceOrder = [
    ...expectedWindowWorkspaceOrder,
    options.workspaceId
  ];
  additionState.windows[source.windowId].workspaceOrder =
    resultingWindowWorkspaceOrder;
  additionState.windows[source.windowId].activeWorkspaceId =
    options.workspaceId;

  // The immutable addition patch must carry the same canonical session launch
  // that apply/recovery will hash; see the replacement path above.
  const canonicalAdditionState = decodeAppStateDto(
    encodeAppStateDto(additionState)
  );
  const encoded = encodeAppStateDto(canonicalAdditionState) as Record<
    string,
    unknown
  >;
  const workspaces = requireConversionRecord(encoded.workspaces, "workspaces");
  const panes = requireConversionRecord(encoded.panes, "panes");
  const surfaces = requireConversionRecord(encoded.surfaces, "surfaces");
  const sessions = requireConversionRecord(encoded.sessions, "sessions");
  return decodeSshWorkspaceAdditionPatch({
    version: 1,
    sourceWorkspaceId: source.id,
    workspaceId: options.workspaceId,
    windowId: source.windowId,
    expectedSourceWorkspaceRevision: computeWorkspaceRevision(state, source.id),
    expectedWindowWorkspaceOrder,
    resultingWindowWorkspaceOrder,
    replacementWorkspaceRevision: computeWorkspaceRevision(
      canonicalAdditionState,
      options.workspaceId
    ),
    workspace: requireConversionRecord(
      workspaces[options.workspaceId],
      "workspace"
    ),
    pane: requireConversionRecord(panes[options.paneId], "pane"),
    surface: requireConversionRecord(surfaces[options.surfaceId], "surface"),
    session: requireConversionRecord(sessions[options.sessionId], "session")
  });
}

/** Applies only the decided workspace slice and is idempotent after commit. */
export function applySshWorkspaceReplacementPatch(
  state: AppState,
  value: unknown
): ApplyMainFactResult {
  const patch = decodeSshWorkspaceReplacementPatch(value);
  const currentRevision = computeWorkspaceRevision(state, patch.workspaceId);
  if (currentRevision === patch.replacementWorkspaceRevision) {
    return noChange();
  }
  if (currentRevision !== patch.expectedSourceWorkspaceRevision) {
    throw new MainFactConflictError(
      "workspace-revision-conflict",
      "conversion patch source workspace revision changed"
    );
  }
  const graph = workspaceGraphIds(state, patch.workspaceId);
  if (
    !sameSortedIds(graph.paneIds, patch.sourcePaneIds) ||
    !sameSortedIds(graph.surfaceIds, patch.sourceSurfaceIds) ||
    !sameSortedIds(graph.sessionIds, patch.sourceSessionIds)
  ) {
    throw new MainFactConflictError(
      "workspace-revision-conflict",
      "conversion patch source graph changed"
    );
  }
  const encoded = encodeAppStateDto(state) as Record<string, unknown>;
  const workspaces = requireConversionRecord(encoded.workspaces, "workspaces");
  const panes = requireConversionRecord(encoded.panes, "panes");
  const surfaces = requireConversionRecord(encoded.surfaces, "surfaces");
  const sessions = requireConversionRecord(encoded.sessions, "sessions");
  for (const id of patch.sourcePaneIds) delete panes[id];
  for (const id of patch.sourceSurfaceIds) delete surfaces[id];
  for (const id of patch.sourceSessionIds) delete sessions[id];
  workspaces[patch.workspaceId] = structuredClone(patch.workspace);
  const paneId = requireConversionId(patch.pane.id, "pane.id");
  const surfaceId = requireConversionId(patch.surface.id, "surface.id");
  const sessionId = requireConversionId(patch.session.id, "session.id");
  panes[paneId] = structuredClone(patch.pane);
  surfaces[surfaceId] = structuredClone(patch.surface);
  sessions[sessionId] = structuredClone(patch.session);
  const notifications = Array.isArray(encoded.notifications)
    ? encoded.notifications
    : [];
  const removedNotifications = new Set(patch.notificationIdsToRemove);
  encoded.notifications = notifications.filter((notification) => {
    const record = requireConversionRecord(notification, "notification");
    return !removedNotifications.has(
      requireConversionId(record.id, "notification.id")
    );
  });
  const candidate = decodeAppStateDto(encoded);
  if (
    computeWorkspaceRevision(candidate, patch.workspaceId) !==
    patch.replacementWorkspaceRevision
  ) {
    throw new MainFactConflictError(
      "workspace-revision-conflict",
      "conversion patch replacement digest does not match"
    );
  }
  state.workspaces = candidate.workspaces;
  state.panes = candidate.panes;
  state.surfaces = candidate.surfaces;
  state.sessions = candidate.sessions;
  state.notifications = candidate.notifications;
  return changed();
}

export function decodeSshWorkspaceReplacementPatch(
  value: unknown
): SshWorkspaceReplacementPatchDto {
  const record = requireConversionRecord(value, "conversion patch");
  const expectedKeys = new Set([
    "version",
    "workspaceId",
    "expectedSourceWorkspaceRevision",
    "replacementWorkspaceRevision",
    "sourcePaneIds",
    "sourceSurfaceIds",
    "sourceSessionIds",
    "notificationIdsToRemove",
    "workspace",
    "pane",
    "surface",
    "session"
  ]);
  const unexpected = Object.keys(record).find((key) => !expectedKeys.has(key));
  if (unexpected || record.version !== 1) {
    throw new TypeError("conversion patch schema is invalid");
  }
  const patch = {
    version: 1 as const,
    workspaceId: requireConversionId(record.workspaceId, "workspaceId"),
    expectedSourceWorkspaceRevision: requireConversionDigest(
      record.expectedSourceWorkspaceRevision,
      "expectedSourceWorkspaceRevision"
    ),
    replacementWorkspaceRevision: requireConversionDigest(
      record.replacementWorkspaceRevision,
      "replacementWorkspaceRevision"
    ),
    sourcePaneIds: requireConversionIdArray(
      record.sourcePaneIds,
      "sourcePaneIds"
    ),
    sourceSurfaceIds: requireConversionIdArray(
      record.sourceSurfaceIds,
      "sourceSurfaceIds"
    ),
    sourceSessionIds: requireConversionIdArray(
      record.sourceSessionIds,
      "sourceSessionIds"
    ),
    notificationIdsToRemove: requireConversionIdArray(
      record.notificationIdsToRemove,
      "notificationIdsToRemove"
    ),
    workspace: structuredClone(
      requireConversionRecord(record.workspace, "workspace")
    ),
    pane: structuredClone(requireConversionRecord(record.pane, "pane")),
    surface: structuredClone(
      requireConversionRecord(record.surface, "surface")
    ),
    session: structuredClone(requireConversionRecord(record.session, "session"))
  };
  if (
    requireConversionId(patch.workspace.id, "workspace.id") !==
      patch.workspaceId ||
    requireConversionId(patch.pane.workspaceId, "pane.workspaceId") !==
      patch.workspaceId ||
    requireConversionId(patch.surface.paneId, "surface.paneId") !==
      requireConversionId(patch.pane.id, "pane.id") ||
    requireConversionId(patch.session.surfaceId, "session.surfaceId") !==
      requireConversionId(patch.surface.id, "surface.id")
  ) {
    throw new TypeError("conversion patch product identities do not match");
  }
  return patch;
}

/** Applies a decided SSH workspace addition without changing its source. */
export function applySshWorkspaceAdditionPatch(
  state: AppState,
  value: unknown
): ApplyMainFactResult {
  const patch = decodeSshWorkspaceAdditionPatch(value);
  const existing = state.workspaces[patch.workspaceId];
  if (existing) {
    if (
      computeWorkspaceRevision(state, patch.workspaceId) ===
      patch.replacementWorkspaceRevision
    ) {
      return noChange();
    }
    throw new MainFactConflictError(
      "operation-id-conflict",
      "SSH workspace creation ID was installed differently"
    );
  }
  if (
    computeWorkspaceRevision(state, patch.sourceWorkspaceId) !==
    patch.expectedSourceWorkspaceRevision
  ) {
    throw new MainFactConflictError(
      "workspace-revision-conflict",
      "SSH workspace creation source changed before commit"
    );
  }
  const source = state.workspaces[patch.sourceWorkspaceId];
  const window = state.windows[patch.windowId];
  if (
    !source ||
    source.windowId !== patch.windowId ||
    !window ||
    !sameOrderedIds(window.workspaceOrder, patch.expectedWindowWorkspaceOrder)
  ) {
    throw new MainFactConflictError(
      "workspace-revision-conflict",
      "SSH workspace creation source window changed before commit"
    );
  }
  const paneId = requireConversionId(patch.pane.id, "pane.id");
  const surfaceId = requireConversionId(patch.surface.id, "surface.id");
  const sessionId = requireConversionId(patch.session.id, "session.id");
  if (
    state.panes[paneId] ||
    state.surfaces[surfaceId] ||
    state.sessions[sessionId]
  ) {
    throw new MainFactConflictError(
      "operation-id-conflict",
      "SSH workspace creation graph ID was already used"
    );
  }
  const encoded = encodeAppStateDto(state) as Record<string, unknown>;
  const windows = requireConversionRecord(encoded.windows, "windows");
  const workspaces = requireConversionRecord(encoded.workspaces, "workspaces");
  const panes = requireConversionRecord(encoded.panes, "panes");
  const surfaces = requireConversionRecord(encoded.surfaces, "surfaces");
  const sessions = requireConversionRecord(encoded.sessions, "sessions");
  workspaces[patch.workspaceId] = structuredClone(patch.workspace);
  panes[paneId] = structuredClone(patch.pane);
  surfaces[surfaceId] = structuredClone(patch.surface);
  sessions[sessionId] = structuredClone(patch.session);
  const encodedWindow = requireConversionRecord(
    windows[patch.windowId],
    "window"
  );
  encodedWindow.workspaceOrder = [...patch.resultingWindowWorkspaceOrder];
  encodedWindow.activeWorkspaceId = patch.workspaceId;
  const candidate = decodeAppStateDto(encoded);
  if (
    computeWorkspaceRevision(candidate, patch.workspaceId) !==
    patch.replacementWorkspaceRevision
  ) {
    throw new MainFactConflictError(
      "workspace-revision-conflict",
      "SSH workspace creation replacement digest does not match"
    );
  }
  state.windows = candidate.windows;
  state.workspaces = candidate.workspaces;
  state.panes = candidate.panes;
  state.surfaces = candidate.surfaces;
  state.sessions = candidate.sessions;
  return changed();
}

export function decodeSshWorkspaceAdditionPatch(
  value: unknown
): SshWorkspaceAdditionPatchDto {
  const record = requireConversionRecord(value, "SSH workspace addition patch");
  const expectedKeys = new Set([
    "version",
    "sourceWorkspaceId",
    "workspaceId",
    "windowId",
    "expectedSourceWorkspaceRevision",
    "expectedWindowWorkspaceOrder",
    "resultingWindowWorkspaceOrder",
    "replacementWorkspaceRevision",
    "workspace",
    "pane",
    "surface",
    "session"
  ]);
  const unexpected = Object.keys(record).find((key) => !expectedKeys.has(key));
  if (unexpected || record.version !== 1) {
    throw new TypeError("SSH workspace addition patch schema is invalid");
  }
  const patch: SshWorkspaceAdditionPatchDto = {
    version: 1,
    sourceWorkspaceId: requireConversionId(
      record.sourceWorkspaceId,
      "sourceWorkspaceId"
    ),
    workspaceId: requireConversionId(record.workspaceId, "workspaceId"),
    windowId: requireConversionId(record.windowId, "windowId"),
    expectedSourceWorkspaceRevision: requireConversionDigest(
      record.expectedSourceWorkspaceRevision,
      "expectedSourceWorkspaceRevision"
    ),
    expectedWindowWorkspaceOrder: requireConversionOrderedIdArray(
      record.expectedWindowWorkspaceOrder,
      "expectedWindowWorkspaceOrder"
    ),
    resultingWindowWorkspaceOrder: requireConversionOrderedIdArray(
      record.resultingWindowWorkspaceOrder,
      "resultingWindowWorkspaceOrder"
    ),
    replacementWorkspaceRevision: requireConversionDigest(
      record.replacementWorkspaceRevision,
      "replacementWorkspaceRevision"
    ),
    workspace: structuredClone(
      requireConversionRecord(record.workspace, "workspace")
    ),
    pane: structuredClone(requireConversionRecord(record.pane, "pane")),
    surface: structuredClone(
      requireConversionRecord(record.surface, "surface")
    ),
    session: structuredClone(requireConversionRecord(record.session, "session"))
  };
  const expectedResultingOrder = [
    ...patch.expectedWindowWorkspaceOrder,
    patch.workspaceId
  ];
  if (
    patch.sourceWorkspaceId === patch.workspaceId ||
    !patch.expectedWindowWorkspaceOrder.includes(patch.sourceWorkspaceId) ||
    !sameOrderedIds(
      patch.resultingWindowWorkspaceOrder,
      expectedResultingOrder
    ) ||
    requireConversionId(patch.workspace.id, "workspace.id") !==
      patch.workspaceId ||
    requireConversionId(patch.workspace.windowId, "workspace.windowId") !==
      patch.windowId ||
    requireConversionId(patch.pane.workspaceId, "pane.workspaceId") !==
      patch.workspaceId ||
    requireConversionId(patch.surface.paneId, "surface.paneId") !==
      requireConversionId(patch.pane.id, "pane.id") ||
    requireConversionId(patch.session.surfaceId, "session.surfaceId") !==
      requireConversionId(patch.surface.id, "surface.id")
  ) {
    throw new TypeError("SSH workspace addition patch identities do not match");
  }
  return patch;
}

function workspaceGraphIds(
  state: AppState,
  workspaceId: Id
): { paneIds: Id[]; surfaceIds: Id[]; sessionIds: Id[] } {
  const paneIds = Object.values(state.panes)
    .filter((pane) => pane.workspaceId === workspaceId)
    .map((pane) => pane.id)
    .sort();
  const paneSet = new Set(paneIds);
  const surfaceIds = Object.values(state.surfaces)
    .filter((surface) => paneSet.has(surface.paneId))
    .map((surface) => surface.id)
    .sort();
  const surfaceSet = new Set(surfaceIds);
  const sessionIds = Object.values(state.sessions)
    .filter((session) => surfaceSet.has(session.surfaceId))
    .map((session) => session.id)
    .sort();
  return { paneIds, surfaceIds, sessionIds };
}

function removeWorkspaceGraph(
  state: AppState,
  graph: { paneIds: Id[]; surfaceIds: Id[]; sessionIds: Id[] }
): void {
  for (const id of graph.paneIds) delete state.panes[id];
  for (const id of graph.surfaceIds) delete state.surfaces[id];
  for (const id of graph.sessionIds) delete state.sessions[id];
}

function sameSortedIds(left: Id[], right: Id[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameOrderedIds(left: Id[], right: Id[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function requireConversionRecord(
  value: unknown,
  field: string
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireConversionId(value: unknown, field: string): Id {
  return requireConversionText(value, field, 256) as Id;
}

function requireConversionText(
  value: unknown,
  field: string,
  maxBytes: number
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maxBytes ||
    /\p{Cc}/u.test(value)
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function requireConversionDigest(value: unknown, field: string): string {
  const digest = requireConversionText(value, field, 64);
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new TypeError(`${field} must be a SHA-256 digest`);
  }
  return digest;
}

function requireConversionIdArray(value: unknown, field: string): Id[] {
  if (!Array.isArray(value) || value.length > 4_096) {
    throw new TypeError(`${field} must be a bounded array`);
  }
  const ids = value.map((item) => requireConversionId(item, field));
  if (new Set(ids).size !== ids.length) {
    throw new TypeError(`${field} contains duplicates`);
  }
  return ids.sort();
}

function requireConversionOrderedIdArray(value: unknown, field: string): Id[] {
  if (!Array.isArray(value) || value.length > 4_096) {
    throw new TypeError(`${field} must be a bounded array`);
  }
  const ids = value.map((item) => requireConversionId(item, field));
  if (new Set(ids).size !== ids.length) {
    throw new TypeError(`${field} contains duplicates`);
  }
  return ids;
}

export function applyMainRemoteOperationFact(
  state: AppState,
  fact: MainRemoteOperationFact
): ApplyMainFactResult {
  switch (fact.type) {
    case "remote-operation.pending":
      return applyPendingFact(state, fact.projection);
    case "remote-operation.succeeded":
      return applySucceededFact(state, fact);
    case "remote-operation.failed":
      return applyFailedFact(state, fact);
  }
}

export function applyMainFact(
  state: AppState,
  fact: MainFact
): ApplyMainFactResult {
  switch (fact.type) {
    case "remote-operation.checkpointed":
      return applyMainRemoteOperationCheckpointFact(state, fact);
    case "remote-session.observation-unknown":
    case "remote-session.observed":
    case "remote-session.absent":
      return applyMainRemoteSessionObservationFact(state, fact);
    case "remote-session.cursor":
      return applyMainRemoteSessionCursorFact(state, fact);
    default:
      return applyMainRemoteOperationFact(state, fact);
  }
}

export function applyMainRemoteOperationCheckpointFact(
  state: AppState,
  fact: MainRemoteOperationCheckpointFact
): ApplyMainFactResult {
  const projection = state.remoteOperations[fact.operationId];
  if (!projection) return noChange();
  if (
    (projection.state !== "succeeded" && projection.state !== "failed") ||
    projection.resultDigest !== fact.resultDigest
  ) {
    throw new MainFactConflictError(
      "operation-terminal",
      `operation ${fact.operationId} is not the checkpointed terminal result`
    );
  }
  delete state.remoteOperations[fact.operationId];
  return changed();
}

/**
 * Applies authority-bearing inventory facts without conflating transport loss
 * with process liveness. These facts are deliberately absent from AppAction.
 */
export function applyMainRemoteSessionObservationFact(
  state: AppState,
  fact: MainRemoteSessionObservationFact
): ApplyMainFactResult {
  const session = requireRemoteSessionForResourceKey(state, fact.resourceKey);
  if (fact.type === "remote-session.observation-unknown") {
    if (session.runtimeStatus.observationState === "unknown") {
      return noChange();
    }
    session.runtimeStatus = {
      ...session.runtimeStatus,
      observationState: "unknown"
    };
    return changed();
  }

  if (fact.type === "remote-session.absent") {
    if (Number.isNaN(Date.parse(fact.observedAt))) {
      throw new TypeError(
        "remote session absent observedAt must be an ISO timestamp"
      );
    }
    const hasExpectedGeneration = fact.expectedKeeperGeneration !== undefined;
    const hasExpectedRevision =
      fact.expectedRemoteResourceRevision !== undefined;
    if (hasExpectedGeneration !== hasExpectedRevision) {
      throw new TypeError(
        "remote session absence fence requires generation and revision together"
      );
    }
    if (
      hasExpectedGeneration &&
      (!session.remoteRuntime ||
        session.remoteRuntime.keeperGeneration !==
          fact.expectedKeeperGeneration ||
        session.remoteRuntime.remoteResourceRevision !==
          fact.expectedRemoteResourceRevision)
    ) {
      throw new MainFactConflictError(
        "remote-revision-conflict",
        "remote session absence fact was fenced by another keeper runtime"
      );
    }
    const unchanged =
      session.runtimeStatus.processState === "exited" &&
      session.runtimeStatus.observationState === "observed" &&
      session.runtimeStatus.attachmentState === "detached" &&
      session.exitCode === undefined;
    if (unchanged) return noChange();
    session.runtimeStatus = {
      processState: "exited",
      observationState: "observed",
      attachmentState: "detached"
    };
    session.shellInputReady = false;
    delete session.pid;
    delete session.exitCode;
    return changed();
  }

  const exitCode = validateExitCode(fact.exitCode);
  const storageStatus = validateRemoteSessionStorageStatus(fact.storageStatus);
  if (Number.isNaN(Date.parse(fact.observedAt))) {
    throw new TypeError("remote session observedAt must be an ISO timestamp");
  }
  if (fact.processState === "running" && exitCode !== undefined) {
    throw new TypeError("a running remote session cannot have an exit code");
  }
  if (
    session.remoteRuntime &&
    fact.remoteResourceRevision < session.remoteRuntime.remoteResourceRevision
  ) {
    throw new MainFactConflictError(
      "remote-revision-conflict",
      "remote session observation regressed its resource revision"
    );
  }
  if (
    session.remoteRuntime &&
    fact.remoteResourceRevision ===
      session.remoteRuntime.remoteResourceRevision &&
    fact.keeperGeneration !== session.remoteRuntime.keeperGeneration
  ) {
    throw new MainFactConflictError(
      "remote-revision-conflict",
      "one remote session revision cannot identify two keeper generations"
    );
  }
  const unchanged =
    session.runtimeStatus.observationState === "observed" &&
    session.runtimeStatus.processState === fact.processState &&
    session.shellInputReady === (fact.processState === "running") &&
    session.remoteRuntime?.keeperGeneration === fact.keeperGeneration &&
    session.remoteRuntime.remoteResourceRevision ===
      fact.remoteResourceRevision &&
    sameRemoteSessionStorageStatus(
      session.remoteRuntime.storageStatus,
      storageStatus
    ) &&
    (fact.processState !== "exited" || session.exitCode === exitCode);
  if (unchanged) {
    return noChange();
  }
  session.runtimeStatus = {
    ...session.runtimeStatus,
    processState: fact.processState,
    observationState: "observed"
  };
  const priorCursor =
    session.remoteRuntime?.keeperGeneration === fact.keeperGeneration
      ? session.remoteRuntime.lastAcknowledgedMutationSequence
      : undefined;
  session.remoteRuntime = {
    keeperGeneration: fact.keeperGeneration,
    remoteResourceRevision: fact.remoteResourceRevision,
    storageStatus,
    ...(priorCursor === undefined
      ? {}
      : { lastAcknowledgedMutationSequence: priorCursor })
  };
  if (fact.processState === "exited") {
    session.shellInputReady = false;
    session.exitCode = exitCode;
  } else {
    session.shellInputReady = true;
    delete session.exitCode;
  }
  return changed();
}

export function applyMainRemoteSessionCursorFact(
  state: AppState,
  fact: MainRemoteSessionCursorFact
): ApplyMainFactResult {
  const session = requireRemoteSessionForResourceKey(state, fact.resourceKey);
  const remoteRuntime = session.remoteRuntime;
  if (!remoteRuntime) {
    throw new MainFactConflictError(
      "operation-missing",
      "remote session cursor has no authoritative keeper runtime"
    );
  }
  if (remoteRuntime.keeperGeneration !== fact.keeperGeneration) {
    throw new MainFactConflictError(
      "remote-revision-conflict",
      "remote session cursor belongs to another keeper generation"
    );
  }
  if (
    remoteRuntime.lastAcknowledgedMutationSequence !== undefined &&
    fact.sequence <= remoteRuntime.lastAcknowledgedMutationSequence
  ) {
    return noChange();
  }
  remoteRuntime.lastAcknowledgedMutationSequence = fact.sequence;
  return changed();
}

export function encodeMainRemoteOperationFact(
  fact: MainRemoteOperationFact
): MainRemoteOperationFactDto {
  switch (fact.type) {
    case "remote-operation.pending":
      return {
        type: fact.type,
        projection: encodeRemoteOperationProjectionDto(fact.projection)
      };
    case "remote-operation.succeeded":
      return {
        ...fact,
        remoteResourceRevision: formatUint64Decimal(fact.remoteResourceRevision)
      };
    case "remote-operation.failed":
      return structuredClone(fact);
  }
}

export function decodeMainRemoteOperationFact(
  value: unknown
): MainRemoteOperationFact {
  const record = requireRecord(value, "Main remote operation fact");
  switch (record.type) {
    case "remote-operation.pending":
      assertExactKeys(record, ["type", "projection"]);
      return {
        type: record.type,
        projection: decodeRemoteOperationProjectionDto(record.projection)
      };
    case "remote-operation.succeeded":
      assertExactKeys(record, [
        "type",
        "operationId",
        "remoteResourceRevision",
        "resultDigest",
        "completedAt",
        "keeperGeneration"
      ]);
      return {
        type: record.type,
        operationId: requireString(record.operationId, "operationId", 256),
        remoteResourceRevision: parseUint64Decimal(
          record.remoteResourceRevision
        ),
        resultDigest: requireDigest(record.resultDigest, "resultDigest"),
        completedAt: requireTimestamp(record.completedAt, "completedAt"),
        ...(record.keeperGeneration === undefined
          ? {}
          : {
              keeperGeneration: requireString(
                record.keeperGeneration,
                "keeperGeneration",
                256
              )
            })
      };
    case "remote-operation.failed":
      assertExactKeys(record, [
        "type",
        "operationId",
        "resultDigest",
        "code",
        "message",
        "completedAt"
      ]);
      return {
        type: record.type,
        operationId: requireString(record.operationId, "operationId", 256),
        resultDigest: requireDigest(record.resultDigest, "resultDigest"),
        code: requireString(record.code, "code", 256),
        message: requireString(record.message, "message", 4 * 1024),
        completedAt: requireTimestamp(record.completedAt, "completedAt")
      };
    default:
      throw new TypeError("unsupported Main remote operation fact");
  }
}

function applyPendingFact(
  state: AppState,
  projection: RemoteOperationProjection
): ApplyMainFactResult {
  const existing = state.remoteOperations[projection.operationId];
  if (existing) {
    if (sameOperationAdmission(existing, projection)) {
      return noChange();
    }
    throw new MainFactConflictError(
      "operation-id-conflict",
      `operation ${projection.operationId} is already bound to another fact`
    );
  }
  const workspace = state.workspaces[projection.resourceKey.workspaceId];
  if (!workspace) {
    throw new MainFactConflictError(
      "workspace-missing",
      `workspace ${projection.resourceKey.workspaceId} does not exist`
    );
  }
  if (
    workspace.location.target.kind !== "ssh" ||
    workspace.location.target.targetId !== projection.resourceKey.targetId
  ) {
    throw new MainFactConflictError(
      "target-mismatch",
      "remote operation target does not match the workspace binding"
    );
  }
  const currentRevision = computeWorkspaceRevision(
    state,
    projection.resourceKey.workspaceId
  );
  if (currentRevision !== projection.expectedWorkspaceRevision) {
    throw new MainFactConflictError(
      "workspace-revision-conflict",
      "remote operation expected an older workspace revision"
    );
  }
  if (
    projection.nextRemoteResourceRevision !==
    incrementUint64(projection.expectedRemoteResourceRevision)
  ) {
    throw new MainFactConflictError(
      "remote-revision-conflict",
      "remote resource revisions must advance by exactly one"
    );
  }
  applyPendingProductProjection(state, projection);
  state.remoteOperations[projection.operationId] = structuredClone(projection);
  return changed();
}

function applySucceededFact(
  state: AppState,
  fact: Extract<MainRemoteOperationFact, { type: "remote-operation.succeeded" }>
): ApplyMainFactResult {
  const projection = requireProjection(state, fact.operationId);
  if (projection.state === "succeeded") {
    if (
      projection.completedAt === fact.completedAt &&
      projection.resultDigest === fact.resultDigest &&
      projection.nextRemoteResourceRevision === fact.remoteResourceRevision &&
      projection.keeperGeneration === fact.keeperGeneration
    ) {
      return noChange();
    }
    throw terminalConflict(fact.operationId);
  }
  if (projection.state === "failed") {
    throw terminalConflict(fact.operationId);
  }
  if (projection.nextRemoteResourceRevision !== fact.remoteResourceRevision) {
    throw new MainFactConflictError(
      "remote-revision-conflict",
      "authoritative result revision does not match the admitted operation"
    );
  }
  assertKeeperGenerationForResult(projection, fact.keeperGeneration);
  applySucceededProductProjection(state, projection, fact);
  if (projection.resourceKey.sessionId === undefined) {
    const workspace = state.workspaces[projection.resourceKey.workspaceId];
    if (workspace) {
      workspace.remoteResourceRevision = fact.remoteResourceRevision;
    }
  }
  projection.state = "succeeded";
  projection.completedAt = fact.completedAt;
  projection.resultDigest = fact.resultDigest;
  if (fact.keeperGeneration === undefined) {
    delete projection.keeperGeneration;
  } else {
    projection.keeperGeneration = fact.keeperGeneration;
  }
  delete projection.failure;
  return changed();
}

function applyFailedFact(
  state: AppState,
  fact: Extract<MainRemoteOperationFact, { type: "remote-operation.failed" }>
): ApplyMainFactResult {
  const projection = requireProjection(state, fact.operationId);
  if (projection.state === "failed") {
    if (
      projection.completedAt === fact.completedAt &&
      projection.resultDigest === fact.resultDigest &&
      projection.failure?.code === fact.code &&
      projection.failure.message === fact.message
    ) {
      return noChange();
    }
    throw terminalConflict(fact.operationId);
  }
  if (projection.state === "succeeded") {
    throw terminalConflict(fact.operationId);
  }
  rollbackFailedProductProjection(state, projection);
  projection.state = "failed";
  projection.completedAt = fact.completedAt;
  projection.resultDigest = fact.resultDigest;
  projection.failure = { code: fact.code, message: fact.message };
  delete projection.keeperGeneration;
  return changed();
}

type SessionOwnershipPendingProduct = Extract<
  RemotePendingProductProjection,
  { kind: "session.create" }
>;

function createSessionProductProjection(
  state: AppState,
  intent: RemoteOperationIntent,
  payload: Extract<
    RemoteOperationPayloadDto,
    { kind: "session.create" | "session.adopt" }
  >,
  initialInput?: string
): SessionOwnershipPendingProduct["product"] {
  const workspace = state.workspaces[intent.resourceKey.workspaceId];
  const targetPane = state.panes[payload.paneId];
  if (!workspace || !targetPane || targetPane.workspaceId !== workspace.id) {
    throw new MainFactConflictError(
      "workspace-missing",
      "session ownership target pane does not belong to its workspace"
    );
  }
  if (!state.surfaces[targetPane.activeSurfaceId]) {
    throw new MainFactConflictError(
      "operation-missing",
      "session ownership target pane has no active surface"
    );
  }
  const direction =
    payload.kind === "session.create" ? payload.direction : undefined;
  const product = {
    authToken: stableProductId("auth", intent.operationId, "auth-token"),
    projectedPaneId:
      direction === undefined
        ? targetPane.id
        : stableProductId("pane", intent.operationId, "split-pane"),
    previousActivePaneId: workspace.activePaneId,
    previousActiveSurfaceId: targetPane.activeSurfaceId,
    ...(initialInput === undefined ? {} : { initialInput }),
    ...(direction === undefined
      ? {}
      : {
          splitLeafNodeId: stableProductId(
            "node",
            intent.operationId,
            "split-leaf"
          ),
          splitNodeId: stableProductId("node", intent.operationId, "split-root")
        })
  } satisfies SessionOwnershipPendingProduct["product"];
  return product;
}

function applyPendingProductProjection(
  state: AppState,
  projection: RemoteOperationProjection
): void {
  const product = projection.pendingProduct;
  if (!product) return;
  if (product.kind === "session.create") {
    applySessionOwnershipProductProjection(state, projection);
    return;
  }
  if (product.kind === "worktree.create") {
    const workspace = state.workspaces[projection.resourceKey.workspaceId];
    if (!workspace || workspace.worktree) {
      throw new MainFactConflictError(
        "operation-id-conflict",
        "worktree create requires a workspace without worktree ownership"
      );
    }
    return;
  }
  if (product.kind === "worktree.remove") {
    requireMatchingWorkspaceWorktree(
      state,
      projection.resourceKey.workspaceId,
      product.product.expectedWorktree
    );
  }
}

function applySessionOwnershipProductProjection(
  state: AppState,
  projection: RemoteOperationProjection
): void {
  const product = projection.pendingProduct;
  if (
    !product ||
    (product.kind !== "session.create" && product.kind !== "session.adopt")
  ) {
    throw new MainFactConflictError(
      "operation-missing",
      "session ownership operation has no product projection"
    );
  }
  if (
    projection.resourceKey.sessionId !== product.sessionId ||
    state.sessions[product.sessionId] ||
    state.surfaces[product.surfaceId]
  ) {
    throw new MainFactConflictError(
      "operation-id-conflict",
      "session ownership product identities are already in use"
    );
  }
  const workspace = state.workspaces[projection.resourceKey.workspaceId];
  const targetPane = state.panes[product.paneId];
  if (!workspace || !targetPane || targetPane.workspaceId !== workspace.id) {
    throw new MainFactConflictError(
      "workspace-missing",
      "session ownership target pane does not belong to its workspace"
    );
  }
  if (
    workspace.activePaneId !== product.product.previousActivePaneId ||
    targetPane.activeSurfaceId !== product.product.previousActiveSurfaceId
  ) {
    throw new MainFactConflictError(
      "workspace-revision-conflict",
      "session ownership projection no longer matches workspace focus"
    );
  }

  let targetLeafId: Id | undefined;
  const direction =
    product.kind === "session.create" ? product.direction : undefined;
  if (direction !== undefined) {
    targetLeafId = findLeafIdForPane(workspace, targetPane.id);
    if (
      !targetLeafId ||
      state.panes[product.product.projectedPaneId] ||
      workspace.nodeMap[product.product.splitLeafNodeId!] ||
      workspace.nodeMap[product.product.splitNodeId!]
    ) {
      throw new MainFactConflictError(
        "operation-id-conflict",
        "session split product identities conflict with the current layout"
      );
    }
  }

  const cwd = locatedPathForTarget(
    workspace.location.target,
    product.launch.cwd
  );
  const launch = {
    cwd,
    ...(product.launch.shell === undefined
      ? {}
      : { shell: product.launch.shell }),
    ...(product.launch.args === undefined
      ? {}
      : { args: [...product.launch.args] }),
    ...(product.launch.env === undefined
      ? {}
      : { env: { ...product.launch.env } }),
    ...(product.launch.title === undefined
      ? {}
      : { title: product.launch.title }),
    ...(product.product.initialInput === undefined
      ? {}
      : { initialInput: product.product.initialInput })
  };
  const projectedPane =
    direction === undefined
      ? targetPane
      : {
          id: product.product.projectedPaneId,
          workspaceId: workspace.id,
          surfaceIds: [] as Id[],
          activeSurfaceId: product.surfaceId
        };

  if (direction !== undefined) {
    insertDeterministicPaneLeafSplit(
      workspace,
      targetLeafId!,
      projectedPane.id,
      direction,
      product.product.splitLeafNodeId!,
      product.product.splitNodeId!
    );
    state.panes[projectedPane.id] = projectedPane;
  }
  state.surfaces[product.surfaceId] = {
    id: product.surfaceId,
    paneId: projectedPane.id,
    title:
      product.launch.title?.trim() ||
      (direction === undefined
        ? `tab ${projectedPane.surfaceIds.length + 1}`
        : "new terminal"),
    titleLocked: Boolean(product.launch.title?.trim()),
    unreadCount: 0,
    attention: false,
    content: { kind: "terminal", sessionId: product.sessionId }
  };
  state.sessions[product.sessionId] = {
    id: product.sessionId,
    surfaceId: product.surfaceId,
    launch,
    authToken: product.product.authToken,
    runtimeStatus: {
      processState: "pending",
      observationState: "unknown",
      attachmentState: "detached"
    },
    shellInputReady: false,
    runtimeMetadata: { cwd, ports: [] }
  };
  projectedPane.surfaceIds.push(product.surfaceId);
  projectedPane.activeSurfaceId = product.surfaceId;
  workspace.activePaneId = projectedPane.id;
}

function applySucceededProductProjection(
  state: AppState,
  projection: RemoteOperationProjection,
  fact: Extract<MainRemoteOperationFact, { type: "remote-operation.succeeded" }>
): void {
  const product = projection.pendingProduct;
  switch (product?.kind) {
    case "session.create":
      markRemoteSessionRunning(
        state,
        projection,
        product.sessionId,
        product.surfaceId,
        fact.keeperGeneration!,
        fact.remoteResourceRevision
      );
      return;
    case "session.restart": {
      const session = requireRemoteSessionForResourceKey(
        state,
        projection.resourceKey as RemoteResourceKey & { sessionId: Id }
      );
      if (session.surfaceId !== product.surfaceId) {
        throw new MainFactConflictError(
          "operation-missing",
          "session restart product surface no longer matches"
        );
      }
      const surface = state.surfaces[product.surfaceId];
      const workspace = state.workspaces[projection.resourceKey.workspaceId];
      if (
        !surface ||
        surface.content.kind !== "terminal" ||
        surface.content.sessionId !== session.id ||
        !workspace
      ) {
        throw new MainFactConflictError(
          "operation-missing",
          "session restart product ownership no longer matches"
        );
      }
      const cwd = locatedPathForTarget(
        workspace.location.target,
        product.launch.cwd
      );
      session.launch = {
        cwd,
        ...(product.launch.shell === undefined
          ? {}
          : { shell: product.launch.shell }),
        ...(product.launch.args === undefined
          ? {}
          : { args: [...product.launch.args] }),
        ...(product.launch.env === undefined
          ? {}
          : { env: { ...product.launch.env } }),
        ...(product.launch.title === undefined
          ? {}
          : { title: product.launch.title }),
        ...(session.launch.initialInput === undefined
          ? {}
          : { initialInput: session.launch.initialInput })
      };
      session.runtimeMetadata.cwd = cwd;
      if (product.launch.title?.trim()) {
        surface.title = product.launch.title.trim();
        surface.titleLocked = true;
      }
      markRemoteSessionRunning(
        state,
        projection,
        product.sessionId,
        product.surfaceId,
        fact.keeperGeneration!,
        fact.remoteResourceRevision
      );
      return;
    }
    case "session.adopt":
      // The bridge has now verified that this exact retained resource and
      // launch descriptor exist. Product layout ownership starts only here.
      applySessionOwnershipProductProjection(state, projection);
      markRemoteSessionRunning(
        state,
        projection,
        product.sessionId,
        product.surfaceId,
        fact.keeperGeneration!,
        fact.remoteResourceRevision
      );
      return;
    case "session.terminate": {
      const session = requireRemoteSessionForResourceKey(
        state,
        projection.resourceKey as RemoteResourceKey & { sessionId: Id }
      );
      session.runtimeStatus = {
        processState: "exited",
        observationState: "observed",
        attachmentState: "detached"
      };
      session.shellInputReady = false;
      delete session.pid;
      session.remoteRuntime = session.remoteRuntime
        ? {
            ...session.remoteRuntime,
            remoteResourceRevision: fact.remoteResourceRevision
          }
        : undefined;
      // A product-owned session termination is the durable half of closing
      // its surface. Apply the normal layout cleanup only after the remote
      // result is authoritative; ignore its local PTY effect because this
      // session is owned by the remote keeper.
      applyAction(state, {
        type: "surface.close",
        surfaceId: session.surfaceId
      });
      return;
    }
    case "workspace.create":
    case "workspace.terminate":
      return;
    case "worktree.create":
      applyAction(state, {
        type: "workspace.worktree.convert",
        workspaceId: projection.resourceKey.workspaceId,
        worktree: product.product.worktree,
        createSurface: false,
        focus: true
      });
      return;
    case "worktree.remove": {
      const workspace = requireMatchingWorkspaceWorktree(
        state,
        projection.resourceKey.workspaceId,
        product.product.expectedWorktree
      );
      workspace.worktree = undefined;
      return;
    }
    case undefined:
      if (projection.kind === "launch-input") {
        const session = requireRemoteSessionForResourceKey(
          state,
          projection.resourceKey as RemoteResourceKey & { sessionId: Id }
        );
        if (
          !session.remoteRuntime ||
          session.remoteRuntime.keeperGeneration !== fact.keeperGeneration
        ) {
          throw new MainFactConflictError(
            "remote-revision-conflict",
            "launch-input result belongs to another keeper generation"
          );
        }
        session.remoteRuntime = {
          ...session.remoteRuntime,
          remoteResourceRevision: fact.remoteResourceRevision
        };
      }
      return;
  }
}

function requireMatchingWorkspaceWorktree(
  state: AppState,
  workspaceId: Id,
  expected: Extract<
    RemoteWorktreeProductMetadata,
    { kind: "worktree.remove" }
  >["expectedWorktree"]
): AppState["workspaces"][string] {
  const workspace = state.workspaces[workspaceId];
  const current = workspace?.worktree;
  if (!workspace || !current) {
    throw new MainFactConflictError(
      "operation-missing",
      "worktree removal product ownership is missing"
    );
  }
  const target = workspace.location.target;
  const matches =
    current.name === expected.name &&
    sameLocatedPath(
      current.path,
      locatedPathForTarget(target, expected.path)
    ) &&
    sameLocatedPath(
      current.repoRoot,
      locatedPathForTarget(target, expected.repoRoot)
    ) &&
    sameLocatedPath(
      current.commonGitDir,
      locatedPathForTarget(target, expected.commonGitDir)
    ) &&
    current.baseRef === expected.baseRef &&
    current.branch === expected.branch &&
    current.createdByKmux === expected.createdByKmux;
  if (!matches) {
    throw new MainFactConflictError(
      "workspace-revision-conflict",
      "worktree removal product ownership changed before projection"
    );
  }
  return workspace;
}

function markRemoteSessionRunning(
  state: AppState,
  projection: RemoteOperationProjection,
  sessionId: Id,
  surfaceId: Id,
  keeperGeneration: Id,
  remoteResourceRevision: Uint64
): void {
  const session = requireRemoteSessionForResourceKey(
    state,
    projection.resourceKey as RemoteResourceKey & { sessionId: Id }
  );
  const surface = state.surfaces[surfaceId];
  if (
    session.id !== sessionId ||
    session.surfaceId !== surfaceId ||
    !surface ||
    surface.content.kind !== "terminal" ||
    surface.content.sessionId !== sessionId
  ) {
    throw new MainFactConflictError(
      "operation-missing",
      "remote session product identity no longer matches"
    );
  }
  session.runtimeStatus = {
    processState: "running",
    observationState: "observed",
    attachmentState: "detached"
  };
  session.remoteRuntime = {
    keeperGeneration,
    remoteResourceRevision
  };
  session.shellInputReady = true;
  delete session.pid;
  delete session.exitCode;
}

function rollbackFailedProductProjection(
  state: AppState,
  projection: RemoteOperationProjection
): void {
  const product = projection.pendingProduct;
  if (!product || product.kind !== "session.create") return;
  const session = state.sessions[product.sessionId];
  const surface = state.surfaces[product.surfaceId];
  const projectedPane = state.panes[product.product.projectedPaneId];
  const workspace = state.workspaces[projection.resourceKey.workspaceId];
  const direction =
    product.kind === "session.create" ? product.direction : undefined;
  if (
    !session ||
    !surface ||
    !projectedPane ||
    !workspace ||
    session.surfaceId !== surface.id ||
    surface.content.kind !== "terminal" ||
    surface.content.sessionId !== session.id ||
    surface.paneId !== projectedPane.id ||
    !projectedPane.surfaceIds.includes(surface.id) ||
    projectedPane.activeSurfaceId !== surface.id ||
    (direction !== undefined &&
      (projectedPane.surfaceIds.length !== 1 ||
        projectedPane.surfaceIds[0] !== surface.id)) ||
    (direction === undefined &&
      !projectedPane.surfaceIds.includes(
        product.product.previousActiveSurfaceId
      ))
  ) {
    throw new MainFactConflictError(
      "operation-missing",
      "failed session ownership cannot roll back a changed product projection"
    );
  }
  if (direction !== undefined) {
    validateDeterministicPaneLeafOwnership(
      workspace,
      product.product.splitLeafNodeId!,
      product.product.splitNodeId!
    );
  }
  projectedPane.surfaceIds = projectedPane.surfaceIds.filter(
    (surfaceId) => surfaceId !== surface.id
  );
  state.notifications = state.notifications.filter(
    (notification) => notification.surfaceId !== surface.id
  );
  delete state.sessions[session.id];
  delete state.surfaces[surface.id];

  if (direction !== undefined) {
    collapseDeterministicPaneLeaf(
      workspace,
      product.product.splitLeafNodeId!,
      product.product.splitNodeId!
    );
    delete state.panes[projectedPane.id];
  } else {
    projectedPane.activeSurfaceId = product.product.previousActiveSurfaceId;
  }
  if (state.panes[product.product.previousActivePaneId]) {
    workspace.activePaneId = product.product.previousActivePaneId;
  }
}

function assertKeeperGenerationForResult(
  projection: RemoteOperationProjection,
  keeperGeneration: Id | undefined
): void {
  const requiresKeeperGeneration =
    projection.kind === "session.create" ||
    projection.kind === "session.restart" ||
    projection.kind === "session.adopt" ||
    projection.kind === "launch-input";
  if (requiresKeeperGeneration !== (keeperGeneration !== undefined)) {
    throw new TypeError(
      requiresKeeperGeneration
        ? `${projection.kind} success requires a keeper generation`
        : `${projection.kind} success cannot contain a keeper generation`
    );
  }
}

function stableProductId(prefix: string, operationId: Id, role: string): Id {
  return `${prefix}_${createHash("sha256")
    .update(`kmux-product\0${role}\0${operationId}`, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}

function invalidProductInitialInput(kind: string): never {
  throw new TypeError(
    `product initial input is not valid for remote operation ${kind}`
  );
}

function findLeafIdForPane(
  workspace: AppState["workspaces"][string],
  paneId: Id
): Id | undefined {
  return Object.values(workspace.nodeMap).find(
    (node) => node.kind === "leaf" && node.paneId === paneId
  )?.id;
}

function insertDeterministicPaneLeafSplit(
  workspace: AppState["workspaces"][string],
  targetLeafId: Id,
  paneId: Id,
  direction: SplitDirection,
  newLeafId: Id,
  splitId: Id
): void {
  const axis =
    direction === "left" || direction === "right"
      ? ("vertical" as const)
      : ("horizontal" as const);
  replaceNodeReference(workspace, targetLeafId, splitId);
  workspace.nodeMap[splitId] =
    direction === "left" || direction === "up"
      ? {
          id: splitId,
          kind: "split",
          axis,
          ratio: 0.5,
          first: newLeafId,
          second: targetLeafId
        }
      : {
          id: splitId,
          kind: "split",
          axis,
          ratio: 0.5,
          first: targetLeafId,
          second: newLeafId
        };
  workspace.nodeMap[newLeafId] = {
    id: newLeafId,
    kind: "leaf",
    paneId
  };
}

function collapseDeterministicPaneLeaf(
  workspace: AppState["workspaces"][string],
  leafId: Id,
  expectedParentId: Id
): void {
  validateDeterministicPaneLeafOwnership(workspace, leafId, expectedParentId);
  const parent = workspace.nodeMap[expectedParentId];
  if (parent.kind !== "split") return;
  const siblingId = parent.first === leafId ? parent.second : parent.first;
  replaceNodeReference(workspace, parent.id, siblingId);
  delete workspace.nodeMap[parent.id];
  delete workspace.nodeMap[leafId];
}

function validateDeterministicPaneLeafOwnership(
  workspace: AppState["workspaces"][string],
  leafId: Id,
  expectedParentId: Id
): void {
  const leaf = workspace.nodeMap[leafId];
  const parent = workspace.nodeMap[expectedParentId];
  if (
    leaf?.kind !== "leaf" ||
    parent?.kind !== "split" ||
    (parent.first !== leafId && parent.second !== leafId)
  ) {
    throw new MainFactConflictError(
      "workspace-revision-conflict",
      "failed session split no longer owns its layout nodes"
    );
  }
}

function replaceNodeReference(
  workspace: AppState["workspaces"][string],
  targetNodeId: Id,
  replacementNodeId: Id
): void {
  if (workspace.rootNodeId === targetNodeId) {
    workspace.rootNodeId = replacementNodeId;
  }
  for (const node of Object.values(workspace.nodeMap)) {
    if (node.kind !== "split") continue;
    if (node.first === targetNodeId) node.first = replacementNodeId;
    if (node.second === targetNodeId) node.second = replacementNodeId;
  }
}

function requireProjection(
  state: AppState,
  operationId: Id
): RemoteOperationProjection {
  const projection = state.remoteOperations[operationId];
  if (!projection) {
    throw new MainFactConflictError(
      "operation-missing",
      `operation ${operationId} has not been projected as pending`
    );
  }
  return projection;
}

function requireRemoteSessionForResourceKey(
  state: AppState,
  resourceKey: RemoteResourceKey & { sessionId: Id }
): AppState["sessions"][string] {
  const workspace = state.workspaces[resourceKey.workspaceId];
  if (!workspace) {
    throw new MainFactConflictError(
      "workspace-missing",
      `workspace ${resourceKey.workspaceId} does not exist`
    );
  }
  if (
    workspace.location.target.kind !== "ssh" ||
    workspace.location.target.targetId !== resourceKey.targetId
  ) {
    throw new MainFactConflictError(
      "target-mismatch",
      "remote session observation target does not match its workspace"
    );
  }
  const session = state.sessions[resourceKey.sessionId];
  const surface = session ? state.surfaces[session.surfaceId] : undefined;
  const pane = surface ? state.panes[surface.paneId] : undefined;
  if (!session || !surface || !pane || pane.workspaceId !== workspace.id) {
    throw new MainFactConflictError(
      "operation-missing",
      "remote session observation does not match a workspace session"
    );
  }
  return session;
}

function validateExitCode(value: number | undefined): number | undefined {
  if (value !== undefined && !Number.isSafeInteger(value)) {
    throw new TypeError("remote session exit code must be a safe integer");
  }
  return value;
}

function validateRemoteSessionStorageStatus(
  value: RemoteSessionStorageStatus
): RemoteSessionStorageStatus {
  if (
    !value ||
    (value.state !== "normal" &&
      value.state !== "degraded" &&
      value.state !== "backpressured") ||
    typeof value.journalAdmitted !== "bigint" ||
    typeof value.journalSynced !== "bigint" ||
    value.journalSynced > value.journalAdmitted ||
    !Number.isSafeInteger(value.emergencyBytes) ||
    value.emergencyBytes < 0 ||
    value.emergencyBytes > 4 * 1024 * 1024 ||
    (value.lastSyncDurationMs !== undefined &&
      (!Number.isSafeInteger(value.lastSyncDurationMs) ||
        value.lastSyncDurationMs < 0))
  ) {
    throw new TypeError("remote session storage status is invalid");
  }
  return {
    state: value.state,
    journalAdmitted: parseUint64Decimal(value.journalAdmitted.toString(10)),
    journalSynced: parseUint64Decimal(value.journalSynced.toString(10)),
    emergencyBytes: value.emergencyBytes,
    ...(value.lastSyncDurationMs === undefined
      ? {}
      : { lastSyncDurationMs: value.lastSyncDurationMs })
  };
}

function sameRemoteSessionStorageStatus(
  left: RemoteSessionStorageStatus | undefined,
  right: RemoteSessionStorageStatus
): boolean {
  return Boolean(
    left &&
    left.state === right.state &&
    left.journalAdmitted === right.journalAdmitted &&
    left.journalSynced === right.journalSynced &&
    left.emergencyBytes === right.emergencyBytes &&
    left.lastSyncDurationMs === right.lastSyncDurationMs
  );
}

function terminalConflict(operationId: Id): MainFactConflictError {
  return new MainFactConflictError(
    "operation-terminal",
    `operation ${operationId} already has a different terminal result`
  );
}

function entriesForWorkspace(
  state: AppState,
  workspaceId: Id,
  encodedValue: unknown
): Record<string, unknown> {
  return filterRecord(encodedValue, (_value, id) => {
    return state.panes[id]?.workspaceId === workspaceId;
  });
}

function filterRecord(
  value: unknown,
  predicate: (value: unknown, key: string) => boolean
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(readRecord(value))
      .filter(([key, entry]) => predicate(entry, key))
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readStringProperty(value: unknown, key: string): string | undefined {
  const candidate = readRecord(value)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function sameOperationAdmission(
  left: RemoteOperationProjection,
  right: RemoteOperationProjection
): boolean {
  const admission = (projection: RemoteOperationProjection) => ({
    operationId: projection.operationId,
    kind: projection.kind,
    resourceKey: projection.resourceKey,
    expectedWorkspaceRevision: projection.expectedWorkspaceRevision,
    expectedRemoteResourceRevision:
      projection.expectedRemoteResourceRevision.toString(10),
    nextRemoteResourceRevision:
      projection.nextRemoteResourceRevision.toString(10),
    canonicalPayloadHash: projection.canonicalPayloadHash,
    pendingProduct: projection.pendingProduct,
    createdAt: projection.createdAt
  });
  return canonicalJson(admission(left)) === canonicalJson(admission(right));
}

function changed(): ApplyMainFactResult {
  return {
    effects: [{ type: "persist" }],
    mutation: {
      workspaceRows: true,
      activeWorkspaceActivity: true,
      activeWorkspacePaneTree: true
    },
    applied: true
  };
}

function noChange(): ApplyMainFactResult {
  return { effects: [], mutation: {}, applied: false };
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("workspace revision contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("workspace revision contains an unsupported value");
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[]
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unexpected) {
    throw new TypeError(`unexpected Main fact field: ${unexpected}`);
  }
}

function requireString(
  value: unknown,
  field: string,
  maxBytes: number
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (new TextEncoder().encode(value).byteLength > maxBytes) {
    throw new RangeError(`${field} exceeds its byte limit`);
  }
  return value;
}

function requireDigest(value: unknown, field: string): string {
  const digest = requireString(value, field, 64);
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new TypeError(`${field} must be a SHA-256 digest`);
  }
  return digest;
}

function requireTimestamp(value: unknown, field: string): string {
  const timestamp = requireString(value, field, 64);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  return timestamp;
}
