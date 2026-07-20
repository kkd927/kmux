import type {
  LocatedPath,
  LocalPath,
  RemotePath,
  SessionLaunchConfig,
  WorkspaceTarget
} from "@kmux/core";
import type {
  Id,
  TerminalKeyInput,
  WorkspaceWorktreeMetadata
} from "@kmux/proto";
import type {
  UsageAdapterDirtyOptions,
  UsageHistoryDay,
  UsageVendor
} from "@kmux/metadata";

export interface GitRepositoryInspection<TPath extends LocalPath | RemotePath> {
  repository?: {
    root: TPath;
    gitDir: TPath;
    commonGitDir: TPath;
    linkedWorktree: boolean;
  };
  branch?: string;
  dirtyEntries: string[];
  dirtyEntriesTruncated: boolean;
  branchExists?: boolean;
}

export type TargetMutationResult =
  | { status: "succeeded" }
  | { status: "pending"; reason: "offline" | "timeout" | "ambiguous" }
  | { status: "failed"; code: string; message: string };

export interface ResolvedFilePath<TPath extends LocalPath | RemotePath> {
  path: TPath;
  displayPath: string;
}

export interface StagedLocalFile {
  localPath: LocalPath;
  byteLength: number;
  sha256: string;
}

export interface TargetHistoryRecord<
  TPath extends LocalPath | RemotePath | LocatedPath
> {
  vendor: "codex" | "claude" | "antigravity";
  sessionId: string;
  updatedAtUnixMs: number;
  canResume: boolean;
  cwd?: TPath;
  title?: string;
  recentConversation?: string;
  model?: string;
  createdAt?: string;
  updatedAt?: string;
  principal?: { uid: number; accountName: string };
}

export interface TargetUsageRecord<
  TPath extends LocalPath | RemotePath | LocatedPath
> {
  vendor: Exclude<UsageVendor, "unknown">;
  sampleId: string;
  timestampUnixMs: number;
  sessionId?: string;
  threadId?: string;
  requestId?: string;
  eventId?: string;
  model?: string;
  cwd?: TPath;
  projectPath?: TPath;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWriteTokensKnown?: boolean;
  cacheTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  costSource?: "reported" | "estimated" | "unavailable";
}

export interface TargetUsageScan<
  TPath extends LocalPath | RemotePath | LocatedPath
> {
  records: TargetUsageRecord<TPath>[];
  truncated: boolean;
  principal?: { uid: number; accountName: string };
  historyDays?: UsageHistoryDay[];
}

export interface StoredAttachment<TPath extends LocalPath | RemotePath> {
  path: TPath;
  terminalReference: string;
}

export interface ForwardMapping {
  forwardId: Id;
  workspaceId: Id;
  remoteHost: string;
  remotePort: number;
  localBindHost: "127.0.0.1" | "::1";
  localPort: number;
  status: "active" | "pending";
}

export interface TerminalControlProvider<TPath extends LocalPath | RemotePath> {
  create(request: {
    workspaceId: Id;
    paneId: Id;
    launch: SessionLaunchConfig<TPath>;
  }): Promise<void>;
  terminate(request: { operationId: Id; sessionId: Id }): Promise<void>;
  sendText(sessionId: Id, text: string): Promise<void>;
  sendKey(sessionId: Id, input: TerminalKeyInput): Promise<void>;
}

export interface GitProvider<TPath extends LocalPath | RemotePath> {
  inspect(
    cwd: TPath,
    options?: { dirtyLimit?: number; branch?: string }
  ): Promise<GitRepositoryInspection<TPath>>;
  managedWorktreeRoot(): TPath;
  createWorktree(request: {
    workspaceId: Id;
    cwd: TPath;
    path: TPath;
    branch: string;
    baseRef: string;
    product: WorkspaceWorktreeMetadata;
  }): Promise<TargetMutationResult>;
  removeWorktree(request: {
    workspaceId: Id;
    cwd: TPath;
    path: TPath;
    force: boolean;
    expectedWorktree: WorkspaceWorktreeMetadata;
  }): Promise<TargetMutationResult>;
}

export interface FileProvider<TPath extends LocalPath | RemotePath> {
  exists(path: TPath): Promise<boolean>;
  read(path: TPath, options: { maxBytes: number }): Promise<Uint8Array>;
  join(base: TPath, ...segments: string[]): TPath;
  dirname(path: TPath): TPath;
  basename(path: TPath): string;
  display(path: TPath): string;
  resolveTerminalPath(request: {
    cwd?: TPath;
    rawPath: string;
  }): Promise<ResolvedFilePath<TPath> | null>;
  stageForLocalOpen(
    path: TPath,
    options: { maxBytes: number }
  ): Promise<StagedLocalFile>;
}

export interface MetadataProvider<TPath extends LocalPath | RemotePath> {
  refresh(request: { surfaceId: Id; cwd?: TPath; pid?: number }): void;
}

export interface HistoryProvider<TPath extends LocalPath | RemotePath> {
  refresh(request: {
    maxRecords: number;
  }): Promise<TargetHistoryRecord<TPath>[]>;
}

