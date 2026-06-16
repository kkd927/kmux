// @vitest-environment jsdom

import { act } from "react";
import ReactDOMClient from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { KmuxSettings, SurfaceVm } from "@kmux/proto";
import type { ColorTheme } from "@kmux/ui";

import { buildPlatformKeyboardPolicy } from "../../../shared/platform/keyboardPolicy";

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn(() => ({
    proposeDimensions: () => ({ cols: 120, rows: 40 })
  }))
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: vi.fn(() => ({
    clearDecorations: vi.fn(),
    findNext: vi.fn(),
    findPrevious: vi.fn()
  }))
}));

vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: vi.fn(() => ({}))
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn(() => ({}))
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn().mockImplementation(() => {
    const terminal = {
      cols: 80,
      rows: 24,
      options: {},
      unicode: { activeVersion: "" },
      buffer: {
        active: {
          viewportY: 0,
          baseY: 0
        }
      },
      modes: {
        bracketedPasteMode: false
      },
      textarea: document.createElement("textarea"),
      loadAddon: vi.fn(),
      open: vi.fn((host: HTMLElement) => {
        const xterm = document.createElement("div");
        xterm.className = "xterm";
        const viewport = document.createElement("div");
        viewport.className = "xterm-viewport";
        const scrollable = document.createElement("div");
        scrollable.className = "xterm-scrollable-element";
        xterm.append(viewport, scrollable, terminal.textarea);
        host.append(xterm);
      }),
      attachCustomKeyEventHandler: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onWriteParsed: vi.fn(() => ({ dispose: vi.fn() })),
      onScroll: vi.fn(() => ({ dispose: vi.fn() })),
      write: vi.fn((_data: string, callback?: () => void) => {
        callback?.();
      }),
      resize: vi.fn((cols: number, rows: number) => {
        terminal.cols = cols;
        terminal.rows = rows;
      }),
      reset: vi.fn(),
      focus: vi.fn(),
      clearSelection: vi.fn(),
      selectAll: vi.fn(),
      getSelection: vi.fn(() => ""),
      scrollLines: vi.fn(),
      scrollPages: vi.fn(),
      scrollToTop: vi.fn(),
      scrollToBottom: vi.fn(),
      paste: vi.fn(),
      dispose: vi.fn()
    };
    return terminal;
  })
}));

import { Terminal } from "@xterm/xterm";
import { TerminalPane } from "./TerminalPane";
import * as terminalInstanceStore from "../terminalInstanceStore";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

type TerminalPaneProps = React.ComponentProps<typeof TerminalPane>;

function createSurface(id: string): SurfaceVm {
  return {
    id,
    title: id,
    ports: [],
    unreadCount: 0,
    attention: false,
    sessionState: "running",
    shellInputReady: true
  };
}

function createSettings(): KmuxSettings {
  return {
    socketMode: "kmuxOnly",
    warnBeforeQuit: true,
    notificationDesktop: false,
    notificationSound: false,
    themeMode: "dark",
    terminalTypography: {
      preferredTextFontFamily: "JetBrains Mono",
      preferredSymbolFallbackFamilies: [],
      fontSize: 13,
      lineHeight: 1
    },
    terminalThemes: {
      activeProfileId: "builtin",
      profiles: []
    },
    shortcuts: {}
  };
}

function createProps(surfaceId: string): TerminalPaneProps {
  const surface = createSurface(surfaceId);
  return {
    paneId: "pane_1",
    focused: true,
    active: true,
    surfaces: [surface],
    activeSurfaceId: surfaceId,
    settings: createSettings(),
    reservedSystemChords: [],
    keyboardPlatform: "linux",
    shortcutLabelStyle: "text",
    copyModeSelectAllShortcut: "Ctrl+A",
    terminalTypography: {
      stackHash: "test-stack",
      textFontFamily: "JetBrains Mono",
      symbolFallbackFamilies: [],
      resolvedFontFamily: "JetBrains Mono",
      autoFallbackApplied: false,
      status: "ready",
      issues: []
    },
    terminalTheme: {
      profileId: "builtin",
      profileName: "Builtin",
      source: "builtin",
      minimumContrastRatio: 4.5,
      variant: "dark",
      palette: {
        foreground: "#f5f5f5",
        background: "#111111",
        cursor: "#ffffff",
        cursorText: "#111111",
        selectionBackground: "#333333",
        selectionForeground: "#f5f5f5",
        ansi: new Array(16).fill("#000000")
      }
    },
    colorTheme: "dark" as ColorTheme,
    showSearch: false,
    draggedSurfaceTab: null,
    onFocusPane: vi.fn(),
    onFocusSurface: vi.fn(),
    onCreateSurface: vi.fn(),
    onCloseSurface: vi.fn(),
    onCloseOthers: vi.fn(),
    onMoveSurfaceToSplit: vi.fn(),
    onSurfaceTabDragStart: vi.fn(),
    onSurfaceTabDragEnd: vi.fn(),
    onSplitRight: vi.fn(),
    onSplitDown: vi.fn(),
    onClosePane: vi.fn(),
    onToggleSearch: vi.fn()
  };
}

