import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createUsageAdapters } from "./usage";

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    rmSync(cleanupPaths.pop()!, { force: true, recursive: true });
  }
});

describe("usage adapters", () => {
  it("parses JSONL usage files incrementally and resets on day rollover", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-usage-adapter-"));
    cleanupPaths.push(root);
    const usageDir = path.join(root, "claude");
    mkdirSync(usageDir, { recursive: true });
    const usagePath = path.join(usageDir, "usage.jsonl");
    const now = new Date("2026-04-17T09:00:00.000Z");

    writeFileSync(
      usagePath,
      `${JSON.stringify({
        timestamp: now.toISOString(),
        session_id: "claude-session-1",
        model: "claude-sonnet-4",
        input_tokens: 1200,
        output_tokens: 300,
        estimated_cost: 1.25
      })}\n`,
      "utf8"
    );

    const [adapter] = createUsageAdapters({
      env: {
        KMUX_CLAUDE_USAGE_DIR: usageDir
      },
      homeDir: root
    });

    const initial = await adapter.initialScan(startOfLocalDay(now.getTime()));
    expect(initial.sourceCount).toBe(1);
    expect(initial.samples).toEqual([
      expect.objectContaining({
        vendor: "claude",
        sessionId: "claude-session-1",
        inputTokens: 1200,
        outputTokens: 300,
        totalTokens: 1500,
        estimatedCostUsd: 1.25
      })
    ]);

    appendFileSync(
      usagePath,
      `${JSON.stringify({
        timestamp: new Date("2026-04-17T09:05:00.000Z").toISOString(),
        session_id: "claude-session-1",
        input_tokens: 400,
        output_tokens: 100,
        estimated_cost: 0.42
      })}\n`,
      "utf8"
    );

    const incremental = await adapter.readIncremental(
      startOfLocalDay(now.getTime())
    );
    expect(incremental.samples).toEqual([
      expect.objectContaining({
        inputTokens: 400,
        outputTokens: 100,
        totalTokens: 500,
        estimatedCostUsd: 0.42
      })
    ]);

    const nextDay = await adapter.readIncremental(
      startOfLocalDay(new Date("2026-04-18T09:00:00.000Z").getTime())
    );
    expect(nextDay.samples).toEqual([]);
  });

  it("can force a one-shot rescan after a new codex usage root appears without relying on fast polling", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-usage-cold-start-"));
    cleanupPaths.push(root);
    const usageDir = path.join(root, "codex");
    const dayRoot = path.join(usageDir, "2026", "04", "17");
    const sessionPath = path.join(dayRoot, "manual-codex-session.jsonl");

    const [, adapter] = createUsageAdapters({
      env: {
        KMUX_CODEX_USAGE_DIR: usageDir
      },
      homeDir: root
    });

    const startOfDayMs = startOfLocalDay(new Date("2026-04-17T09:00:00.000Z").getTime());
    const initial = await adapter.initialScan(startOfDayMs);
    expect(initial.sourceCount).toBe(0);
    expect(initial.samples).toEqual([]);

    mkdirSync(dayRoot, { recursive: true });
    writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          timestamp: "2026-04-17T09:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "manual-codex-session",
            cwd: "/tmp/kmux-cold-start",
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

    adapter.markDirty?.();
    const incremental = await adapter.readIncremental(startOfDayMs);
    expect(incremental.sourceCount).toBe(1);
    expect(incremental.samples).toEqual([
      expect.objectContaining({
        vendor: "codex",
        sessionId: "manual-codex-session",
        model: "gpt-5.4",
        cwd: "/tmp/kmux-cold-start",
        totalTokens: 544
      })
    ]);
  });

  it("picks the vendor-specific override roots independently", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-usage-adapter-roots-"));
    cleanupPaths.push(root);
    const claudeDir = path.join(root, "claude");
    const codexDir = path.join(root, "codex");
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });

    writeFileSync(
      path.join(claudeDir, "claude.jsonl"),
      `${JSON.stringify({
        timestamp: new Date("2026-04-17T10:00:00.000Z").toISOString(),
        session_id: "claude-session-2",
        input_tokens: 50,
        output_tokens: 25,
        estimated_cost: 0.1
      })}\n`,
      "utf8"
    );
    writeFileSync(
      path.join(codexDir, "codex.jsonl"),
      `${JSON.stringify({
        timestamp: new Date("2026-04-17T10:00:00.000Z").toISOString(),
        thread_id: "codex-thread-1",
        prompt_tokens: 70,
        completion_tokens: 30,
        total_cost_usd: 0.2
      })}\n`,
      "utf8"
    );

    const [claude, codex] = createUsageAdapters({
      env: {
        KMUX_CLAUDE_USAGE_DIR: claudeDir,
        KMUX_CODEX_USAGE_DIR: codexDir
      },
      homeDir: root
    });

    const [claudeRead, codexRead] = await Promise.all([
      claude.initialScan(startOfLocalDay(new Date("2026-04-17T10:00:00.000Z").getTime())),
      codex.initialScan(startOfLocalDay(new Date("2026-04-17T10:00:00.000Z").getTime()))
    ]);

    expect(claudeRead.samples).toHaveLength(1);
    expect(codexRead.samples).toHaveLength(1);
    expect(claudeRead.samples[0]?.vendor).toBe("claude");
    expect(codexRead.samples[0]?.vendor).toBe("codex");
    expect(codexRead.samples[0]?.totalTokens).toBe(100);
  });

  it("parses codex session jsonl token_count events as deltas with cwd metadata", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-usage-codex-session-"));
    cleanupPaths.push(root);
    const codexDir = path.join(root, "sessions", "2026", "04", "17");
    mkdirSync(codexDir, { recursive: true });
    const sessionPath = path.join(
      codexDir,
      "rollout-2026-04-17T09-00-00-codex-session.jsonl"
    );

    writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          timestamp: "2026-04-17T09:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "codex-session-42",
            cwd: "/tmp/kmux-codex-real"
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-17T09:00:01.000Z",
          type: "turn_context",
          payload: {
            model: "gpt-5.4"
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-17T09:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 1200,
                cached_input_tokens: 200,
                output_tokens: 80,
                total_tokens: 1280
              }
            }
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-17T09:01:02.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 1800,
                cached_input_tokens: 260,
                output_tokens: 140,
                total_tokens: 1940
              }
            }
          }
        }),
        ""
      ].join("\n"),
      "utf8"
    );

    const [, codexAdapter] = createUsageAdapters({
      env: {
        KMUX_CODEX_USAGE_DIR: path.join(root, "sessions")
      },
      homeDir: root
    });

    const initial = await codexAdapter.initialScan(
      startOfLocalDay(new Date("2026-04-17T09:00:00.000Z").getTime())
    );
    expect(initial.samples).toEqual([
      expect.objectContaining({
        vendor: "codex",
        sessionId: "codex-session-42",
        model: "gpt-5.4",
        cwd: "/tmp/kmux-codex-real",
        inputTokens: 1000,
        cacheTokens: 200,
        outputTokens: 80,
        totalTokens: 1280
      }),
      expect.objectContaining({
        vendor: "codex",
        sessionId: "codex-session-42",
        model: "gpt-5.4",
        cwd: "/tmp/kmux-codex-real",
        inputTokens: 540,
        cacheTokens: 60,
        outputTokens: 60,
        totalTokens: 660
      })
    ]);
  });

  it("parses a valid trailing codex token_count line even when the file lacks a final newline", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-usage-codex-tail-"));
    cleanupPaths.push(root);
    const codexDir = path.join(root, "sessions", "2026", "04", "17");
    mkdirSync(codexDir, { recursive: true });
    const sessionPath = path.join(
      codexDir,
      "rollout-2026-04-17T09-10-00-codex-tail.jsonl"
    );

    writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          timestamp: "2026-04-17T09:10:00.000Z",
          type: "session_meta",
          payload: {
            id: "codex-tail-session",
            cwd: "/tmp/kmux-codex-tail"
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-17T09:10:01.000Z",
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
        })
      ].join("\n"),
      "utf8"
    );

    const [, codexAdapter] = createUsageAdapters({
      env: {
        KMUX_CODEX_USAGE_DIR: path.join(root, "sessions")
      },
      homeDir: root
    });

    const initial = await codexAdapter.initialScan(
      startOfLocalDay(new Date("2026-04-17T09:10:00.000Z").getTime())
    );
    expect(initial.samples).toEqual([
      expect.objectContaining({
        vendor: "codex",
        sessionId: "codex-tail-session",
        cwd: "/tmp/kmux-codex-tail",
        inputTokens: 384,
        cacheTokens: 128,
        outputTokens: 32,
        cacheWriteTokensKnown: false,
        thinkingTokens: 0,
        totalTokens: 544,
        estimatedCostUsd: 0,
        costSource: "unavailable"
      })
    ]);
  });

  it("extracts codex reasoning tokens from token_count deltas", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-usage-codex-thinking-"));
    cleanupPaths.push(root);
    const codexDir = path.join(root, "sessions", "2026", "04", "17");
    mkdirSync(codexDir, { recursive: true });
    const sessionPath = path.join(
      codexDir,
      "rollout-2026-04-17T10-00-00-codex-thinking.jsonl"
    );

    writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          timestamp: "2026-04-17T10:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "codex-thinking-session",
            cwd: "/tmp/kmux-codex-thinking"
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-17T10:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 1200,
                cached_input_tokens: 300,
                output_tokens: 180,
                reasoning_output_tokens: 70,
                total_tokens: 1380
              }
            }
          }
        })
      ].join("\n"),
      "utf8"
    );

    const [, codexAdapter] = createUsageAdapters({
      env: {
        KMUX_CODEX_USAGE_DIR: path.join(root, "sessions")
      },
      homeDir: root
    });

    const initial = await codexAdapter.initialScan(
      startOfLocalDay(new Date("2026-04-17T10:00:00.000Z").getTime())
    );
    expect(initial.samples).toEqual([
      expect.objectContaining({
        vendor: "codex",
        sessionId: "codex-thinking-session",
        inputTokens: 900,
        cacheReadTokens: 300,
        cacheWriteTokensKnown: false,
        outputTokens: 110,
        thinkingTokens: 70,
        totalTokens: 1380
      })
    ]);
  });

  it("extracts reasoning tokens and cache detail from generic usage payloads", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-usage-generic-json-"));
    cleanupPaths.push(root);
    const usageDir = path.join(root, "codex");
    mkdirSync(usageDir, { recursive: true });
    const usagePath = path.join(usageDir, "usage.jsonl");

    writeFileSync(
      usagePath,
      `${JSON.stringify({
        id: "resp_123",
        model: "gpt-5.4",
        created_at: "2026-04-17T11:00:00.000Z",
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 180,
          total_tokens: 1380,
          prompt_tokens_details: {
            cached_tokens: 300,
            cache_write_tokens: 120
          },
          completion_tokens_details: {
            reasoning_tokens: 70
          }
        }
      })}\n`,
      "utf8"
    );

    const [, codexAdapter] = createUsageAdapters({
      env: {
        KMUX_CODEX_USAGE_DIR: usageDir
      },
      homeDir: root
    });

    const initial = await codexAdapter.initialScan(
      startOfLocalDay(new Date("2026-04-17T11:00:00.000Z").getTime())
    );

    expect(initial.samples).toEqual([
      expect.objectContaining({
        vendor: "codex",
        model: "gpt-5.4",
        inputTokens: 780,
        cacheReadTokens: 300,
        cacheWriteTokens: 120,
        cacheWriteTokensKnown: true,
        outputTokens: 110,
        thinkingTokens: 70,
        totalTokens: 1380
      })
    ]);
  });

  it("estimates codex subscription-model cost from token_count deltas when the transcript has no provider cost", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-usage-codex-cost-"));
    cleanupPaths.push(root);
    const codexDir = path.join(root, "sessions", "2026", "04", "17");
    mkdirSync(codexDir, { recursive: true });
    const sessionPath = path.join(
      codexDir,
      "rollout-2026-04-17T09-00-00-codex-cost.jsonl"
    );

    writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          timestamp: "2026-04-17T09:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "codex-priced-session",
            cwd: "/tmp/kmux-codex-priced"
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-17T09:00:01.000Z",
          type: "turn_context",
          payload: {
            model: "gpt-5.4"
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-17T09:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 1200,
                cached_input_tokens: 200,
                output_tokens: 80,
                total_tokens: 1280
              }
            }
          }
        }),
        ""
      ].join("\n"),
      "utf8"
    );

    const [, codexAdapter] = createUsageAdapters({
      env: {
        KMUX_CODEX_USAGE_DIR: path.join(root, "sessions")
      },
      homeDir: root
    });

    const initial = await codexAdapter.initialScan(
      startOfLocalDay(new Date("2026-04-17T09:00:00.000Z").getTime())
    );

    expect(initial.samples).toEqual([
      expect.objectContaining({
        vendor: "codex",
        sessionId: "codex-priced-session",
        model: "gpt-5.4",
        inputTokens: 1000,
        cacheTokens: 200,
        outputTokens: 80,
        totalTokens: 1280,
        estimatedCostUsd: expect.closeTo(0.00375, 8),
        costSource: "estimated"
      })
    ]);
  });

  it("parses gemini session json files from tmp chats and resolves the project root", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-usage-gemini-session-"));
    cleanupPaths.push(root);
    const homeDir = path.join(root, "home");
    const geminiTmpDir = path.join(homeDir, ".gemini", "tmp", "kmux");
    const geminiHistoryDir = path.join(homeDir, ".gemini", "history", "kmux");
    mkdirSync(path.join(geminiTmpDir, "chats"), { recursive: true });
    mkdirSync(geminiHistoryDir, { recursive: true });
    writeFileSync(
      path.join(geminiHistoryDir, ".project_root"),
      "/tmp/kmux-gemini-real\n",
      "utf8"
    );
    writeFileSync(
      path.join(geminiTmpDir, "chats", "session-2026-04-17T09-00-abc123.json"),
      JSON.stringify({
        sessionId: "gemini-session-9",
        messages: [
          {
            id: "gemini-message-1",
            timestamp: "2026-04-17T09:00:00.000Z",
            type: "gemini",
            tokens: {
              input: 640,
              output: 120,
              cached: 40,
              total: 800
            },
            model: "gemini-3.1-pro-preview"
          }
        ]
      }),
      "utf8"
    );

    const [, , geminiAdapter] = createUsageAdapters({
      env: {
        KMUX_GEMINI_USAGE_DIR: path.join(homeDir, ".gemini", "tmp")
      },
      homeDir
    });

    const initial = await geminiAdapter.initialScan(
      startOfLocalDay(new Date("2026-04-17T09:00:00.000Z").getTime())
    );
    expect(initial.samples).toEqual([
      expect.objectContaining({
        vendor: "gemini",
        sessionId: "gemini-session-9",
        model: "gemini-3.1-pro-preview",
        cwd: "/tmp/kmux-gemini-real",
        projectPath: "/tmp/kmux-gemini-real",
        inputTokens: 640,
        outputTokens: 120,
        cacheTokens: 40,
        totalTokens: 800
      })
    ]);
  });

  it("resolves gemini history next to an overridden tmp root even when HOME points elsewhere", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-usage-gemini-override-"));
    cleanupPaths.push(root);
    const homeDir = path.join(root, "sandbox-home");
    const externalGeminiRoot = path.join(root, "external-gemini");
    const geminiTmpDir = path.join(externalGeminiRoot, "tmp", "kmux");
    const geminiHistoryDir = path.join(externalGeminiRoot, "history", "kmux");
    mkdirSync(path.join(geminiTmpDir, "chats"), { recursive: true });
    mkdirSync(geminiHistoryDir, { recursive: true });

    writeFileSync(
      path.join(geminiHistoryDir, ".project_root"),
      "/tmp/kmux-gemini-override\n",
      "utf8"
    );
    writeFileSync(
      path.join(geminiTmpDir, "chats", "session-2026-04-17T10-00-override.json"),
      JSON.stringify({
        sessionId: "gemini-session-override",
        messages: [
          {
            id: "gemini-message-override",
            timestamp: "2026-04-17T10:00:00.000Z",
            type: "gemini",
            tokens: {
              input: 900,
              output: 100,
              cached: 0,
              total: 1000
            },
            model: "gemini-2.5-flash"
          }
        ]
      }),
      "utf8"
    );

    const [, , geminiAdapter] = createUsageAdapters({
      env: {
        KMUX_GEMINI_USAGE_DIR: path.join(externalGeminiRoot, "tmp")
      },
      homeDir
    });

    const initial = await geminiAdapter.initialScan(
      startOfLocalDay(new Date("2026-04-17T10:00:00.000Z").getTime())
    );
    expect(initial.samples).toEqual([
      expect.objectContaining({
        vendor: "gemini",
        sessionId: "gemini-session-override",
        cwd: "/tmp/kmux-gemini-override",
        projectPath: "/tmp/kmux-gemini-override",
        totalTokens: 1000,
        model: "gemini-2.5-flash"
      })
    ]);
  });

  it("parses Antigravity transcript usage from local conversation storage", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-usage-agy-"));
    cleanupPaths.push(root);
    const homeDir = path.join(root, "home");
    const conversationId = "4814da0a-b93c-41cc-837d-8a747e9d5b2e";
    const workspace = "/tmp/kmux-antigravity-real";
    const logDir = path.join(
      homeDir,
      ".gemini",
      "antigravity-cli",
      "brain",
      conversationId,
      ".system_generated",
      "logs"
    );
    mkdirSync(logDir, { recursive: true });
    mkdirSync(path.join(homeDir, ".gemini", "antigravity-cli", "cache"), {
      recursive: true
    });
    writeFileSync(
      path.join(homeDir, ".gemini", "antigravity-cli", "history.jsonl"),
      `${JSON.stringify({
        display: "hello",
        timestamp: new Date("2026-06-02T03:55:54.000Z").getTime(),
        workspace,
        conversationId
      })}\n`,
      "utf8"
    );
    writeFileSync(
      path.join(
        homeDir,
        ".gemini",
        "antigravity-cli",
        "cache",
        "last_conversations.json"
      ),
      JSON.stringify({ [workspace]: conversationId }),
      "utf8"
    );
    writeFileSync(
      path.join(logDir, "transcript.jsonl"),
      [
        JSON.stringify({
          step_index: 0,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          status: "DONE",
          created_at: "2026-06-02T03:55:54.000Z",
          content:
            "The user changed setting `Model Selection` from None to Gemini 3.5 Flash (Medium).\n<USER_REQUEST>\nhello\n</USER_REQUEST>"
        }),
        JSON.stringify({
          step_index: 1,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          created_at: "2026-06-02T03:55:59.000Z",
          content: "Hello from Antigravity.",
          tool_calls: [
            {
              name: "list_dir",
              args: {
                DirectoryPath: workspace
              }
            }
          ]
        }),
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(logDir, "transcript_full.jsonl"),
      `${JSON.stringify({
        step_index: 2,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        created_at: "2026-06-02T03:56:00.000Z",
        content: "This should not be double-counted."
      })}\n`,
      "utf8"
    );

    const [, , , antigravityAdapter] = createUsageAdapters({
      homeDir
    });

    const initial = await antigravityAdapter.initialScan(
      startOfLocalDay(new Date("2026-06-02T03:55:54.000Z").getTime())
    );
    expect(initial.sourceCount).toBe(1);
    expect(initial.samples).toHaveLength(2);
    expect(initial.samples).toEqual([
      expect.objectContaining({
        vendor: "antigravity",
        sessionId: conversationId,
        threadId: `${conversationId}:0`,
        model: "Gemini 3.5 Flash (Medium)",
        cwd: workspace,
        projectPath: workspace,
        outputTokens: 0,
        costSource: "estimated"
      }),
      expect.objectContaining({
        vendor: "antigravity",
        sessionId: conversationId,
        threadId: `${conversationId}:1`,
        model: "Gemini 3.5 Flash (Medium)",
        cwd: workspace,
        projectPath: workspace,
        inputTokens: 0,
        costSource: "estimated"
      })
    ]);
    expect(
      initial.samples.reduce((sum, sample) => sum + sample.totalTokens, 0)
    ).toBeGreaterThan(0);
    expect(
      initial.samples.reduce((sum, sample) => sum + sample.estimatedCostUsd, 0)
    ).toBeGreaterThan(0);
  });

  it("replays Antigravity transcript samples when conversation workspace metadata appears during incremental reads", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-usage-agy-refresh-"));
    cleanupPaths.push(root);
    const homeDir = path.join(root, "home");
    const conversationId = "614e5204-a346-44fa-ba98-2cbf60cf574d";
    const workspace = "/tmp/kmux-antigravity-late-workspace";
    const logDir = path.join(
      homeDir,
      ".gemini",
      "antigravity-cli",
      "brain",
      conversationId,
      ".system_generated",
      "logs"
    );
    mkdirSync(logDir, { recursive: true });
    const transcriptPath = path.join(logDir, "transcript.jsonl");
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-06-02T03:55:54.000Z",
        content:
          "The user changed setting `Model Selection` from None to Gemini 3.5 Flash (Medium).\n<USER_REQUEST>\nhello\n</USER_REQUEST>"
      })}\n`,
      "utf8"
    );

    const [, , , antigravityAdapter] = createUsageAdapters({
      homeDir
    });
    const startOfDayMs = startOfLocalDay(
      new Date("2026-06-02T03:55:54.000Z").getTime()
    );

    const initial = await antigravityAdapter.initialScan(startOfDayMs);
    expect(initial.samples).toEqual([
      expect.objectContaining({
        sessionId: conversationId,
        cwd: undefined,
        projectPath: undefined
      })
    ]);

    mkdirSync(path.join(homeDir, ".gemini", "antigravity-cli", "cache"), {
      recursive: true
    });
    writeFileSync(
      path.join(homeDir, ".gemini", "antigravity-cli", "history.jsonl"),
      `${JSON.stringify({
        display: "hello",
        timestamp: new Date("2026-06-02T03:55:56.000Z").getTime(),
        workspace,
        conversationId
      })}\n`,
      "utf8"
    );
    writeFileSync(
      path.join(
        homeDir,
        ".gemini",
        "antigravity-cli",
        "cache",
        "last_conversations.json"
      ),
      JSON.stringify({ [workspace]: conversationId }),
      "utf8"
    );
    const incremental = await antigravityAdapter.readIncremental(startOfDayMs);
    expect(incremental.samples).toEqual([
      expect.objectContaining({
        sessionId: conversationId,
        cwd: workspace,
        projectPath: workspace
      })
    ]);
  });

  it("scans recent usage history into daily buckets without reusing the live incremental cursors", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kmux-usage-history-scan-"));
    cleanupPaths.push(root);
    const usageDir = path.join(root, "claude");
    mkdirSync(usageDir, { recursive: true });
    const usagePath = path.join(usageDir, "usage.jsonl");

    writeFileSync(
      usagePath,
      [
        JSON.stringify({
          timestamp: "2026-04-16T11:00:00.000Z",
          session_id: "claude-history-day-1",
          model: "claude-sonnet-4-5",
          input_tokens: 1000,
          output_tokens: 120,
          estimated_cost: 1.2
        }),
        JSON.stringify({
          timestamp: "2026-04-17T11:00:00.000Z",
          session_id: "claude-history-day-2",
          model: "claude-sonnet-4-5",
          input_tokens: 600,
          output_tokens: 80,
          estimated_cost: 0.8
        }),
        ""
      ].join("\n"),
      "utf8"
    );

    const usageModule = (await import("./usage")) as {
      scanUsageHistoryDays?: (options: {
        env?: NodeJS.ProcessEnv;
        homeDir?: string;
        fromMs: number;
        toMs: number;
      }) => Promise<
        Array<{
          dayKey: string;
          totalCostUsd: number;
          totalTokens: number;
          activeSessionCount: number;
        }>
      >;
    };

    expect(typeof usageModule.scanUsageHistoryDays).toBe("function");

    const days = await usageModule.scanUsageHistoryDays!({
      env: {
        KMUX_CLAUDE_USAGE_DIR: usageDir
      },
      homeDir: root,
      fromMs: new Date("2026-04-16T00:00:00.000Z").getTime(),
      toMs: new Date("2026-04-17T23:59:59.999Z").getTime()
    });

    expect(days).toEqual([
      expect.objectContaining({
        dayKey: "2026-04-16",
        totalCostUsd: 1.2,
        totalTokens: 1120,
        activeSessionCount: 1
      }),
      expect.objectContaining({
        dayKey: "2026-04-17",
        totalCostUsd: 0.8,
        totalTokens: 680,
        activeSessionCount: 1
      })
    ]);
  });
});

function startOfLocalDay(timestampMs: number): number {
  const date = new Date(timestampMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}
