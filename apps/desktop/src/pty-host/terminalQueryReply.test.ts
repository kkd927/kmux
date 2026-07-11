import type { Terminal as HeadlessTerminalType } from "@xterm/headless";
import * as Headless from "@xterm/headless";
import { describe, expect, it, vi } from "vitest";

import { createTerminalQueryReplyHandler } from "./terminalQueryReply";

const HeadlessTerminalCtor = (
  Headless as unknown as {
    Terminal: new (options?: Record<string, unknown>) => HeadlessTerminalType;
  }
).Terminal;

describe("createTerminalQueryReplyHandler", () => {
  it("forwards live model queries, including ones split across writes", async () => {
    const terminal = new HeadlessTerminalCtor({ allowProposedApi: true });
    const writeReply = vi.fn();
    terminal.onData(
      createTerminalQueryReplyHandler({
        isCurrent: () => true,
        write: writeReply
      })
    );

    await write(terminal, "abc\u001b[");
    await write(terminal, "6n");

    expect(writeReply).toHaveBeenCalledOnce();
    expect(writeReply).toHaveBeenCalledWith("\u001b[1;4R");
    terminal.dispose();
  });

  it("forwards every model-query family owned by the supervisor", async () => {
    const terminal = new HeadlessTerminalCtor({
      allowProposedApi: true,
      cols: 91,
      rows: 27,
      cursorBlink: true,
      windowOptions: { getWinSizeChars: true }
    });
    const replies: string[] = [];
    terminal.onData(
      createTerminalQueryReplyHandler({
        isCurrent: () => true,
        write: (reply) => replies.push(reply)
      })
    );

    for (const query of [
      "\u001b[c",
      "\u001b[>c",
      "\u001b[5n",
      "\u001b[6n",
      "\u001b[?6n",
      "\u001b[4$p",
      "\u001b[?2004$p",
      "\u001b[18t",
      "\u001bP$q q\u001b\\"
    ]) {
      await write(terminal, query);
    }

    expect(replies).toHaveLength(9);
    expect(replies[0]).toBe("\u001b[?1;2c");
    expect(replies[1]?.startsWith("\u001b[>0;")).toBe(true);
    expect(replies[1]?.endsWith(";0c")).toBe(true);
    expect(Number.isInteger(Number(replies[1]?.slice(5, -3)))).toBe(true);
    expect(replies.slice(2)).toEqual([
      "\u001b[0n",
      "\u001b[1;1R",
      "\u001b[?1;1R",
      "\u001b[4;2$y",
      "\u001b[?2004;2$y",
      "\u001b[8;27;91t",
      "\u001bP1$r1 q\u001b\\"
    ]);
    terminal.dispose();
  });

  it("drops replies for a stale runtime epoch", async () => {
    const terminal = new HeadlessTerminalCtor({ allowProposedApi: true });
    const writeReply = vi.fn();
    terminal.onData(
      createTerminalQueryReplyHandler({
        isCurrent: () => false,
        write: writeReply
      })
    );

    await write(terminal, "\u001b[6n");

    expect(writeReply).not.toHaveBeenCalled();
    terminal.dispose();
  });

  it("reports byte counts without exposing reply contents", () => {
    const error = new Error("closed");
    const onWriteError = vi.fn();
    const handle = createTerminalQueryReplyHandler({
      isCurrent: () => true,
      write: () => {
        throw error;
      },
      onWriteError
    });

    handle("\u001b[1;1R");

    expect(onWriteError).toHaveBeenCalledWith(error, 6);
  });
});

function write(terminal: HeadlessTerminalType, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}
