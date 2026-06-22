import type { KmuxSettings, SessionRuntimeState } from "@kmux/proto";

export type SurfaceContextAction =
  | "copy"
  | "paste"
  | "split-horizontally"
  | "split-vertically"
  | "restart-session"
  | "capture-diagnostics";

export type SurfaceContextMenuEntry =
  | {
      id: string;
      kind: "action";
      label: string;
      action: SurfaceContextAction;
      disabled?: boolean;
      shortcut?: string;
    }
  | {
      id: string;
      kind: "separator";
    };

export interface SurfaceContextMenuContext {
  canCopy: boolean;
  canPaste: boolean;
  canRestart: boolean;
  sessionState: SessionRuntimeState;
  diagnosticsEnabled?: boolean;
  settings: Pick<KmuxSettings, "shortcuts">;
}

export function buildSurfaceContextMenuEntries(
  context: SurfaceContextMenuContext
): SurfaceContextMenuEntry[] {
  return [
    {
      id: "copy",
      kind: "action",
      label: "Copy",
      action: "copy",
      disabled: !context.canCopy,
      shortcut: context.settings.shortcuts["terminal.copy"]
    },
    {
      id: "paste",
      kind: "action",
      label: "Paste",
      action: "paste",
      disabled: !context.canPaste,
      shortcut: context.settings.shortcuts["terminal.paste"]
    },
    { id: "separator-edit", kind: "separator" },
    {
      id: "split-horizontally",
      kind: "action",
      label: "Split Horizontally",
      action: "split-horizontally",
      shortcut: context.settings.shortcuts["pane.split.down"]
    },
    {
      id: "split-vertically",
      kind: "action",
      label: "Split Vertically",
      action: "split-vertically",
      shortcut: context.settings.shortcuts["pane.split.right"]
    },
    { id: "separator-session", kind: "separator" },
    {
      id: "restart-session",
      kind: "action",
      label:
        context.sessionState === "running"
          ? "Restart Session…"
          : "Restart Session",
      action: "restart-session",
      disabled: !context.canRestart
    },
    ...(context.diagnosticsEnabled
      ? [
          { id: "separator-diagnostics", kind: "separator" as const },
          {
            id: "capture-diagnostics",
            kind: "action" as const,
            label: "Capture Diagnostics",
            action: "capture-diagnostics" as const
          }
        ]
      : [])
  ];
}
