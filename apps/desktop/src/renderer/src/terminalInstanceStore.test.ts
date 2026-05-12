// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn(() => ({
    loadAddon: vi.fn(),
    open: vi.fn(),
    dispose: vi.fn(),
    clearTextureAtlas: vi.fn(),
    refresh: vi.fn(),
    rows: 4,
    unicode: { activeVersion: "" }
  }))
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: vi.fn(() => ({})) }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: vi.fn(() => ({})) }));
vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: vi.fn(() => ({}))
}));

import {
  acquire,
  clearRenderSink,
  getRenderSink,
  release,
  releaseAll,
  getLastHydratedSurfaceId,
  getLastHydratedSurfaceSequence,
  markSurfaceHydrated,
  markSurfaceRendered,
  registerAttachment,
  registerWebglTerminal,
  recoverWebglTextureAtlases,
  setRenderSink,
  unregisterWebglTerminal,
  type TerminalInstance
} from "./terminalInstanceStore";
import { Terminal } from "@xterm/xterm";

function makeInstance(): TerminalInstance {
  const host = document.createElement("div");
  const terminal = new Terminal();
  return {
    host,
    terminal,
    fit: {} as TerminalInstance["fit"],
    search: {} as TerminalInstance["search"],
    unicode11: {} as TerminalInstance["unicode11"],
    lastHydratedSurfaceId: null,
    lastHydratedSurfaceSequence: null,
    attachmentCleanup: null,
    renderSink: null
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  releaseAll();
});

describe("acquire", () => {
  it("creates a new instance on first call", () => {
    const init = vi.fn(makeInstance);
    const { instance, isNew } = acquire("pane-1", init);
    expect(isNew).toBe(true);
    expect(init).toHaveBeenCalledOnce();
    expect(instance).toBeDefined();
    release("pane-1");
  });

  it("returns existing instance on second call (store hit)", () => {
    const init = vi.fn(makeInstance);
    const { instance: first } = acquire("pane-2", init);
    const { instance: second, isNew } = acquire("pane-2", init);
    expect(isNew).toBe(false);
    expect(init).toHaveBeenCalledOnce();
    expect(second).toBe(first);
    release("pane-2");
  });
});

describe("release", () => {
  it("disposes the terminal and removes from store", () => {
    const init = vi.fn(makeInstance);
    const { instance } = acquire("pane-4", init);
    const disposeSpy = vi.spyOn(instance.terminal, "dispose");

    release("pane-4");
    expect(disposeSpy).toHaveBeenCalledOnce();

    // Store is cleared — next acquire creates a new instance
    const { isNew } = acquire("pane-4", init);
    expect(isNew).toBe(true);
    release("pane-4");
  });

  it("removes host from DOM on release", () => {
    const parent = document.createElement("div");
    const init = vi.fn(makeInstance);
    const { instance } = acquire("pane-5", init);
    parent.appendChild(instance.host);

    release("pane-5");
    expect(parent.contains(instance.host)).toBe(false);
  });

  it("is a no-op for unknown paneId", () => {
    expect(() => release("unknown")).not.toThrow();
  });

  it("runs attachment cleanup before disposing", () => {
    const init = vi.fn(makeInstance);
    acquire("pane-attachment", init);
    const cleanup = vi.fn();

    expect(registerAttachment("pane-attachment", cleanup)).toBe(true);

    release("pane-attachment");

    expect(cleanup).toHaveBeenCalledOnce();
  });
});

describe("render sink", () => {
  it("clears only the current render sink", () => {
    const init = vi.fn(makeInstance);
    acquire("pane-sink", init);
    const firstSink = {
      write: vi.fn(),
      fitAndSync: vi.fn(async () => {})
    };
    const secondSink = {
      write: vi.fn(),
      fitAndSync: vi.fn(async () => {})
    };

    setRenderSink("pane-sink", firstSink);
    setRenderSink("pane-sink", secondSink);

    clearRenderSink("pane-sink", firstSink);
    expect(getRenderSink("pane-sink")).toBe(secondSink);

    clearRenderSink("pane-sink", secondSink);
    expect(getRenderSink("pane-sink")).toBeNull();
    release("pane-sink");
  });
});

