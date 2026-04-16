import { describe, expect, it } from "vitest";

import {
  TERMINAL_CTRL_ENTER_SEQUENCE,
  TERMINAL_SHIFT_ENTER_SEQUENCE
} from "@kmux/proto";
import { encodeTerminalKeyInput } from "./terminalInput";

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
