import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_SMOOTHNESS_PROFILE_FILENAME,
  KMUX_PROFILE_LOG_PATH_ENV,
  isSmoothnessProfileEnabled
} from "./smoothnessProfile";
import {
  createNodeSmoothnessProfileRecorder,
  resolveNodeSmoothnessProfileLogPath
} from "./nodeSmoothnessProfile";

describe("smoothness profiling", () => {
  it("is enabled only when an absolute profile log path is configured", () => {
    expect(isSmoothnessProfileEnabled({})).toBe(false);
    expect(
      isSmoothnessProfileEnabled({
        [KMUX_PROFILE_LOG_PATH_ENV]: ""
      })
    ).toBe(false);
    expect(
      isSmoothnessProfileEnabled({
        [KMUX_PROFILE_LOG_PATH_ENV]: "logs/kmux-smoothness.jsonl"
      })
    ).toBe(false);
    expect(
      isSmoothnessProfileEnabled({
        [KMUX_PROFILE_LOG_PATH_ENV]: "/tmp/kmux-smoothness.jsonl"
      })
    ).toBe(true);
  });

  it("resolves directory-like profile paths to the default JSONL file", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-profile-test-"));
    try {
      expect(resolveNodeSmoothnessProfileLogPath("")).toBe(null);
      expect(resolveNodeSmoothnessProfileLogPath("profile")).toBe(null);
      expect(resolveNodeSmoothnessProfileLogPath(sandbox)).toBe(
        join(sandbox, DEFAULT_SMOOTHNESS_PROFILE_FILENAME)
      );
      expect(
        resolveNodeSmoothnessProfileLogPath(join(sandbox, "profile"))
      ).toBe(join(sandbox, "profile", DEFAULT_SMOOTHNESS_PROFILE_FILENAME));
      expect(
        resolveNodeSmoothnessProfileLogPath(
          join(sandbox, "smoothness-profile.jsonl")
        )
      ).toBe(join(sandbox, "smoothness-profile.jsonl"));
    } finally {
      rmSync(sandbox, { force: true, recursive: true });
    }
  });

  it("does not enable the recorder for blank or relative profile paths", () => {
    expect(
      createNodeSmoothnessProfileRecorder({
        [KMUX_PROFILE_LOG_PATH_ENV]: "   "
      }).enabled
    ).toBe(false);
    expect(
      createNodeSmoothnessProfileRecorder({
        [KMUX_PROFILE_LOG_PATH_ENV]: "logs/kmux-smoothness.jsonl"
      }).enabled
    ).toBe(false);
  });

  it("writes profile records as JSON lines when enabled", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-profile-test-"));
    const logPath = join(sandbox, "smoothness.jsonl");
    try {
      const recorder = createNodeSmoothnessProfileRecorder({
        [KMUX_PROFILE_LOG_PATH_ENV]: logPath
      });

      recorder.record({
        source: "main",
        name: "shell.patch.emit",
        at: 12.5,
        details: {
          version: 1,
          requestedGroups: ["workspaceRows"],
          payloadBytes: 123
        }
      });
      recorder.recordMany?.([
        {
          source: "renderer",
          name: "terminal.data-plane.render",
          at: 13,
          details: { sequence: 2 }
        },
        {
          source: "pty-host",
          name: "terminal.data-plane.supervisor",
          at: 14,
          details: { sessions: 1 }
        }
      ]);

      const [line, rendererLine, hostLine] = readFileSync(logPath, "utf8")
        .trim()
        .split("\n");
      expect(JSON.parse(line)).toEqual({
        source: "main",
        name: "shell.patch.emit",
        at: 12.5,
        details: {
          version: 1,
          requestedGroups: ["workspaceRows"],
          payloadBytes: 123
        }
      });
      expect(JSON.parse(rendererLine)).toMatchObject({
        source: "renderer",
        name: "terminal.data-plane.render"
      });
      expect(JSON.parse(hostLine)).toMatchObject({
        source: "pty-host",
        name: "terminal.data-plane.supervisor"
      });
    } finally {
      rmSync(sandbox, { force: true, recursive: true });
    }
  });
});
