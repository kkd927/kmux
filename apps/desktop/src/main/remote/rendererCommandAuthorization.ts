import type { AppAction, AppState, WorkspaceTarget } from "@kmux/core";
import type { RemoteRendererLifecycleAction } from "./remoteLifecycleRuntime";

const PUBLIC_RENDERER_ACTION_TYPES = new Set<AppAction["type"]>([
  "workspace.create",
  "workspace.select",
  "workspace.selectRelative",
  "workspace.selectIndex",
  "workspace.rename",
  "workspace.close",
  "workspace.closeOthers",
  "workspace.pin.toggle",
  "workspace.move",
  "workspace.worktree.convert",
  "workspace.worktree.detected",
  "workspace.worktree.dismissDetected",
  "workspace.worktree.clearDetected",
  "workspace.sidebar.toggle",
  "workspace.sidebar.setWidth",
  "pane.split",
  "pane.focus",
  "pane.focusDirection",
  "pane.resize",
  "pane.setSplitRatio",
  "pane.close",
  "surface.create",
  "surface.focus",
  "surface.moveToSplit",
  "surface.focusRelative",
  "surface.focusIndex",
  "surface.rename",
  "surface.close",
  "surface.closeOthers",
  "surface.restartSession",
  "surface.metadata",
  "sidebar.setStatus",
  "sidebar.clearStatus",
  "sidebar.setProgress",
  "sidebar.clearProgress",
  "sidebar.log",
  "sidebar.clearLog",
  "notification.create",
  "agent.event",
  "agent.attention.clear",
  "notification.clear",
  "notification.jumpLatestUnread",
  "terminal.bell",
  "settings.update"
]);

/** Keeps legacy generic dispatch local-only for resource lifecycle changes. */
export function authorizeRendererAppAction(
  value: unknown,
  state: AppState
): AppAction {
  const action = decodeRendererAppAction(value);
  validateRemoteLayoutAction(action, state);
  if (touchesRemoteLifecycle(action, state)) {
    throw new Error(
      "SSH resource lifecycle commands must use the durable remote operation coordinator"
    );
  }
  return action;
}

export type RendererAppActionRoute =
  | { kind: "local"; action: AppAction }
  | { kind: "remote-lifecycle"; action: RemoteRendererLifecycleAction };

export function routeRendererAppAction(
  value: unknown,
  state: AppState
): RendererAppActionRoute {
  const action = decodeRendererAppAction(value);
  validateRemoteLayoutAction(action, state);
  if (!touchesRemoteLifecycle(action, state)) {
    return { kind: "local", action };
  }
  if (isRemoteRendererLifecycleAction(action)) {
    return { kind: "remote-lifecycle", action };
  }
  throw new Error(
    "SSH resource lifecycle commands must use a dedicated Main-owned workflow"
  );
}

function decodeRendererAppAction(value: unknown): AppAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("renderer action must be an object");
  }
  const type = (value as { type?: unknown }).type;
  if (
    typeof type !== "string" ||
    !PUBLIC_RENDERER_ACTION_TYPES.has(type as AppAction["type"])
  ) {
    throw new Error("renderer action type is not allowlisted");
  }
  return value as AppAction;
}

function touchesRemoteLifecycle(action: AppAction, state: AppState): boolean {
  switch (action.type) {
    case "workspace.create":
      return action.target?.kind === "ssh";
    case "workspace.close":
    case "workspace.worktree.convert":
      return isSshTarget(state.workspaces[action.workspaceId]?.location.target);
    case "workspace.closeOthers":
      return Object.values(state.workspaces).some(
        (workspace) =>
          workspace.id !== action.workspaceId &&
          isSshTarget(workspace.location.target)
      );
    case "pane.split":
    case "pane.close":
      return isSshPane(state, action.paneId);
    case "surface.create":
      return isSshPane(state, action.paneId);
    case "surface.close":
    case "surface.closeOthers":
    case "surface.restartSession":
      return isSshSurface(state, action.surfaceId);
    default:
      return false;
  }
}

function isRemoteRendererLifecycleAction(
  action: AppAction
): action is RemoteRendererLifecycleAction {
  return (
    action.type === "pane.split" ||
    action.type === "pane.close" ||
    action.type === "surface.create" ||
    action.type === "surface.close" ||
    action.type === "surface.closeOthers" ||
    action.type === "surface.restartSession"
  );
}

function validateRemoteLayoutAction(action: AppAction, state: AppState): void {
  if (
    action.type !== "surface.moveToSplit" ||
    !isSshSurface(state, action.surfaceId)
  ) {
    return;
  }
  const pendingOwnership = Object.values(state.remoteOperations).some(
    (operation) =>
      operation.state === "pending" &&
      operation.pendingProduct?.kind === "session.create" &&
      operation.pendingProduct.surfaceId === action.surfaceId
  );
  if (pendingOwnership) {
    throw new Error(
      "a pending SSH surface cannot move before its create operation settles"
    );
  }
}

function isSshSurface(state: AppState, surfaceId: string): boolean {
  const surface = state.surfaces[surfaceId];
  return surface ? isSshPane(state, surface.paneId) : false;
}

function isSshPane(state: AppState, paneId: string): boolean {
  const pane = state.panes[paneId];
  return pane
    ? isSshTarget(state.workspaces[pane.workspaceId]?.location.target)
    : false;
}

function isSshTarget(target: WorkspaceTarget | undefined): boolean {
  return target?.kind === "ssh";
}
