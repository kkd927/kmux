import { randomUUID } from "node:crypto";

export type Id = string;

export type SocketMode = "kmuxOnly" | "allowAll" | "off";
export type SplitAxis = "horizontal" | "vertical";
export type SplitDirection = "left" | "right" | "up" | "down";
export type NotificationSource = "bell" | "socket" | "status" | "system";
export type SessionRuntimeState = "pending" | "running" | "exited";
export type SidebarLogLevel = "info" | "warn" | "error";

export interface SessionLaunchConfig {
  cwd?: string;
  shell?: string;
  args?: string[];
  env?: Record<string, string>;
  title?: string;
}

export interface SidebarProgress {
  value: number;
  label?: string;
}

export interface SidebarLogEntry {
  id: Id;
  level: SidebarLogLevel;
  message: string;
  createdAt: string;
}

export interface WorkspaceRowVm {
  workspaceId: Id;
  name: string;
  nameLocked: boolean;
  summary: string;
  cwd?: string;
  branch?: string;
  ports: number[];
  statusText?: string;
  unreadCount: number;
  attention: boolean;
  pinned: boolean;
  isActive: boolean;
}

export interface NotificationItem {
  id: Id;
  workspaceId: Id;
  paneId?: Id;
  surfaceId?: Id;
  title: string;
  message: string;
  source: NotificationSource;
  createdAt: string;
  read: boolean;
}

export interface TerminalKeyInput {
  key: string;
  text?: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

export interface SurfaceSnapshotPayload {
  surfaceId: Id;
  sessionId: Id;
  sequence: number;
  vt: string;
  title: string;
  cwd?: string;
  branch?: string;
  ports: number[];
  unreadCount: number;
  attention: boolean;
}

export interface SurfaceChunkPayload {
  surfaceId: Id;
  sessionId: Id;
  sequence: number;
  chunk: string;
}

export interface SurfaceExitPayload {
  surfaceId: Id;
  sessionId: Id;
  exitCode?: number;
}

export interface SurfaceMetadataPayload {
  surfaceId: Id;
  cwd?: string;
  title?: string;
  branch?: string;
  ports?: number[];
  attention?: boolean;
  unreadDelta?: number;
}

export interface PtySessionSpec {
  sessionId: Id;
  surfaceId: Id;
  workspaceId: Id;
  launch: SessionLaunchConfig;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

export type PtyRequest =
  | { type: "spawn"; spec: PtySessionSpec }
  | { type: "close"; sessionId: Id }
  | { type: "resize"; sessionId: Id; cols: number; rows: number }
  | { type: "input:text"; sessionId: Id; text: string }
  | { type: "input:key"; sessionId: Id; input: TerminalKeyInput }
  | { type: "snapshot"; sessionId: Id; surfaceId: Id; requestId: Id };

export type PtyEvent =
  | { type: "ready" }
  | { type: "spawned"; sessionId: Id; pid: number }
  | { type: "snapshot"; requestId: Id; payload: SurfaceSnapshotPayload }
  | { type: "chunk"; payload: SurfaceChunkPayload }
  | { type: "metadata"; payload: SurfaceMetadataPayload }
  | { type: "bell"; surfaceId: Id; sessionId: Id; title: string; cwd?: string }
  | { type: "exit"; payload: SurfaceExitPayload }
  | { type: "error"; sessionId?: Id; message: string };

export interface JsonRpcEnvelope<T = unknown> {
  jsonrpc: "2.0";
  id?: Id;
  method?: string;
  params?: T;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

export type ThemeMode = "dark" | "light" | "system";

export interface KmuxSettings {
  socketMode: SocketMode;
  startupRestore: boolean;
  notificationDesktop: boolean;
  notificationSound: boolean;
  themeMode: ThemeMode;
  shell?: string;
  shortcuts: Record<string, string>;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalLineHeight: number;
}

export interface PaneLeafNode {
  id: Id;
  kind: "leaf";
  paneId: Id;
}

export interface PaneSplitNode {
  id: Id;
  kind: "split";
  axis: SplitAxis;
  ratio: number;
  first: Id;
  second: Id;
}

export type PaneTreeNode = PaneLeafNode | PaneSplitNode;

export interface SurfaceVm {
  id: Id;
  title: string;
  cwd?: string;
  branch?: string;
  ports: number[];
  unreadCount: number;
  attention: boolean;
  sessionState: SessionRuntimeState;
  exitCode?: number;
}

export interface PaneVm {
  id: Id;
  surfaceIds: Id[];
  activeSurfaceId: Id;
  focused: boolean;
}

export interface ActiveWorkspaceVm {
  id: Id;
  name: string;
  rootNodeId: Id;
  nodes: Record<Id, PaneTreeNode>;
  panes: Record<Id, PaneVm>;
  surfaces: Record<Id, SurfaceVm>;
  activePaneId: Id;
  sidebarStatus?: string;
  progress?: SidebarProgress;
  logs: SidebarLogEntry[];
}

export interface ShellViewModel {
  windowId: Id;
  title: string;
  sidebarVisible: boolean;
  sidebarWidth: number;
  workspaceRows: WorkspaceRowVm[];
  activeWorkspace: ActiveWorkspaceVm;
  notifications: NotificationItem[];
  unreadNotifications: number;
  settings: KmuxSettings;
}

export interface ShellIdentity {
  socketPath: string;
  socketMode: SocketMode;
  windowId: Id;
  activeWorkspaceId: Id;
  activeSurfaceId: Id;
  capabilities: string[];
}

export function makeId(prefix: string): Id {
  return `${prefix}_${randomUUID()}`;
}

export function isoNow(date = new Date()): string {
  return date.toISOString();
}
