// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn(() => ({
    loadAddon: vi.fn(),
    open: vi.fn(),
    dispose: vi.fn(),
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
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn(() => ({}))
}));

import {
  acquireSettlementPin,
  acquireVisible,
  clearAttachment,
  clearAttachmentReady,
  clearRenderSink,
  detachAttachment,
  getAttachmentSessionId,
  getTerminalCacheDiagnostics,
  getReadyAttachId,
  invalidateHydration,
  isCurrentTerminal,
  getRenderSink,
  release,
  releaseAll,
  releaseVisibilityPin,
  getLastHydratedSurfaceId,
  getLastHydratedSurfaceSequence,
  markSurfaceHydrated,
  markAttachmentReady,
  markSurfaceRendered,
  prepareVisibleSet,
  registerAttachment,
  replaceTerminalBundle,
  restoreHydrationState,
  setRenderSink,
  type TerminalInstance
} from "./terminalInstanceStore";
import { Terminal } from "@xterm/xterm";

function makeInstance(
  dimensions: {
    cols?: number;
    normalLines?: number;
    alternateLines?: number;
  } = {}
): TerminalInstance {
  const host = document.createElement("div");
  const terminal = new Terminal();
  const normal = { length: dimensions.normalLines ?? 4 };
  const alternate = { length: dimensions.alternateLines ?? 0 };
  Object.assign(terminal as unknown as Record<string, unknown>, {
    cols: dimensions.cols ?? 80,
    buffer: { active: normal, normal, alternate }
  });
  return {
    host,
    terminal,
    fit: {} as TerminalInstance["fit"],
    search: {} as TerminalInstance["search"],
    unicode11: {} as TerminalInstance["unicode11"],
    webLinks: {} as TerminalInstance["webLinks"],
    fileLinks: { dispose: vi.fn() },
    lineCwdTrimListener: { dispose: vi.fn() },
    lineCwds: {
      getTrimmedLineCount: vi.fn(() => 0),
      handleTrim: vi.fn(),
      importSnapshotRanges: vi.fn(),
      recordWrite: vi.fn(),
      getCwdForLine: vi.fn(),
      clear: vi.fn()
    },
    lastHydratedSurfaceId: null,
    lastHydratedSurfaceSequence: null,
    attachmentCleanup: null,
    attachmentSessionId: null,
    attachmentToken: null,
    readyAttachId: null,
    renderSink: null
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  releaseAll();
});

describe("replaceTerminalBundle", () => {
  it("keeps the visible surface capability and cache ownership on widget swap", () => {
    const { instance, visibilityPin } = acquireVisible(
      "surface-swap",
      makeInstance
    );
    const cleanup = vi.fn();
    const token = registerAttachment("surface-swap", "session-1", cleanup);
    expect(token).not.toBeNull();
    markAttachmentReady("surface-swap", "session-1", "attach-1", token!);
    markSurfaceHydrated("surface-swap", "surface-swap", 9);
    const oldTerminal = instance.terminal;
    const replacement = makeInstance();

    const previous = replaceTerminalBundle(
      "surface-swap",
      oldTerminal,
      replacement
    );

    expect(previous?.terminal).toBe(oldTerminal);
    expect(isCurrentTerminal("surface-swap", replacement.terminal)).toBe(true);
    expect(getReadyAttachId("surface-swap", "session-1")).toBe("attach-1");
    expect(getLastHydratedSurfaceSequence("surface-swap")).toBe(9);
    expect(cleanup).not.toHaveBeenCalled();

    releaseVisibilityPin("surface-swap", visibilityPin);
    expect(replacement.terminal.dispose).not.toHaveBeenCalled();
  });

  it("rejects replacement once the surface no longer has a visible owner", () => {
    const { instance, visibilityPin } = acquireVisible(
      "surface-hidden-swap",
      makeInstance
    );
    releaseVisibilityPin("surface-hidden-swap", visibilityPin);
    const replacement = makeInstance();

    expect(
      replaceTerminalBundle(
        "surface-hidden-swap",
        instance.terminal,
        replacement
      )
    ).toBeNull();
    expect(isCurrentTerminal("surface-hidden-swap", instance.terminal)).toBe(
      true
    );
  });
});

