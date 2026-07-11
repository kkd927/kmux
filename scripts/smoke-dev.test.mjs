import { describe, expect, it } from "vitest";

import {
  hasDevSmokeReadySignal,
  parsePosixProcessTable,
  resolveOwnedPosixProcessIds,
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
    expect(
      resolveDevSmokeTimeoutMs({ KMUX_DEV_SMOKE_TIMEOUT_MS: "45000" })
    ).toBe(45_000);
    expect(resolveDevSmokeTimeoutMs({ KMUX_DEV_SMOKE_TIMEOUT_MS: "0" })).toBe(
      180_000
    );
    expect(
      resolveDevSmokeTimeoutMs({ KMUX_DEV_SMOKE_TIMEOUT_MS: "nope" })
    ).toBe(180_000);
  });

  it("finds detached Electron processes only through the smoke-owned profile", () => {
    const rows = parsePosixProcessTable(
      [
        " 100  50 100 npm run dev",
        " 101 100 100 node scripts/dev.mjs",
        " 200   1 200 Electron /repo/apps/desktop",
        " 201 200 200 Electron Helper --user-data-dir=/tmp/kmux-dev-smoke-owned/runtime/electron-user-data",
        " 202 200 200 usageScanWorker.js",
        " 300   1 300 /Applications/kmux.app/Contents/MacOS/kmux",
        " 301 300 300 Electron Helper --user-data-dir=/Users/me/Library/Application Support/kmux"
      ].join("\n")
    );

    expect(
      resolveOwnedPosixProcessIds(rows, {
        rootPid: 100,
        ownerMarkers: ["/tmp/kmux-dev-smoke-owned"],
        selfPid: 50
      }).sort((left, right) => left - right)
    ).toEqual([100, 101, 200, 201, 202]);
  });
});
