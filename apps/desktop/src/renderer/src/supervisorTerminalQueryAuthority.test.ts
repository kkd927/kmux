import type { Terminal as HeadlessTerminalType } from "@xterm/headless";
import * as Headless from "@xterm/headless";
import type { Terminal as BrowserTerminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";

import { SupervisorTerminalQueryAuthorityAddon } from "./supervisorTerminalQueryAuthority";

const HeadlessTerminalCtor = (
  Headless as unknown as {
    Terminal: new (options?: Record<string, unknown>) => HeadlessTerminalType;
  }
).Terminal;

describe("SupervisorTerminalQueryAuthorityAddon", () => {
  it("suppresses supervisor-owned model replies without suppressing user input", async () => {
    const terminal = new HeadlessTerminalCtor({
      allowProposedApi: true,
      cols: 91,
      rows: 27,
      cursorBlink: true,
      windowOptions: { getWinSizeChars: true }
    });
    const addon = new SupervisorTerminalQueryAuthorityAddon();
    terminal.loadAddon(
      addon as unknown as Parameters<BrowserTerminal["loadAddon"]>[0]
    );
    const data: string[] = [];
    terminal.onData((value) => data.push(value));

    await write(
      terminal,
      [
        "\u001b[c",
        "\u001b[>c",
        "\u001b[5n",
        "\u001b[6n",
        "\u001b[?6n",
        "\u001b[4$p",
        "\u001b[?2004$p",
        "\u001b[18t",
        "\u001bP$q q\u001b\\"
      ].join("")
    );
    terminal.input("USER", true);

    expect(data).toEqual(["USER"]);
    terminal.dispose();
  });

  it("restores the built-in replies when disposed", async () => {
    const terminal = new HeadlessTerminalCtor({ allowProposedApi: true });
    const addon = new SupervisorTerminalQueryAuthorityAddon();
    terminal.loadAddon(
      addon as unknown as Parameters<BrowserTerminal["loadAddon"]>[0]
    );
    const data: string[] = [];
    terminal.onData((value) => data.push(value));

    addon.dispose();
    await write(terminal, "\u001b[6n");

    expect(data).toEqual(["\u001b[1;1R"]);
    terminal.dispose();
  });

  it("preserves parser state when a query is split across writes", async () => {
    const terminal = new HeadlessTerminalCtor({ allowProposedApi: true });
    const addon = new SupervisorTerminalQueryAuthorityAddon();
    terminal.loadAddon(
      addon as unknown as Parameters<BrowserTerminal["loadAddon"]>[0]
    );
    const data: string[] = [];
    terminal.onData((value) => data.push(value));

    await write(terminal, "abc\u001b[");
    await write(terminal, "6n");

    expect(data).toEqual([]);
    terminal.dispose();
  });
});

function write(terminal: HeadlessTerminalType, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}
