import { Terminal } from "@xterm/headless";
import { describe, expect, it, vi } from "vitest";

import {
  registerTerminalVtDiagnostics,
  syncTerminalVtDiagnosticsRegistration,
  type TerminalVtDestructiveEvent
} from "./terminalVtDiagnostics";

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

describe("terminal VT diagnostics", () => {
  it("registers only while diagnostics are enabled", () => {
    const dispose = vi.fn();
    const register = vi.fn(() => ({ dispose }));

    let current = syncTerminalVtDiagnosticsRegistration({
      enabled: false
    });
    expect(current).toBeUndefined();
    expect(register).not.toHaveBeenCalled();

    current = syncTerminalVtDiagnosticsRegistration({
      enabled: true,
      current,
      register
    });
    expect(register).toHaveBeenCalledTimes(1);

    current = syncTerminalVtDiagnosticsRegistration({
      enabled: true,
      current,
      register
    });
    expect(register).toHaveBeenCalledTimes(1);

    current = syncTerminalVtDiagnosticsRegistration({
      enabled: false,
      current
    });
    expect(current).toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("observes split destructive sequences without consuming xterm behavior", async () => {
    const terminal = new Terminal({
      cols: 20,
      rows: 5,
      allowProposedApi: true
    });
    const events: TerminalVtDestructiveEvent[] = [];
    const registration = registerTerminalVtDiagnostics(terminal, (event) => {
      events.push(event);
    });

    await write(terminal, "visible text");
    await write(terminal, "\u001b[");
    await write(terminal, "2J");

    expect(events).toEqual([{ kind: "erase-display", mode: 2 }]);
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("");

    await write(terminal, "\u001b[?1049h");
    await write(terminal, "\u001b[?1049l");
    await write(terminal, "\u001bc");

    expect(events).toEqual([
      { kind: "erase-display", mode: 2 },
      { kind: "alternate-screen", action: "enter", modes: [1049] },
      { kind: "alternate-screen", action: "exit", modes: [1049] },
      { kind: "terminal-reset" }
    ]);

    registration.dispose();
    terminal.dispose();
  });

  it("ignores partial erase-display operations", async () => {
    const terminal = new Terminal({
      cols: 20,
      rows: 5,
      allowProposedApi: true
    });
    const events: TerminalVtDestructiveEvent[] = [];
    const registration = registerTerminalVtDiagnostics(terminal, (event) => {
      events.push(event);
    });

    await write(terminal, "\u001b[J\u001b[1J");

    expect(events).toEqual([]);
    registration.dispose();
    terminal.dispose();
  });
});