describe("TerminalPane visibility cleanup", () => {
  let container: HTMLDivElement;
  let root: ReactDOMClient.Root;
  let windowFocus: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    windowFocus = vi.spyOn(window, "focus").mockImplementation(() => {});
    (
      globalThis as typeof globalThis & { ResizeObserver: unknown }
    ).ResizeObserver = MockResizeObserver;
    window.kmux = {
      ...window.kmux,
      subscribeTerminal: vi.fn(() => vi.fn()),
      attachSurface: vi.fn(async () => ({
        attachId: "attach_1",
        snapshot: {
          surfaceId: "surface_1",
          sessionId: "session_1",
          sequence: 0,
          vt: "",
          cols: 120,
          rows: 40,
          title: "surface_1",
          ports: [],
          unreadCount: 0,
          attention: false
        }
      })),
      completeAttachSurface: vi.fn(async () => ({ status: "ready" as const })),
      detachSurface: vi.fn(async () => {}),
      resizeSurface: vi.fn(async () => {}),
      sendText: vi.fn(async () => {}),
      createImageAttachments: vi.fn(async () => ({
        attachments: [],
        promptText: "",
        skippedCount: 0,
        status: "attached" as const,
        message: ""
      })),
      readClipboardImages: vi.fn(() => []),
      readClipboardText: vi.fn(() => ""),
      writeClipboardText: vi.fn(),
      openExternalUrl: vi.fn(async () => {}),
      showSurfaceContextMenu: vi.fn(async () => true)
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = ReactDOMClient.createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    terminalInstanceStore.releaseAll();
    windowFocus.mockRestore();
    container.remove();
  });

  it("keeps shell startup status hidden while the active surface waits for input", async () => {
    const props = createProps("surface_1");
    props.surfaces = [
      {
        ...props.surfaces[0],
        shellInputReady: false
      }
    ];

    await act(async () => {
      root.render(<TerminalPane {...props} />);
    });

    expect(
      container.querySelector(
        "[data-testid='terminal-shell-loading-surface_1']"
      )
    ).toBeNull();
    expect(container.textContent).not.toContain("Starting shell");
    expect(
      container.querySelector("[data-testid='terminal-surface_1']")
    ).not.toBeNull();
  });

  it("passes reserved system chords through terminal shortcuts", async () => {
    const policy = buildPlatformKeyboardPolicy({
      platform: "linux",
      labelStyle: "text"
    });
    const props = createProps("surface_1");
    props.reservedSystemChords = policy.reservedSystemChords;
    props.settings = {
      ...props.settings,
      shortcuts: {
        ...props.settings.shortcuts,
        "terminal.search": "Ctrl+Alt+T"
      }
    };
    const onToggleSearch = vi.fn();
    props.onToggleSearch = onToggleSearch;

    await act(async () => {
      root.render(<TerminalPane {...props} />);
    });

    const terminalHost = container.querySelector(
      "[data-testid='terminal-surface_1'] .xterm"
    );
    expect(terminalHost).not.toBeNull();
    const event = new KeyboardEvent("keydown", {
      key: "t",
      code: "KeyT",
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true
    });

    act(() => {
      terminalHost!.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(onToggleSearch).not.toHaveBeenCalled();
  });

  it("keeps non-reserved terminal shortcuts active", async () => {
    const policy = buildPlatformKeyboardPolicy({
      platform: "linux",
      labelStyle: "text"
    });
    const props = createProps("surface_1");
    props.reservedSystemChords = policy.reservedSystemChords;
    props.settings = {
      ...props.settings,
      shortcuts: {
        ...props.settings.shortcuts,
        "terminal.search": "Ctrl+Alt+W"
      }
    };
    const onToggleSearch = vi.fn();
    props.onToggleSearch = onToggleSearch;

    await act(async () => {
      root.render(<TerminalPane {...props} />);
    });

    const terminalHost = container.querySelector(
      "[data-testid='terminal-surface_1'] .xterm"
    );
    expect(terminalHost).not.toBeNull();
    const event = new KeyboardEvent("keydown", {
      key: "w",
      code: "KeyW",
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true
    });

    act(() => {
      terminalHost!.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(onToggleSearch).toHaveBeenCalledWith("surface_1");
  });

  it("uses the Linux copy-mode select-all binding and label", async () => {
    const policy = buildPlatformKeyboardPolicy({
      platform: "linux",
      labelStyle: "text"
    });
    const props = createProps("surface_1");
    props.reservedSystemChords = policy.reservedSystemChords;
    props.shortcutLabelStyle = policy.labelStyle;
    props.copyModeSelectAllShortcut = policy.copyModeSelectAllShortcut;
    props.settings = {
      ...props.settings,
      shortcuts: {
        ...props.settings.shortcuts,
        "terminal.copyMode": "Ctrl+Shift+M"
      }
    };

    await act(async () => {
      root.render(<TerminalPane {...props} />);
    });

    const terminalHost = container.querySelector(
      "[data-testid='terminal-surface_1'] .xterm"
    );
    expect(terminalHost).not.toBeNull();

    act(() => {
      terminalHost!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "m",
          code: "KeyM",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })
      );
    });

    expect(container.textContent).toContain("Ctrl + A selects all");

    const ctrlA = new KeyboardEvent("keydown", {
      key: "a",
      code: "KeyA",
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    });
    act(() => {
      terminalHost!.dispatchEvent(ctrlA);
    });

    const terminal = vi.mocked(Terminal).mock.results.at(-1)?.value as
      | { selectAll: ReturnType<typeof vi.fn> }
      | undefined;
    expect(ctrlA.defaultPrevented).toBe(true);
    expect(terminal?.selectAll).toHaveBeenCalledOnce();
  });

  it("defers terminal shortcuts to active IME composition", async () => {
    const policy = buildPlatformKeyboardPolicy({
      platform: "linux",
      labelStyle: "text"
    });
    const props = createProps("surface_1");
    props.reservedSystemChords = policy.reservedSystemChords;
    props.settings = {
      ...props.settings,
      shortcuts: {
        ...props.settings.shortcuts,
        "terminal.search": "Ctrl+Alt+W"
      }
    };
    const onToggleSearch = vi.fn();
    props.onToggleSearch = onToggleSearch;

    await act(async () => {
      root.render(<TerminalPane {...props} />);
    });

    const terminalHost = container.querySelector(
      "[data-testid='terminal-surface_1'] .xterm"
    );
    const terminalTextarea = container.querySelector(
      "[data-testid='terminal-surface_1'] textarea"
    );
    expect(terminalHost).not.toBeNull();
    expect(terminalTextarea).not.toBeNull();

    act(() => {
      terminalTextarea!.dispatchEvent(
        new Event("compositionstart", { bubbles: true })
      );
    });

    const composingEvent = new KeyboardEvent("keydown", {
      key: "w",
      code: "KeyW",
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true
    });

    act(() => {
      terminalHost!.dispatchEvent(composingEvent);
    });

    expect(composingEvent.defaultPrevented).toBe(false);
    expect(onToggleSearch).not.toHaveBeenCalled();

    act(() => {
      terminalTextarea!.dispatchEvent(
        new Event("compositionend", { bubbles: true })
      );
    });

    const afterCompositionEvent = new KeyboardEvent("keydown", {
      key: "w",
      code: "KeyW",
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true
    });

    act(() => {
      terminalHost!.dispatchEvent(afterCompositionEvent);
    });

    expect(afterCompositionEvent.defaultPrevented).toBe(true);
    expect(onToggleSearch).toHaveBeenCalledWith("surface_1");
  });

  it("suppresses xterm key handling while IME composition is active", async () => {
    const props = createProps("surface_1");

    await act(async () => {
      root.render(<TerminalPane {...props} />);
    });

    const terminalTextarea = container.querySelector(
      "[data-testid='terminal-surface_1'] textarea"
    );
    expect(terminalTextarea).not.toBeNull();

    const terminal = vi.mocked(Terminal).mock.results.at(-1)?.value as
      | {
          attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
        }
      | undefined;
    const handler = terminal?.attachCustomKeyEventHandler.mock.calls.at(-1)?.[0] as
      | ((event: KeyboardEvent) => boolean)
      | undefined;
    expect(handler).toBeTypeOf("function");

    expect(
      handler!(
        new KeyboardEvent("keydown", {
          key: "a",
          code: "KeyA"
        })
      )
    ).toBe(true);
    expect(
      handler!(
        new KeyboardEvent("keydown", {
          key: "a",
          code: "KeyA",
          isComposing: true
        })
      )
    ).toBe(false);

    act(() => {
      terminalTextarea!.dispatchEvent(
        new Event("compositionstart", { bubbles: true })
      );
    });

    expect(
      handler!(
        new KeyboardEvent("keydown", {
          key: "a",
          code: "KeyA"
        })
      )
    ).toBe(false);
    expect(
      handler!(
        new KeyboardEvent("keyup", {
          key: "a",
          code: "KeyA"
        })
      )
    ).toBe(true);

    act(() => {
      terminalTextarea!.dispatchEvent(
        new Event("compositionend", { bubbles: true })
      );
    });

    expect(
      handler!(
        new KeyboardEvent("keydown", {
          key: "a",
          code: "KeyA"
        })
      )
    ).toBe(true);
  });
});
