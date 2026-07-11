// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SmoothnessProfileEvent } from "../../shared/smoothnessProfile";
import { recordRendererSmoothnessProfileEvent } from "./smoothnessProfile";

describe("renderer smoothness profile batching", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
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
});
