import { describe, expect, it, vi } from "vitest";

import {
  TERMINAL_CTRL_ENTER_SEQUENCE,
  TERMINAL_SHIFT_ENTER_SEQUENCE
} from "@kmux/proto";
import {
  applyPendingTerminalEnterRewrite,
  applyTerminalWebglPreference,
  createTerminalPaneXtermTheme,
  pasteClipboardIntoTerminal,
  resolveTerminalWebglRecovery,
  resolveTerminalEnterRewrite,
  shouldSwallowImeCompositionMetaKey
} from "./terminalRenderer";
import type { TerminalKeyboardEventLike } from "./terminalRenderer";
import { THEMES } from "@kmux/ui";

function keyboardEvent(
  overrides: Partial<TerminalKeyboardEventLike> = {}
): TerminalKeyboardEventLike {
  return {
    code: "Enter",
    key: "Enter",
    keyCode: 13,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    ...overrides
  };
}

describe("terminal renderer helpers", () => {
  it("uses the right sidebar background for xterm's input surface", () => {
    const theme = createTerminalPaneXtermTheme(
      {
        background: "#111111",
        foreground: "#eeeeee",
        cursor: "#ffffff",
        cursorText: "#111111",
        selectionBackground: "#333333",
        selectionForeground: "#eeeeee",
        ansi: new Array(16).fill("#777777")
      },
      "dark"
    );

    expect(theme.background).toBe(THEMES.dark.windowBg);
    expect(theme.foreground).toBe("#eeeeee");
  });

  it("loads the WebGL addon once when enabled", () => {
    const addon = {
      dispose: vi.fn()
    };
    const terminal = {
      loadAddon: vi.fn()
    };

    const loadedAddon = applyTerminalWebglPreference({
      terminal,
      currentAddon: null,
      useWebgl: true,
      createAddon: () => addon
    });
    const reusedAddon = applyTerminalWebglPreference({
      terminal,
      currentAddon: loadedAddon,
      useWebgl: true,
      createAddon: () => {
        throw new Error("should not create another addon");
      }
    });

    expect(loadedAddon).toBe(addon);
    expect(reusedAddon).toBe(addon);
    expect(terminal.loadAddon).toHaveBeenCalledTimes(1);
    expect(terminal.loadAddon).toHaveBeenCalledWith(addon);
  });

  it("disposes the WebGL addon when disabled", () => {
    const addon = {
      dispose: vi.fn()
    };

    const nextAddon = applyTerminalWebglPreference({
      terminal: {
        loadAddon: vi.fn()
      },
      currentAddon: addon,
      useWebgl: false,
      createAddon: () => addon
    });

    expect(nextAddon).toBeNull();
    expect(addon.dispose).toHaveBeenCalledTimes(1);
  });

  it("falls back cleanly when the WebGL addon fails to load", () => {
    const loadError = new Error("webgl unavailable");
    const onLoadError = vi.fn();

    const nextAddon = applyTerminalWebglPreference({
      terminal: {
        loadAddon: vi.fn(() => {
          throw loadError;
        })
      },
      currentAddon: null,
      useWebgl: true,
      createAddon: () => ({
        dispose: vi.fn()
      }),
      onLoadError
    });

    expect(nextAddon).toBeNull();
    expect(onLoadError).toHaveBeenCalledWith(loadError);
  });

  it("recreates WebGL after hydration because snapshot replay can leave stale canvas paint", () => {
    expect(
      resolveTerminalWebglRecovery({
        webglActive: true,
        reason: "hydrate",
        resized: false,
        previousCols: 120,
        previousRows: 30,
        cols: 120,
        rows: 30,
        resizeBurstCount: 1
      })
    ).toEqual({
      refresh: true,
      recreate: true
    });
  });

  it("uses refresh-only recovery for isolated small WebGL resizes", () => {
    expect(
      resolveTerminalWebglRecovery({
        webglActive: true,
        reason: "resize",
        resized: true,
        previousCols: 120,
        previousRows: 30,
        cols: 118,
        rows: 30,
        resizeBurstCount: 1
      })
    ).toEqual({
      refresh: true,
      recreate: false
    });
  });

  it("recreates WebGL after large or churned resizes", () => {
    expect(
      resolveTerminalWebglRecovery({
        webglActive: true,
        reason: "resize",
        resized: true,
        previousCols: 58,
        previousRows: 16,
        cols: 27,
        rows: 16,
        resizeBurstCount: 1
      })
    ).toEqual({
      refresh: true,
      recreate: true
    });
    expect(
      resolveTerminalWebglRecovery({
        webglActive: true,
        reason: "resize",
        resized: true,
        previousCols: 80,
        previousRows: 24,
        cols: 79,
        rows: 24,
        resizeBurstCount: 2
      })
    ).toEqual({
      refresh: true,
      recreate: true
    });
  });

  it("does not paste when the clipboard is empty", () => {
    const terminal = {
      paste: vi.fn()
    };

    const didPaste = pasteClipboardIntoTerminal({
      terminal,
      readClipboardText: () => ""
    });

    expect(didPaste).toBe(false);
    expect(terminal.paste).not.toHaveBeenCalled();
  });

  it("delegates multiline clipboard text to xterm paste unchanged", () => {
    const terminal = {
      paste: vi.fn()
    };
    const text = "alpha\nbeta\n";

    const didPaste = pasteClipboardIntoTerminal({
      terminal,
      readClipboardText: () => text
    });

    expect(didPaste).toBe(true);
    expect(terminal.paste).toHaveBeenCalledTimes(1);
    expect(terminal.paste).toHaveBeenCalledWith(text);
  });

  it("rewrites Ctrl and Shift Enter to modified terminal sequences", () => {
    expect(resolveTerminalEnterRewrite(keyboardEvent({ ctrlKey: true }))).toEqual(
      {
        sequence: TERMINAL_CTRL_ENTER_SEQUENCE
      }
    );
    expect(
      resolveTerminalEnterRewrite(keyboardEvent({ shiftKey: true }))
    ).toEqual({
      sequence: TERMINAL_SHIFT_ENTER_SEQUENCE
    });
  });

  it("does not queue rewrites for IME process-key Enter", () => {
    expect(
      resolveTerminalEnterRewrite(
        keyboardEvent({
          ctrlKey: true,
          isComposing: true,
          keyCode: 229
        })
      )
    ).toBeNull();
    expect(
      resolveTerminalEnterRewrite(
        keyboardEvent({
          shiftKey: true,
          keyCode: 229
        })
      )
    ).toBeNull();
  });

  it("leaves Alt Enter to xterm's native IME path", () => {
    expect(
      resolveTerminalEnterRewrite(
        keyboardEvent({
          altKey: true
        })
      )
    ).toBeNull();
    expect(
      resolveTerminalEnterRewrite(
        keyboardEvent({
          code: "AltLeft",
          key: "Alt",
          keyCode: 18,
          altKey: true
        })
      )
    ).toBeNull();
  });

  it("does not rewrite non-Enter, Meta-modified, or mixed-modifier input", () => {
    expect(
      resolveTerminalEnterRewrite(keyboardEvent({ keyCode: 229 }))
    ).toBeNull();
    expect(
      resolveTerminalEnterRewrite(
        keyboardEvent({ ctrlKey: true, shiftKey: true })
      )
    ).toBeNull();
    expect(
      resolveTerminalEnterRewrite(keyboardEvent({ metaKey: true }))
    ).toBeNull();
    expect(
      resolveTerminalEnterRewrite(
        keyboardEvent({
          code: "KeyA",
          key: "a",
          keyCode: 65,
          shiftKey: true
        })
      )
    ).toBeNull();
  });

  it("swallows bare Meta keydown during IME composition", () => {
    expect(
      shouldSwallowImeCompositionMetaKey(
        keyboardEvent({
          code: "MetaLeft",
          key: "Meta",
          keyCode: 91,
          metaKey: true,
          type: "keydown"
        }),
        true
      )
    ).toBe(true);
    expect(
      shouldSwallowImeCompositionMetaKey(
        keyboardEvent({
          code: "MetaRight",
          key: "Meta",
          keyCode: 93,
          metaKey: true,
          type: "keydown"
        }),
        true
      )
    ).toBe(true);
  });

  it("does not swallow Meta when not composing", () => {
    expect(
      shouldSwallowImeCompositionMetaKey(
        keyboardEvent({
          code: "MetaLeft",
          key: "Meta",
          keyCode: 91,
          metaKey: true,
          type: "keydown"
        }),
        false
      )
    ).toBe(false);
  });

  it("does not swallow Cmd-combined shortcuts or non-keydown events", () => {
    expect(
      shouldSwallowImeCompositionMetaKey(
        keyboardEvent({
          code: "KeyC",
          key: "c",
          keyCode: 67,
          metaKey: true,
          type: "keydown"
        }),
        true
      )
    ).toBe(false);
    expect(
      shouldSwallowImeCompositionMetaKey(
        keyboardEvent({
          code: "MetaLeft",
          key: "Meta",
          keyCode: 91,
          metaKey: true,
          shiftKey: true,
          type: "keydown"
        }),
        true
      )
    ).toBe(false);
    expect(
      shouldSwallowImeCompositionMetaKey(
        keyboardEvent({
          code: "MetaLeft",
          key: "Meta",
          keyCode: 91,
          metaKey: true,
          type: "keyup"
        }),
        true
      )
    ).toBe(false);
  });

  it("does not swallow other keys (Enter, letters, IME process) even when composing", () => {
    expect(
      shouldSwallowImeCompositionMetaKey(
        keyboardEvent({
          code: "Enter",
          key: "Enter",
          keyCode: 13,
          shiftKey: true,
          type: "keydown"
        }),
        true
      )
    ).toBe(false);
    expect(
      shouldSwallowImeCompositionMetaKey(
        keyboardEvent({
          code: "KeyA",
          key: "a",
          keyCode: 65,
          type: "keydown"
        }),
        true
      )
    ).toBe(false);
    expect(
      shouldSwallowImeCompositionMetaKey(
        keyboardEvent({
          code: "",
          key: "Process",
          keyCode: 229,
          type: "keydown"
        }),
        true
      )
    ).toBe(false);
  });

  it("applies pending Enter rewrites only to the originating surface CR", () => {
    expect(
      applyPendingTerminalEnterRewrite("surface_1", "가나다\r", {
        surfaceId: "surface_1",
        sequence: TERMINAL_SHIFT_ENTER_SEQUENCE
      })
    ).toEqual({
      data: `가나다${TERMINAL_SHIFT_ENTER_SEQUENCE}`,
      clearPending: true
    });
    expect(
      applyPendingTerminalEnterRewrite("surface_2", "\r", {
        surfaceId: "surface_1",
        sequence: TERMINAL_SHIFT_ENTER_SEQUENCE
      })
    ).toEqual({
      data: "\r",
      clearPending: true
    });
    expect(
      applyPendingTerminalEnterRewrite("surface_1", "가나다", {
        surfaceId: "surface_1",
        sequence: TERMINAL_SHIFT_ENTER_SEQUENCE
      })
    ).toEqual({
      data: "가나다",
      clearPending: false
    });
    expect(
      applyPendingTerminalEnterRewrite("surface_1", "\u001b\r", {
        surfaceId: "surface_1",
        sequence: TERMINAL_SHIFT_ENTER_SEQUENCE
      })
    ).toEqual({
      data: "\u001b\r",
      clearPending: true
    });
  });
});
