import type { AppAction } from "@kmux/core";
import type {
  ImportedTerminalThemePalette,
  TerminalColorPalette,
  ResolvedTerminalTypographyVm,
  ShellIdentity,
  ShellViewModel,
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
      getView(): Promise<ShellViewModel>;
      getUsageView(): Promise<UsageViewSnapshot>;
      getUpdaterState(): Promise<UpdaterState>;
      dispatch(action: AppAction): Promise<ShellViewModel>;
      subscribeView(listener: (view: ShellViewModel) => void): () => void;
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
