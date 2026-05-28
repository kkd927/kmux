import { describe, expect, it } from "vitest";

import { TERMINAL_SCROLLBACK_LINES } from "./terminalConfig";

describe("terminal config", () => {
  it("uses a 20k-line scrollback for long-running agent output", () => {
    expect(TERMINAL_SCROLLBACK_LINES).toBe(20_000);
  });
});
