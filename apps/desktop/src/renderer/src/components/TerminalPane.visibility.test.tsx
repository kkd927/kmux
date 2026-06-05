// @vitest-environment jsdom

import { act } from "react";
import ReactDOMClient from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { KmuxSettings, SurfaceVm } from "@kmux/proto";
import type { ColorTheme } from "@kmux/ui";

const mocks = vi.hoisted(() => {
  const redrawController = {
    start: vi.fn(),
    touch: vi.fn(),
    revealNow: vi.fn(),
    revealAllNow: vi.fn()
  };
  return {
    redrawController
  };
});

vi.mock("../terminalRedrawConcealment", () => ({
  createTerminalRedrawConcealment: vi.fn(() => mocks.redrawController)
}));

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
    sessionState: "running"
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

  beforeEach(() => {
    vi.clearAllMocks();
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
    container.remove();
  });

  it("reveals resize-redraw concealment when cleaning up a surface attachment", async () => {
    await act(async () => {
      root.render(<TerminalPane {...createProps("surface_1")} />);
    });

    await act(async () => {
      root.render(<TerminalPane {...createProps("surface_2")} />);
    });

    expect(mocks.redrawController.revealNow).toHaveBeenCalledWith("surface_1");
  });
});
