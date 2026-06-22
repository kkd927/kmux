import { buildDefaultShortcuts } from "@kmux/ui";

import { buildSurfaceContextMenuEntries } from "./surfaceContextMenu";

describe("surface context menu helpers", () => {
  it("builds edit, split, and restart entries with shortcuts", () => {
    const shortcuts = buildDefaultShortcuts("darwin");
    const entries = buildSurfaceContextMenuEntries({
      canCopy: true,
      canPaste: false,
      canRestart: true,
      sessionState: "running",
      settings: { shortcuts }
    });

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "copy",
          label: "Copy",
          disabled: false,
          shortcut: shortcuts["terminal.copy"]
        }),
        expect.objectContaining({
          id: "paste",
          label: "Paste",
          disabled: true,
          shortcut: shortcuts["terminal.paste"]
        }),
        expect.objectContaining({
          id: "split-horizontally",
          label: "Split Horizontally",
          shortcut: shortcuts["pane.split.down"]
        }),
        expect.objectContaining({
          id: "split-vertically",
          label: "Split Vertically",
          shortcut: shortcuts["pane.split.right"]
        }),
        expect.objectContaining({
          id: "restart-session",
          label: "Restart Session…",
          disabled: false
        })
      ])
    );
  });

  it("disables restart while a session is pending", () => {
    const entries = buildSurfaceContextMenuEntries({
      canCopy: false,
      canPaste: false,
      canRestart: false,
      sessionState: "pending",
      settings: { shortcuts: buildDefaultShortcuts("darwin") }
    });

    expect(
      entries.find((entry) => entry.id === "restart-session")
    ).toMatchObject({
      disabled: true,
      label: "Restart Session"
    });
  });

  it("includes diagnostics only when requested", () => {
    const entries = buildSurfaceContextMenuEntries({
      canCopy: false,
      canPaste: false,
      canRestart: true,
      sessionState: "exited",
      diagnosticsEnabled: true,
      settings: { shortcuts: buildDefaultShortcuts("darwin") }
    });

    expect(entries.at(-1)).toMatchObject({
      id: "capture-diagnostics",
      action: "capture-diagnostics"
    });
  });
});
