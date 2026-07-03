// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import ReactDOMClient from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { KmuxSettings, SurfaceVm } from "@kmux/proto";
import type { ColorTheme } from "@kmux/ui";
import type { ILink, ILinkProvider } from "@xterm/xterm";

import { buildPlatformKeyboardPolicy } from "../../../shared/platform/keyboardPolicy";

let fitDimensions = { cols: 120, rows: 40 };
let terminalBufferText = "";

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn(() => ({
    proposeDimensions: () => fitDimensions
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
    const cell = {
      chars: "",
      width: 0,
      getChars() {
        return this.chars;
      },
      getWidth() {
        return this.width;
      }
    };
    const terminal = {
      cols: 80,
      rows: 24,
      options: {},
      unicode: { activeVersion: "" },
      buffer: {
        active: {
          viewportY: 0,
          baseY: 0,
          cursorY: 0,
          getLine(index: number) {
            if (index !== 0) {
              return undefined;
            }
            return {
              isWrapped: false,
              get length() {
                return terminalBufferText.length;
              },
              translateToString(trimRight?: boolean) {
                return trimRight
                  ? terminalBufferText.trimEnd()
                  : terminalBufferText;
              },
              getCell(index: number, targetCell = cell) {
                targetCell.chars = terminalBufferText[index] ?? "";
                targetCell.width = index < terminalBufferText.length ? 1 : 0;
                return targetCell;
              }
            };
          },
          getNullCell() {
            return cell;
          }
        }
      },
      modes: {
        bracketedPasteMode: false
      },
      textarea: document.createElement("textarea"),
      _core: {
        _renderService: {
          _isPaused: false,
          _needsFullRefresh: false,
          _pausedResizeTask: { flush: vi.fn() },
          refreshRows: vi.fn(),
          _renderRows: vi.fn()
        }
      },
      loadAddon: vi.fn(),
      registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
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
      write: vi.fn((data: string, callback?: () => void) => {
        terminalBufferText += data;
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
    sessionId: `session_${id}`,
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
    onRestartSurface: vi.fn(),
    onToggleSearch: vi.fn()
  };
}

async function flushMicrotasks(iterations = 5): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

function createTextPasteEvent(text: string): ClipboardEvent {
  const event = new Event("paste", {
    bubbles: true,
    cancelable: true
  }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: {
      files: [],
      items: [],
      getData: vi.fn((format: string) => (format === "text/plain" ? text : ""))
    }
  });
  return event;
}

function captureTerminalListeners(): Array<(event: unknown) => void> {
  const listeners: Array<(event: unknown) => void> = [];
  window.kmux.subscribeTerminal = vi.fn((listener) => {
    const captured = listener as (event: unknown) => void;
    listeners.push(captured);
    return () => {
      const index = listeners.indexOf(captured);
      if (index >= 0) {
        listeners.splice(index, 1);
      }
    };
  });
  return listeners;
}

function provideCurrentTerminalFileLinks(): ILink[] | undefined {
  const terminalMock = vi.mocked(Terminal);
  const terminal = terminalMock.mock.results.at(-1)?.value as
    | {
        registerLinkProvider: {
          mock: { calls: Array<[ILinkProvider]> };
        };
      }
    | undefined;
  const provider = terminal?.registerLinkProvider.mock.calls[0]?.[0];
  let links: ILink[] | undefined;
  provider?.provideLinks(1, (providedLinks) => {
    links = providedLinks;
  });
  return links;
}

describe("TerminalPane visibility cleanup", () => {
  let container: HTMLDivElement;
  let root: ReactDOMClient.Root;
  let windowFocus: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fitDimensions = { cols: 120, rows: 40 };
    terminalBufferText = "";
    windowFocus = vi.spyOn(window, "focus").mockImplementation(() => {});
    (
      globalThis as typeof globalThis & { ResizeObserver: unknown }
    ).ResizeObserver = MockResizeObserver;
    window.kmux = {
      ...window.kmux,
      subscribeTerminal: vi.fn(() => vi.fn()),
      attachSurface: vi.fn(async (surfaceId: string, sessionId: string) => ({
        attachId: "attach_1",
        snapshot: {
          surfaceId,
          sessionId,
          sequence: 0,
          vt: "",
          cols: 120,
          rows: 40,
          title: surfaceId,
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
      readClipboardImages: vi.fn(async () => []),
      hasPasteableClipboardContent: vi.fn(async () => false),
      readClipboardText: vi.fn(async () => ""),
      writeClipboardText: vi.fn(async () => {}),
      openExternalUrl: vi.fn(async () => {}),
      openTerminalFilePath: vi.fn(async () => {}),
      showSurfaceContextMenu: vi.fn(async () => true),
      subscribeSurfaceContextMenuAction: vi.fn(() => vi.fn()),
      captureSurfaceDiagnostics: vi.fn(async () => ({}) as never)
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

  it("disables xterm mouse behaviors that replace intentional selection", async () => {
    const props = createProps("surface_1");
    props.keyboardPlatform = "darwin";

    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks();
    });

    expect(Terminal).toHaveBeenCalledWith(
      expect.objectContaining({
        altClickMovesCursor: false,
        macOptionClickForcesSelection: true,
        macOptionIsMeta: false,
        rightClickSelectsWord: false
      })
    );
  });

  it("passes snapshot cwd ranges into terminal file links", async () => {
    const props = createProps("surface_1");
    terminalBufferText = "src/App.tsx";
    window.kmux.attachSurface = vi.fn(
      async (surfaceId: string, sessionId: string) => ({
        attachId: "attach_1",
        snapshot: {
          surfaceId,
          sessionId,
          sequence: 0,
          vt: "",
          cols: 120,
          rows: 40,
          title: surfaceId,
          ports: [],
          unreadCount: 0,
          attention: false,
          cwdRanges: [{ startLine: 0, endLine: 0, cwd: "/repo/snapshot" }]
        }
      })
    );

    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks();
    });

    const links = provideCurrentTerminalFileLinks();
    links?.[0]?.activate(
      new MouseEvent("click", { ctrlKey: true }),
      "src/App.tsx"
    );
    await Promise.resolve();

    expect(window.kmux.openTerminalFilePath).toHaveBeenCalledWith(
      "surface_1",
      "src/App.tsx",
      "/repo/snapshot"
    );
  });

  it("records live chunk cwd for terminal file links", async () => {
    const props = createProps("surface_1");
    let terminalListener: ((event: unknown) => void) | null = null;
    window.kmux.subscribeTerminal = vi.fn((listener) => {
      terminalListener = listener as (event: unknown) => void;
      return vi.fn();
    });

    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks();
    });

    await act(async () => {
      terminalListener?.({
        type: "chunk",
        payload: {
          surfaceId: "surface_1",
          sessionId: "session_surface_1",
          sequence: 1,
          chunk: "src/App.tsx",
          cwd: "/repo/live"
        }
      });
      await flushMicrotasks();
    });

    const links = provideCurrentTerminalFileLinks();
    links?.[0]?.activate(
      new MouseEvent("click", { ctrlKey: true }),
      "src/App.tsx"
    );
    await Promise.resolve();

    expect(window.kmux.openTerminalFilePath).toHaveBeenCalledWith(
      "surface_1",
      "src/App.tsx",
      "/repo/live"
    );
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

  it("passes the active session id through attach completion and release detach", async () => {
    const props = createProps("surface_1");

    await act(async () => {
      root.render(<TerminalPane {...props} />);
    });

    expect(window.kmux.attachSurface).toHaveBeenCalledWith(
      "surface_1",
      "session_surface_1"
    );
    expect(window.kmux.completeAttachSurface).toHaveBeenCalledWith(
      "surface_1",
      "attach_1",
      "session_surface_1"
    );

    terminalInstanceStore.release("surface_1");

    expect(window.kmux.detachSurface).toHaveBeenCalledWith(
      "surface_1",
      "session_surface_1"
    );
  });

  it("keeps the same surface session attached across TerminalPane remounts", async () => {
    const props = createProps("surface_1");

    await act(async () => {
      root.render(<TerminalPane key="first" {...props} />);
    });

    await act(async () => {
      root.render(<TerminalPane key="second" {...props} />);
    });

    expect(window.kmux.detachSurface).not.toHaveBeenCalled();
    expect(window.kmux.attachSurface).toHaveBeenCalledTimes(1);
    expect(window.kmux.completeAttachSurface).toHaveBeenCalledTimes(1);
  });

  it("keeps the same render sink object across same-surface rerenders", async () => {
    const props = createProps("surface_1");

    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks();
    });
    const firstSink = terminalInstanceStore.getRenderSink("surface_1");
    expect(firstSink).toBeTruthy();

    await act(async () => {
      root.render(<TerminalPane {...props} focused={false} />);
      await flushMicrotasks();
    });

    expect(terminalInstanceStore.getRenderSink("surface_1")).toBe(firstSink);
  });

  it("does not force a full renderer refresh for ordinary live chunks", async () => {
    const props = createProps("surface_1");
    let terminalListener: ((event: unknown) => void) | null = null;
    window.kmux.subscribeTerminal = vi.fn((listener) => {
      terminalListener = listener as (event: unknown) => void;
      return vi.fn();
    });

    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks();
    });

    const terminal = vi.mocked(Terminal).mock.results.at(-1)?.value as
      | {
          write: ReturnType<typeof vi.fn>;
          _core: {
            _renderService: {
              refreshRows: ReturnType<typeof vi.fn>;
              _renderRows: ReturnType<typeof vi.fn>;
            };
          };
        }
      | undefined;
    expect(terminal).toBeDefined();
    terminal!.write.mockClear();
    terminal!._core._renderService.refreshRows.mockClear();
    terminal!._core._renderService._renderRows.mockClear();

    await act(async () => {
      terminalListener?.({
        type: "chunk",
        payload: {
          surfaceId: "surface_1",
          sessionId: "session_surface_1",
          sequence: 1,
          chunk: "live output"
        }
      });
      await flushMicrotasks();
    });

    expect(terminal!.write).toHaveBeenCalledWith(
      "live output",
      expect.any(Function)
    );
    expect(terminal!._core._renderService.refreshRows).not.toHaveBeenCalled();
    expect(terminal!._core._renderService._renderRows).not.toHaveBeenCalled();
  });

  it("keeps the live chunk queue moving when an attached write is dropped", async () => {
    const props = createProps("surface_1");
    let terminalListener: ((event: unknown) => void) | null = null;
    window.kmux.subscribeTerminal = vi.fn((listener) => {
      terminalListener = listener as (event: unknown) => void;
      return vi.fn();
    });

    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks();
    });

    const dropSink: terminalInstanceStore.TerminalRenderSink = {
      write: vi.fn(() => false),
      fitAndSync: vi.fn(async () => {})
    };
    terminalInstanceStore.setRenderSink("surface_1", dropSink);

    await act(async () => {
      terminalListener?.({
        type: "chunk",
        payload: {
          surfaceId: "surface_1",
          sessionId: "session_surface_1",
          sequence: 1,
          chunk: "dropped one"
        }
      });
      terminalListener?.({
        type: "chunk",
        payload: {
          surfaceId: "surface_1",
          sessionId: "session_surface_1",
          sequence: 2,
          chunk: "dropped two"
        }
      });
      await flushMicrotasks();
    });

    expect(dropSink.write).toHaveBeenCalledTimes(2);
    expect(
      container
        .querySelector("[data-testid='terminal-surface_1']")
        ?.getAttribute("data-terminal-rendered-sequence")
    ).not.toBe("2");
  });

  it("keeps pending hidden-surface chunk cwd on the original surface tracker", async () => {
    const firstSurface = createSurface("surface_1");
    const secondSurface = createSurface("surface_2");
    const props = createProps("surface_1");
    props.surfaces = [firstSurface, secondSurface];
    const terminalListeners = captureTerminalListeners();

    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks();
    });

    const firstSurfaceListener = terminalListeners[0];
    expect(firstSurfaceListener).toBeDefined();
    const firstTerminal = vi.mocked(Terminal).mock.results.at(-1)?.value as
      | {
          write: ReturnType<typeof vi.fn>;
        }
      | undefined;
    expect(firstTerminal).toBeDefined();
    firstTerminal!.write.mockClear();
    let resolveChunkWrite: (() => void) | null = null;
    firstTerminal!.write.mockImplementationOnce(
      (data: string, callback?: () => void) => {
        terminalBufferText += data;
        resolveChunkWrite = callback ?? null;
      }
    );
    vi.mocked(window.kmux.openTerminalFilePath).mockClear();

    await act(async () => {
      firstSurfaceListener({
        type: "chunk",
        payload: {
          surfaceId: "surface_1",
          sessionId: "session_surface_1",
          sequence: 1,
          chunk: "src/App.tsx",
          cwd: "/repo/hidden"
        }
      });
      await flushMicrotasks();
    });

    expect(firstTerminal!.write).toHaveBeenCalledWith(
      "src/App.tsx",
      expect.any(Function)
    );

    await act(async () => {
      flushSync(() => {
        root.render(<TerminalPane {...props} activeSurfaceId="surface_2" />);
      });
      resolveChunkWrite?.();
      await flushMicrotasks();
    });

    const links = provideCurrentTerminalFileLinks();
    expect(links?.[0]).toBeDefined();
    links?.[0]?.activate(
      new MouseEvent("click", { ctrlKey: true }),
      "src/App.tsx"
    );
    await Promise.resolve();

    expect(window.kmux.openTerminalFilePath).toHaveBeenCalledWith(
      "surface_2",
      "src/App.tsx",
      undefined
    );
    expect(window.kmux.openTerminalFilePath).not.toHaveBeenCalledWith(
      "surface_2",
      "src/App.tsx",
      "/repo/hidden"
    );
  });

  it("pauses renderer work while inactive and refreshes when active again", async () => {
    const props = createProps("surface_1");

    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks();
    });

    const terminal = vi.mocked(Terminal).mock.results.at(-1)?.value as
      | {
          rows: number;
          _core: {
            _renderService: {
              _isPaused: boolean;
              _needsFullRefresh: boolean;
              refreshRows: ReturnType<typeof vi.fn>;
              _renderRows: ReturnType<typeof vi.fn>;
            };
          };
        }
      | undefined;
    expect(terminal).toBeDefined();
    const renderService = terminal!._core._renderService;
    renderService.refreshRows.mockClear();
    renderService._renderRows.mockClear();

    await act(async () => {
      root.render(<TerminalPane {...props} active={false} />);
      await flushMicrotasks();
    });

    expect(renderService._isPaused).toBe(true);
    expect(renderService._needsFullRefresh).toBe(true);
    expect(renderService.refreshRows).not.toHaveBeenCalled();

    await act(async () => {
      root.render(<TerminalPane {...props} active />);
      await flushMicrotasks();
    });

    expect(renderService._isPaused).toBe(false);
    expect(renderService._needsFullRefresh).toBe(false);
    expect(renderService.refreshRows).toHaveBeenCalledWith(
      0,
      terminal!.rows - 1
    );
  });

  it("reasserts renderer pause when inactive writes observe an unpaused xterm service", async () => {
    const props = createProps("surface_1");
    let terminalListener: ((event: unknown) => void) | null = null;
    window.kmux.subscribeTerminal = vi.fn((listener) => {
      terminalListener = listener as (event: unknown) => void;
      return vi.fn();
    });

    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks();
    });

    const terminal = vi.mocked(Terminal).mock.results.at(-1)?.value as
      | {
          write: ReturnType<typeof vi.fn>;
          _core: {
            _renderService: {
              _isPaused: boolean;
              _needsFullRefresh: boolean;
            };
          };
        }
      | undefined;
    expect(terminal).toBeDefined();

    await act(async () => {
      root.render(<TerminalPane {...props} active={false} />);
      await flushMicrotasks();
    });

    const renderService = terminal!._core._renderService;
    renderService._isPaused = false;
    renderService._needsFullRefresh = false;
    terminal!.write.mockClear();

    await act(async () => {
      terminalListener?.({
        type: "chunk",
        payload: {
          surfaceId: "surface_1",
          sessionId: "session_surface_1",
          sequence: 1,
          chunk: "inactive output"
        }
      });
      await flushMicrotasks();
    });

    expect(terminal!.write).toHaveBeenCalledWith(
      "inactive output",
      expect.any(Function)
    );
    expect(renderService._isPaused).toBe(true);
    expect(renderService._needsFullRefresh).toBe(true);
  });

  it("applies terminal resize events after pending chunk write callbacks", async () => {
    const props = createProps("surface_1");
    let terminalListener: ((event: unknown) => void) | null = null;
    window.kmux.subscribeTerminal = vi.fn((listener) => {
      terminalListener = listener as (event: unknown) => void;
      return vi.fn();
    });

    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks();
    });

    const terminal = vi.mocked(Terminal).mock.results.at(-1)?.value as
      | {
          write: ReturnType<typeof vi.fn>;
          resize: ReturnType<typeof vi.fn>;
        }
      | undefined;
    expect(terminal).toBeDefined();
    terminal!.write.mockClear();
    terminal!.resize.mockClear();
    let resolveChunkWrite: (() => void) | null = null;
    terminal!.write.mockImplementationOnce(
      (_data: string, callback?: () => void) => {
        resolveChunkWrite = callback ?? null;
      }
    );

    await act(async () => {
      terminalListener?.({
        type: "chunk",
        payload: {
          surfaceId: "surface_1",
          sessionId: "session_surface_1",
          sequence: 1,
          chunk: "pending"
        }
      });
      terminalListener?.({
        type: "resize",
        payload: {
          surfaceId: "surface_1",
          sessionId: "session_surface_1",
          attachId: "attach_1",
          cols: 132,
          rows: 41
        }
      });
      await flushMicrotasks();
    });

    expect(terminal!.write).toHaveBeenCalledWith(
      "pending",
      expect.any(Function)
    );
    expect(terminal!.resize).not.toHaveBeenCalledWith(132, 41);

    await act(async () => {
      resolveChunkWrite?.();
      await flushMicrotasks();
    });

    expect(terminal!.resize).toHaveBeenCalledWith(132, 41);
  });

  it("drops queued resize echoes that are older than the latest local fit", async () => {
    const props = createProps("surface_1");
    let terminalListener: ((event: unknown) => void) | null = null;
    window.kmux.subscribeTerminal = vi.fn((listener) => {
      terminalListener = listener as (event: unknown) => void;
      return vi.fn();
    });

    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks();
    });

    const terminal = vi.mocked(Terminal).mock.results.at(-1)?.value as
      | {
          write: ReturnType<typeof vi.fn>;
          resize: ReturnType<typeof vi.fn>;
        }
      | undefined;
    expect(terminal).toBeDefined();
    terminal!.write.mockClear();
    terminal!.resize.mockClear();
    let resolveChunkWrite: (() => void) | null = null;
    terminal!.write.mockImplementationOnce(
      (_data: string, callback?: () => void) => {
        resolveChunkWrite = callback ?? null;
      }
    );

    await act(async () => {
      terminalListener?.({
        type: "chunk",
        payload: {
          surfaceId: "surface_1",
          sessionId: "session_surface_1",
          sequence: 1,
          chunk: "pending"
        }
      });
      terminalListener?.({
        type: "resize",
        payload: {
          surfaceId: "surface_1",
          sessionId: "session_surface_1",
          attachId: "attach_1",
          cols: 100,
          rows: 30
        }
      });
      await flushMicrotasks();
    });

    fitDimensions = { cols: 140, rows: 50 };
    await act(async () => {
      await terminalInstanceStore.getRenderSink("surface_1")?.fitAndSync();
      await flushMicrotasks();
    });

    expect(window.kmux.resizeSurface).toHaveBeenCalledWith(
      "surface_1",
      "attach_1",
      140,
      50
    );

    await act(async () => {
      resolveChunkWrite?.();
      await flushMicrotasks();
    });

    expect(terminal!.resize).not.toHaveBeenCalledWith(100, 30);
  });

  it("writes the exit banner after pending chunk write callbacks", async () => {
    const props = createProps("surface_1");
    let terminalListener: ((event: unknown) => void) | null = null;
    window.kmux.subscribeTerminal = vi.fn((listener) => {
      terminalListener = listener as (event: unknown) => void;
      return vi.fn();
    });

    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks();
    });

    const terminal = vi.mocked(Terminal).mock.results.at(-1)?.value as
      | {
          write: ReturnType<typeof vi.fn>;
        }
      | undefined;
    expect(terminal).toBeDefined();
    terminal!.write.mockClear();
    const writes: string[] = [];
    let resolveChunkWrite: (() => void) | null = null;
    terminal!.write.mockImplementation(
      (data: string, callback?: () => void) => {
        writes.push(data);
        if (data === "pending") {
          resolveChunkWrite = callback ?? null;
          return;
        }
        callback?.();
      }
    );

    await act(async () => {
      terminalListener?.({
        type: "chunk",
        payload: {
          surfaceId: "surface_1",
          sessionId: "session_surface_1",
          sequence: 1,
          chunk: "pending"
        }
      });
      terminalListener?.({
        type: "exit",
        payload: {
          surfaceId: "surface_1",
          sessionId: "session_surface_1",
          exitCode: 7
        }
      });
      await flushMicrotasks();
    });

    expect(writes).toEqual(["pending"]);

    await act(async () => {
      resolveChunkWrite?.();
      await flushMicrotasks();
    });

    expect(writes).toHaveLength(2);
    expect(writes[1]).toContain("Session exited (7)");
  });

  it("keeps a queued exit banner for a hidden surface when the session is unchanged", async () => {
    const firstSurface = createSurface("surface_1");
    const secondSurface = createSurface("surface_2");
    const props = createProps("surface_1");
    props.surfaces = [firstSurface, secondSurface];
    const terminalListeners = captureTerminalListeners();

    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks();
    });

    const firstSurfaceListener = terminalListeners[0];
    expect(firstSurfaceListener).toBeDefined();
    const terminal = vi.mocked(Terminal).mock.results.at(-1)?.value as
      | {
          write: ReturnType<typeof vi.fn>;
        }
      | undefined;
    expect(terminal).toBeDefined();
    terminal!.write.mockClear();
    const writes: string[] = [];
    let resolveChunkWrite: (() => void) | null = null;
    terminal!.write.mockImplementation(
      (data: string, callback?: () => void) => {
        writes.push(data);
        if (data === "pending") {
          resolveChunkWrite = callback ?? null;
          return;
        }
        callback?.();
      }
    );

    await act(async () => {
      firstSurfaceListener({
        type: "chunk",
        payload: {
          surfaceId: "surface_1",
          sessionId: "session_surface_1",
          sequence: 1,
          chunk: "pending"
        }
      });
      firstSurfaceListener({
        type: "exit",
        payload: {
          surfaceId: "surface_1",
          sessionId: "session_surface_1",
          exitCode: 7
        }
      });
      await flushMicrotasks();
    });

    expect(writes).toEqual(["pending"]);

    await act(async () => {
      flushSync(() => {
        root.render(<TerminalPane {...props} activeSurfaceId="surface_2" />);
      });
      await flushMicrotasks();
    });

    await act(async () => {
      resolveChunkWrite?.();
      await flushMicrotasks();
    });

    expect(writes).toHaveLength(2);
    expect(writes[1]).toContain("Session exited (7)");
  });

  it("drops a queued exit banner when the surface has moved to a new session", async () => {
    const props = createProps("surface_1");
    const terminalListeners = captureTerminalListeners();

    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks();
    });

    const firstSurfaceListener = terminalListeners[0];
    expect(firstSurfaceListener).toBeDefined();
    const terminal = vi.mocked(Terminal).mock.results.at(-1)?.value as
      | {
          write: ReturnType<typeof vi.fn>;
        }
      | undefined;
    expect(terminal).toBeDefined();
    terminal!.write.mockClear();
    const writes: string[] = [];
    let resolveChunkWrite: (() => void) | null = null;
    terminal!.write.mockImplementation(
      (data: string, callback?: () => void) => {
        writes.push(data);
        if (data === "pending") {
          resolveChunkWrite = callback ?? null;
          return;
        }
        callback?.();
      }
    );

    await act(async () => {
      firstSurfaceListener({
        type: "chunk",
        payload: {
          surfaceId: "surface_1",
          sessionId: "session_surface_1",
          sequence: 1,
          chunk: "pending"
        }
      });
      firstSurfaceListener({
        type: "exit",
        payload: {
          surfaceId: "surface_1",
          sessionId: "session_surface_1",
          exitCode: 7
        }
      });
      await flushMicrotasks();
    });

    const restartedProps = createProps("surface_1");
    restartedProps.surfaces = [
      {
        ...restartedProps.surfaces[0],
        sessionId: "session_restarted"
      }
    ];

    await act(async () => {
      flushSync(() => {
        root.render(<TerminalPane {...restartedProps} />);
      });
      await flushMicrotasks();
    });

    await act(async () => {
      resolveChunkWrite?.();
      await flushMicrotasks();
    });

    expect(writes).toEqual(["pending"]);
  });

  it("continues the terminal operation queue when a write callback never fires", async () => {
    const props = createProps("surface_1");
    let terminalListener: ((event: unknown) => void) | null = null;
    window.kmux.subscribeTerminal = vi.fn((listener) => {
      terminalListener = listener as (event: unknown) => void;
      return vi.fn();
    });

    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks();
    });

    const terminal = vi.mocked(Terminal).mock.results.at(-1)?.value as
      | {
          write: ReturnType<typeof vi.fn>;
          resize: ReturnType<typeof vi.fn>;
        }
      | undefined;
    expect(terminal).toBeDefined();
    terminal!.write.mockClear();
    terminal!.resize.mockClear();
    terminal!.write.mockImplementationOnce(() => {});

    vi.useFakeTimers();
    try {
      await act(async () => {
        terminalListener?.({
          type: "chunk",
          payload: {
            surfaceId: "surface_1",
            sessionId: "session_surface_1",
            sequence: 1,
            chunk: "pending"
          }
        });
        terminalListener?.({
          type: "resize",
          payload: {
            surfaceId: "surface_1",
            sessionId: "session_surface_1",
            attachId: "attach_1",
            cols: 132,
            rows: 41
          }
        });
        await flushMicrotasks();
      });

      expect(terminal!.resize).not.toHaveBeenCalledWith(132, 41);

      await act(async () => {
        vi.advanceTimersByTime(10_001);
        await flushMicrotasks();
      });

      expect(terminal!.resize).toHaveBeenCalledWith(132, 41);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the ready attach id for the first resize after a same session remount", async () => {
    const props = createProps("surface_1");

    await act(async () => {
      root.render(<TerminalPane key="first" {...props} />);
    });

    vi.mocked(window.kmux.resizeSurface).mockClear();
    fitDimensions = { cols: 100, rows: 40 };

    await act(async () => {
      root.render(<TerminalPane key="second" {...props} />);
    });

    expect(window.kmux.detachSurface).not.toHaveBeenCalled();
    expect(window.kmux.resizeSurface).toHaveBeenCalledWith(
      "surface_1",
      "attach_1",
      100,
      40
    );
    expect(window.kmux.resizeSurface).not.toHaveBeenCalledWith(
      "surface_1",
      null,
      100,
      40
    );
  });

  it("detaches the old attachment when the same surface moves to a new session", async () => {
    const props = createProps("surface_1");
    const restartedProps = createProps("surface_1");
    restartedProps.surfaces = [
      {
        ...restartedProps.surfaces[0],
        sessionId: "session_restarted"
      }
    ];

    await act(async () => {
      root.render(<TerminalPane {...props} />);
    });

    await act(async () => {
      root.render(<TerminalPane {...restartedProps} />);
    });

    expect(window.kmux.detachSurface).toHaveBeenCalledWith(
      "surface_1",
      "session_surface_1"
    );
    expect(window.kmux.attachSurface).toHaveBeenLastCalledWith(
      "surface_1",
      "session_restarted"
    );
  });

  it("detaches the previous surface when switching active tabs in the same pane", async () => {
    const firstSurface = createSurface("surface_1");
    const secondSurface = createSurface("surface_2");
    const props = createProps("surface_1");
    props.surfaces = [firstSurface, secondSurface];
    const switchedProps = {
      ...props,
      activeSurfaceId: "surface_2"
    };

    await act(async () => {
      root.render(<TerminalPane {...props} />);
    });

    await act(async () => {
      root.render(<TerminalPane {...switchedProps} />);
    });

    expect(window.kmux.detachSurface).toHaveBeenCalledWith(
      "surface_1",
      "session_surface_1"
    );
    expect(window.kmux.attachSurface).toHaveBeenLastCalledWith(
      "surface_2",
      "session_surface_2"
    );
  });

  it("stops stale focus retries after the active surface changes", async () => {
    const firstSurface = createSurface("surface_1");
    const secondSurface = createSurface("surface_2");
    const props = createProps("surface_1");
    props.surfaces = [firstSurface, secondSurface];
    const animationFrames: FrameRequestCallback[] = [];
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback): number => {
        animationFrames.push(callback);
        return animationFrames.length;
      });
    const cancelAnimationFrameSpy = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => {});
    const textareaFocusSpy = vi
      .spyOn(HTMLTextAreaElement.prototype, "focus")
      .mockImplementation(() => {});

    try {
      await act(async () => {
        root.render(<TerminalPane {...props} />);
        await flushMicrotasks();
      });

      const firstTerminal = vi.mocked(Terminal).mock.results.at(-1)?.value as
        | {
            focus: ReturnType<typeof vi.fn>;
            textarea: HTMLTextAreaElement;
          }
        | undefined;
      expect(firstTerminal).toBeDefined();
      expect(firstTerminal?.focus).toHaveBeenCalled();
      expect(animationFrames.length).toBeGreaterThan(0);

      textareaFocusSpy.mockRestore();
      await act(async () => {
        root.render(<TerminalPane {...props} activeSurfaceId="surface_2" />);
        await flushMicrotasks();
      });

      const secondTerminal = vi.mocked(Terminal).mock.results.at(-1)?.value as
        | {
            focus: ReturnType<typeof vi.fn>;
            textarea: HTMLTextAreaElement;
          }
        | undefined;
      expect(secondTerminal).toBeDefined();
      expect(document.activeElement).toBe(secondTerminal?.textarea);
      const firstFocusCallsBeforeRetry = firstTerminal!.focus.mock.calls.length;
      const secondFocusCallsBeforeRetry =
        secondTerminal!.focus.mock.calls.length;

      await act(async () => {
        for (const callback of animationFrames.splice(0)) {
          callback(performance.now());
        }
        await flushMicrotasks();
      });

      expect(firstTerminal?.focus).toHaveBeenCalledTimes(
        firstFocusCallsBeforeRetry
      );
      expect(secondTerminal?.focus).toHaveBeenCalledTimes(
        secondFocusCallsBeforeRetry
      );
      expect(document.activeElement).toBe(secondTerminal?.textarea);
    } finally {
      requestAnimationFrameSpy.mockRestore();
      cancelAnimationFrameSpy.mockRestore();
      textareaFocusSpy.mockRestore();
    }
  });

  it("keeps a moved surface attached when another pane reuses it", async () => {
    const firstSurface = createSurface("surface_1");
    const secondSurface = createSurface("surface_2");
    const sourceProps = createProps("surface_1");
    sourceProps.paneId = "pane_source";
    sourceProps.surfaces = [firstSurface, secondSurface];
    const targetProps = createProps("surface_1");
    targetProps.paneId = "pane_target";
    targetProps.surfaces = [firstSurface];
    const sourceAfterMoveProps = {
      ...sourceProps,
      surfaces: [secondSurface],
      activeSurfaceId: "surface_2"
    };
    const targetContainer = document.createElement("div");
    document.body.appendChild(targetContainer);
    const targetRoot = ReactDOMClient.createRoot(targetContainer);

    try {
      await act(async () => {
        root.render(<TerminalPane {...sourceProps} />);
        await flushMicrotasks();
      });
      await act(async () => {
        targetRoot.render(<TerminalPane {...targetProps} />);
        await flushMicrotasks();
      });
      await act(async () => {
        root.render(<TerminalPane {...sourceAfterMoveProps} />);
        await flushMicrotasks();
      });

      expect(window.kmux.detachSurface).not.toHaveBeenCalledWith(
        "surface_1",
        "session_surface_1"
      );
      expect(window.kmux.attachSurface).toHaveBeenCalledTimes(2);
      expect(window.kmux.attachSurface).toHaveBeenLastCalledWith(
        "surface_2",
        "session_surface_2"
      );
    } finally {
      act(() => {
        targetRoot.unmount();
      });
      targetContainer.remove();
    }
  });

  it("ignores stale attach completion after the same surface reattaches", async () => {
    const firstSurface = createSurface("surface_1");
    const secondSurface = createSurface("surface_2");
    const props = createProps("surface_1");
    props.surfaces = [firstSurface, secondSurface];
    let attachSequence = 0;
    let resolveFirstCompletion:
      | ((completion: { status: "ready" }) => void)
      | null = null;
    window.kmux.attachSurface = vi.fn(
      async (surfaceId: string, sessionId: string) => {
        attachSequence += 1;
        return {
          attachId: `attach_${attachSequence}`,
          snapshot: {
            surfaceId,
            sessionId,
            sequence: 0,
            vt: "",
            cols: 120,
            rows: 40,
            title: surfaceId,
            ports: [],
            unreadCount: 0,
            attention: false
          }
        };
      }
    );
    window.kmux.completeAttachSurface = vi.fn(
      async (_surfaceId: string, attachId: string) => {
        if (attachId === "attach_1") {
          return new Promise<{ status: "ready" }>((resolve) => {
            resolveFirstCompletion = resolve;
          });
        }
        return { status: "ready" as const };
      }
    );

    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks();
    });
    expect(window.kmux.completeAttachSurface).toHaveBeenCalledWith(
      "surface_1",
      "attach_1",
      "session_surface_1"
    );

    await act(async () => {
      root.render(<TerminalPane {...props} activeSurfaceId="surface_2" />);
      await flushMicrotasks();
    });
    await act(async () => {
      root.render(<TerminalPane {...props} activeSurfaceId="surface_1" />);
      await flushMicrotasks();
    });

    expect(
      terminalInstanceStore.getReadyAttachId("surface_1", "session_surface_1")
    ).toBe("attach_3");

    await act(async () => {
      resolveFirstCompletion?.({ status: "ready" });
      await flushMicrotasks();
    });

    expect(
      terminalInstanceStore.getReadyAttachId("surface_1", "session_surface_1")
    ).toBe("attach_3");
  });

  it("waits for a previous same-surface detach before reattaching", async () => {
    const firstSurface = createSurface("surface_1");
    const secondSurface = createSurface("surface_2");
    const props = createProps("surface_1");
    props.surfaces = [firstSurface, secondSurface];
    let resolveFirstDetach: (() => void) | null = null;
    window.kmux.detachSurface = vi.fn(async (surfaceId: string) => {
      if (surfaceId !== "surface_1") {
        return;
      }
      return new Promise<void>((resolve) => {
        resolveFirstDetach = resolve;
      });
    });

    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks();
    });
    await act(async () => {
      root.render(<TerminalPane {...props} activeSurfaceId="surface_2" />);
      await flushMicrotasks();
    });
    await act(async () => {
      root.render(<TerminalPane {...props} activeSurfaceId="surface_1" />);
      await flushMicrotasks();
    });

    expect(
      vi
        .mocked(window.kmux.attachSurface)
        .mock.calls.filter(([surfaceId]) => surfaceId === "surface_1")
    ).toHaveLength(1);

    await act(async () => {
      resolveFirstDetach?.();
      await flushMicrotasks();
    });

    expect(
      vi
        .mocked(window.kmux.attachSurface)
        .mock.calls.filter(([surfaceId]) => surfaceId === "surface_1")
    ).toHaveLength(2);
  });

  it("opens the fallback surface menu from the terminal viewport", async () => {
    const props = createProps("surface_1");
    const onSplitDown = vi.fn();
    props.onSplitDown = onSplitDown;
    window.kmux.showSurfaceContextMenu = vi.fn(async () => false);
    window.kmux.hasPasteableClipboardContent = vi.fn(async () => true);

    await act(async () => {
      root.render(<TerminalPane {...props} />);
    });
    vi.mocked(window.kmux.readClipboardImages).mockClear();

    const viewport = container.querySelector(
      "[data-testid='terminal-surface_1']"
    );
    expect(viewport).not.toBeNull();

    await act(async () => {
      viewport!.dispatchEvent(
        new MouseEvent("contextmenu", {
          clientX: 24,
          clientY: 32,
          bubbles: true,
          cancelable: true
        })
      );
    });

    const menu = container.querySelector(
      '[role="menu"][aria-label="Surface menu"]'
    );
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain("Copy");
    expect(menu?.textContent).toContain("Paste");
    expect(menu?.textContent).toContain("Split Horizontally");
    expect(menu?.textContent).toContain("Split Vertically");
    expect(menu?.textContent).toContain("Restart Session…");

    const copyButton = Array.from(
      menu!.querySelectorAll<HTMLButtonElement>("button")
    ).find((button) => button.textContent?.includes("Copy"));
    expect(copyButton?.disabled).toBe(true);
    expect(window.kmux.hasPasteableClipboardContent).toHaveBeenCalledOnce();
    expect(window.kmux.readClipboardImages).not.toHaveBeenCalled();

    const splitButton = Array.from(
      menu!.querySelectorAll<HTMLButtonElement>("button")
    ).find((button) => button.textContent?.includes("Split Horizontally"));
    expect(splitButton).toBeTruthy();

    act(() => {
      splitButton!.click();
    });

    expect(onSplitDown).toHaveBeenCalledWith("pane_1");
  });

  it("routes fallback restart through the surface restart callback", async () => {
    const props = createProps("surface_1");
    const onRestartSurface = vi.fn();
    props.onRestartSurface = onRestartSurface;
    window.kmux.showSurfaceContextMenu = vi.fn(async () => false);

    await act(async () => {
      root.render(<TerminalPane {...props} />);
    });

    const viewport = container.querySelector(
      "[data-testid='terminal-surface_1']"
    );
    await act(async () => {
      viewport!.dispatchEvent(
        new MouseEvent("contextmenu", {
          clientX: 24,
          clientY: 32,
          bubbles: true,
          cancelable: true
        })
      );
    });

    const restartButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[role="menu"] button[role="menuitem"]'
      )
    ).find((button) => button.textContent?.includes("Restart Session"));
    expect(restartButton).toBeTruthy();

    act(() => {
      restartButton!.click();
    });

    expect(onRestartSurface).toHaveBeenCalledWith("surface_1");
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

  it("sanitizes paste events that occur while copy mode is active", async () => {
    const props = createProps("surface_1");
    props.settings = {
      ...props.settings,
      shortcuts: {
        ...props.settings.shortcuts,
        "terminal.copyMode": "Ctrl+Shift+M"
      }
    };

    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks();
    });

    const terminalHost = container.querySelector(
      "[data-testid='terminal-surface_1'] .xterm"
    );
    expect(terminalHost).not.toBeNull();

    await act(async () => {
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
      await flushMicrotasks();
    });

    const terminal = vi.mocked(Terminal).mock.results.at(-1)?.value as
      | { paste: ReturnType<typeof vi.fn> }
      | undefined;
    expect(terminal).toBeDefined();
    terminal!.paste.mockClear();

    const pasteEvent = createTextPasteEvent("\u001b[201~hello\u007f");
    await act(async () => {
      terminalHost!.dispatchEvent(pasteEvent);
      await flushMicrotasks();
    });

    expect(pasteEvent.defaultPrevented).toBe(true);
    expect(terminal!.paste).toHaveBeenCalledWith("[201~hello");
  });

  it("falls back to bridge clipboard text when a paste event has no text", async () => {
    const props = createProps("surface_1");
    window.kmux.readClipboardText = vi.fn(async () => "fallback paste text");

    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks();
    });

    const terminalHost = container.querySelector(
      "[data-testid='terminal-surface_1'] .xterm"
    );
    expect(terminalHost).not.toBeNull();

    const terminal = vi.mocked(Terminal).mock.results.at(-1)?.value as
      | { paste: ReturnType<typeof vi.fn> }
      | undefined;
    expect(terminal).toBeDefined();
    terminal!.paste.mockClear();

    const pasteEvent = createTextPasteEvent("");
    await act(async () => {
      terminalHost!.dispatchEvent(pasteEvent);
      await flushMicrotasks();
    });

    expect(pasteEvent.defaultPrevented).toBe(true);
    expect(window.kmux.readClipboardText).toHaveBeenCalledOnce();
    expect(terminal!.paste).toHaveBeenCalledWith("fallback paste text");
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
    const handler = terminal?.attachCustomKeyEventHandler.mock.calls.at(
      -1
    )?.[0] as ((event: KeyboardEvent) => boolean) | undefined;
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
