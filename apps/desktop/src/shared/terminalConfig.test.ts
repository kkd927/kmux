import { describe, expect, it } from "vitest";

import {
  TERMINAL_LIVE_SCROLLBACK_LINES,
  TERMINAL_RESTORE_SCROLLBACK_LINES
} from "./terminalConfig";

describe("terminal config", () => {
  it("keeps live agent output scrollback larger than restore snapshots", () => {
    expect(TERMINAL_LIVE_SCROLLBACK_LINES).toBe(15_000);
    expect(TERMINAL_RESTORE_SCROLLBACK_LINES).toBe(8_000);
    expect(TERMINAL_RESTORE_SCROLLBACK_LINES).toBeLessThan(
      TERMINAL_LIVE_SCROLLBACK_LINES
    );
  });
});
