import { describe, expect, it, vi } from "vitest";

import {
  resolveTerminalOutputGapMs,
  settlePtyProfileBucketsBeforeDiagnosticsDisable
} from "./terminalDiagnostics";

describe("terminal diagnostics", () => {
  it("reports a separate output gap only after two seconds", () => {
    expect(resolveTerminalOutputGapMs(undefined, 5_000)).toBeUndefined();
    expect(resolveTerminalOutputGapMs(1_000, 2_999)).toBeUndefined();
    expect(resolveTerminalOutputGapMs(1_000, 3_000)).toBe(2_000);
    expect(resolveTerminalOutputGapMs(1_000, 4_250)).toBe(3_250);
  });

  it("flushes diagnostic-only PTY buckets before disabling their sink", () => {
    const flushAll = vi.fn();
    settlePtyProfileBucketsBeforeDiagnosticsDisable({
      continuousProfileEnabled: false,
      flushAll
    });
    expect(flushAll).toHaveBeenCalledOnce();

    flushAll.mockClear();
    settlePtyProfileBucketsBeforeDiagnosticsDisable({
      continuousProfileEnabled: true,
      flushAll
    });
    expect(flushAll).not.toHaveBeenCalled();
  });
});