export interface UsageProvider<TPath extends LocalPath | RemotePath> {
  refresh(request: {
    startAtUnixMs: number;
    initial: boolean;
    maxRecords: number;
    historyRange?: { fromMs: number; toMs: number };
  }): Promise<TargetUsageScan<TPath>>;
  watch?(onChange: (vendor: UsageVendor) => void): () => void;
  markDirty?(
    vendor: Exclude<UsageVendor, "unknown">,
    options?: UsageAdapterDirtyOptions
  ): void;
  close?(): void;
}

export interface PortProvider {
  list(sessionId: Id): Promise<number[]>;
  remapBrowserUrl(request: {
    workspaceId: Id;
    url: URL;
  }): Promise<{ url: URL; mapping?: ForwardMapping }>;
  closeWorkspace(workspaceId: Id): Promise<void>;
}

export interface AttachmentProvider<TPath extends LocalPath | RemotePath> {
  store(request: {
    workspaceId: Id;
    sessionId: Id;
    cwd: TPath;
    bytes: Uint8Array;
    name?: string;
  }): Promise<StoredAttachment<TPath>>;
}

export interface TargetServiceSet<TPath extends LocalPath | RemotePath> {
  terminal: TerminalControlProvider<TPath>;
  git: GitProvider<TPath>;
  files: FileProvider<TPath>;
  metadata: MetadataProvider<TPath>;
  history: HistoryProvider<TPath>;
  usage: UsageProvider<TPath>;
  ports: PortProvider;
  attachments: AttachmentProvider<TPath>;
}

export type ResolvedTargetServices =
  | {
      target: { kind: "local" };
      services: TargetServiceSet<LocalPath>;
    }
  | {
      target: { kind: "ssh"; targetId: Id };
      services: TargetServiceSet<RemotePath>;
    };

export interface TargetServiceRegistry {
  resolve(target: WorkspaceTarget): ResolvedTargetServices;
  resolveLocated(target: WorkspaceTarget): LocatedTargetServiceSet;
}

export interface LocatedGitRepositoryInspection {
  repository?: {
    root: LocatedPath;
    gitDir: LocatedPath;
    commonGitDir: LocatedPath;
    linkedWorktree: boolean;
  };
  branch?: string;
  dirtyEntries: string[];
  dirtyEntriesTruncated: boolean;
  branchExists?: boolean;
}

export interface LocatedTargetServiceSet {
  terminal: {
    create(request: {
      workspaceId: Id;
      paneId: Id;
      launch: {
        cwd: LocatedPath;
        shell?: string;
        args?: string[];
        initialInput?: string;
        env?: Record<string, string>;
        title?: string;
      };
    }): Promise<void>;
    terminate(request: { operationId: Id; sessionId: Id }): Promise<void>;
    sendText(sessionId: Id, text: string): Promise<void>;
    sendKey(sessionId: Id, input: TerminalKeyInput): Promise<void>;
  };
  git: {
    inspect(
      cwd: LocatedPath,
      options?: { dirtyLimit?: number; branch?: string }
    ): Promise<LocatedGitRepositoryInspection>;
    managedWorktreeRoot(): LocatedPath;
    createWorktree(request: {
      workspaceId: Id;
      cwd: LocatedPath;
      path: LocatedPath;
      branch: string;
      baseRef: string;
      product: WorkspaceWorktreeMetadata;
    }): Promise<TargetMutationResult>;
    removeWorktree(request: {
      workspaceId: Id;
      cwd: LocatedPath;
      path: LocatedPath;
      force: boolean;
      expectedWorktree: WorkspaceWorktreeMetadata;
    }): Promise<TargetMutationResult>;
  };
  files: {
    exists(path: LocatedPath): Promise<boolean>;
    read(path: LocatedPath, options: { maxBytes: number }): Promise<Uint8Array>;
    join(base: LocatedPath, ...segments: string[]): LocatedPath;
    dirname(path: LocatedPath): LocatedPath;
    basename(path: LocatedPath): string;
    display(path: LocatedPath): string;
    resolveTerminalPath(request: {
      cwd?: LocatedPath;
      rawPath: string;
    }): Promise<{ path: LocatedPath; displayPath: string } | null>;
    stageForLocalOpen(
      path: LocatedPath,
      options: { maxBytes: number }
    ): Promise<StagedLocalFile>;
  };
  metadata: {
    refresh(request: { surfaceId: Id; cwd?: LocatedPath; pid?: number }): void;
  };
  history: {
    refresh(request: {
      maxRecords: number;
    }): Promise<TargetHistoryRecord<LocatedPath>[]>;
  };
  usage: {
    refresh(request: {
      startAtUnixMs: number;
      initial: boolean;
      maxRecords: number;
      historyRange?: { fromMs: number; toMs: number };
    }): Promise<TargetUsageScan<LocatedPath>>;
    watch?(onChange: (vendor: UsageVendor) => void): () => void;
    markDirty?(
      vendor: Exclude<UsageVendor, "unknown">,
      options?: UsageAdapterDirtyOptions
    ): void;
    close?(): void;
  };
  ports: PortProvider;
  attachments: {
    store(request: {
      workspaceId: Id;
      sessionId: Id;
      cwd: LocatedPath;
      bytes: Uint8Array;
      name?: string;
    }): Promise<{ path: LocatedPath; terminalReference: string }>;
  };
}
