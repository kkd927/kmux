import type { AppAction } from "@kmux/core";
import type { SmoothnessProfileEvent } from "../../shared/smoothnessProfile";
import type {
  CreateImageAttachmentPayload,
  CreateImageAttachmentsResult,
  ExternalAgentSessionResumeResult,
  ExternalAgentSessionsSnapshot,
  ImportedTerminalThemePalette,
  TerminalColorPalette,
  ResolvedTerminalTypographyVm,
  ShellPatch,
  ShellIdentity,
  ShellStoreSnapshot,
  UsageViewSnapshot,
  SurfaceAttachCompletionResult,
  SurfaceAttachPayload,
  SurfaceSnapshotOptions,
  SurfaceSnapshotPayload,
  TerminalTypographyProbeReport,
  TerminalTypographySettings,
  TerminalKeyInput,
  UpdaterState,
  WorktreeConversionPreview,
  WorktreeBulkRemoveResult,
  WorktreeRemoveResult,
  WorkspaceWorktreeMetadata
} from "@kmux/proto";
import type { TerminalEvent } from "../../preload/index";

declare global {
  interface Window {
    kmux: {
      getShellState(): Promise<ShellStoreSnapshot>;
      getUsageView(): Promise<UsageViewSnapshot>;
      getExternalAgentSessions(): Promise<ExternalAgentSessionsSnapshot>;
      resumeExternalAgentSession(
        key: string
      ): Promise<ExternalAgentSessionResumeResult>;
      getUpdaterState(): Promise<UpdaterState>;
      dispatch(action: AppAction): Promise<void>;
      subscribeShellPatches(listener: (patch: ShellPatch) => void): () => void;
      subscribeUsage(
        listener: (snapshot: UsageViewSnapshot) => void
      ): () => void;
      subscribeUpdater(listener: (state: UpdaterState) => void): () => void;
      subscribeTerminal(listener: (event: TerminalEvent) => void): () => void;
      attachSurface(surfaceId: string): Promise<SurfaceAttachPayload | null>;
      completeAttachSurface(
        surfaceId: string,
        attachId: string
      ): Promise<SurfaceAttachCompletionResult>;
      detachSurface(surfaceId: string): Promise<void>;
      sendText(surfaceId: string, text: string): Promise<void>;
      sendKey(surfaceId: string, input: TerminalKeyInput): Promise<void>;
      createImageAttachments(
        surfaceId: string,
        payloads: CreateImageAttachmentPayload[]
      ): Promise<CreateImageAttachmentsResult>;
      readClipboardImages(): CreateImageAttachmentPayload[];
      resizeSurface(
        surfaceId: string,
        attachId: string | null,
        cols: number,
        rows: number
      ): Promise<void>;
      listTerminalFontFamilies(): Promise<string[]>;
      previewTerminalTypography(
        settings: TerminalTypographySettings
      ): Promise<ResolvedTerminalTypographyVm>;
      reportTerminalTypographyProbe(
        report: TerminalTypographyProbeReport
      ): Promise<void>;
      importTerminalThemePalette(): Promise<ImportedTerminalThemePalette | null>;
      exportTerminalThemePalette(
        suggestedName: string,
        palette: TerminalColorPalette
      ): Promise<boolean>;
      openSettingsJson(): Promise<void>;
      readClipboardText(): string;
      writeClipboardText(text: string): void;
      windowControl(
        action: "minimize" | "maximize" | "fullscreen" | "close"
      ): Promise<void>;
      showWorkspaceContextMenu(
        workspaceId: string,
        x: number,
        y: number
      ): Promise<boolean>;
      subscribeWorkspaceRenameRequest(
        listener: (workspaceId: string) => void
      ): () => void;
      subscribeWorkspaceCloseRequest(
        listener: (workspaceId: string) => void
      ): () => void;
      subscribeWorkspaceCloseOthersRequest(
        listener: (workspaceId: string) => void
      ): () => void;
      subscribeWorkspaceWorktreeConvertRequest(
        listener: (workspaceId: string) => void
      ): () => void;
      prepareWorktreeConversion(
        workspaceId: string
      ): Promise<WorktreeConversionPreview | null>;
      createWorktreeWorkspace(
        workspaceId: string,
        name: string
      ): Promise<WorkspaceWorktreeMetadata>;
      convertDetectedWorktree(
        workspaceId: string
      ): Promise<WorkspaceWorktreeMetadata>;
      removeWorkspaceWorktree(
        workspaceId: string,
        force: boolean
      ): Promise<WorktreeRemoveResult>;
      removeWorkspaceWorktrees(
        workspaceIds: string[],
        force: boolean
      ): Promise<WorktreeBulkRemoveResult>;
      identify(): Promise<ShellIdentity>;
      setUsageDashboardOpen(open: boolean): Promise<void>;
      downloadAvailableUpdate(): Promise<void>;
      installDownloadedUpdate(): Promise<void>;
      profileSmoothnessEnabled(): boolean;
      recordSmoothnessProfileEvent(
        event: SmoothnessProfileEvent
      ): Promise<void>;
    };
    kmuxTest?: {
      snapshotSurface(
        surfaceId: string,
        options?: SurfaceSnapshotOptions
      ): Promise<SurfaceSnapshotPayload | null>;
    };
  }
}

export {};
