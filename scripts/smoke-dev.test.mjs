import { describe, expect, it } from "vitest";

import {
  hasDevSmokeReadySignal,
  resolveDevSmokeTimeoutMs
} from "./smoke-dev.mjs";

describe("dev smoke readiness signal", () => {
  it("accepts the explicit main window did-finish-load marker", () => {
    expect(
      hasDevSmokeReadySignal(
        [
          "dev server running",
          "start electron app...",
          "[main:window] did-finish-load"
        ].join("\n")
      )
    ).toBe(true);
  });

  it("accepts pty shell-ready diagnostics when renderer console logs stay quiet", () => {
    expect(
      hasDevSmokeReadySignal(
        [
          "dev server running",
          "start electron app...",
          '{"scope":"pty-host.raw-terminal-event","kind":"osc.shell-ready","surfaceId":"surface_1"}'
        ].join("\n")
      )
    ).toBe(true);
  });

  it("does not pass before Electron startup begins", () => {
    expect(
      hasDevSmokeReadySignal(
        '{"scope":"pty-host.raw-terminal-event","kind":"osc.shell-ready"}'
      )
    ).toBe(false);
  });

  it("uses a longer default timeout and accepts an explicit override", () => {
    expect(resolveDevSmokeTimeoutMs({})).toBe(180_000);
    expect(resolveDevSmokeTimeoutMs({ KMUX_DEV_SMOKE_TIMEOUT_MS: "45000" }))
      .toBe(45_000);
    expect(resolveDevSmokeTimeoutMs({ KMUX_DEV_SMOKE_TIMEOUT_MS: "0" })).toBe(
      180_000
    );
    expect(resolveDevSmokeTimeoutMs({ KMUX_DEV_SMOKE_TIMEOUT_MS: "nope" }))
      .toBe(180_000);
  });
});
