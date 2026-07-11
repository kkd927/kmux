import { describe, expect, it } from "vitest";

import {
  nonNegativeDurationMs,
  terminalDataPlaneNowMs
} from "./terminalDataPlaneMetrics";

describe("terminal data-plane metric timestamps", () => {
  it("converts process-relative clocks to a comparable epoch", () => {
    expect(
      terminalDataPlaneNowMs({ timeOrigin: 1_700_000_000_000, now: () => 12.5 })
    ).toBe(1_700_000_000_012.5);
  });

  it("never reports a negative cross-process duration", () => {
    expect(nonNegativeDurationMs(12, 20)).toBe(8);
    expect(nonNegativeDurationMs(20, 12)).toBe(0);
    expect(nonNegativeDurationMs(undefined, 12)).toBeUndefined();
  });
});
