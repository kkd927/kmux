import * as fs from "node:fs";
import type * as NodeFs from "node:fs";
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual: typeof NodeFs = await importOriginal();
  return {
    ...actual,
    readdirSync: vi.fn(actual.readdirSync),
    readFileSync: vi.fn(actual.readFileSync),
    watch: vi.fn(
      () =>
        ({
          close: vi.fn()
        }) as unknown as NodeFs.FSWatcher
    )
  };
});

import { createUsageAdapters } from "./usage";

const cleanupPaths: string[] = [];

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  while (cleanupPaths.length > 0) {
    rmSync(cleanupPaths.pop()!, { force: true, recursive: true });
  }
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("usage adapter performance", () => {
  it("does not rescan roots or reread unchanged jsonl files while the watch-driven source set is clean", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-usage-clean-"));
    cleanupPaths.push(root);
    const usageDir = path.join(root, "claude");
    mkdirSync(usageDir, { recursive: true });
    writeFileSync(
      path.join(usageDir, "usage.jsonl"),
      `${JSON.stringify({
        timestamp: "2026-04-17T09:00:00.000Z",
        session_id: "claude-session-clean",
        input_tokens: 120,
        output_tokens: 30,
        estimated_cost: 0.12
      })}\n`,
      "utf8"
    );

    const [adapter] = createUsageAdapters({
      env: {
        KMUX_CLAUDE_USAGE_DIR: usageDir
      },
      homeDir: root
    });
    const unwatch = adapter.watch(() => undefined);
    await adapter.initialScan(startOfLocalDay(new Date("2026-04-17T09:00:00.000Z").getTime()));

    vi.mocked(fs.readdirSync).mockClear();
    vi.mocked(fs.readFileSync).mockClear();

    const incremental = await adapter.readIncremental(
      startOfLocalDay(new Date("2026-04-17T09:00:00.000Z").getTime())
    );

    expect(incremental.samples).toEqual([]);
    expect(fs.readdirSync).not.toHaveBeenCalled();
    expect(fs.readFileSync).not.toHaveBeenCalled();

    unwatch();
    adapter.close();
  });

  it("does not walk the full source tree when a watched usage file appends", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-usage-append-"));
    cleanupPaths.push(root);
    const usageDir = path.join(root, "claude");
    mkdirSync(usageDir, { recursive: true });
    const usagePath = path.join(usageDir, "usage.jsonl");
    writeFileSync(
      usagePath,
      `${JSON.stringify({
        timestamp: "2026-04-17T09:00:00.000Z",
        session_id: "claude-session-append",
        input_tokens: 120,
        output_tokens: 30,
        estimated_cost: 0.12
      })}\n`,
      "utf8"
    );

    const [adapter] = createUsageAdapters({
      env: {
        KMUX_CLAUDE_USAGE_DIR: usageDir
      },
      homeDir: root
    });
    const unwatch = adapter.watch(() => undefined);
    await adapter.initialScan(startOfLocalDay(new Date("2026-04-17T09:00:00.000Z").getTime()));

    appendFileSync(
      usagePath,
      `${JSON.stringify({
        timestamp: "2026-04-17T09:05:00.000Z",
        session_id: "claude-session-append",
        input_tokens: 400,
        output_tokens: 100,
        estimated_cost: 0.42
      })}\n`,
      "utf8"
    );
    vi.mocked(fs.readdirSync).mockClear();
    const watchCall = vi.mocked(fs.watch).mock.calls.at(-1);
    const watchListener = watchCall?.[watchCall.length - 1] as
      | NodeFs.WatchListener<string>
      | undefined;
    expect(watchListener).toBeTypeOf("function");
    watchListener?.("change", "usage.jsonl");

    const incremental = await adapter.readIncremental(
      startOfLocalDay(new Date("2026-04-17T09:00:00.000Z").getTime())
    );

    expect(incremental.samples).toEqual([
      expect.objectContaining({
        inputTokens: 400,
        outputTokens: 100,
        totalTokens: 500,
        estimatedCostUsd: 0.42
      })
    ]);
    expect(fs.readdirSync).not.toHaveBeenCalled();

    unwatch();
    adapter.close();
  });

  it("does not climb above the provider parent when the usage root is missing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-usage-watch-root-"));
    cleanupPaths.push(root);
    mkdirSync(path.join(root, ".codex"), { recursive: true });

    const [, adapter] = createUsageAdapters({
      homeDir: root
    });

    const unwatch = adapter.watch(() => undefined);

    expect(fs.watch).toHaveBeenCalledWith(
      path.join(root, ".codex"),
      { recursive: true },
      expect.any(Function)
    );

    unwatch();
    adapter.close();
  });

  it("discovers external codex usage files on a low-frequency resync even without a watch event", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-17T09:00:00.000Z"));
    const root = mkdtempSync(path.join(tmpdir(), "kmux-usage-external-"));
    cleanupPaths.push(root);
    const usageDir = path.join(root, "codex");
    mkdirSync(usageDir, { recursive: true });
    const [_, adapter] = createUsageAdapters({
      env: {
        KMUX_CODEX_USAGE_DIR: usageDir
      },
      homeDir: root
    });
    const unwatch = adapter.watch(() => undefined);
    const startOfDayMs = startOfLocalDay(Date.now());

    const initial = await adapter.initialScan(startOfDayMs);
    expect(initial.sourceCount).toBe(0);

    const sessionDir = path.join(usageDir, "2026", "04", "17");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      path.join(sessionDir, "external-codex-session.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-04-17T09:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "external-codex-session",
            cwd: "/tmp/kmux-external-codex",
            model: "gpt-5.4"
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-17T09:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 512,
                cached_input_tokens: 128,
                output_tokens: 32,
                total_tokens: 544
              }
            }
          }
        }),
        ""
      ].join("\n"),
      "utf8"
    );

    const beforeResync = await adapter.readIncremental(startOfDayMs);
    expect(beforeResync.samples).toEqual([]);

    vi.mocked(fs.readdirSync).mockClear();
    await vi.advanceTimersByTimeAsync(60_000);

    const afterResync = await adapter.readIncremental(startOfDayMs);
    expect(afterResync.samples).toEqual([
      expect.objectContaining({
        vendor: "codex",
        sessionId: "external-codex-session",
        cwd: "/tmp/kmux-external-codex",
        totalTokens: 544
      })
    ]);
    expect(fs.readdirSync).toHaveBeenCalled();

    unwatch();
    adapter.close();
  });

  it("replays appended codex session usage on a low-frequency resync even when a watch event is missed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-17T09:00:00.000Z"));
    const root = mkdtempSync(path.join(tmpdir(), "kmux-usage-codex-append-"));
    cleanupPaths.push(root);
    const usageDir = path.join(root, "codex");
    const sessionDir = path.join(usageDir, "2026", "04", "17");
    mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, "desktop-codex-session.jsonl");
    writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          timestamp: "2026-04-17T09:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "desktop-codex-session",
            cwd: "/tmp/kmux-external-codex-desktop",
            model: "gpt-5.4"
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-17T09:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 512,
                cached_input_tokens: 128,
                output_tokens: 32,
                total_tokens: 544
              }
            }
          }
        }),
        ""
      ].join("\n"),
      "utf8"
    );

    const [, adapter] = createUsageAdapters({
      env: {
        KMUX_CODEX_USAGE_DIR: usageDir
      },
      homeDir: root
    });
    const unwatch = adapter.watch(() => undefined);
    const startOfDayMs = startOfLocalDay(Date.now());

    const initial = await adapter.initialScan(startOfDayMs);
    expect(initial.samples).toEqual([
      expect.objectContaining({
        vendor: "codex",
        sessionId: "desktop-codex-session",
        totalTokens: 544
      })
    ]);

    appendFileSync(
      sessionPath,
      `${JSON.stringify({
        timestamp: "2026-04-17T09:05:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 900,
              cached_input_tokens: 200,
              output_tokens: 60,
              total_tokens: 960
            }
          }
        }
      })}\n`,
      "utf8"
    );

    const beforeResync = await adapter.readIncremental(startOfDayMs);
    expect(beforeResync.samples).toEqual([]);

    vi.mocked(fs.readdirSync).mockClear();
    await vi.advanceTimersByTimeAsync(60_000);

    const afterResync = await adapter.readIncremental(startOfDayMs);
    expect(afterResync.samples).toEqual([
      expect.objectContaining({
        vendor: "codex",
        sessionId: "desktop-codex-session",
        cwd: "/tmp/kmux-external-codex-desktop",
        totalTokens: 416,
        inputTokens: 316,
        cacheReadTokens: 72,
        outputTokens: 28
      })
    ]);
    expect(fs.readdirSync).toHaveBeenCalled();

    unwatch();
    adapter.close();
  });

  it("replays appended claude usage on a low-frequency resync even when a watch event is missed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-17T09:00:00.000Z"));
    const root = mkdtempSync(path.join(tmpdir(), "kmux-usage-claude-append-miss-"));
    cleanupPaths.push(root);
    const usageDir = path.join(root, "claude");
    mkdirSync(usageDir, { recursive: true });
    const usagePath = path.join(usageDir, "usage.jsonl");
    writeFileSync(
      usagePath,
      `${JSON.stringify({
        timestamp: "2026-04-17T09:00:00.000Z",
        session_id: "claude-session-resync",
        cwd: "/tmp/kmux-external-claude",
        model: "claude-sonnet-4",
        input_tokens: 120,
        output_tokens: 30,
        estimated_cost: 0.12
      })}\n`,
      "utf8"
    );

    const [adapter] = createUsageAdapters({
      env: {
        KMUX_CLAUDE_USAGE_DIR: usageDir
      },
      homeDir: root
    });
    const unwatch = adapter.watch(() => undefined);
    const startOfDayMs = startOfLocalDay(Date.now());

    const initial = await adapter.initialScan(startOfDayMs);
    expect(initial.samples).toEqual([
      expect.objectContaining({
        vendor: "claude",
        sessionId: "claude-session-resync",
        totalTokens: 150,
        estimatedCostUsd: 0.12
      })
    ]);

    appendFileSync(
      usagePath,
      `${JSON.stringify({
        timestamp: "2026-04-17T09:05:00.000Z",
        session_id: "claude-session-resync",
        cwd: "/tmp/kmux-external-claude",
        model: "claude-sonnet-4",
        input_tokens: 240,
        output_tokens: 60,
        estimated_cost: 0.24
      })}\n`,
      "utf8"
    );

    const beforeResync = await adapter.readIncremental(startOfDayMs);
    expect(beforeResync.samples).toEqual([]);

    vi.mocked(fs.readdirSync).mockClear();
    await vi.advanceTimersByTimeAsync(60_000);

    const afterResync = await adapter.readIncremental(startOfDayMs);
    expect(afterResync.samples).toEqual([
      expect.objectContaining({
        vendor: "claude",
        sessionId: "claude-session-resync",
        cwd: "/tmp/kmux-external-claude",
        totalTokens: 300,
        estimatedCostUsd: 0.24
      })
    ]);
    expect(fs.readdirSync).toHaveBeenCalled();

    unwatch();
    adapter.close();
  });
});

function startOfLocalDay(timestampMs: number): number {
  const date = new Date(timestampMs);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    0,
    0,
    0,
    0
  ).getTime();
}