describe("release", () => {
  it("disposes the terminal and removes from store", () => {
    const init = vi.fn(makeInstance);
    const { instance } = acquireVisible("pane-4", init);
    const disposeSpy = vi.spyOn(instance.terminal, "dispose");

    release("pane-4");
    expect(disposeSpy).toHaveBeenCalledOnce();

    // Store is cleared — next acquire creates a new instance
    const { isNew } = acquireVisible("pane-4", init);
    expect(isNew).toBe(true);
    release("pane-4");
  });

  it("removes host from DOM on release", () => {
    const parent = document.createElement("div");
    const init = vi.fn(makeInstance);
    const { instance } = acquireVisible("pane-5", init);
    parent.appendChild(instance.host);

    release("pane-5");
    expect(parent.contains(instance.host)).toBe(false);
  });

  it("is a no-op for unknown paneId", () => {
    expect(() => release("unknown")).not.toThrow();
  });

  it("runs attachment cleanup before disposing", () => {
    const init = vi.fn(makeInstance);
    acquireVisible("pane-attachment", init);
    const cleanup = vi.fn();

    expect(
      registerAttachment("pane-attachment", "session-1", cleanup)
    ).not.toBeNull();

    release("pane-attachment");

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("clears a failed attachment without disposing the terminal", () => {
    const init = vi.fn(makeInstance);
    const { instance } = acquireVisible("pane-attachment", init);
    const cleanup = vi.fn();
    const disposeSpy = vi.spyOn(instance.terminal, "dispose");

    expect(
      registerAttachment("pane-attachment", "session-1", cleanup)
    ).not.toBeNull();
    expect(clearAttachment("pane-attachment", cleanup)).toBe(true);
    expect(disposeSpy).not.toHaveBeenCalled();

    release("pane-attachment");

    expect(cleanup).not.toHaveBeenCalled();
    expect(disposeSpy).toHaveBeenCalledOnce();
  });

  it("tracks the active attachment session and ready attach id", () => {
    const init = vi.fn(makeInstance);
    acquireVisible("pane-attachment", init);
    const cleanup = vi.fn();

    const token = registerAttachment("pane-attachment", "session-1", cleanup);
    expect(token).not.toBeNull();
    expect(getAttachmentSessionId("pane-attachment")).toBe("session-1");
    expect(getReadyAttachId("pane-attachment", "session-1")).toBeNull();

    expect(
      markAttachmentReady("pane-attachment", "session-1", "attach-1", token!)
    ).toBe(true);
    expect(getReadyAttachId("pane-attachment", "session-1")).toBe("attach-1");
    expect(getReadyAttachId("pane-attachment", "session-2")).toBeNull();

    expect(clearAttachmentReady("pane-attachment", "session-2", token!)).toBe(
      false
    );
    expect(getReadyAttachId("pane-attachment", "session-1")).toBe("attach-1");
    expect(clearAttachmentReady("pane-attachment", "session-1", token!)).toBe(
      true
    );
    expect(getReadyAttachId("pane-attachment", "session-1")).toBeNull();

    release("pane-attachment");
  });

  it("ignores ready changes from stale attachment tokens", () => {
    const init = vi.fn(makeInstance);
    acquireVisible("pane-attachment", init);
    const firstCleanup = vi.fn();
    const secondCleanup = vi.fn();

    const firstToken = registerAttachment(
      "pane-attachment",
      "session-1",
      firstCleanup
    );
    expect(firstToken).not.toBeNull();
    expect(clearAttachment("pane-attachment", firstCleanup)).toBe(true);

    const secondToken = registerAttachment(
      "pane-attachment",
      "session-1",
      secondCleanup
    );
    expect(secondToken).not.toBeNull();
    expect(
      markAttachmentReady(
        "pane-attachment",
        "session-1",
        "attach-stale",
        firstToken!
      )
    ).toBe(false);
    expect(getReadyAttachId("pane-attachment", "session-1")).toBeNull();

    expect(
      markAttachmentReady(
        "pane-attachment",
        "session-1",
        "attach-current",
        secondToken!
      )
    ).toBe(true);
    expect(getReadyAttachId("pane-attachment", "session-1")).toBe(
      "attach-current"
    );

    release("pane-attachment");
  });

  it("detaches the registered attachment without disposing the terminal", () => {
    const init = vi.fn(makeInstance);
    const { instance } = acquireVisible("pane-attachment", init);
    const cleanup = vi.fn();
    const disposeSpy = vi.spyOn(instance.terminal, "dispose");

    const token = registerAttachment("pane-attachment", "session-1", cleanup);
    expect(token).not.toBeNull();
    markAttachmentReady("pane-attachment", "session-1", "attach-1", token!);

    detachAttachment("pane-attachment");

    expect(cleanup).toHaveBeenCalledOnce();
    expect(disposeSpy).not.toHaveBeenCalled();
    expect(getAttachmentSessionId("pane-attachment")).toBeNull();
    expect(getReadyAttachId("pane-attachment", "session-1")).toBeNull();

    release("pane-attachment");
  });
});

describe("warm terminal LRU", () => {
  it("reserves the incoming visible set across a workspace tree handoff", async () => {
    const incoming = new Map<string, TerminalInstance>();
    const incomingKeys = [
      "incoming-0",
      "incoming-1",
      "incoming-2",
      "incoming-3"
    ];
    for (const key of incomingKeys) {
      const acquired = acquireVisible(key, () => {
        const instance = makeInstance();
        incoming.set(key, instance);
        return instance;
      });
      releaseVisibilityPin(key, acquired.visibilityPin);
    }

    const outgoing = [
      "outgoing-0",
      "outgoing-1",
      "outgoing-2",
      "outgoing-3"
    ].map((key) => ({ key, ...acquireVisible(key, makeInstance) }));
    prepareVisibleSet(incomingKeys);
    for (const entry of outgoing) {
      releaseVisibilityPin(entry.key, entry.visibilityPin);
    }
    const reacquired = incomingKeys.map((key) =>
      acquireVisible(key, makeInstance)
    );
    await Promise.resolve();

    expect(reacquired.every((entry) => !entry.isNew)).toBe(true);
    for (const instance of incoming.values()) {
      expect(instance.terminal.dispose).not.toHaveBeenCalled();
    }
    expect(getTerminalCacheDiagnostics()).toMatchObject({
      visibleTerminals: 4,
      warmTerminals: 4,
      boundViolationCount: 0
    });

    for (const [index, entry] of reacquired.entries()) {
      releaseVisibilityPin(incomingKeys[index]!, entry.visibilityPin);
    }
  });

  it("keeps an overlapping pane-move handoff pinned until its final owner leaves", () => {
    const first = acquireVisible("handoff", makeInstance);
    const second = acquireVisible("handoff", makeInstance);

    releaseVisibilityPin("handoff", first.visibilityPin);
    for (const key of ["warm-a", "warm-b", "warm-c", "warm-d", "warm-e"]) {
      const warm = acquireVisible(key, makeInstance);
      releaseVisibilityPin(key, warm.visibilityPin);
    }

    expect(second.instance.terminal.dispose).not.toHaveBeenCalled();
    releaseVisibilityPin("handoff", second.visibilityPin);
    expect(second.instance.terminal.dispose).not.toHaveBeenCalled();
  });

  it("keeps a hidden terminal out of the warm LRU until parser settlement releases its lease", () => {
    const settling = acquireVisible("settling", makeInstance);
    const settlementPin = acquireSettlementPin("settling");
    expect(settlementPin).not.toBeNull();
    releaseVisibilityPin("settling", settling.visibilityPin);

    for (const key of ["warm-0", "warm-1", "warm-2", "warm-3", "warm-4"]) {
      const warm = acquireVisible(key, makeInstance);
      releaseVisibilityPin(key, warm.visibilityPin);
    }

    expect(settling.instance.terminal.dispose).not.toHaveBeenCalled();
    releaseVisibilityPin("settling", settlementPin!);
    expect(settling.instance.terminal.dispose).not.toHaveBeenCalled();
  });

  it("seals an attachment before its last visible pin becomes evictable", () => {
    const settling = acquireVisible("attached-settling", makeInstance);
    let settlementPin: ReturnType<typeof acquireSettlementPin> = null;
    const cleanup = vi.fn(() => {
      settlementPin = acquireSettlementPin("attached-settling");
    });
    registerAttachment("attached-settling", "session-1", cleanup);

    releaseVisibilityPin("attached-settling", settling.visibilityPin);

    expect(cleanup).toHaveBeenCalledOnce();
    expect(settlementPin).not.toBeNull();
    for (const key of ["warm-0", "warm-1", "warm-2", "warm-3", "warm-4"]) {
      const warm = acquireVisible(key, makeInstance);
      releaseVisibilityPin(key, warm.visibilityPin);
    }
    expect(settling.instance.terminal.dispose).not.toHaveBeenCalled();

    releaseVisibilityPin("attached-settling", settlementPin!);
    expect(settling.instance.terminal.dispose).not.toHaveBeenCalled();
  });

  it("keeps at most four detached terminals and evicts the least recently used", () => {
    const instances = new Map<string, TerminalInstance>();
    const detach = (key: string): void => {
      const acquired = acquireVisible(key, () => {
        const instance = makeInstance();
        instances.set(key, instance);
        return instance;
      });
      releaseVisibilityPin(key, acquired.visibilityPin);
    };

    for (const key of ["surface-0", "surface-1", "surface-2", "surface-3"]) {
      detach(key);
    }

    const recentlyUsed = acquireVisible("surface-0", makeInstance);
    releaseVisibilityPin("surface-0", recentlyUsed.visibilityPin);
    detach("surface-4");

    expect(instances.get("surface-0")?.terminal.dispose).not.toHaveBeenCalled();
    expect(instances.get("surface-1")?.terminal.dispose).toHaveBeenCalledOnce();
    expect(instances.get("surface-2")?.terminal.dispose).not.toHaveBeenCalled();
    expect(instances.get("surface-3")?.terminal.dispose).not.toHaveBeenCalled();
    expect(instances.get("surface-4")?.terminal.dispose).not.toHaveBeenCalled();
    expect(getTerminalCacheDiagnostics()).toMatchObject({
      warmTerminals: 4,
      peakWarmTerminals: 4,
      maxWarmTerminals: 4,
      boundViolationCount: 0
    });
  });

  it("evicts warm terminals until their combined buffers fit four million cells", () => {
    const first = acquireVisible("large-0", () =>
      makeInstance({ cols: 1_000, normalLines: 1_500 })
    );
    const second = acquireVisible("large-1", () =>
      makeInstance({ cols: 1_000, normalLines: 1_500 })
    );
    const third = acquireVisible("large-2", () =>
      makeInstance({ cols: 1_000, normalLines: 1_500 })
    );

    releaseVisibilityPin("large-0", first.visibilityPin);
    releaseVisibilityPin("large-1", second.visibilityPin);
    releaseVisibilityPin("large-2", third.visibilityPin);

    expect(first.instance.terminal.dispose).toHaveBeenCalledOnce();
    expect(second.instance.terminal.dispose).not.toHaveBeenCalled();
    expect(third.instance.terminal.dispose).not.toHaveBeenCalled();
    expect(getTerminalCacheDiagnostics()).toMatchObject({
      warmBufferCells: 3_000_000,
      peakWarmBufferCells: 3_000_000,
      maxWarmBufferCells: 4_000_000,
      boundViolationCount: 0
    });
  });

  it("never evicts a visible terminal, even when its buffer exceeds the warm cap", () => {
    const visible = acquireVisible("visible", () =>
      makeInstance({ cols: 2_000, normalLines: 2_500 })
    );

    for (const key of ["warm-0", "warm-1", "warm-2", "warm-3", "warm-4"]) {
      const warm = acquireVisible(key, makeInstance);
      releaseVisibilityPin(key, warm.visibilityPin);
    }

    expect(visible.instance.terminal.dispose).not.toHaveBeenCalled();

    releaseVisibilityPin("visible", visible.visibilityPin);
    expect(visible.instance.terminal.dispose).toHaveBeenCalledOnce();
  });

  it("disposes a deleted surface immediately and ignores its stale pin", () => {
    const visible = acquireVisible("deleted", makeInstance);

    release("deleted");
    releaseVisibilityPin("deleted", visible.visibilityPin);

    expect(visible.instance.terminal.dispose).toHaveBeenCalledOnce();
    expect(acquireVisible("deleted", makeInstance).isNew).toBe(true);
  });
});

describe("terminal liveness", () => {
  it("matches the stored terminal instance", () => {
    const init = vi.fn(makeInstance);
    const { instance } = acquireVisible("pane-live", init);
    const otherTerminal = new Terminal();

    expect(isCurrentTerminal("pane-live", instance.terminal)).toBe(true);
    expect(isCurrentTerminal("pane-live", otherTerminal)).toBe(false);
    release("pane-live");

    expect(isCurrentTerminal("pane-live", instance.terminal)).toBe(false);
  });
});

describe("render sink", () => {
  it("clears only the current render sink", () => {
    const init = vi.fn(makeInstance);
    acquireVisible("pane-sink", init);
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

describe("getLastHydratedSurfaceId / markSurfaceHydrated", () => {
  it("returns null before any hydration", () => {
    const init = vi.fn(makeInstance);
    acquireVisible("pane-6", init);
    expect(getLastHydratedSurfaceId("pane-6")).toBeNull();
    release("pane-6");
  });

  it("returns null for unknown paneId", () => {
    expect(getLastHydratedSurfaceId("unknown")).toBeNull();
  });

  it("reflects the surface id after markSurfaceHydrated", () => {
    const init = vi.fn(makeInstance);
    acquireVisible("pane-7", init);
    markSurfaceHydrated("pane-7", "surface-abc");
    expect(getLastHydratedSurfaceId("pane-7")).toBe("surface-abc");
    release("pane-7");
  });

  it("resets to null after release + re-acquire", () => {
    const init = vi.fn(makeInstance);
    acquireVisible("pane-8", init);
    markSurfaceHydrated("pane-8", "surface-abc");
    release("pane-8");

    // Fresh acquire must not carry over the previous surface id
    acquireVisible("pane-8", init);
    expect(getLastHydratedSurfaceId("pane-8")).toBeNull();
    release("pane-8");
  });

  it("is a no-op for unknown paneId", () => {
    expect(() => markSurfaceHydrated("unknown", "surface-abc")).not.toThrow();
  });

  it("clears line cwd state when hydration is invalidated", () => {
    const init = vi.fn(makeInstance);
    const { instance } = acquireVisible("pane-cwd", init);
    markSurfaceHydrated("pane-cwd", "surface-abc", 12);

    invalidateHydration("pane-cwd");

    expect(getLastHydratedSurfaceId("pane-cwd")).toBeNull();
    expect(getLastHydratedSurfaceSequence("pane-cwd")).toBeNull();
    expect(instance.lineCwds.clear).toHaveBeenCalledOnce();
    release("pane-cwd");
  });

  it("tracks the rendered sequence for the hydrated surface", () => {
    const init = vi.fn(makeInstance);
    acquireVisible("pane-9", init);
    markSurfaceHydrated("pane-9", "surface-abc", 12);
    expect(getLastHydratedSurfaceSequence("pane-9")).toBe(12);

    markSurfaceRendered("pane-9", "surface-abc", 13);
    expect(getLastHydratedSurfaceSequence("pane-9")).toBe(13);
    release("pane-9");
  });

  it("does not move the rendered sequence backward for the same hydrated surface", () => {
    const init = vi.fn(makeInstance);
    acquireVisible("pane-11", init);
    markSurfaceHydrated("pane-11", "surface-abc", 20);

    markSurfaceHydrated("pane-11", "surface-abc", 12);

    expect(getLastHydratedSurfaceSequence("pane-11")).toBe(20);
    release("pane-11");
  });

  it("restores the exact cursor after a failed checkpoint transaction", () => {
    acquireVisible("pane-rollback", makeInstance);
    markSurfaceHydrated("pane-rollback", "surface-current", 20);
    markSurfaceHydrated("pane-rollback", "surface-current", 30);

    restoreHydrationState("pane-rollback", "surface-current", 20);

    expect(getLastHydratedSurfaceId("pane-rollback")).toBe("surface-current");
    expect(getLastHydratedSurfaceSequence("pane-rollback")).toBe(20);
    release("pane-rollback");
  });

  it("ignores rendered sequence updates for stale surfaces", () => {
    const init = vi.fn(makeInstance);
    acquireVisible("pane-10", init);
    markSurfaceHydrated("pane-10", "surface-current", 12);

    markSurfaceRendered("pane-10", "surface-stale", 13);

    expect(getLastHydratedSurfaceSequence("pane-10")).toBe(12);
    release("pane-10");
  });
});