describe("WebGL texture atlas recovery", () => {
  it("clears and refreshes every registered WebGL terminal", () => {
    const init = vi.fn(makeInstance);
    const first = acquire("surface-webgl-1", init).instance.terminal;
    const second = acquire("surface-webgl-2", init).instance.terminal;
    const events: string[] = [];
    vi.mocked(first.clearTextureAtlas).mockImplementation(() => {
      events.push("first.clear");
    });
    vi.mocked(second.clearTextureAtlas).mockImplementation(() => {
      events.push("second.clear");
    });
    vi.mocked(first.refresh).mockImplementation(() => {
      events.push("first.refresh");
    });
    vi.mocked(second.refresh).mockImplementation(() => {
      events.push("second.refresh");
    });

    registerWebglTerminal(first);
    registerWebglTerminal(second);

    expect(recoverWebglTextureAtlases()).toBe(2);
    expect(first.clearTextureAtlas).toHaveBeenCalledOnce();
    expect(first.refresh).toHaveBeenCalledWith(0, 3);
    expect(second.clearTextureAtlas).toHaveBeenCalledOnce();
    expect(second.refresh).toHaveBeenCalledWith(0, 3);
    expect(events).toEqual([
      "first.clear",
      "second.clear",
      "first.refresh",
      "second.refresh"
    ]);
  });

  it("stops recovering a terminal after unregister", () => {
    const init = vi.fn(makeInstance);
    const terminal = acquire("surface-webgl-unregister", init).instance.terminal;

    registerWebglTerminal(terminal);
    unregisterWebglTerminal(terminal);

    expect(recoverWebglTextureAtlases()).toBe(0);
    expect(terminal.clearTextureAtlas).not.toHaveBeenCalled();
    expect(terminal.refresh).not.toHaveBeenCalled();
  });

  it("removes a registered WebGL terminal when its instance is released", () => {
    const init = vi.fn(makeInstance);
    const terminal = acquire("surface-webgl-release", init).instance.terminal;

    registerWebglTerminal(terminal);
    release("surface-webgl-release");

    expect(recoverWebglTextureAtlases()).toBe(0);
    expect(terminal.clearTextureAtlas).not.toHaveBeenCalled();
  });
});

describe("getLastHydratedSurfaceId / markSurfaceHydrated", () => {
  it("returns null before any hydration", () => {
    const init = vi.fn(makeInstance);
    acquire("pane-6", init);
    expect(getLastHydratedSurfaceId("pane-6")).toBeNull();
    release("pane-6");
  });

  it("returns null for unknown paneId", () => {
    expect(getLastHydratedSurfaceId("unknown")).toBeNull();
  });

  it("reflects the surface id after markSurfaceHydrated", () => {
    const init = vi.fn(makeInstance);
    acquire("pane-7", init);
    markSurfaceHydrated("pane-7", "surface-abc");
    expect(getLastHydratedSurfaceId("pane-7")).toBe("surface-abc");
    release("pane-7");
  });

  it("resets to null after release + re-acquire", () => {
    const init = vi.fn(makeInstance);
    acquire("pane-8", init);
    markSurfaceHydrated("pane-8", "surface-abc");
    release("pane-8");

    // Fresh acquire must not carry over the previous surface id
    acquire("pane-8", init);
    expect(getLastHydratedSurfaceId("pane-8")).toBeNull();
    release("pane-8");
  });

  it("is a no-op for unknown paneId", () => {
    expect(() => markSurfaceHydrated("unknown", "surface-abc")).not.toThrow();
  });

  it("tracks the rendered sequence for the hydrated surface", () => {
    const init = vi.fn(makeInstance);
    acquire("pane-9", init);
    markSurfaceHydrated("pane-9", "surface-abc", 12);
    expect(getLastHydratedSurfaceSequence("pane-9")).toBe(12);

    markSurfaceRendered("pane-9", "surface-abc", 13);
    expect(getLastHydratedSurfaceSequence("pane-9")).toBe(13);
    release("pane-9");
  });

  it("ignores rendered sequence updates for stale surfaces", () => {
    const init = vi.fn(makeInstance);
    acquire("pane-10", init);
    markSurfaceHydrated("pane-10", "surface-current", 12);

    markSurfaceRendered("pane-10", "surface-stale", 13);

    expect(getLastHydratedSurfaceSequence("pane-10")).toBe(12);
    release("pane-10");
  });
});
