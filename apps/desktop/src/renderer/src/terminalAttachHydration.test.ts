import { describe, expect, it, vi } from "vitest";

import { hydrateAttachedTerminal } from "./terminalAttachHydration";

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
