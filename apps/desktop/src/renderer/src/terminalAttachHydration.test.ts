import { describe, expect, it, vi } from "vitest";

import {
  hydrateAttachedTerminal,
  reattachPreservedTerminal
} from "./terminalAttachHydration";

describe("hydrateAttachedTerminal", () => {
  it("fits before requesting the attach snapshot", async () => {
    const order: string[] = [];
    const terminal = {
      cols: 120,
      rows: 40,
      resize: vi.fn(),
      reset: vi.fn(() => {
        order.push("reset");
      })
    };

    await hydrateAttachedTerminal({
      terminal,
      isMounted: () => true,
      isTerminalActive: () => true,
      waitForTerminalFonts: async () => {
        order.push("fonts");
      },
      fitAndSyncTerminal: async () => {
        order.push("fit");
      },
      attachSurface: async () => {
        order.push("attach");
        return {
          cols: 80,
          rows: 24,
          sequence: 1,
          vt: "snapshot"
        };
      },
      writeTerminal: (_terminal, data, afterWrite) => {
        order.push(`write:${data}`);
        afterWrite?.();
      }
    });

    expect(order).toEqual([
      "fonts",
      "fit",
      "attach",
      "reset",
      "write:snapshot",
      "fit"
    ]);
  });

  it("does not resize an already fitted terminal back to snapshot dimensions", async () => {
    const terminal = {
      cols: 120,
      rows: 40,
      resize: vi.fn(),
      reset: vi.fn()
    };

    await hydrateAttachedTerminal({
      terminal,
      isMounted: () => true,
      isTerminalActive: () => true,
      waitForTerminalFonts: async () => {},
      fitAndSyncTerminal: async () => {},
      attachSurface: async () => ({
        cols: 80,
        rows: 24,
        sequence: 1,
        vt: "snapshot"
      }),
      writeTerminal: (_terminal, _data, afterWrite) => {
        afterWrite?.();
      }
    });

    expect(terminal.resize).not.toHaveBeenCalled();
    expect(terminal.reset).toHaveBeenCalledTimes(1);
  });

  it("falls back to the snapshot size when the terminal still has no live dimensions", async () => {
    const terminal = {
      cols: 0,
      rows: 0,
      resize: vi.fn((cols: number, rows: number) => {
        terminal.cols = cols;
        terminal.rows = rows;
      }),
      reset: vi.fn()
    };

    await hydrateAttachedTerminal({
      terminal,
      isMounted: () => true,
      isTerminalActive: () => true,
      waitForTerminalFonts: async () => {},
      fitAndSyncTerminal: async () => {},
      attachSurface: async () => ({
        cols: 80,
        rows: 24,
        sequence: 1,
        vt: "snapshot"
      }),
      writeTerminal: (_terminal, _data, afterWrite) => {
        afterWrite?.();
      }
    });

    expect(terminal.resize).toHaveBeenCalledWith(80, 24);
  });

  it("stops before attaching when the terminal is no longer current after fitting", async () => {
    const terminal = {
      cols: 120,
      rows: 40,
      resize: vi.fn(),
      reset: vi.fn()
    };
    let terminalIsActive = true;
    const attachSurface = vi.fn(async () => ({
      cols: 120,
      rows: 40,
      sequence: 1,
      vt: "snapshot"
    }));

    await hydrateAttachedTerminal({
      terminal,
      isMounted: () => true,
      isTerminalActive: () => terminalIsActive,
      waitForTerminalFonts: async () => {},
      fitAndSyncTerminal: async () => {
        terminalIsActive = false;
      },
      attachSurface,
      writeTerminal: () => {}
    });

    expect(attachSurface).not.toHaveBeenCalled();
    expect(terminal.reset).not.toHaveBeenCalled();
  });
});

describe("reattachPreservedTerminal", () => {
  it("reattaches without resetting or replaying an already rendered snapshot", async () => {
    const order: string[] = [];
    const terminal = {
      cols: 120,
      rows: 40,
      resize: vi.fn(),
      reset: vi.fn(() => {
        order.push("reset");
      })
    };
    const writeTerminal = vi.fn();

    await reattachPreservedTerminal({
      terminal,
      isMounted: () => true,
      isTerminalActive: () => true,
      lastRenderedSequence: 12,
      waitForTerminalFonts: async () => {
        order.push("fonts");
      },
      attachSurface: async () => {
        order.push("attach");
        return {
          cols: 120,
          rows: 40,
          sequence: 12,
          vt: "full snapshot"
        };
      },
      beforeFitAndSync: () => {
        order.push("clear-resize-cache");
      },
      fitAndSyncTerminal: async () => {
        order.push("fit");
      },
      writeTerminal
    });

    expect(order).toEqual(["fonts", "attach", "clear-resize-cache", "fit"]);
    expect(terminal.reset).not.toHaveBeenCalled();
    expect(writeTerminal).not.toHaveBeenCalled();
  });

  it("resets before replaying the snapshot when the preserved terminal is behind", async () => {
    const order: string[] = [];
    const renderedSequences: number[] = [];
    const terminal = {
      cols: 120,
      rows: 40,
      resize: vi.fn(),
      reset: vi.fn(() => {
        order.push("reset");
      })
    };

    await reattachPreservedTerminal({
      terminal,
      isMounted: () => true,
      isTerminalActive: () => true,
      lastRenderedSequence: 12,
      waitForTerminalFonts: async () => {
        order.push("fonts");
      },
      attachSurface: async () => {
        order.push("attach");
        return {
          cols: 120,
          rows: 40,
          sequence: 13,
          vt: "advanced snapshot"
        };
      },
      beforeFitAndSync: () => {
        order.push("clear-resize-cache");
      },
      fitAndSyncTerminal: async () => {
        order.push("fit");
      },
      writeTerminal: (_terminal, data, afterWrite) => {
        order.push(`write:${data}`);
        afterWrite?.();
      },
      onSnapshotRendered: (snapshot) => {
        renderedSequences.push(snapshot.sequence);
      }
    });

    expect(order).toEqual([
      "fonts",
      "attach",
      "reset",
      "write:advanced snapshot",
      "clear-resize-cache",
      "fit"
    ]);
    expect(renderedSequences).toEqual([13]);
  });
});
