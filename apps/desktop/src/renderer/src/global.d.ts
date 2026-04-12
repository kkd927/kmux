import type { AppAction } from "@kmux/core";
import type {
  ShellIdentity,
  ShellViewModel,
  SurfaceSnapshotPayload,
  TerminalKeyInput
} from "@kmux/proto";
import type { TerminalEvent } from "../../preload/index";

declare global {
  interface Window {
    kmux: {
      getView(): Promise<ShellViewModel>;
      dispatch(action: AppAction): Promise<ShellViewModel>;
      subscribeView(listener: (view: ShellViewModel) => void): () => void;
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
    };
  }
}

export {};
