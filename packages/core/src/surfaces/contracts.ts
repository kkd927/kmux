import type {
  ExternalAgentSessionRef,
  Id,
  SessionLaunchConfig,
  SplitDirection,
  SurfaceKind
} from "@kmux/proto";

import type {
  LocatedPath,
  LocatedWorkspaceGitRepositoryMetadata
} from "../domain";

export interface TerminalSurfaceContent {
  kind: "terminal";
  sessionId: Id;
}

export interface MarkdownFileSource {
  kind: "file";
  path: LocatedPath;
}

export interface MarkdownSurfaceContent {
  kind: "markdown";
  source: MarkdownFileSource;
}

export type SurfaceContentMap = {
  terminal: TerminalSurfaceContent;
  markdown: MarkdownSurfaceContent;
};

export type SurfaceContentOf<K extends SurfaceKind = SurfaceKind> =
  SurfaceContentMap[K];

export type SurfaceContent = SurfaceContentOf;

export interface SurfaceState<K extends SurfaceKind = SurfaceKind> {
  id: Id;
  paneId: Id;
  title: string;
  titleLocked: boolean;
  unreadCount: number;
  attention: boolean;
  content: SurfaceContentOf<K>;
}

export interface TerminalRuntimeMetadata {
  cwd: LocatedPath;
  branch?: string;
  gitRepository?: LocatedWorkspaceGitRepositoryMetadata;
  ports: number[];
}

export interface TerminalSurfaceInit {
  kind: "terminal";
  title?: string;
  cwd?: string;
  launch?: SessionLaunchConfig;
  agentSessionRef?: ExternalAgentSessionRef;
}

export interface MarkdownSurfaceInit {
  kind: "markdown";
  path: LocatedPath;
  title: string;
}

export type SurfaceInitMap = {
  terminal: TerminalSurfaceInit;
  markdown: MarkdownSurfaceInit;
};

export type SurfaceInit<K extends SurfaceKind = SurfaceKind> =
  SurfaceInitMap[K];

export type SurfacePlacementRequest =
  | { kind: "tab"; paneId: Id }
  | { kind: "split"; paneId: Id; direction: SplitDirection }
  | { kind: "right-preview"; sourceSurfaceId: Id };

export interface SurfaceOpenAction {
  type: "surface.open";
  workspaceId: Id;
  init: SurfaceInit;
  placement: SurfacePlacementRequest;
}
