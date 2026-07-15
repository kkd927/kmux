// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SmoothnessProfileEvent } from "../../shared/smoothnessProfile";
import {
  clearRendererDiagnosticLog,
  flushRendererSmoothnessProfileEvents,
  recordRendererSmoothnessProfileEvent
} from "./smoothnessProfile";

describe("renderer smoothness profile batching", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.runOnlyPendingTimers();
    await flushRendererSmoothnessProfileEvents();
    vi.useRealTimers();
  });

  it("creates no timer or diagnostics IPC while profiling and logging are disabled", () => {
    const recordMany = vi.fn(async (_events: SmoothnessProfileEvent[]) => {});
    const recordOne = vi.fn(async () => {});
    window.kmux = {
      ...window.kmux,
      profileSmoothnessEnabled: () => false,
      recordSmoothnessProfileEvent: recordOne,
      recordSmoothnessProfileEvents: recordMany
    };

    recordRendererSmoothnessProfileEvent("terminal.data-plane.receive", {
      sequence: 1
    });

    expect(vi.getTimerCount()).toBe(0);
    expect(recordMany).not.toHaveBeenCalled();
    expect(recordOne).not.toHaveBeenCalled();
  });

  it("sends hot-path metrics to Main in one bounded batch", async () => {
    const recordMany = vi.fn(async (_events: SmoothnessProfileEvent[]) => {});
    const recordOne = vi.fn(async () => {});
    window.kmux = {
      ...window.kmux,
      profileSmoothnessEnabled: () => true,
      recordSmoothnessProfileEvent: recordOne,
      recordSmoothnessProfileEvents: recordMany
    };

    recordRendererSmoothnessProfileEvent("terminal.data-plane.receive", {
      sequence: 1
    });
    recordRendererSmoothnessProfileEvent("terminal.data-plane.parsed", {
      sequence: 1
    });

    expect(recordMany).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);

    expect(recordMany).toHaveBeenCalledOnce();
    expect(recordMany.mock.calls[0]?.[0]).toHaveLength(2);
    expect(recordOne).not.toHaveBeenCalled();
  });

  it("waits for pending and in-flight renderer batches before clearing", async () => {
    let releaseBatch!: () => void;
    const batchWritten = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    const recordMany = vi.fn(async () => batchWritten);
    const clearDiagnosticLog = vi.fn(async () => true);
    window.kmux = {
      ...window.kmux,
      profileSmoothnessEnabled: () => true,
      recordSmoothnessProfileEvents: recordMany,
      clearDiagnosticLog
    };
    recordRendererSmoothnessProfileEvent("terminal.data-plane.receive", {
      sequence: 7
    });

    const clearing = clearRendererDiagnosticLog();
    await Promise.resolve();
    expect(recordMany).toHaveBeenCalledOnce();
    expect(clearDiagnosticLog).not.toHaveBeenCalled();

    releaseBatch();
    await expect(clearing).resolves.toBe(true);
    expect(clearDiagnosticLog).toHaveBeenCalledOnce();
  });
});
