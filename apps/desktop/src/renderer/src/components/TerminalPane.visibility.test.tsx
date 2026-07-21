// @vitest-environment jsdom

import { act } from "react";
import ReactDOMClient from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  KmuxSettings,
  SurfaceVm,
  TerminalDataPlaneClientMessage,
  TerminalDataPlaneHostMessage,
  TerminalFileLinkResolveCandidate,
  Uint64
} from "@kmux/proto";
import {
  IncrementalSha256,
  TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
  uint64
} from "@kmux/proto";
import type { ColorTheme } from "@kmux/ui";
import type { ILink, ILinkProvider } from "@xterm/xterm";
import type {
  TerminalStreamAttachResult,
  TerminalStreamGrant
} from "../../../shared/terminalPort";

import { buildPlatformKeyboardPolicy } from "../../../shared/platform/keyboardPolicy";
import {
  beginPaneDividerDrag,
  endPaneDividerDrag,
  resetPaneDividerDragForTests
} from "../paneDividerDrag";

let fitDimensions = { cols: 120, rows: 40 };
let terminalBufferText = "";
let nextFakeAttachId = 0;

interface FakeTerminalStreamAttach {
  grant: TerminalStreamGrant;
  port: FakeTerminalStreamPort;
}

let terminalStreamAttaches: FakeTerminalStreamAttach[] = [];

class FakeTerminalStreamPort {
  readonly sent: TerminalDataPlaneClientMessage[] = [];
  readonly close = vi.fn();
  readonly start = vi.fn();
  private readonly listeners = new Map<
    "message" | "messageerror",
    Set<(event: MessageEvent<unknown>) => void>
  >();

  postMessage(message: unknown): void {
    this.sent.push(message as TerminalDataPlaneClientMessage);
  }

  addEventListener(
    type: "message" | "messageerror",
    listener: (event: MessageEvent<unknown>) => void
  ): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(
    type: "message" | "messageerror",
    listener: (event: MessageEvent<unknown>) => void
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  receive(message: TerminalDataPlaneHostMessage): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: message } as MessageEvent<unknown>);
    }
  }
}

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
    let onDataListener: ((data: string) => void) | undefined;
    let compositionStartIndex = 0;
    let compositionActive = false;
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
      _bufferText: terminalBufferText,
      _rowsElement: null as HTMLElement | null,
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
        applicationCursorKeysMode: false,
        bracketedPasteMode: false,
        sendFocusMode: false,
        mouseTrackingMode: "none",
        synchronizedOutputMode: false
      },
      textarea: document.createElement("textarea"),
      loadAddon: vi.fn(),
      registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
      open: vi.fn((host: HTMLElement) => {
        terminal.textarea.addEventListener("compositionstart", () => {
          compositionActive = true;
          compositionStartIndex = terminal.textarea.value.length;
        });
        terminal.textarea.addEventListener("compositionend", () => {
          const endedCompositionStartIndex = compositionStartIndex;
          compositionActive = false;
          // Match xterm's CompositionHelper: native propagation updates the
          // textarea after compositionend, then xterm reads the final value.
          setTimeout(() => {
            const endIndex = compositionActive
              ? compositionStartIndex
              : terminal.textarea.value.length;
            const data = terminal.textarea.value.slice(
              endedCompositionStartIndex,
              endIndex
            );
            if (data) {
              onDataListener?.(data);
            }
          }, 0);
        });
        const xterm = document.createElement("div");
        xterm.className = "xterm";
        const viewport = document.createElement("div");
        viewport.className = "xterm-viewport";
        const scrollable = document.createElement("div");
        scrollable.className = "xterm-scrollable-element";
        const rows = document.createElement("span");
        rows.className = "xterm-rows";
        rows.textContent = terminal._bufferText;
        terminal._rowsElement = rows;
        xterm.append(viewport, scrollable, rows, terminal.textarea);
        host.append(xterm);
      }),
      attachCustomKeyEventHandler: vi.fn(),
      onData: vi.fn((listener: (data: string) => void) => {
        onDataListener = listener;
        return { dispose: vi.fn() };
      }),
      input: vi.fn((data: string) => {
        onDataListener?.(data);
      }),
      onBinary: vi.fn(() => ({ dispose: vi.fn() })),
      onRender: vi.fn(() => ({ dispose: vi.fn() })),
      onWriteParsed: vi.fn(() => ({ dispose: vi.fn() })),
      onScroll: vi.fn(() => ({ dispose: vi.fn() })),
      write: vi.fn((data: string, callback?: () => void) => {
        terminal._bufferText += data;
        terminalBufferText = terminal._bufferText;
        if (terminal._rowsElement) {
          terminal._rowsElement.textContent = terminal._bufferText;
        }
        callback?.();
      }),
      resize: vi.fn((cols: number, rows: number) => {
        terminal.cols = cols;
        terminal.rows = rows;
      }),
      refresh: vi.fn(),
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
import { flushRendererSmoothnessProfileEvents } from "../smoothnessProfile";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let resizeObserverCallbacks: Array<() => void> = [];

class MockResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverCallbacks.push(() =>
      callback([], this as unknown as ResizeObserver)
    );
  }

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
    restoreWorkspacesAfterQuit: true,
    notificationDesktop: false,
    notificationSound: false,
    themeMode: "dark",
    surfaceDiagnosticCaptureMode: "default",
    diagnosticLoggingEnabled: false,
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

function createCompositionEvent(
  type: "compositionstart" | "compositionupdate" | "compositionend",
  data = ""
): CompositionEvent {
  const event = new Event(type, { bubbles: true }) as CompositionEvent;
  Object.defineProperty(event, "data", { value: data });
  return event;
}

