import { describe, expect, it, vi } from "vitest";

import type { CreateImageAttachmentPayload } from "@kmux/proto";
import {
  TERMINAL_CTRL_ENTER_SEQUENCE,
  TERMINAL_SHIFT_ENTER_SEQUENCE
} from "@kmux/proto";
import {
  applyPendingTerminalEnterRewrite,
  countSupportedImageFiles,
  createTerminalPaneXtermTheme,
  isSupportedImageMimeType,
  pasteClipboardIntoTerminal,
  resolveTerminalEnterRewrite,
  shouldDeferTerminalShortcutToIme,
  shouldUseImagePaste,
  shouldSuppressXtermDuringIme
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

  it("does not paste when the clipboard is empty", async () => {
    const terminal = {
      paste: vi.fn()
    };

    const didPaste = await pasteClipboardIntoTerminal({
      terminal,
      readClipboardText: () => ""
    });

    expect(didPaste).toBe(false);
    expect(terminal.paste).not.toHaveBeenCalled();
  });

  it("delegates multiline clipboard text to xterm paste unchanged", async () => {
    const terminal = {
      paste: vi.fn()
    };
    const text = "alpha\nbeta\n";

    const didPaste = await pasteClipboardIntoTerminal({
      terminal,
      readClipboardText: () => text
    });

    expect(didPaste).toBe(true);
    expect(terminal.paste).toHaveBeenCalledTimes(1);
    expect(terminal.paste).toHaveBeenCalledWith(text);
  });

  it("attaches native clipboard images before falling back to clipboard text", async () => {
    const terminal = {
      paste: vi.fn()
    };
    const imagePayload: CreateImageAttachmentPayload = {
      source: "clipboard",
      originalName: "screenshot.png",
      mimeType: "image/png",
      bytes: new Uint8Array([1, 2, 3])
    };
    const createImageAttachments = vi.fn(async () => ({
      attachments: [],
      promptText: "Attached image: /tmp/kmux/screenshot.png",
      skippedCount: 0,
      status: "attached" as const,
      message: "Attached screenshot.png"
    }));

    const didPaste = await pasteClipboardIntoTerminal({
      terminal,
      surfaceId: "surface_1",
      readClipboardText: () => "스크린샷 2026-05-03 오후 1.02.05",
      readClipboardImages: () => [imagePayload],
      createImageAttachments
    });

    expect(didPaste).toBe(true);
    expect(createImageAttachments).toHaveBeenCalledWith("surface_1", [
      imagePayload
    ]);
    expect(terminal.paste).toHaveBeenCalledWith(
      "Attached image: /tmp/kmux/screenshot.png"
    );
  });

  it("falls back to clipboard text when image attachment returns no prompt text", async () => {
    const terminal = {
      paste: vi.fn()
    };
    const imagePayload: CreateImageAttachmentPayload = {
      source: "clipboard",
      originalName: "too-large.png",
      mimeType: "image/png",
      bytes: new Uint8Array([1, 2, 3])
    };

    const didPaste = await pasteClipboardIntoTerminal({
      terminal,
      surfaceId: "surface_1",
      readClipboardText: () => "too-large.png",
      readClipboardImages: () => [imagePayload],
      createImageAttachments: vi.fn(async () => ({
        attachments: [],
        promptText: "",
        skippedCount: 1,
        status: "failed" as const,
        message: "Could not attach image"
      }))
    });

    expect(didPaste).toBe(true);
    expect(terminal.paste).toHaveBeenCalledWith("too-large.png");
  });

  it("falls back to clipboard text when image attachment creation fails", async () => {
    const terminal = {
      paste: vi.fn()
    };
    const imagePayload: CreateImageAttachmentPayload = {
      source: "clipboard",
      originalName: "broken.png",
      mimeType: "image/png",
      bytes: new Uint8Array([1, 2, 3])
    };

    const didPaste = await pasteClipboardIntoTerminal({
      terminal,
      surfaceId: "surface_1",
      readClipboardText: () => "broken.png",
      readClipboardImages: () => [imagePayload],
      createImageAttachments: vi.fn(async () => {
        throw new Error("attach failed");
      })
    });

    expect(didPaste).toBe(true);
    expect(terminal.paste).toHaveBeenCalledWith("broken.png");
  });

  it("recognizes only supported image MIME types for attachments", () => {
    expect(isSupportedImageMimeType("image/png")).toBe(true);
    expect(isSupportedImageMimeType("image/jpeg")).toBe(true);
    expect(isSupportedImageMimeType("image/gif")).toBe(true);
    expect(isSupportedImageMimeType("image/webp")).toBe(true);
    expect(isSupportedImageMimeType("text/plain")).toBe(false);
    expect(isSupportedImageMimeType("")).toBe(false);
  });

  it("uses image paste only when an image candidate exists", () => {
    expect(shouldUseImagePaste({ imageCount: 1, text: "hello" })).toBe(true);
    expect(shouldUseImagePaste({ imageCount: 0, text: "hello" })).toBe(false);
    expect(shouldUseImagePaste({ imageCount: 0, text: "" })).toBe(false);
  });

  it("counts supported image files in file-like payloads", () => {
    expect(
      countSupportedImageFiles([
        { type: "image/png" },
        { type: "text/plain" },
        { type: "image/webp" }
      ])
    ).toBe(2);
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
    expect(
      resolveTerminalEnterRewrite(
        keyboardEvent({
          ctrlKey: true,
          isComposing: true
        })
      )
    ).toBeNull();
  });

  it("defers terminal shortcut handling to active IME composition", () => {
    expect(shouldDeferTerminalShortcutToIme(keyboardEvent(), true)).toBe(true);
    expect(
      shouldDeferTerminalShortcutToIme(
        keyboardEvent({
          isComposing: true
        }),
        false
      )
    ).toBe(true);
    expect(
      shouldDeferTerminalShortcutToIme(
        keyboardEvent({
          key: "Process",
          keyCode: 229
        }),
        false
      )
    ).toBe(true);
    expect(shouldDeferTerminalShortcutToIme(keyboardEvent(), false)).toBe(
      false
    );
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
      shouldSuppressXtermDuringIme(
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
      shouldSuppressXtermDuringIme(
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
      shouldSuppressXtermDuringIme(
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

  it("does not swallow Cmd combined with letter keys (e.g., Cmd+C)", () => {
    expect(
      shouldSuppressXtermDuringIme(
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
  });

  it("does not swallow bare Meta when another modifier is also held", () => {
    expect(
      shouldSuppressXtermDuringIme(
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
  });

  it("does not swallow non-keydown events", () => {
    expect(
      shouldSuppressXtermDuringIme(
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

  it("swallows Cmd + navigation keys during IME composition", () => {
    for (const key of [
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
      "PageUp",
      "PageDown"
    ]) {
      expect(
        shouldSuppressXtermDuringIme(
          keyboardEvent({
            key,
            metaKey: true,
            type: "keydown"
          }),
          true
        )
      ).toBe(true);
    }
  });

  it("swallows Alt + navigation keys during IME composition", () => {
    for (const key of [
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
      "PageUp",
      "PageDown"
    ]) {
      expect(
        shouldSuppressXtermDuringIme(
          keyboardEvent({
            key,
            altKey: true,
            type: "keydown"
          }),
          true
        )
      ).toBe(true);
    }
  });

  it("does not swallow bare navigation keys (no modifier) even when composing", () => {
    expect(
      shouldSuppressXtermDuringIme(
        keyboardEvent({
          key: "ArrowLeft",
          type: "keydown"
        }),
        true
      )
    ).toBe(false);
  });

  it("does not swallow modifier + navigation when not composing", () => {
    expect(
      shouldSuppressXtermDuringIme(
        keyboardEvent({
          key: "ArrowLeft",
          metaKey: true,
          type: "keydown"
        }),
        false
      )
    ).toBe(false);
  });

  it("does not swallow other keys (Enter, letters, IME process) even when composing", () => {
    expect(
      shouldSuppressXtermDuringIme(
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
      shouldSuppressXtermDuringIme(
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
      shouldSuppressXtermDuringIme(
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
