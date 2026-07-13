import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyDiagnosticsLogPath,
  clearDiagnosticsLog,
  clearDiagnosticsLogForEnableTransition,
  DIAGNOSTICS_LOG_PATH_ENV,
  formatDiagnosticsRecord,
  formatLocalLogTimestamp,
  logDiagnostics,
  MAX_DIAGNOSTICS_LOG_BYTES,
  prepareExistingDiagnosticsLogFile,
  resolveEffectiveDiagnosticsLogPath
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

  it("formats local log timestamps like Electron stdout", () => {
    expect(formatLocalLogTimestamp(new Date(2026, 6, 6, 20, 29, 3, 938))).toBe(
      "2026-07-06 20:29:03.938"
    );
  });

  it("is a no-op when no diagnostics path is configured", () => {
    delete process.env[DIAGNOSTICS_LOG_PATH_ENV];

    expect(logDiagnostics("terminal.notification", { protocol: 9 })).toBe(
      false
    );
  });

  it("is a no-op when diagnostics path is blank or relative", () => {
    process.env[DIAGNOSTICS_LOG_PATH_ENV] = "   ";
    expect(logDiagnostics("terminal.notification", { protocol: 9 })).toBe(
      false
    );

    process.env[DIAGNOSTICS_LOG_PATH_ENV] = "logs/diagnostics.log";
    expect(logDiagnostics("terminal.notification", { protocol: 9 })).toBe(
      false
    );
  });

  it("contains serialization failures so diagnostics cannot disrupt the app", () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), "kmux-diagnostics-test-"));
    const logPath = join(sandboxDir, "diagnostics.log");
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    try {
      expect(logDiagnostics("invalid.details", circular, logPath)).toBe(false);
      expect(existsSync(logPath)).toBe(false);
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it("uses the settings-managed path only while logging is enabled", () => {
    expect(
      resolveEffectiveDiagnosticsLogPath({
        settingsEnabled: true,
        settingsLogPath: "/tmp/settings-debug.log"
      })
    ).toBe("/tmp/settings-debug.log");
    expect(
      resolveEffectiveDiagnosticsLogPath({
        settingsEnabled: false,
        settingsLogPath: "/tmp/settings-debug.log"
      })
    ).toBeUndefined();
  });

  it("applies or removes only absolute diagnostics paths", () => {
    const env: NodeJS.ProcessEnv = {
      [DIAGNOSTICS_LOG_PATH_ENV]: "/tmp/old-debug.log"
    };

    expect(applyDiagnosticsLogPath(env, " /tmp/new-debug.log ")).toBe(
      "/tmp/new-debug.log"
    );
    expect(env[DIAGNOSTICS_LOG_PATH_ENV]).toBe("/tmp/new-debug.log");

    expect(applyDiagnosticsLogPath(env, "logs/debug.log")).toBeUndefined();
    expect(env).not.toHaveProperty(DIAGNOSTICS_LOG_PATH_ENV);
  });

  it("appends JSON lines to the configured diagnostics file", () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), "kmux-diagnostics-test-"));
    const logPath = join(sandboxDir, "diagnostics.log");
    process.env[DIAGNOSTICS_LOG_PATH_ENV] = logPath;
    writeFileSync(logPath, "legacy\n", { mode: 0o644 });
    chmodSync(logPath, 0o644);

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
      expect(statSync(logPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it("secures and bounds an existing log even when logging is off", () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), "kmux-diagnostics-test-"));
    const logPath = join(sandboxDir, "diagnostics.log");
    writeFileSync(logPath, "legacy\n", { mode: 0o644 });
    truncateSync(logPath, MAX_DIAGNOSTICS_LOG_BYTES + 1);
    chmodSync(logPath, 0o644);

    try {
      expect(prepareExistingDiagnosticsLogFile(logPath)).toBe(true);
      expect(statSync(logPath).mode & 0o777).toBe(0o600);
      expect(statSync(logPath).size).toBe(0);
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it("starts the single log file over before it exceeds 20 MiB", () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), "kmux-diagnostics-test-"));
    const logPath = join(sandboxDir, "diagnostics.log");
    writeFileSync(logPath, "stale-record\n");
    truncateSync(logPath, MAX_DIAGNOSTICS_LOG_BYTES);

    try {
      expect(
        logDiagnostics("terminal.stream.latest", { sequence: 42 }, logPath)
      ).toBe(true);

      const contents = readFileSync(logPath, "utf8");
      expect(contents).toContain('"scope":"terminal.stream.latest"');
      expect(contents).not.toContain("stale-record");
      expect(statSync(logPath).size).toBeLessThan(MAX_DIAGNOSTICS_LOG_BYTES);
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it("clears the settings-managed log without failing when it is absent", () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), "kmux-diagnostics-test-"));
    const logPath = join(sandboxDir, "diagnostics.log");
    writeFileSync(logPath, "diagnostics\n");

    try {
      expect(clearDiagnosticsLog(logPath)).toBe(true);
      expect(existsSync(logPath)).toBe(false);
      expect(clearDiagnosticsLog(logPath)).toBe(true);
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it("starts fresh on Off-to-On while preserving the log on On-to-Off", () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), "kmux-diagnostics-test-"));
    const logPath = join(sandboxDir, "diagnostics.log");
    writeFileSync(logPath, "previous-session\n");

    try {
      expect(
        clearDiagnosticsLogForEnableTransition({
          previouslyEnabled: false,
          nextEnabled: true,
          logPath
        })
      ).toBe(true);
      expect(existsSync(logPath)).toBe(false);

      writeFileSync(logPath, "captured-session\n");
      expect(
        clearDiagnosticsLogForEnableTransition({
          previouslyEnabled: true,
          nextEnabled: false,
          logPath
        })
      ).toBeUndefined();
      expect(readFileSync(logPath, "utf8")).toBe("captured-session\n");
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });
});