function transferTerminalPort(attach: FakeTerminalStreamAttach): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      source: window,
      data: {
        type: "kmux:terminal-port-transfer",
        grant: attach.grant
      },
      ports: [attach.port as unknown as MessagePort]
    })
  );
}

function createTerminalStreamAttach(
  surfaceId: string,
  sessionId: string
): FakeTerminalStreamAttach {
  const serial = ++nextFakeAttachId;
  return {
    grant: {
      attachId: `attach_${serial}`,
      session: {
        surfaceId,
        sessionId,
        epoch: `epoch_${serial}`
      }
    },
    port: new FakeTerminalStreamPort()
  };
}

function latestTerminalStreamAttach(
  surfaceId: string
): FakeTerminalStreamAttach {
  for (let index = terminalStreamAttaches.length - 1; index >= 0; index -= 1) {
    const attach = terminalStreamAttaches[index];
    if (attach?.grant.session.surfaceId === surfaceId) {
      return attach;
    }
  }
  throw new Error(`missing terminal stream attach for ${surfaceId}`);
}

function sendCheckpoint(
  attach: FakeTerminalStreamAttach,
  sequence = 0,
  overrides: {
    data?: string;
    cols?: number;
    rows?: number;
    cwdRanges?: Array<{ startLine: number; endLine: number; cwd: string }>;
  } = {}
): void {
  const data = overrides.data ?? "";
  const bytes = new TextEncoder().encode(data);
  const chunk = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(chunk).set(bytes);
  const checkpointId = `checkpoint-${sequence}`;
  const checkpointEnvelope = {
    protocol: TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
    attachId: attach.grant.attachId,
    session: attach.grant.session
  };
  attach.port.receive({
    ...checkpointEnvelope,
    type: "checkpoint:begin",
    checkpointId,
    purpose: { kind: "attach" },
    metadata: {
      format: "xterm-vt/1",
      session: attach.grant.session,
      sequence: u(sequence),
      cols: overrides.cols ?? 120,
      rows: overrides.rows ?? 40,
      ...(overrides.cwdRanges === undefined
        ? {}
        : { cwdRanges: overrides.cwdRanges })
    },
    totalBytes: bytes.byteLength
  });
  if (bytes.byteLength > 0) {
    attach.port.receive({
      ...checkpointEnvelope,
      type: "checkpoint:chunk",
      checkpointId,
      offset: 0,
      data: chunk
    });
  }
  attach.port.receive({
    ...checkpointEnvelope,
    type: "checkpoint:end",
    checkpointId,
    digest: new IncrementalSha256().update(bytes).digestHex()
  });
}

function u(value: number): Uint64 {
  return uint64(BigInt(value));
}

function sendOutput(
  attach: FakeTerminalStreamAttach,
  fromSequence: number,
  data: string,
  cwd?: string
): void {
  const sequence = fromSequence + 1;
  const byteLength = new TextEncoder().encode(data).byteLength;
  attach.port.receive({
    protocol: TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
    attachId: attach.grant.attachId,
    session: attach.grant.session,
    type: "delta",
    delta: {
      type: "output",
      fromSequence: u(fromSequence),
      sequence: u(sequence),
      byteLength,
      segments: [
        { sequence: u(sequence), data, byteLength, ...(cwd ? { cwd } : {}) }
      ]
    }
  });
}

function latestResizeRequest(
  attach: FakeTerminalStreamAttach
): Extract<TerminalDataPlaneClientMessage, { type: "resize" }> {
  for (let index = attach.port.sent.length - 1; index >= 0; index -= 1) {
    const message = attach.port.sent[index];
    if (message?.type === "resize") {
      return message;
    }
  }
  throw new Error(`missing direct resize request for ${attach.grant.attachId}`);
}

function acknowledgeResizeRequest(
  attach: FakeTerminalStreamAttach,
  request: Extract<TerminalDataPlaneClientMessage, { type: "resize" }>,
  sequence: number
): void {
  if (!request.requestId) {
    throw new Error("direct resize request is missing its request id");
  }
  attach.port.receive({
    protocol: TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
    attachId: attach.grant.attachId,
    session: attach.grant.session,
    type: "delta",
    delta: {
      type: "resize",
      sequence: u(sequence),
      cols: request.cols,
      rows: request.rows
    }
  });
  attach.port.receive({
    protocol: TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
    attachId: attach.grant.attachId,
    session: attach.grant.session,
    type: "resize:ack",
    requestId: request.requestId,
    sequence: u(sequence),
    cols: request.cols,
    rows: request.rows
  });
}

function provideCurrentTerminalFileLinks(): Promise<ILink[] | undefined> {
  const terminalMock = vi.mocked(Terminal);
  const terminal = terminalMock.mock.results.at(-1)?.value as
    | {
        registerLinkProvider: {
          mock: { calls: Array<[ILinkProvider]> };
        };
      }
    | undefined;
  const provider = terminal?.registerLinkProvider.mock.calls[0]?.[0];
  return new Promise((resolve) => {
    if (!provider) {
      resolve(undefined);
      return;
    }
    provider.provideLinks(1, (providedLinks) => {
      resolve(providedLinks);
    });
  });
}

