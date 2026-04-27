import type { AppAction } from "@kmux/core";
import type { SmoothnessProfileEvent } from "../../shared/smoothnessProfile";
import type {
  ExternalAgentSessionResumeResult,
  ExternalAgentSessionsSnapshot,
  ImportedTerminalThemePalette,
  TerminalColorPalette,
  ResolvedTerminalTypographyVm,
  ShellPatch,
  ShellIdentity,
  ShellStoreSnapshot,
  UsageViewSnapshot,
  SurfaceSnapshotOptions,
  SurfaceSnapshotPayload,
  TerminalTypographyProbeReport,
  TerminalTypographySettings,
  TerminalKeyInput,
  UpdaterState
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
      attachSurface(surfaceId: string): Promise<SurfaceSnapshotPayload | null>;
      detachSurface(surfaceId: string): Promise<void>;
      sendText(surfaceId: string, text: string): Promise<void>;
      sendKey(surfaceId: string, input: TerminalKeyInput): Promise<void>;
      resizeSurface(
        surfaceId: string,
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
