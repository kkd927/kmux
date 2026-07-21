// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const diagnostics = vi.hoisted(() => ({
  enabled: true,
  listener: null as ((enabled: boolean) => void) | null,
  record: vi.fn()
}));

vi.mock("./smoothnessProfile", () => ({
  isRendererSmoothnessProfileEnabled: () => diagnostics.enabled,
  recordRendererSmoothnessProfileEvent: diagnostics.record,
  subscribeRendererDiagnosticsLogging: (
    listener: (enabled: boolean) => void
  ) => {
    diagnostics.listener = listener;
    return vi.fn();
  }
}));

import { installRendererDiagnostics } from "./rendererDiagnostics";

describe("renderer diagnostics", () => {
  beforeEach(() => {
    diagnostics.enabled = true;
    diagnostics.listener = null;
    diagnostics.record.mockReset();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("captures interaction metadata without recording key or input content", () => {
    const dispose = installRendererDiagnostics();
    const button = document.createElement("button");
    button.dataset.testid = "run-agent";
    button.setAttribute("role", "button");
    document.body.append(button);

    button.dispatchEvent(new KeyboardEvent("keydown", { key: "SecretKey" }));
    button.dispatchEvent(
      new InputEvent("input", { data: "sensitive text", bubbles: true })
    );

    const serialized = JSON.stringify(diagnostics.record.mock.calls);
    expect(serialized).not.toContain("SecretKey");
    expect(serialized).not.toContain("sensitive text");
    expect(diagnostics.record).toHaveBeenCalledWith("renderer.interaction", {
      eventType: "keydown",
      targetRole: "button",
      targetTestId: "run-agent",
      byteLength: undefined
    });
    expect(diagnostics.record).toHaveBeenCalledWith("renderer.interaction", {
      eventType: "input",
      targetRole: "button",
      targetTestId: "run-agent",
      byteLength: 14
    });
    dispose();
  });

  it("changes capture gating immediately and rate-limits repeated input", () => {
    const dispose = installRendererDiagnostics();
    const input = document.createElement("input");
    input.dataset.testid = "terminal-input";
    document.body.append(input);

    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(diagnostics.record).toHaveBeenCalledTimes(1);

    diagnostics.listener?.(false);
    input.dispatchEvent(new Event("click", { bubbles: true }));
    expect(diagnostics.record).toHaveBeenCalledTimes(1);

    diagnostics.listener?.(true);
    input.dispatchEvent(new Event("click", { bubbles: true }));
    expect(diagnostics.record).toHaveBeenCalledTimes(2);
    dispose();
  });

  it("samples renderer event-loop and heap state every five seconds", () => {
    vi.useFakeTimers();
    const dispose = installRendererDiagnostics();

    vi.advanceTimersByTime(5_000);

    expect(diagnostics.record).toHaveBeenCalledWith(
      "renderer.event-loop-memory.sample",
      expect.objectContaining({
        eventLoopDelayMs: expect.any(Number),
        visibilityState: "visible"
      })
    );
    dispose();
  });
});
