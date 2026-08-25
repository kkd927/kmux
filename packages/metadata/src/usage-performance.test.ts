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
import { listBuiltinLocalUsageAdapters } from "@kmux/agents/builtin-runtime";

vi.mock("node:fs", async (importOriginal) => {
  const actual: typeof NodeFs = await importOriginal();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    openSync: vi.fn(actual.openSync),
    opendirSync: vi.fn(actual.opendirSync),
    readSync: vi.fn(actual.readSync),
    readFileSync: vi.fn(actual.readFileSync),
    statSync: vi.fn(actual.statSync),
    watch: vi.fn(
      () =>
        ({
          close: vi.fn(),
          on: vi.fn()
        }) as unknown as NodeFs.FSWatcher
    )
  };
});

import { createLocalMetadataInventoryService } from "./localMetadataInventory";
import { IncrementalCoreUsageJsonlParser } from "./core/usage";
import { createFileUsageAdapter } from "./usage";

const listTestBuiltinUsageAdapters = (
  options: Parameters<typeof listBuiltinLocalUsageAdapters>[0] = {}
) => [...listBuiltinLocalUsageAdapters(options)];

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
  it("performs no file I/O for a clean incremental read through the production metadata lease", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-usage-shared-clean-"));
    cleanupPaths.push(root);
    const usagePath = path.join(root, "usage.jsonl");
    writeFileSync(
      usagePath,
      `${JSON.stringify({
        timestamp: "2026-04-17T09:00:00.000Z",
        session_id: "claude-shared-clean",
        input_tokens: 120,
        output_tokens: 30
      })}\n`,
      "utf8"
    );
    const inventory = createLocalMetadataInventoryService({
      principal: "uid:test",
      sourceDefinitionRevisions: { claude: "claude-metadata-v1" }
    });
    const adapter = createFileUsageAdapter({
      agentId: "claude",
      roots: [root],
      sourceProjection: createFixtureUsageProjection("claude"),
      classifySource: () => ({ role: "fixture/usage", format: "jsonl" }),
      metadataInventory: inventory
    });
    const unwatch = adapter.watch(() => undefined);
    const startOfDayMs = startOfLocalDay(
      Date.parse("2026-04-17T09:00:00.000Z")
    );

    await adapter.initialScan(startOfDayMs);
    vi.mocked(fs.lstatSync).mockClear();
    vi.mocked(fs.openSync).mockClear();
    vi.mocked(fs.opendirSync).mockClear();
    vi.mocked(fs.readSync).mockClear();
    vi.mocked(fs.readFileSync).mockClear();
    vi.mocked(fs.statSync).mockClear();

    await expect(adapter.readIncremental(startOfDayMs)).resolves.toMatchObject({
      samples: []
    });
    expect(fs.lstatSync).not.toHaveBeenCalled();
    expect(fs.openSync).not.toHaveBeenCalled();
    expect(fs.opendirSync).not.toHaveBeenCalled();
    expect(fs.readSync).not.toHaveBeenCalled();
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.statSync).not.toHaveBeenCalled();

    unwatch();
    adapter.close();
    await inventory.close();
  });

  it("debounces a shared watcher event and rereads only the changed source", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-17T09:00:00.000Z"));
    const root = mkdtempSync(path.join(tmpdir(), "kmux-usage-shared-dirty-"));
    cleanupPaths.push(root);
    const changedPath = path.join(root, "changed.jsonl");
    const unchangedPath = path.join(root, "unchanged.jsonl");
    const record = (sessionId: string, inputTokens: number) =>
      `${JSON.stringify({
        timestamp: "2026-04-17T09:00:00.000Z",
        session_id: sessionId,
        input_tokens: inputTokens,
        output_tokens: 1
      })}\n`;
    writeFileSync(changedPath, record("changed", 1), "utf8");
    writeFileSync(unchangedPath, record("unchanged", 1), "utf8");
    const inventory = createLocalMetadataInventoryService({
      principal: "uid:test",
      sourceDefinitionRevisions: { claude: "claude-metadata-v1" }
    });
    const adapter = createFileUsageAdapter({
      agentId: "claude",
      roots: [root],
      sourceProjection: createFixtureUsageProjection("claude"),
      classifySource: () => ({ role: "fixture/usage", format: "jsonl" }),
      metadataInventory: inventory
    });
    const onChange = vi.fn();
    const unwatch = adapter.watch(onChange);
    const startOfDayMs = startOfLocalDay(Date.now());
    await adapter.initialScan(startOfDayMs);

    appendFileSync(changedPath, record("changed", 5), "utf8");
    const watchCall = vi.mocked(fs.watch).mock.calls.at(-1);
    const watchListener = watchCall?.[watchCall.length - 1] as
      | NodeFs.WatchListener<string>
      | undefined;
    expect(watchListener).toBeTypeOf("function");
    watchListener?.("change", path.basename(changedPath));
    await vi.advanceTimersByTimeAsync(179);
    expect(onChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onChange).toHaveBeenCalledTimes(1);

    vi.mocked(fs.openSync).mockClear();
    vi.mocked(fs.opendirSync).mockClear();
    const incremental = await adapter.readIncremental(startOfDayMs);

    expect(incremental.samples).toEqual([
      expect.objectContaining({
        sessionId: "changed",
        inputTokens: 5,
        outputTokens: 1
      })
    ]);
    expect(fs.openSync).toHaveBeenCalledTimes(1);
    expect(fs.openSync).toHaveBeenCalledWith(
      expect.stringMatching(/changed\.jsonl$/u),
      expect.any(Number)
    );
    expect(fs.opendirSync).not.toHaveBeenCalled();

    unwatch();
    adapter.close();
    await inventory.close();
  });

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

    const [adapter] = listTestBuiltinUsageAdapters({
      env: {
        KMUX_CLAUDE_USAGE_DIR: usageDir
      },
      homeDir: root
    });
    const unwatch = adapter.watch(() => undefined);
    await adapter.initialScan(
      startOfLocalDay(new Date("2026-04-17T09:00:00.000Z").getTime())
    );

    vi.mocked(fs.opendirSync).mockClear();
    vi.mocked(fs.readFileSync).mockClear();

    const incremental = await adapter.readIncremental(
      startOfLocalDay(new Date("2026-04-17T09:00:00.000Z").getTime())
    );

    expect(incremental.samples).toEqual([]);
    expect(fs.opendirSync).not.toHaveBeenCalled();
    expect(fs.readFileSync).not.toHaveBeenCalled();

    unwatch();
    adapter.close();
  });

  it("does not rescan unchanged Antigravity workspace metadata on every usage read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-17T09:00:00.000Z"));
    const root = mkdtempSync(path.join(tmpdir(), "kmux-usage-agy-clean-"));
    cleanupPaths.push(root);
    const antigravityRoot = path.join(root, ".gemini", "antigravity-cli");
    const conversationId = "8ea8b3f8-e50d-42d0-9e9f-8fe1079e80a2";
    const transcriptDir = path.join(
      antigravityRoot,
      "brain",
      conversationId,
      ".system_generated",
      "logs"
    );
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(
      path.join(antigravityRoot, "history.jsonl"),
      `${JSON.stringify({
        conversationId,
        workspace: "/tmp/kmux-antigravity-clean",
        timestamp: Date.parse("2026-04-17T09:00:00.000Z")
      })}\n`,
      "utf8"
    );
    writeFileSync(
      path.join(transcriptDir, "transcript.jsonl"),
      `${JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-04-17T09:00:00.000Z",
        content: "<USER_REQUEST>hello</USER_REQUEST>"
      })}\n`,
      "utf8"
    );

    const [, , adapter] = listTestBuiltinUsageAdapters({ homeDir: root });
    const startOfDayMs = startOfLocalDay(
      Date.parse("2026-04-17T09:00:00.000Z")
    );
    await adapter.initialScan(startOfDayMs);

    vi.mocked(fs.opendirSync).mockClear();

    const incremental = await adapter.readIncremental(startOfDayMs);

    expect(incremental.samples).toEqual([]);
    expect(fs.opendirSync).not.toHaveBeenCalled();

    vi.mocked(fs.readFileSync).mockClear();
    await vi.advanceTimersByTimeAsync(60_000);

    await adapter.readIncremental(startOfDayMs);

    expect(fs.opendirSync).toHaveBeenCalled();
    expect(fs.readFileSync).not.toHaveBeenCalled();
    adapter.close();
  });

  it("revalidates a watched usage file through the bounded inventory before reading it", async () => {
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

    const [adapter] = listTestBuiltinUsageAdapters({
      env: {
        KMUX_CLAUDE_USAGE_DIR: usageDir
      },
      homeDir: root
    });
    const unwatch = adapter.watch(() => undefined);
    await adapter.initialScan(
      startOfLocalDay(new Date("2026-04-17T09:00:00.000Z").getTime())
    );

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
    vi.mocked(fs.opendirSync).mockClear();
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
    expect(fs.opendirSync).toHaveBeenCalledTimes(1);

    unwatch();
    adapter.close();
  });

  it("does not climb above the provider parent when the usage root is missing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-usage-watch-root-"));
    cleanupPaths.push(root);
    mkdirSync(path.join(root, ".codex"), { recursive: true });

    const [, adapter] = listTestBuiltinUsageAdapters({
      homeDir: root,
      platform: "darwin"
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

  it("uses a non-recursive watch policy on Linux", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-usage-linux-watch-"));
    cleanupPaths.push(root);
    mkdirSync(path.join(root, ".codex"), { recursive: true });

    const [, adapter] = listTestBuiltinUsageAdapters({
      homeDir: root,
      platform: "linux"
    });

    const unwatch = adapter.watch(() => undefined);

    expect(fs.watch).toHaveBeenCalledWith(
      path.join(root, ".codex"),
      { recursive: false },
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
    const [_, adapter] = listTestBuiltinUsageAdapters({
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

    vi.mocked(fs.opendirSync).mockClear();
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
    expect(fs.opendirSync).toHaveBeenCalled();

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

    const [, adapter] = listTestBuiltinUsageAdapters({
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

    vi.mocked(fs.opendirSync).mockClear();
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
    expect(fs.opendirSync).toHaveBeenCalled();

    unwatch();
    adapter.close();
  });

  it("replays appended claude usage on a low-frequency resync even when a watch event is missed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-17T09:00:00.000Z"));
    const root = mkdtempSync(
      path.join(tmpdir(), "kmux-usage-claude-append-miss-")
    );
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

    const [adapter] = listTestBuiltinUsageAdapters({
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

    vi.mocked(fs.opendirSync).mockClear();
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
    expect(fs.opendirSync).toHaveBeenCalled();

    unwatch();
    adapter.close();
  });
});

function createFixtureUsageProjection(agentId: string) {
  return {
    createSession() {
      return {
        beginInventory: () => undefined,
        applySourceClaim: () => undefined,
        createParser(options: {
          sourcePath: string;
          maximumPendingBytes: number;
        }) {
          const parser = new IncrementalCoreUsageJsonlParser(
            (record, range) => {
              const timestampMs = Date.parse(String(record.timestamp ?? ""));
              if (
                !Number.isFinite(timestampMs) ||
                timestampMs < range.fromMs ||
                (range.toMs !== undefined && timestampMs > range.toMs)
              ) {
                return [];
              }
              const inputTokens = Number(record.input_tokens ?? 0);
              const outputTokens = Number(record.output_tokens ?? 0);
              return [
                {
                  vendor: agentId,
                  timestampMs,
                  sourcePath: options.sourcePath,
                  sourceType: "jsonl" as const,
                  sessionId: String(record.session_id ?? ""),
                  inputTokens,
                  outputTokens,
                  cacheTokens: 0,
                  totalTokens: inputTokens + outputTokens,
                  estimatedCostUsd: 0,
                  costSource: "unavailable" as const
                }
              ];
            },
            { maximumPendingBytes: options.maximumPendingBytes }
          );
          return {
            append: parser.append.bind(parser),
            reset: parser.reset.bind(parser)
          };
        }
      };
    }
  };
}

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
