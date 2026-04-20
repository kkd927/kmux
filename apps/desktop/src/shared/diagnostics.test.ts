import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DIAGNOSTICS_LOG_PATH_ENV,
  formatDiagnosticsRecord,
  logDiagnostics
} from "./diagnostics";

describe("diagnostics logging", () => {
  const originalLogPath = process.env[DIAGNOSTICS_LOG_PATH_ENV];

  afterEach(() => {
    if (typeof originalLogPath === "string") {
      process.env[DIAGNOSTICS_LOG_PATH_ENV] = originalLogPath;
      return;
    }
    delete process.env[DIAGNOSTICS_LOG_PATH_ENV];
  });

  it("formats a record as a single timestamped line", () => {
    expect(
      formatDiagnosticsRecord(
        "terminal.notification",
        {
          protocol: 9,
          surfaceId: "surface_123"
        },
        {
          now: new Date("2026-04-20T01:23:45.000Z"),
          pid: 42
        }
      )
    ).toBe(
      '2026-04-20T01:23:45.000Z pid=42 {"scope":"terminal.notification","protocol":9,"surfaceId":"surface_123"}\n'
    );
  });

  it("is a no-op when no diagnostics path is configured", () => {
    delete process.env[DIAGNOSTICS_LOG_PATH_ENV];

    expect(logDiagnostics("terminal.notification", { protocol: 9 })).toBe(
      false
    );
  });

  it("appends JSON lines to the configured diagnostics file", () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), "kmux-diagnostics-test-"));
    const logPath = join(sandboxDir, "diagnostics.log");
    process.env[DIAGNOSTICS_LOG_PATH_ENV] = logPath;

    try {
      expect(
        logDiagnostics("terminal.notification", {
          protocol: 9,
          title: "CodexBar"
        })
      ).toBe(true);

      const contents = readFileSync(logPath, "utf8");
      expect(contents).toContain('"scope":"terminal.notification"');
      expect(contents).toContain('"protocol":9');
      expect(contents).toContain('"title":"CodexBar"');
      expect(contents.endsWith("\n")).toBe(true);
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });
});
