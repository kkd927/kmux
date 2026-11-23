import { describe, expect, it } from "vitest";

import {
  TERMINAL_CTRL_ENTER_SEQUENCE,
  TERMINAL_SHIFT_ENTER_SEQUENCE
} from "@kmux/proto";
import { encodeTerminalKeyInput, isTerminalFocusReport } from "./terminalInput";

describe("pty-host terminal input encoding", () => {
  it("encodes plain Enter as carriage return", () => {
    expect(encodeTerminalKeyInput({ key: "Enter" })).toBe("\r");
  });

  it("encodes Enter variants for terminal apps", () => {
    expect(encodeTerminalKeyInput({ key: "Enter", ctrlKey: true })).toBe(
      TERMINAL_CTRL_ENTER_SEQUENCE
    );
    expect(encodeTerminalKeyInput({ key: "Enter", shiftKey: true })).toBe(
      TERMINAL_SHIFT_ENTER_SEQUENCE
    );
    expect(
      encodeTerminalKeyInput({
        key: "Enter",
        altKey: true,
        ctrlKey: true,
        shiftKey: true
      })
    ).toBe("\r");
  });

  it("does not encode Alt Enter specially for automation", () => {
    expect(encodeTerminalKeyInput({ key: "Enter", altKey: true })).toBe("\r");
  });
});

describe("terminal focus reports", () => {
  it.each(["\u001b[I", "\u001b[O", "\u001b[I\u001b[O\u001b[I"])(
    "recognizes focus-only traffic %j",
    (input) => {
      expect(isTerminalFocusReport(input)).toBe(true);
    }
  );

  it.each([
    "",
    "typed text",
    "\u001b[A",
    "\u001b[<0;40;12M",
    "\u001b[Ityped text",
    "\u001b[O\r",
    "\u001b[200~\u001b[I\u001b[201~"
  ])("keeps other input eligible for user takeover %j", (input) => {
    expect(isTerminalFocusReport(input)).toBe(false);
  });
});
