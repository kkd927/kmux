import { describe, expect, it, vi } from "vitest";

import type { CreateImageAttachmentPayload } from "@kmux/proto";
import {
  TERMINAL_CTRL_ENTER_SEQUENCE,
  TERMINAL_SHIFT_ENTER_SEQUENCE
} from "@kmux/proto";
import {
  applyPendingTerminalEnterRewrite,
  countSupportedImageFiles,
  createTerminalImeDuplicateCommitGuard,
  createTerminalPaneXtermTheme,
  formatDroppedFilePathsForTerminal,
  isSupportedImageMimeType,
  pasteClipboardIntoTerminal,
  resolveTerminalEnterRewrite,
  sanitizeTerminalPasteText,
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

  it("awaits async clipboard text before pasting", async () => {
    const terminal = {
      paste: vi.fn()
    };

    const didPaste = await pasteClipboardIntoTerminal({
      terminal,
      readClipboardText: async () => "async clipboard text",
      readClipboardImages: async () => []
    });

    expect(didPaste).toBe(true);
    expect(terminal.paste).toHaveBeenCalledWith("async clipboard text");
  });

  it("falls back to clipboard text when native image read fails", async () => {
    const terminal = {
      paste: vi.fn()
    };
    const onImageAttachmentError = vi.fn();

    const didPaste = await pasteClipboardIntoTerminal({
      terminal,
      readClipboardText: async () => "text survives image read failure",
      readClipboardImages: async () => {
        throw new Error("image read failed");
      },
      onImageAttachmentError
    });

    expect(didPaste).toBe(true);
    expect(onImageAttachmentError).toHaveBeenCalledOnce();
    expect(terminal.paste).toHaveBeenCalledWith(
      "text survives image read failure"
    );
  });

  it("removes terminal control characters from clipboard text paste", async () => {
    const terminal = {
      paste: vi.fn()
    };

    const didPaste = await pasteClipboardIntoTerminal({
      terminal,
      readClipboardText: () => "alpha\u001b[201~\u009b31m\u007fbeta"
    });

    expect(didPaste).toBe(true);
    expect(terminal.paste).toHaveBeenCalledWith("alpha[201~31mbeta");
  });

  it("preserves tabs and line endings when sanitizing terminal paste text", () => {
    expect(sanitizeTerminalPasteText("alpha\tbeta\nnext\rline")).toBe(
      "alpha\tbeta\nnext\rline"
    );
  });

  it("does not paste when sanitization removes the whole clipboard text", async () => {
    const terminal = {
      paste: vi.fn()
    };

    const didPaste = await pasteClipboardIntoTerminal({
      terminal,
      readClipboardText: () => "\u0000\u001b\u007f\u009b"
    });

    expect(didPaste).toBe(false);
    expect(terminal.paste).not.toHaveBeenCalled();
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

  it("sanitizes image attachment prompt text before pasting", async () => {
    const terminal = {
      paste: vi.fn()
    };
    const imagePayload: CreateImageAttachmentPayload = {
      source: "clipboard",
      originalName: "screenshot.png",
      mimeType: "image/png",
      bytes: new Uint8Array([1, 2, 3])
    };

    const didPaste = await pasteClipboardIntoTerminal({
      terminal,
      surfaceId: "surface_1",
      readClipboardText: () => "screenshot.png",
      readClipboardImages: () => [imagePayload],
      createImageAttachments: vi.fn(async () => ({
        attachments: [],
        promptText: "@\u001b/tmp/kmux/screenshot.png\u009b",
        skippedCount: 0,
        status: "attached" as const,
        message: "Attached screenshot.png"
      }))
    });

    expect(didPaste).toBe(true);
    expect(terminal.paste).toHaveBeenCalledWith("@/tmp/kmux/screenshot.png");
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

  it("formats a single dropped file path as a quoted shell token", () => {
    expect(formatDroppedFilePathsForTerminal(["/Users/me/README.md"])).toBe(
      "'/Users/me/README.md'"
    );
  });

  it("quotes dropped file paths with spaces", () => {
    expect(
      formatDroppedFilePathsForTerminal(["/Users/me/My Project/README.md"])
    ).toBe("'/Users/me/My Project/README.md'");
  });

  it("escapes single quotes in dropped file paths", () => {
    expect(
      formatDroppedFilePathsForTerminal(["/Users/me/it's ready.txt"])
    ).toBe("'/Users/me/it'\\''s ready.txt'");
  });

  it("joins multiple dropped file paths with spaces", () => {
    expect(
      formatDroppedFilePathsForTerminal([
        "/Users/me/one.txt",
        "/Users/me/two.txt"
      ])
    ).toBe("'/Users/me/one.txt' '/Users/me/two.txt'");
  });

  it("skips empty and control-character dropped file paths", () => {
    expect(
      formatDroppedFilePathsForTerminal([
        "",
        "/Users/me/ok.txt",
        "/Users/me/bad\nname.txt",
        "/Users/me/bad\rname.txt",
        "/Users/me/bad\u001bname.txt",
        "/Users/me/also-ok.txt"
      ])
    ).toBe("'/Users/me/ok.txt' '/Users/me/also-ok.txt'");
  });

  it("rewrites Ctrl and Shift Enter to modified terminal sequences", () => {
    expect(
      resolveTerminalEnterRewrite(keyboardEvent({ ctrlKey: true }))
    ).toEqual({
      sequence: TERMINAL_CTRL_ENTER_SEQUENCE
    });
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

  it("swallows Linux keydown events during IME composition", () => {
    expect(
      shouldSuppressXtermDuringIme(
        keyboardEvent({
          code: "KeyA",
          key: "a",
          keyCode: 65,
          type: "keydown"
        }),
        true,
        "linux"
      )
    ).toBe(true);
    expect(
      shouldSuppressXtermDuringIme(
        keyboardEvent({
          code: "",
          key: "Process",
          keyCode: 229,
          isComposing: true,
          type: "keydown"
        }),
        false,
        "linux"
      )
    ).toBe(true);
    expect(
      shouldSuppressXtermDuringIme(
        keyboardEvent({
          code: "Enter",
          key: "Enter",
          keyCode: 13,
          shiftKey: true,
          type: "keydown"
        }),
        true,
        "linux"
      )
    ).toBe(true);
  });

  it("does not swallow keydown events when not composing", () => {
    expect(
      shouldSuppressXtermDuringIme(
        keyboardEvent({
          code: "KeyA",
          key: "a",
          keyCode: 65,
          type: "keydown"
        }),
        false,
        "linux"
      )
    ).toBe(false);
  });

  it("does not swallow non-keydown events", () => {
    expect(
      shouldSuppressXtermDuringIme(
        keyboardEvent({
          code: "KeyA",
          key: "a",
          keyCode: 65,
          metaKey: true,
          type: "keyup"
        }),
        true,
        "linux"
      )
    ).toBe(false);
  });

  it("leaves ordinary macOS composing letters to xterm", () => {
    expect(
      shouldSuppressXtermDuringIme(
        keyboardEvent({
          code: "KeyA",
          key: "a",
          keyCode: 65,
          isComposing: true,
          type: "keydown"
        }),
        false,
        "darwin"
      )
    ).toBe(false);
  });

  it("still swallows bare Meta keydown during macOS IME composition", () => {
    expect(
      shouldSuppressXtermDuringIme(
        keyboardEvent({
          code: "MetaLeft",
          key: "Meta",
          keyCode: 91,
          metaKey: true,
          type: "keydown"
        }),
        true,
        "darwin"
      )
    ).toBe(true);
  });

  it("swallows Cmd + navigation keys during macOS IME composition", () => {
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
          true,
          "darwin"
        )
      ).toBe(true);
    }
  });

  it("swallows Alt + navigation keys during macOS IME composition", () => {
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
          true,
          "darwin"
        )
      ).toBe(true);
    }
  });

  it("leaves bare navigation keys to xterm during macOS IME composition", () => {
    expect(
      shouldSuppressXtermDuringIme(
        keyboardEvent({
          key: "ArrowLeft",
          type: "keydown"
        }),
        true,
        "darwin"
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
        false,
        "darwin"
      )
    ).toBe(false);
  });

  it("uses one explicit Linux IME commit while suppressing xterm composition data", () => {
    let time = 0;
    const guard = createTerminalImeDuplicateCommitGuard({
      now: () => time,
      duplicateWindowMs: 20
    });

    guard.compositionStart("");
    guard.compositionUpdate("가");
    expect(guard.filterData("가")).toBeNull();
    time = 1;
    expect(guard.compositionEnd("가", "가")).toBe("가");

    time = 2;
    expect(guard.filterData("가")).toBeNull();

    guard.compositionStart("");
    guard.compositionUpdate("가");
    expect(guard.filterData("가")).toBeNull();
    expect(guard.compositionEnd("가", "가")).toBe("가");
    time = 30;
    expect(guard.filterData("가")).toBe("가");
  });

  it("keeps a space typed immediately after a Linux IME commit while removing the duplicate commit", () => {
    let time = 0;
    const guard = createTerminalImeDuplicateCommitGuard({
      now: () => time,
      duplicateWindowMs: 20
    });

    guard.compositionStart("");
    guard.compositionUpdate("한");
    time = 1;
    expect(guard.compositionEnd("한", "한")).toBe("한");

    time = 2;
    expect(guard.filterData("한 ")).toBe(" ");
    expect(guard.filterData(" ")).toBe(" ");
  });

  it("removes a duplicate Linux IME commit even when xterm emits a different Unicode normalization form", () => {
    let time = 0;
    const guard = createTerminalImeDuplicateCommitGuard({
      now: () => time,
      duplicateWindowMs: 20
    });
    const composed = "한";
    const decomposed = composed.normalize("NFD");

    guard.compositionStart("");
    guard.compositionUpdate(composed);
    time = 1;
    expect(guard.compositionEnd(composed, composed)).toBe(composed);

    time = 2;
    expect(guard.filterData(`${decomposed} `)).toBe(" ");
    expect(guard.filterData(decomposed)).toBeNull();
  });

  it("allows the first post-composition commit when ibus ends composition with empty data", () => {
    let time = 0;
    const guard = createTerminalImeDuplicateCommitGuard({
      now: () => time,
      duplicateWindowMs: 20
    });

    guard.compositionStart("안");
    guard.compositionUpdate("녕");
    guard.compositionUpdate("");
    time = 1;
    expect(guard.compositionEnd("안", "")).toBe("");

    time = 2;
    expect(guard.filterData("녕")).toBe("녕");
  });

  it("suppresses only an immediate repeated post-composition commit from xterm", () => {
    let time = 0;
    const guard = createTerminalImeDuplicateCommitGuard({
      now: () => time,
      duplicateWindowMs: 20
    });

    guard.compositionStart("안");
    guard.compositionUpdate("녕");
    guard.compositionUpdate("");
    time = 1;
    expect(guard.compositionEnd("안", "")).toBe("");

    time = 2;
    expect(guard.filterData("녕")).toBe("녕");
    expect(guard.filterData("녕")).toBeNull();
    expect(guard.filterData(" ")).toBe(" ");
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
