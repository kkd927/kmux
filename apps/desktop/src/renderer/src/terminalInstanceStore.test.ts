// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn(() => ({
    loadAddon: vi.fn(),
    open: vi.fn(),
    dispose: vi.fn(),
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
  detach,
  release,
  releaseAll,
  getLastHydratedSurfaceId,
  getLastHydratedSurfaceSequence,
  markSurfaceHydrated,
  markSurfaceRendered,
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
    lastHydratedSurfaceSequence: null
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

describe("detach", () => {
  it("removes host from DOM but keeps instance in store", () => {
    const parent = document.createElement("div");
    const init = vi.fn(makeInstance);
    const { instance } = acquire("pane-3", init);
    parent.appendChild(instance.host);
    expect(parent.contains(instance.host)).toBe(true);

    detach("pane-3");
    expect(parent.contains(instance.host)).toBe(false);

    // Store still has it — second acquire is a hit
    const { isNew } = acquire("pane-3", init);
    expect(isNew).toBe(false);
    release("pane-3");
  });

  it("is a no-op for unknown paneId", () => {
    expect(() => detach("unknown")).not.toThrow();
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
