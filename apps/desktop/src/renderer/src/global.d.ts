import type { AppAction, RemoteOperationCommandResult } from "@kmux/core";
import type { RendererPlatformDescriptor } from "../../shared/platform/rendererPlatform";
import type { SmoothnessProfileEvent } from "../../shared/smoothnessProfile";
import type { TerminalStreamErrorReport } from "../../shared/terminalStreamDiagnostics";
import type {
  SurfaceContextAction,
  SurfaceContextMenuContext
} from "../../shared/surfaceContextMenu";
import type {
  CreateImageAttachmentPayload,
  CreateImageAttachmentsResult,
  ExternalAgentSessionResumeResult,
  ExternalAgentSessionsSnapshot,
  ImportedTerminalThemePalette,
  TerminalColorPalette,
  ResolvedTerminalTypographyVm,
  RetainedRemoteSessionResourceKey,
  RetainedRemoteSessionsSnapshot,
  ShellPatch,
  ShellIdentity,
  ShellStoreSnapshot,
  SshConnectionsSnapshot,
  SshAskpassPrompt,
  SshAskpassResponseRequest,
  SshProfileDto,
  SshProfileSaveRequest,
  SshRuntimeCleanReport,
  SshRuntimeResetReport,
  SshWorkspaceCancelRequest,
  SshWorkspaceCommitRequest,
  SshWorkspaceOpenResult,
  SshWorkspacePrepareRequest,
  SshWorkspacePrepareResult,
  UsageViewSnapshot,
  SurfaceCapturePayload,
  SurfaceSnapshotOptions,
  SurfaceSnapshotPayload,
  TerminalFileLinkResolveCandidate,
  TerminalFileLinkResolveResult,
  TerminalKeyInput,
  TerminalTypographyProbeReport,
  TerminalTypographySettings,
  UpdaterState,
  WorktreeConversionPreview,
  WorktreeBulkRemoveResult,
  WorktreeRemoveResult,
  WorkspaceWorktreeMetadata
} from "@kmux/proto";
import type { TerminalStreamAttachResult } from "../../shared/terminalPort";

declare global {
  interface Window {
    __kmuxLastShellPublishAt?: number;
    kmux: {
      getPlatform(): Promise<RendererPlatformDescriptor>;
      getPathForFile(file: File): string;
      getShellState(): Promise<ShellStoreSnapshot>;
      getUsageView(): Promise<UsageViewSnapshot>;
      getExternalAgentSessions(): Promise<ExternalAgentSessionsSnapshot>;
      resumeExternalAgentSession(
        key: string
      ): Promise<ExternalAgentSessionResumeResult>;
      getUpdaterState(): Promise<UpdaterState>;
      dispatch(action: AppAction): Promise<void>;
      getRetainedRemoteSessions(): Promise<RetainedRemoteSessionsSnapshot>;
      terminateRetainedRemoteSession(
        resourceKey: RetainedRemoteSessionResourceKey
      ): Promise<RemoteOperationCommandResult>;
      getSshConnections(
        resolveEffective?: boolean
      ): Promise<SshConnectionsSnapshot>;
      listSshConfigAliases(): Promise<string[]>;
      importSshConfigAliases(
        aliases: string[]
      ): Promise<SshConnectionsSnapshot>;
      saveSshProfile(request: SshProfileSaveRequest): Promise<SshProfileDto>;
      duplicateSshProfile(profileId: string): Promise<SshProfileDto>;
      deleteSshProfile(profileId: string): Promise<void>;
      testSshProfile(profileId: string): Promise<SshConnectionsSnapshot>;
      rebindSshProfile(profileId: string): Promise<SshConnectionsSnapshot>;
      cleanSshRuntime(profileId: string): Promise<SshRuntimeCleanReport>;
      resetSshRuntime(profileId: string): Promise<SshRuntimeResetReport>;
      prepareSshWorkspace(
        request: SshWorkspacePrepareRequest
      ): Promise<SshWorkspacePrepareResult>;
      commitSshWorkspace(
        request: SshWorkspaceCommitRequest
      ): Promise<SshWorkspaceOpenResult>;
      cancelSshWorkspacePreparation(
        request: SshWorkspaceCancelRequest
      ): Promise<void>;
      respondSshAskpass(request: SshAskpassResponseRequest): Promise<void>;
      closeWorkspaceSafely(workspaceId: string): Promise<void>;
      closeOtherWorkspacesSafely(workspaceId: string): Promise<void>;
      subscribeShellPatches(listener: (patch: ShellPatch) => void): () => void;
      subscribeUsage(
        listener: (snapshot: UsageViewSnapshot) => void
      ): () => void;
      subscribeUpdater(listener: (state: UpdaterState) => void): () => void;
      subscribeSshAskpassPrompt(
        listener: (prompt: SshAskpassPrompt) => void
      ): () => void;
      attachTerminalStream(
        surfaceId: string,
        expectedSessionId: string
      ): Promise<TerminalStreamAttachResult>;
      reportTerminalStreamError(
        report: TerminalStreamErrorReport
      ): Promise<void>;
      sendText(surfaceId: string, text: string): Promise<void>;
      sendKey(surfaceId: string, input: TerminalKeyInput): Promise<void>;
      openExternalUrl(surfaceId: string, url: string): Promise<void>;
      openTerminalFilePath(
        surfaceId: string,
        rawPath: string,
        baseCwd?: string
      ): Promise<void>;
      resolveTerminalFileLinks(
        surfaceId: string,
        candidates: TerminalFileLinkResolveCandidate[]
      ): Promise<TerminalFileLinkResolveResult>;
      createImageAttachments(
        surfaceId: string,
        payloads: CreateImageAttachmentPayload[]
      ): Promise<CreateImageAttachmentsResult>;
      readClipboardImages(): Promise<CreateImageAttachmentPayload[]>;
      hasPasteableClipboardContent(): Promise<boolean>;
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
      clearDiagnosticLog(): Promise<boolean>;
      readClipboardText(): Promise<string>;
      writeClipboardText(text: string): Promise<void>;
      windowControl(
        action: "minimize" | "maximize" | "fullscreen" | "close"
      ): Promise<void>;
      showWorkspaceContextMenu(
        workspaceId: string,
        x: number,
        y: number
      ): Promise<boolean>;
      captureSurfaceDiagnostics(
        surfaceId: string
      ): Promise<SurfaceCapturePayload>;
      showSurfaceContextMenu(
        surfaceId: string,
        x: number,
        y: number,
        context: SurfaceContextMenuContext
      ): Promise<void>;
      subscribeSurfaceContextMenuAction(
        listener: (event: {
          surfaceId: string;
          action: SurfaceContextAction;
        }) => void
      ): () => void;
      subscribeWorkspaceRenameRequest(
        listener: (workspaceId: string) => void
      ): () => void;
      subscribeSshWorkspaceOpenRequest(
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
      subscribeDiagnosticsLogging(
        listener: (enabled: boolean) => void
      ): () => void;
      recordSmoothnessProfileEvent(
        event: SmoothnessProfileEvent
      ): Promise<void>;
      recordSmoothnessProfileEvents(
        events: SmoothnessProfileEvent[]
      ): Promise<void>;
    };
    kmuxTest?: {
      getRuntimeEnv(): Record<string, string>;
      snapshotSurface(
        surfaceId: string,
        options?: SurfaceSnapshotOptions
      ): Promise<SurfaceSnapshotPayload | null>;
      subscribeExternalUrlOpen(listener: (url: string) => void): () => void;
    };
  }
}

export {};
