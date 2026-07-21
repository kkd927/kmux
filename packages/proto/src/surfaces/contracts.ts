import type {
  Id,
  SessionRuntimeState,
  SurfaceStorageStatusVm,
  WorkspaceGitRepositoryMetadata
} from "../index";

export type SurfaceKind = "terminal";

export interface SurfaceVmCommon {
  id: Id;
  paneId: Id;
  title: string;
  titleLocked: boolean;
  unreadCount: number;
  attention: boolean;
}

export interface TerminalRuntimeMetadataDto {
  cwd?: string;
  branch?: string;
  gitRepository?: WorkspaceGitRepositoryMetadata;
  ports: number[];
}

export interface TerminalSurfaceVmContent {
  kind: "terminal";
  sessionId: Id;
  runtimeStatus: SessionRuntimeState;
  shellInputReady: boolean;
  exitCode?: number;
  storageStatus?: SurfaceStorageStatusVm;
  runtimeMetadata: TerminalRuntimeMetadataDto;
}

export type SurfaceVmContentMap = {
  terminal: TerminalSurfaceVmContent;
};

export type SurfaceVm<K extends SurfaceKind = SurfaceKind> = SurfaceVmCommon & {
  content: SurfaceVmContentMap[K];
};
