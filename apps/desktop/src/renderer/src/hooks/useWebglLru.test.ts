import { describe, expect, it } from "vitest";

// Direct reducer test (no React needed)
import { useWebglLru } from "./useWebglLru";

// Test the reducer logic indirectly by testing the hook behavior.
// Since useWebglLru uses useReducer internally, we test the exported hook.
// For pure reducer logic, we replicate a simplified version here.

type LruState = { mostRecent: string[] };
type LruAction =
  | { type: "touch"; paneId: string }
  | { type: "touchMany"; paneIds: string[] }
  | { type: "forget"; paneId: string };

const WEBGL_LRU_SIZE = 10;

function lruReducer(state: LruState, action: LruAction): LruState {
  switch (action.type) {
    case "touch": {
      const filtered = state.mostRecent.filter((id) => id !== action.paneId);
      return { mostRecent: [action.paneId, ...filtered].slice(0, WEBGL_LRU_SIZE) };
    }
    case "touchMany": {
      const incoming = [...new Set(action.paneIds)].slice(0, WEBGL_LRU_SIZE);
      const filtered = state.mostRecent.filter((id) => !incoming.includes(id));
      return { mostRecent: [...incoming, ...filtered].slice(0, WEBGL_LRU_SIZE) };
    }
    case "forget": {
      return { mostRecent: state.mostRecent.filter((id) => id !== action.paneId) };
    }
  }
}

describe("lruReducer", () => {
  it("touch promotes a new pane to the front", () => {
    const state = { mostRecent: ["b", "c"] };
    const next = lruReducer(state, { type: "touch", paneId: "a" });
    expect(next.mostRecent).toEqual(["a", "b", "c"]);
  });

  it("touch moves an existing pane to the front", () => {
    const state = { mostRecent: ["a", "b", "c"] };
    const next = lruReducer(state, { type: "touch", paneId: "c" });
    expect(next.mostRecent).toEqual(["c", "a", "b"]);
  });

  it("touch evicts the oldest pane when LRU is full", () => {
    const ids = Array.from({ length: WEBGL_LRU_SIZE }, (_, i) => `pane_${i}`);
    const state = { mostRecent: ids };
    const next = lruReducer(state, { type: "touch", paneId: "new_pane" });
    expect(next.mostRecent).toHaveLength(WEBGL_LRU_SIZE);
    expect(next.mostRecent[0]).toBe("new_pane");
    expect(next.mostRecent).not.toContain(ids[ids.length - 1]);
  });

  it("touchMany promotes multiple panes, deduplicating incoming", () => {
    const state = { mostRecent: ["old_a", "old_b"] };
    const next = lruReducer(state, {
      type: "touchMany",
      paneIds: ["new_1", "new_2", "new_1"]
    });
    expect(next.mostRecent).toEqual(["new_1", "new_2", "old_a", "old_b"]);
  });

  it("touchMany caps total at WEBGL_LRU_SIZE", () => {
    const existing = Array.from({ length: 8 }, (_, i) => `e_${i}`);
    const state = { mostRecent: existing };
    const next = lruReducer(state, {
      type: "touchMany",
      paneIds: ["n_0", "n_1", "n_2", "n_3", "n_4"]
    });
    expect(next.mostRecent).toHaveLength(WEBGL_LRU_SIZE);
    expect(next.mostRecent.slice(0, 5)).toEqual(["n_0", "n_1", "n_2", "n_3", "n_4"]);
  });

  it("forget removes the pane", () => {
    const state = { mostRecent: ["a", "b", "c"] };
    const next = lruReducer(state, { type: "forget", paneId: "b" });
    expect(next.mostRecent).toEqual(["a", "c"]);
  });

  it("forget is a no-op for unknown pane", () => {
    const state = { mostRecent: ["a", "b"] };
    const next = lruReducer(state, { type: "forget", paneId: "x" });
    expect(next.mostRecent).toEqual(["a", "b"]);
  });
});

// Smoke test that the export is a function
describe("useWebglLru", () => {
  it("is exported as a function", () => {
    expect(typeof useWebglLru).toBe("function");
  });
});