describe("TerminalPane visibility cleanup", () => {
  let container: HTMLDivElement;
  let root: ReactDOMClient.Root;
  let windowFocus: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fitDimensions = { cols: 120, rows: 40 };
    terminalBufferText = "";
    nextFakeAttachId = 0;
    terminalStreamAttaches = [];
    resizeObserverCallbacks = [];
    resetPaneDividerDragForTests();
    windowFocus = vi.spyOn(window, "focus").mockImplementation(() => {});
    (
      globalThis as typeof globalThis & { ResizeObserver: unknown }
    ).ResizeObserver = MockResizeObserver;
    window.kmux = {
      ...window.kmux,
      attachTerminalStream: vi.fn(async (surfaceId, sessionId) => {
        const attach = createTerminalStreamAttach(surfaceId, sessionId);
        terminalStreamAttaches.push(attach);
        queueMicrotask(() => transferTerminalPort(attach));
        return {
          status: "granted",
          grant: attach.grant
        } satisfies TerminalStreamAttachResult;
      }),
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
      resolveTerminalFileLinks: vi.fn(
        async (
          _surfaceId: string,
          candidates: TerminalFileLinkResolveCandidate[]
        ) => ({
          links: candidates.map((candidate) => ({
            id: candidate.id,
            openRawPath: candidate.rawPath,
            resolvedPath: candidate.baseCwd
              ? `${candidate.baseCwd}/${candidate.rawPath}`
              : candidate.rawPath,
            linkText: candidate.linkText,
            startIndex: candidate.startIndex,
            endIndex: candidate.endIndex
          }))
        })
      ),
      showSurfaceContextMenu: vi.fn(async () => {}),
      subscribeSurfaceContextMenuAction: vi.fn(() => vi.fn()),
      reportTerminalStreamError: vi.fn(async () => {}),
      captureSurfaceDiagnostics: vi.fn(async () => ({}) as never)
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = ReactDOMClient.createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await flushMicrotasks(10);
    });
    terminalInstanceStore.releaseAll();
    resetPaneDividerDragForTests();
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

  it("installs interaction diagnostics only while diagnostic logging is enabled", async () => {
    let diagnosticsEnabled = false;
    let notifyDiagnosticsLogging: ((enabled: boolean) => void) | null = null;
    window.kmux.profileSmoothnessEnabled = vi.fn(() => diagnosticsEnabled);
    window.kmux.subscribeDiagnosticsLogging = vi.fn((listener) => {
      notifyDiagnosticsLogging = listener;
      return vi.fn();
    });
    window.kmux.recordSmoothnessProfileEvents = vi.fn(async () => {});

    await act(async () => {
      root.render(<TerminalPane {...createProps("surface_1")} />);
      await flushMicrotasks();
    });
    const terminal = vi.mocked(Terminal).mock.results[0]?.value as {
      onWriteParsed: ReturnType<typeof vi.fn>;
    };
    expect(terminal.onWriteParsed).toHaveBeenCalledTimes(1);

    diagnosticsEnabled = true;
    await act(async () => {
      notifyDiagnosticsLogging?.(true);
      await flushMicrotasks();
    });
    expect(terminal.onWriteParsed).toHaveBeenCalledTimes(2);
    const diagnosticListenerDispose = terminal.onWriteParsed.mock.results[1]
      ?.value.dispose as ReturnType<typeof vi.fn>;

    diagnosticsEnabled = false;
    await act(async () => {
      notifyDiagnosticsLogging?.(false);
      await flushMicrotasks();
    });
    expect(diagnosticListenerDispose).toHaveBeenCalledOnce();
    await flushRendererSmoothnessProfileEvents();
  });

  it("uses one direct v2 port for checkpoint, text, binary, and detach", async () => {
    const props = createProps("surface_1");
    const port = new FakeTerminalStreamPort();
    const grant = {
      attachId: "attach_v2",
      session: {
        surfaceId: "surface_1",
        sessionId: "session_surface_1",
        epoch: "epoch_v2"
      }
    };
    window.kmux.attachTerminalStream = vi.fn(async () => {
      queueMicrotask(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            source: window,
            data: {
              type: "kmux:terminal-port-transfer",
              grant
            },
            ports: [port as unknown as MessagePort]
          })
        );
      });
      return { status: "granted", grant } satisfies TerminalStreamAttachResult;
    });

    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks(10);
    });
    const oldTerminal = vi.mocked(Terminal).mock.results[0]?.value as {
      _bufferText: string;
      write(data: string, callback?: () => void): void;
      reset: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
      onData: ReturnType<typeof vi.fn>;
    };
    oldTerminal.write("old-visible");
    terminalBufferText = "";
    expect(port.sent[0]).toMatchObject({
      type: "attach",
      attachId: "attach_v2"
    });

    const frames: FrameRequestCallback[] = [];
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
    const cancelAnimationFrameSpy = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => {});
    try {
      await act(async () => {
        sendCheckpoint({ grant, port }, 0, { data: "snapshot-v2" });
        await flushMicrotasks();
      });

      const stagedTerminal = vi.mocked(Terminal).mock.results.at(-1)?.value as {
        _bufferText: string;
        onData: { mock: { calls: Array<[(data: string) => void]> } };
        onBinary: { mock: { calls: Array<[(data: string) => void]> } };
        onRender: { mock: { calls: Array<[() => void]> } };
      };
      expect(vi.mocked(Terminal)).toHaveBeenCalledTimes(2);
      expect(oldTerminal._bufferText).toBe("old-visible");
      expect(oldTerminal.reset).not.toHaveBeenCalled();
      expect(oldTerminal.dispose).not.toHaveBeenCalled();
      expect(stagedTerminal._bufferText).toBe("snapshot-v2");
      expect(
        terminalInstanceStore.getTerminalBundle("surface_1")?.terminal
      ).toBe(oldTerminal);
      expect(frames).toHaveLength(1);

      await act(async () => {
        frames.shift()?.(performance.now());
        await flushMicrotasks();
        frames.shift()?.(performance.now());
        await flushMicrotasks(10);
      });

      expect(
        terminalInstanceStore.getTerminalBundle("surface_1")?.terminal
      ).toBe(stagedTerminal);
      expect(oldTerminal.dispose).toHaveBeenCalledOnce();
      expect(
        oldTerminal.onData.mock.results[0]?.value.dispose
      ).toHaveBeenCalledOnce();

      stagedTerminal.onData.mock.calls[0]?.[0]("text-v2");
      stagedTerminal.onBinary.mock.calls[0]?.[0]("\u0001");
      stagedTerminal.onRender.mock.calls.at(-1)?.[0]();
      const wrapper = container.querySelector<HTMLElement>(
        "[data-testid='terminal-surface_1']"
      );
      expect(Number(wrapper?.dataset.terminalRenderGeneration)).toBe(1);
      expect(Number(wrapper?.dataset.terminalLastOnRenderAt)).toBeGreaterThan(
        0
      );
      expect(port.sent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "input:text", text: "text-v2" }),
          expect.objectContaining({ type: "input:binary", data: "\u0001" })
        ])
      );
    } finally {
      requestAnimationFrameSpy.mockRestore();
      cancelAnimationFrameSpy.mockRestore();
    }

    await act(async () => {
      root.render(<div />);
      await flushMicrotasks();
    });
    expect(port.sent.at(-1)).toMatchObject({
      type: "detach",
      reason: "hidden"
    });
    expect(port.close).toHaveBeenCalledOnce();
  });

  it("buffers v2 text and binary on the direct port while the grant is pending", async () => {
    const props = createProps("surface_1");
    const port = new FakeTerminalStreamPort();
    const grant = {
      attachId: "attach_pending_input",
      session: {
        surfaceId: "surface_1",
        sessionId: "session_surface_1",
        epoch: "epoch_pending_input"
      }
    };
    let resolveGrant!: (value: TerminalStreamAttachResult) => void;
    window.kmux.attachTerminalStream = vi.fn(
      () =>
        new Promise<TerminalStreamAttachResult>((resolve) => {
          resolveGrant = resolve;
        })
    );

    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks();
    });
    const terminal = vi.mocked(Terminal).mock.results.at(-1)?.value as {
      onData: { mock: { calls: Array<[(data: string) => void]> } };
      onBinary: { mock: { calls: Array<[(data: string) => void]> } };
    };
    terminal.onData.mock.calls[0]?.[0]("before-grant");
    terminal.onBinary.mock.calls[0]?.[0]("\u0002");

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          data: {
            type: "kmux:terminal-port-transfer",
            grant
          },
          ports: [port as unknown as MessagePort]
        })
      );
      resolveGrant({ status: "granted", grant });
      await flushMicrotasks(10);
    });

    expect(
      port.sent
        .filter(
          (message) =>
            message.type === "input:text" || message.type === "input:binary"
        )
        .map((message) => message.type)
    ).toEqual(["input:text", "input:binary"]);
    expect(port.sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "input:text",
          text: "before-grant"
        }),
        expect.objectContaining({ type: "input:binary", data: "\u0002" })
      ])
    );
  });

  it("buffers text and binary in FIFO order while a closed stream reattaches", async () => {
    const props = createProps("surface_1");
    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks(10);
    });
    const firstAttach = latestTerminalStreamAttach("surface_1");
    const nextAttach = createTerminalStreamAttach(
      "surface_1",
      "session_surface_1"
    );
    let resolveGrant!: (value: TerminalStreamAttachResult) => void;
    window.kmux.attachTerminalStream = vi.fn(
      () =>
        new Promise<TerminalStreamAttachResult>((resolve) => {
          resolveGrant = resolve;
        })
    );

    await act(async () => {
      firstAttach.port.receive({
        protocol: TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
        attachId: firstAttach.grant.attachId,
        session: firstAttach.grant.session,
        type: "error",
        code: "internal",
        message: "replace stream",
        recoverable: false
      });
      await flushMicrotasks(20);
    });

    expect(window.kmux.reportTerminalStreamError).toHaveBeenCalledWith({
      surfaceId: "surface_1",
      sessionId: "session_surface_1",
      error: {
        kind: "host-error",
        code: "internal",
        message: "replace stream",
        recoverable: false
      }
    });

    const terminal = vi.mocked(Terminal).mock.results.at(-1)?.value as {
      onData: { mock: { calls: Array<[(data: string) => void]> } };
      onBinary: { mock: { calls: Array<[(data: string) => void]> } };
    };
    terminal.onData.mock.calls[0]?.[0]("text-before");
    terminal.onBinary.mock.calls[0]?.[0]("\u0003");
    terminal.onData.mock.calls[0]?.[0]("text-after");

    await act(async () => {
      transferTerminalPort(nextAttach);
      resolveGrant({ status: "granted", grant: nextAttach.grant });
      await flushMicrotasks(20);
    });

    expect(
      nextAttach.port.sent
        .filter(
          (message) =>
            message.type === "input:text" || message.type === "input:binary"
        )
        .map((message) =>
          message.type === "input:text"
            ? `text:${message.text}`
            : `binary:${message.data}`
        )
    ).toEqual(["text:text-before", "binary:\u0003", "text:text-after"]);
  });

  it("passes snapshot cwd ranges into terminal file links", async () => {
    const props = createProps("surface_1");

    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks(10);
    });

    const attach = latestTerminalStreamAttach("surface_1");
    const frames: FrameRequestCallback[] = [];
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
    const cancelAnimationFrameSpy = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => {});
    try {
      await act(async () => {
        sendCheckpoint(attach, 0, {
          data: "src/App.tsx",
          cwdRanges: [{ startLine: 0, endLine: 0, cwd: "/repo/snapshot" }]
        });
        await flushMicrotasks();
        frames.shift()?.(performance.now());
        await flushMicrotasks();
        frames.shift()?.(performance.now());
        await flushMicrotasks(10);
      });
    } finally {
      requestAnimationFrameSpy.mockRestore();
      cancelAnimationFrameSpy.mockRestore();
    }

    const links = await provideCurrentTerminalFileLinks();
    links?.[0]?.activate(
      new MouseEvent("click", { ctrlKey: true }),
      "src/App.tsx"
    );
    await Promise.resolve();

    expect(window.kmux.openTerminalFilePath).toHaveBeenCalledWith(
      "surface_1",
      "/repo/snapshot/src/App.tsx",
      undefined
    );
  });

  it("records live chunk cwd for terminal file links", async () => {
    const props = createProps("surface_1");

    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks(10);
    });
    const attach = latestTerminalStreamAttach("surface_1");
    const frames: FrameRequestCallback[] = [];
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
    const cancelAnimationFrameSpy = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => {});
    try {
      await act(async () => {
        sendCheckpoint(attach);
        await flushMicrotasks();
        frames.shift()?.(performance.now());
        await flushMicrotasks();
        frames.shift()?.(performance.now());
        await flushMicrotasks(10);
        sendOutput(attach, 0, "src/App.tsx", "/repo/live");
        await flushMicrotasks(10);
      });
    } finally {
      requestAnimationFrameSpy.mockRestore();
      cancelAnimationFrameSpy.mockRestore();
    }

    const links = await provideCurrentTerminalFileLinks();
    links?.[0]?.activate(
      new MouseEvent("click", { ctrlKey: true }),
      "src/App.tsx"
    );
    await Promise.resolve();

    expect(window.kmux.openTerminalFilePath).toHaveBeenCalledWith(
      "surface_1",
      "/repo/live/src/App.tsx",
      undefined
    );
  });

  it("waits for a restored session to be running before attaching its direct port", async () => {
    const pendingProps = createProps("surface_1");
    pendingProps.surfaces = [
      {
        ...pendingProps.surfaces[0],
        sessionState: "pending",
        shellInputReady: false
      }
    ];

    await act(async () => {
      root.render(<TerminalPane {...pendingProps} />);
      await flushMicrotasks(10);
    });

    expect(window.kmux.attachTerminalStream).not.toHaveBeenCalled();

    const runningProps = {
      ...pendingProps,
      surfaces: [
        {
          ...pendingProps.surfaces[0],
          sessionState: "running" as const
        }
      ]
    };
    await act(async () => {
      root.render(<TerminalPane {...runningProps} />);
      await flushMicrotasks(10);
    });

    expect(window.kmux.attachTerminalStream).toHaveBeenCalledOnce();
    expect(window.kmux.attachTerminalStream).toHaveBeenCalledWith(
      "surface_1",
      "session_surface_1"
    );
  });

  it("shows remote journal degradation without replacing the direct terminal attachment", async () => {
    const props = createProps("surface_1");
    props.surfaces = [
      {
        ...props.surfaces[0],
        storageStatus: {
          state: "backpressured",
          journalAdmitted: "42",
          journalSynced: "41",
          emergencyBytes: 4 * 1024 * 1024,
          lastSyncDurationMs: 2000
        }
      }
    ];

    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks(10);
    });

    expect(
      container.querySelector('[data-storage-state="backpressured"]')
        ?.textContent
    ).toContain("Terminal output is paused");
    expect(window.kmux.attachTerminalStream).toHaveBeenCalledOnce();

    await act(async () => {
      root.render(
        <TerminalPane
          {...props}
          surfaces={[
            {
              ...props.surfaces[0],
              storageStatus: {
                state: "normal",
                journalAdmitted: "42",
                journalSynced: "42",
                emergencyBytes: 0
              }
            }
          ]}
        />
      );
      await flushMicrotasks(10);
    });

    expect(container.querySelector("[data-storage-state]")).toBeNull();
    expect(window.kmux.attachTerminalStream).toHaveBeenCalledOnce();
  });

  it("can attach a surface that is first shown after its session exited", async () => {
    const props = createProps("surface_1");
    props.surfaces = [
      {
        ...props.surfaces[0],
        sessionState: "exited",
        exitCode: 0
      }
    ];

    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks(10);
    });

    expect(window.kmux.attachTerminalStream).toHaveBeenCalledOnce();
  });

  it("keeps the direct port alive for final output after the control state exits", async () => {
    const props = createProps("surface_1");
    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks(10);
    });
    const attach = latestTerminalStreamAttach("surface_1");
    const frames: FrameRequestCallback[] = [];
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
    const cancelAnimationFrameSpy = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => {});
    try {
      await act(async () => {
        sendCheckpoint(attach);
        await flushMicrotasks();
        frames.shift()?.(performance.now());
        await flushMicrotasks();
        frames.shift()?.(performance.now());
        await flushMicrotasks(10);
      });

      const exitedProps = {
        ...props,
        surfaces: [
          {
            ...props.surfaces[0],
            sessionState: "exited" as const,
            exitCode: 0
          }
        ]
      };
      await act(async () => {
        root.render(<TerminalPane {...exitedProps} />);
        await flushMicrotasks(10);
      });

      expect(window.kmux.attachTerminalStream).toHaveBeenCalledOnce();
      expect(attach.port.sent).not.toContainEqual(
        expect.objectContaining({ type: "detach" })
      );

      await act(async () => {
        sendOutput(attach, 0, "final-output-tail");
        attach.port.receive({
          protocol: TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
          attachId: attach.grant.attachId,
          session: attach.grant.session,
          type: "exit",
          sequence: u(2),
          exitCode: 0
        });
        await flushMicrotasks(10);
      });
    } finally {
      requestAnimationFrameSpy.mockRestore();
      cancelAnimationFrameSpy.mockRestore();
    }

    const rows = container.querySelector<HTMLElement>(
      "[data-testid='terminal-surface_1'] .xterm-rows"
    );
    expect(rows?.textContent).toContain("final-output-tail");
    expect(rows?.textContent).toContain("Session exited (0)");
  });

  it("rearms a visible running surface after one transient retry cycle is exhausted", async () => {
    vi.useFakeTimers();
    try {
      const props = createProps("surface_1");
      window.kmux.attachTerminalStream = vi.fn(async (surfaceId, sessionId) => {
        const callCount = vi.mocked(window.kmux.attachTerminalStream).mock.calls
          .length;
        if (callCount <= 5) {
          return {
            status: "retryable-not-ready",
            reason: "runtime-not-ready"
          } satisfies TerminalStreamAttachResult;
        }
        const attach = createTerminalStreamAttach(surfaceId, sessionId);
        terminalStreamAttaches.push(attach);
        queueMicrotask(() => transferTerminalPort(attach));
        return {
          status: "granted",
          grant: attach.grant
        } satisfies TerminalStreamAttachResult;
      });

      await act(async () => {
        root.render(<TerminalPane {...props} />);
        await flushMicrotasks(10);
      });
      expect(window.kmux.attachTerminalStream).toHaveBeenCalledOnce();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_600);
        await flushMicrotasks(20);
      });
      expect(window.kmux.attachTerminalStream).toHaveBeenCalledTimes(5);

      const terminal = vi.mocked(Terminal).mock.results.at(-1)?.value as {
        onData: { mock: { calls: Array<[(data: string) => void]> } };
      };
      terminal.onData.mock.calls[0]?.[0]("input-during-rearm");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
        await flushMicrotasks(20);
      });

      expect(window.kmux.attachTerminalStream).toHaveBeenCalledTimes(6);
      const attached = latestTerminalStreamAttach("surface_1");
      expect(
        container.querySelector<HTMLElement>(
          "[data-testid='terminal-surface_1']"
        )?.dataset.terminalStreamReady
      ).toBe(attached.grant.attachId);
      expect(attached.port.sent).toContainEqual(
        expect.objectContaining({
          type: "input:text",
          text: "input-during-rearm"
        })
      );
    } finally {
      vi.useRealTimers();
    }
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

  it("defers container-size fits during a divider drag and flushes a final fit when it ends", async () => {
    const props = createProps("surface_1");

    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks(10);
    });

    const attach = latestTerminalStreamAttach("surface_1");
    const initialResize = latestResizeRequest(attach);
    await act(async () => {
      sendCheckpoint(attach);
      acknowledgeResizeRequest(attach, initialResize, 1);
      await new Promise((resolve) => setTimeout(resolve, 80));
      await flushMicrotasks(10);
    });
    const observerCallback = resizeObserverCallbacks.at(-1);
    expect(observerCallback).toBeDefined();
    attach.port.sent.splice(0);

    // No drag active: a container-size change still resizes promptly.
    fitDimensions = { cols: 90, rows: 28 };
    await act(async () => {
      observerCallback?.();
      await new Promise((resolve) => setTimeout(resolve, 60));
      await flushMicrotasks();
    });

    expect(attach.port.sent).toContainEqual(
      expect.objectContaining({
        type: "resize",
        cols: 90,
        rows: 28,
        gestureActive: false
      })
    );
    const settledResize = latestResizeRequest(attach);
    await act(async () => {
      acknowledgeResizeRequest(attach, settledResize, 2);
      await flushMicrotasks(10);
    });

    attach.port.sent.splice(0);
    beginPaneDividerDrag();
    fitDimensions = { cols: 100, rows: 30 };

    await act(async () => {
      observerCallback?.();
      // The 30ms container-resize debounce elapses, but the divider-drag
      // throttle (~200ms) should still be holding the fit back.
      await new Promise((resolve) => setTimeout(resolve, 60));
      await flushMicrotasks();
    });

    expect(attach.port.sent).not.toContainEqual(
      expect.objectContaining({ type: "resize", cols: 100, rows: 30 })
    );

    await act(async () => {
      endPaneDividerDrag();
      await flushMicrotasks();
    });

    expect(attach.port.sent).toContainEqual(
      expect.objectContaining({
        type: "resize",
        cols: 100,
        rows: 30,
        gestureActive: false
      })
    );
  });

  it("reuses the direct port and sends the first resize after a same-session remount", async () => {
    const props = createProps("surface_1");

    await act(async () => {
      root.render(<TerminalPane key="first" {...props} />);
      await flushMicrotasks(10);
    });

    const attach = latestTerminalStreamAttach("surface_1");
    attach.port.sent.splice(0);
    fitDimensions = { cols: 100, rows: 40 };

    await act(async () => {
      root.render(<TerminalPane key="second" {...props} />);
      await flushMicrotasks(10);
    });

    expect(window.kmux.attachTerminalStream).toHaveBeenCalledTimes(1);
    expect(attach.port.sent).toContainEqual(
      expect.objectContaining({
        type: "resize",
        cols: 100,
        rows: 40,
        gestureActive: false
      })
    );
    expect(attach.port.sent).not.toContainEqual(
      expect.objectContaining({ type: "detach" })
    );
  });

  it("preserves warm geometry until resume replay precedes the desired pane resize", async () => {
    const props = createProps("surface_1");
    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks(10);
    });
    const firstAttach = latestTerminalStreamAttach("surface_1");
    const frames: FrameRequestCallback[] = [];
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
    const cancelAnimationFrameSpy = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => {});
    try {
      await act(async () => {
        sendCheckpoint(firstAttach);
        await flushMicrotasks();
        frames.shift()?.(performance.now());
        await flushMicrotasks();
        frames.shift()?.(performance.now());
        await flushMicrotasks(10);
      });
    } finally {
      requestAnimationFrameSpy.mockRestore();
      cancelAnimationFrameSpy.mockRestore();
    }
    const warmTerminal =
      terminalInstanceStore.getTerminalBundle("surface_1")!.terminal;
    expect({ cols: warmTerminal.cols, rows: warmTerminal.rows }).toEqual({
      cols: 120,
      rows: 40
    });

    await act(async () => {
      root.render(<div />);
      await flushMicrotasks(20);
    });

    const resumeAttach = createTerminalStreamAttach(
      "surface_1",
      "session_surface_1"
    );
    resumeAttach.grant.session.epoch = firstAttach.grant.session.epoch;
    window.kmux.attachTerminalStream = vi.fn(async () => {
      terminalStreamAttaches.push(resumeAttach);
      queueMicrotask(() => transferTerminalPort(resumeAttach));
      return {
        status: "granted",
        grant: resumeAttach.grant
      } satisfies TerminalStreamAttachResult;
    });
    fitDimensions = { cols: 90, rows: 28 };
    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks(20);
    });

    expect(resumeAttach.port.sent[0]).toMatchObject({
      type: "attach",
      resumeFromSequence: u(0)
    });
    expect({ cols: warmTerminal.cols, rows: warmTerminal.rows }).toEqual({
      cols: 120,
      rows: 40
    });
    const desiredResize = latestResizeRequest(resumeAttach);
    expect(desiredResize).toMatchObject({ cols: 90, rows: 28 });

    await act(async () => {
      resumeAttach.port.receive({
        protocol: TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
        attachId: resumeAttach.grant.attachId,
        session: resumeAttach.grant.session,
        type: "attached",
        mode: "resume",
        resumedFromSequence: u(0),
        sequence: u(0),
        cols: 120,
        rows: 40
      });
      sendOutput(resumeAttach, 0, "warm-replay-tail");
      await flushMicrotasks(10);
    });
    expect({ cols: warmTerminal.cols, rows: warmTerminal.rows }).toEqual({
      cols: 120,
      rows: 40
    });

    await act(async () => {
      acknowledgeResizeRequest(resumeAttach, desiredResize, 2);
      await flushMicrotasks(10);
    });
    expect({ cols: warmTerminal.cols, rows: warmTerminal.rows }).toEqual({
      cols: 90,
      rows: 28
    });
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
      await flushMicrotasks(10);
    });
    const previousAttach = latestTerminalStreamAttach("surface_1");

    await act(async () => {
      root.render(<TerminalPane {...restartedProps} />);
      await flushMicrotasks(10);
    });

    expect(previousAttach.port.sent).toContainEqual(
      expect.objectContaining({ type: "detach" })
    );
    expect(window.kmux.attachTerminalStream).toHaveBeenLastCalledWith(
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
      await flushMicrotasks(10);
    });
    const previousAttach = latestTerminalStreamAttach("surface_1");

    await act(async () => {
      root.render(<TerminalPane {...switchedProps} />);
      await flushMicrotasks(10);
    });

    expect(previousAttach.port.sent).toContainEqual(
      expect.objectContaining({ type: "detach" })
    );
    expect(window.kmux.attachTerminalStream).toHaveBeenLastCalledWith(
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
        await flushMicrotasks(10);
      });
      const movedAttach = latestTerminalStreamAttach("surface_1");
      await act(async () => {
        targetRoot.render(<TerminalPane {...targetProps} />);
        await flushMicrotasks(10);
      });
      await act(async () => {
        root.render(<TerminalPane {...sourceAfterMoveProps} />);
        await flushMicrotasks(10);
      });

      expect(movedAttach.port.sent).not.toContainEqual(
        expect.objectContaining({ type: "detach" })
      );
      expect(window.kmux.attachTerminalStream).toHaveBeenCalledTimes(2);
      expect(window.kmux.attachTerminalStream).toHaveBeenLastCalledWith(
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

  it("requests the native surface menu from the terminal viewport", async () => {
    const props = createProps("surface_1");
    window.kmux.showSurfaceContextMenu = vi.fn(async () => {});
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

    expect(window.kmux.showSurfaceContextMenu).toHaveBeenCalledWith(
      "surface_1",
      24,
      32,
      expect.objectContaining({
        canCopy: false,
        canPaste: true,
        canRestart: true,
        sessionState: "running"
      })
    );
    expect(window.kmux.hasPasteableClipboardContent).toHaveBeenCalledOnce();
    expect(window.kmux.readClipboardImages).not.toHaveBeenCalled();
  });

  it("routes native surface menu restart events through the surface restart callback", async () => {
    const props = createProps("surface_1");
    const onRestartSurface = vi.fn();
    let nativeMenuListener:
      | Parameters<typeof window.kmux.subscribeSurfaceContextMenuAction>[0]
      | null = null;
    props.onRestartSurface = onRestartSurface;
    window.kmux.subscribeSurfaceContextMenuAction = vi.fn((listener) => {
      nativeMenuListener = listener;
      return vi.fn();
    });

    await act(async () => {
      root.render(<TerminalPane {...props} />);
    });

    await act(async () => {
      nativeMenuListener?.({
        surfaceId: "surface_1",
        action: "restart-session"
      });
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

  it("preserves xterm's delayed ibus commit after an empty compositionend", async () => {
    const props = createProps("surface_1");

    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks(10);
    });

    const terminalTextarea = container.querySelector<HTMLTextAreaElement>(
      "[data-testid='terminal-surface_1'] textarea"
    );
    const terminal = vi.mocked(Terminal).mock.results.at(-1)?.value as
      | { onData: ReturnType<typeof vi.fn> }
      | undefined;
    const onData = terminal?.onData.mock.calls.at(-1)?.[0] as
      | ((data: string) => void)
      | undefined;
    expect(terminalTextarea).not.toBeNull();
    expect(onData).toBeTypeOf("function");

    const attach = latestTerminalStreamAttach("surface_1");
    const sentTexts = (): string[] =>
      attach.port.sent.flatMap((message) =>
        message.type === "input:text" ? [message.text] : []
      );

    act(() => {
      terminalTextarea!.value = "안";
      terminalTextarea!.dispatchEvent(
        createCompositionEvent("compositionstart")
      );
      terminalTextarea!.dispatchEvent(
        createCompositionEvent("compositionupdate", "녕")
      );
      terminalTextarea!.dispatchEvent(
        createCompositionEvent("compositionupdate", "")
      );
      terminalTextarea!.dispatchEvent(createCompositionEvent("compositionend"));
      // Some ibus paths expose the final text only after compositionend.
      terminalTextarea!.value = "안녕";
    });

    expect(terminalTextarea!.value).toBe("안녕");
    expect(sentTexts()).toEqual([]);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(sentTexts()).toEqual(["녕"]);
    expect(terminalTextarea!.value).toBe("");

    act(() => {
      onData!("녕");
    });
    expect(sentTexts()).toEqual(["녕"]);
  });

  it("clears propagated macOS IME residue before cursor movement and the next composition", async () => {
    const props = createProps("surface_1");
    props.keyboardPlatform = "darwin";

    await act(async () => {
      root.render(<TerminalPane {...props} />);
      await flushMicrotasks(10);
    });

    const terminalTextarea = container.querySelector<HTMLTextAreaElement>(
      "[data-testid='terminal-surface_1'] textarea"
    );
    expect(terminalTextarea).not.toBeNull();

    const terminal = vi.mocked(Terminal).mock.results.at(-1)?.value as
      | {
          attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
          input: ReturnType<typeof vi.fn>;
        }
      | undefined;
    const handler = terminal?.attachCustomKeyEventHandler.mock.calls.at(
      -1
    )?.[0] as ((event: KeyboardEvent) => boolean) | undefined;
    expect(handler).toBeTypeOf("function");

    const attach = latestTerminalStreamAttach("surface_1");
    const sentTexts = (): string[] =>
      attach.port.sent.flatMap((message) =>
        message.type === "input:text" ? [message.text] : []
      );

    act(() => {
      terminalTextarea!.value = "";
      terminalTextarea!.dispatchEvent(
        createCompositionEvent("compositionstart")
      );
      terminalTextarea!.value = "대";
      terminalTextarea!.dispatchEvent(
        createCompositionEvent("compositionupdate", "대")
      );
      expect(
        handler!(
          new KeyboardEvent("keydown", {
            key: "ArrowLeft",
            code: "ArrowLeft"
          })
        )
      ).toBe(false);
      terminalTextarea!.dispatchEvent(
        createCompositionEvent("compositionend", "대")
      );
      // Chromium can expose the real commit only after compositionend. This
      // non-prefix correction catches both an early guessed send and a clear.
      terminalTextarea!.value = "데";
      expect(
        handler!(
          new KeyboardEvent("keydown", {
            key: "ArrowRight",
            code: "ArrowRight"
          })
        )
      ).toBe(false);
    });

    expect(terminalTextarea!.value).toBe("데");
    expect(sentTexts()).toEqual([]);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(terminal!.input.mock.calls).toEqual([
      ["\u001b[D", true],
      ["\u001b[C", true]
    ]);
    expect(sentTexts()).toEqual(["데", "\u001b[D", "\u001b[C"]);

    act(() => {
      // A retained commit plus a hidden-textarea caret moved to the front made
      // xterm slice the old suffix as the next commit (for example, "데"
      // instead of the newly composed "근").
      terminalTextarea!.setSelectionRange(0, 0);
      terminalTextarea!.dispatchEvent(
        createCompositionEvent("compositionstart")
      );
      terminalTextarea!.setRangeText("근");
      terminalTextarea!.dispatchEvent(
        createCompositionEvent("compositionupdate", "근")
      );
      terminalTextarea!.dispatchEvent(
        createCompositionEvent("compositionend", "근")
      );
    });

    expect(sentTexts()).toEqual(["데", "\u001b[D", "\u001b[C"]);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(sentTexts()).toEqual(["데", "\u001b[D", "\u001b[C", "근"]);
    expect(terminalTextarea!.value).toBe("");
  });
});
