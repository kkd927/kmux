import { Buffer } from "node:buffer";

import {
  METADATA_SOURCE_CONTRACT,
  type MetadataSourceContract
} from "@kmux/metadata/core";
import type { RemoteMetadataSourceDto } from "@kmux/proto";
import {
  createBuiltinRemoteHistoryProjections,
  createBuiltinRemoteUsageProjections
} from "@kmux/agents/builtin-runtime";
import { describe, expect, it, vi } from "vitest";

import type {
  RemoteMetadataSourceQuery,
  RemoteMetadataSourceRead,
  RemoteMetadataSourcesList
} from "./linuxX64RemoteRuntime";
import { RemoteRuntimeError } from "./linuxX64RemoteRuntime";
import {
  RemoteMetadataSession,
  type RemoteMetadataSessionLimits
} from "./remoteMetadataSession";

const TARGET_ID = "target_1";
const SESSION_ID = "session-1";
const AGENT_DEFINITIONS = Object.freeze({
  claude: "claude-v1",
  codex: "codex-v1",
  antigravity: "antigravity-v1"
});
const CLAUDE_DEFINITIONS = Object.freeze({ claude: AGENT_DEFINITIONS.claude });
const CLAUDE_CODEX_DEFINITIONS = Object.freeze({
  claude: AGENT_DEFINITIONS.claude,
  codex: AGENT_DEFINITIONS.codex
});
const ANTIGRAVITY_DEFINITIONS = Object.freeze({
  antigravity: AGENT_DEFINITIONS.antigravity
});
const HISTORY_PROJECTIONS = createBuiltinRemoteHistoryProjections();
const USAGE_PROJECTIONS = createBuiltinRemoteUsageProjections();

describe("RemoteMetadataSession", () => {
  it("reuses unchanged sources and handles append, truncate, and rotation without duplicate usage", async () => {
    const runtime = new FakeMetadataRuntime(initialClaudeLog());
    const session = createSession(runtime);

    const cold = await session.scanUsage({ startAtUnixMs: 0, maxRecords: 64 });
    expect(cold.records).toHaveLength(1);
    expect(cold.records[0]).toMatchObject({
      vendor: "claude",
      sessionId: SESSION_ID,
      inputTokens: "10",
      outputTokens: "4"
    });
    expect(runtime.readOffsets).toEqual([0]);

    const warm = await session.scanUsage({ startAtUnixMs: 0, maxRecords: 64 });
    expect(warm.records).toEqual(cold.records);
    expect(runtime.readOffsets).toEqual([0]);

    const sameSizeRewrite = initialClaudeLog().replace(
      '"input_tokens":10',
      '"input_tokens":11'
    );
    expect(Buffer.byteLength(sameSizeRewrite, "utf8")).toBe(
      Buffer.byteLength(initialClaudeLog(), "utf8")
    );
    runtime.replace(sameSizeRewrite);
    const rewritten = await session.scanUsage({
      startAtUnixMs: 0,
      maxRecords: 64
    });
    expect(rewritten.records[0]?.inputTokens).toBe("11");
    expect(runtime.readOffsets.at(-1)).toBe(0);

    runtime.append(claudeAssistant("request-2", "2026-08-02T00:00:02Z", 7));
    const appended = await session.scanUsage({
      startAtUnixMs: 0,
      maxRecords: 64
    });
    expect(appended.records).toEqual([
      expect.objectContaining({
        sampleId: `claude:${SESSION_ID}`,
        inputTokens: "18",
        outputTokens: "8"
      })
    ]);
    expect(runtime.readOffsets.at(-1)).toBe(
      Buffer.byteLength(initialClaudeLog(), "utf8")
    );

    runtime.replace(
      `${claudeUser("replacement", "2026-08-02T00:00:03Z")}${claudeAssistant(
        "request-3",
        "2026-08-02T00:00:04Z",
        3
      )}`
    );
    const truncated = await session.scanUsage({
      startAtUnixMs: 0,
      maxRecords: 64
    });
    expect(truncated.records).toHaveLength(1);
    expect(truncated.records[0]?.inputTokens).toBe("3");
    expect(runtime.readOffsets.at(-1)).toBe(0);

    runtime.rotate(
      `${claudeUser("rotated", "2026-08-02T00:00:05Z")}${claudeAssistant(
        "request-4",
        "2026-08-02T00:00:06Z",
        12
      )}`
    );
    const rotated = await session.scanUsage({
      startAtUnixMs: 0,
      maxRecords: 64
    });
    expect(rotated.records).toHaveLength(1);
    expect(rotated.records[0]?.inputTokens).toBe("12");
    expect(runtime.readOffsets.at(-1)).toBe(0);
  });

  it("keeps simultaneous usage and history inventories independently bounded", async () => {
    const runtime = new FakeMetadataRuntime(initialClaudeLog());
    const session = createSession(runtime);

    const [usage, history] = await Promise.all([
      session.scanUsage({ startAtUnixMs: 0, maxRecords: 64 }),
      session.scanHistory({ maxRecords: 100 })
    ]);
    expect(runtime.maximumConcurrentInventories).toBe(2);
    expect(runtime.inventoryPurposes).toEqual(["usage", "history"]);
    expect(runtime.readOffsets).toEqual([0, 0]);
    expect(usage.records).toHaveLength(1);
    expect(history.records).toEqual([
      expect.objectContaining({
        vendor: "claude",
        sessionId: SESSION_ID,
        title: "hello from user"
      })
    ]);

    runtime.failInventories = true;
    await expect(
      session.scanUsage({ startAtUnixMs: 0, maxRecords: 64 })
    ).resolves.toEqual({ ...usage, truncated: true });
    await expect(session.scanHistory({ maxRecords: 100 })).resolves.toEqual({
      ...history,
      truncated: true
    });
  });

  it("does not reuse a narrower cached usage range for a wider failed scan", async () => {
    const runtime = new FakeMetadataRuntime(initialClaudeLog());
    const session = createSession(runtime);
    await session.scanUsage({
      startAtUnixMs: Date.parse("2026-08-02T00:00:01Z"),
      maxRecords: 64
    });

    runtime.failInventories = true;
    await expect(
      session.scanUsage({ startAtUnixMs: 0, maxRecords: 64 })
    ).rejects.toThrow("bridge unavailable");
  });

  it("reaggregates committed samples when a failed scan narrows the usage range", async () => {
    const runtime = new FakeMetadataRuntime(
      `${claudeAssistant("request-before", "2026-08-02T00:00:01Z", 10)}${claudeAssistant(
        "request-after",
        "2026-08-02T00:00:02Z",
        20
      )}`
    );
    const session = createSession(runtime);
    await expect(
      session.scanUsage({ startAtUnixMs: 0, maxRecords: 64 })
    ).resolves.toMatchObject({
      records: [expect.objectContaining({ inputTokens: "30" })]
    });

    runtime.failInventories = true;
    await expect(
      session.scanUsage({
        startAtUnixMs: Date.parse("2026-08-02T00:00:02Z"),
        maxRecords: 64
      })
    ).resolves.toMatchObject({
      truncated: true,
      records: [expect.objectContaining({ inputTokens: "20" })]
    });
  });

  it("retains incomplete EOF records until a later append completes them", async () => {
    const assistantRecord = claudeAssistant(
      "request-late",
      "2026-08-02T00:00:07Z",
      19
    ).trimEnd();
    const assistantSplit = Math.floor(assistantRecord.length / 2);
    const usageRuntime = new FakeMetadataRuntime(
      assistantRecord.slice(0, assistantSplit)
    );
    const usageSession = createSession(usageRuntime);

    await expect(
      usageSession.scanUsage({ startAtUnixMs: 0, maxRecords: 64 })
    ).resolves.toMatchObject({ records: [] });
    usageRuntime.append(`${assistantRecord.slice(assistantSplit)}\n`);
    await expect(
      usageSession.scanUsage({ startAtUnixMs: 0, maxRecords: 64 })
    ).resolves.toMatchObject({
      records: [expect.objectContaining({ inputTokens: "19" })]
    });

    const userRecord = claudeUser(
      "late history title",
      "2026-08-02T00:00:08Z"
    ).trimEnd();
    const userSplit = Math.floor(userRecord.length / 2);
    const historyRuntime = new FakeMetadataRuntime(
      userRecord.slice(0, userSplit)
    );
    const historySession = createSession(historyRuntime);

    await expect(
      historySession.scanHistory({ maxRecords: 100 })
    ).resolves.toEqual({
      type: "history.scanned",
      targetId: TARGET_ID,
      principal: { uid: 1_000, accountName: "kmux" },
      truncated: false,
      records: [expect.objectContaining({ title: "Claude session" })]
    });
    historyRuntime.append(`${userRecord.slice(userSplit)}\n`);
    await expect(
      historySession.scanHistory({ maxRecords: 100 })
    ).resolves.toMatchObject({
      records: [expect.objectContaining({ title: "late history title" })]
    });
  });

  it("invalidates the coordinated inventory before retrying a stale source", async () => {
    const runtime = new FakeMetadataRuntime(initialClaudeLog());
    const session = createSession(runtime);
    await session.scanUsage({ startAtUnixMs: 0, maxRecords: 64 });
    runtime.append(claudeAssistant("request-stale", "2026-08-02T00:00:09Z", 5));
    runtime.staleReadOnce = true;

    const refreshed = await session.scanUsage({
      startAtUnixMs: 0,
      maxRecords: 64
    });

    expect(runtime.inventoryPurposes.slice(-2)).toEqual(["usage", "usage"]);
    expect(refreshed.records).toEqual([
      expect.objectContaining({ inputTokens: "15" })
    ]);
  });

  it("batches agent inventory and preserves every handle across a stale retry", async () => {
    const runtime = new AgentScopedMetadataRuntime();
    const session = new RemoteMetadataSession({
      runtime,
      desktopInstallationId: "desktop_1",
      targetId: TARGET_ID,
      principal: { uid: 1_000, accountName: "kmux" },
      agentDefinitions: CLAUDE_CODEX_DEFINITIONS,
      historyProjections: HISTORY_PROJECTIONS,
      usageProjections: USAGE_PROJECTIONS
    });

    const history = await session.scanHistory({ maxRecords: 100 });

    expect(runtime.maximumConcurrentInventories).toBe(1);
    expect(runtime.inventoryAgents).toEqual([
      ["claude", "codex"],
      ["claude", "codex"]
    ]);
    expect(history.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          vendor: "claude",
          sessionId: SESSION_ID,
          title: "hello from user"
        }),
        expect.objectContaining({
          vendor: "codex",
          sessionId: "codex-session",
          title: "hello from codex"
        })
      ])
    );
  });

  it("keeps compatible agents when the remote omits an unsupported definition", async () => {
    const runtime = new AgentScopedMetadataRuntime();
    runtime.staleReadOnce = false;
    runtime.unsupportedAgents.add("codex");
    const session = new RemoteMetadataSession({
      runtime,
      desktopInstallationId: "desktop_1",
      targetId: TARGET_ID,
      principal: { uid: 1_000, accountName: "kmux" },
      agentDefinitions: CLAUDE_CODEX_DEFINITIONS,
      historyProjections: HISTORY_PROJECTIONS,
      usageProjections: USAGE_PROJECTIONS
    });

    await expect(
      session.scanHistory({ maxRecords: 100 })
    ).resolves.toMatchObject({
      records: [
        expect.objectContaining({
          vendor: "claude",
          sessionId: SESSION_ID
        })
      ]
    });
  });

  it("keeps the most complete duplicate Claude usage sample", async () => {
    const runtime = new FakeMetadataRuntime(
      `${claudeUser("deduplicated", "2026-08-02T00:00:00Z")}${claudeAssistant(
        "request-duplicate",
        "2026-08-02T00:00:01Z",
        20
      )}${claudeAssistant("request-duplicate", "2026-08-02T00:00:02Z", 5)}`
    );

    await expect(
      createSession(runtime).scanUsage({ startAtUnixMs: 0, maxRecords: 64 })
    ).resolves.toMatchObject({
      records: [expect.objectContaining({ inputTokens: "20" })]
    });
  });

  it("keeps an owned history claim visible before its source file exists", async () => {
    const runtime = new FakeMetadataRuntime("");
    runtime.removeSource();

    await expect(
      createSession(runtime).scanHistory({ maxRecords: 100 })
    ).resolves.toMatchObject({
      truncated: false,
      records: [
        expect.objectContaining({
          vendor: "claude",
          sessionId: SESSION_ID,
          title: "Claude session",
          cwd: "/srv/project"
        })
      ]
    });
  });

  it("applies changed claim metadata without rereading an unchanged source", async () => {
    const runtime = new FakeMetadataRuntime("");
    const session = createSession(runtime);
    await session.scanHistory({ maxRecords: 100 });
    runtime.updateClaim({
      cwd: "/srv/moved",
      launchTitle: "Renamed session",
      lastSeenAtUnixMs: "1700000000999"
    });

    await expect(
      session.scanHistory({ maxRecords: 100 })
    ).resolves.toMatchObject({
      records: [
        expect.objectContaining({
          sessionId: SESSION_ID,
          cwd: "/srv/moved",
          title: "Renamed session",
          updatedAtUnixMs: "1700000000999"
        })
      ]
    });
    expect(runtime.readOffsets).toEqual([]);
  });

  it("never attributes a source containing another session to the owned claim", async () => {
    const runtime = new FakeMetadataRuntime(
      initialClaudeLog().replaceAll(SESSION_ID, "session-other")
    );
    const session = createSession(runtime);

    await expect(
      session.scanUsage({ startAtUnixMs: 0, maxRecords: 64 })
    ).resolves.toMatchObject({ records: [] });
    await expect(
      session.scanHistory({ maxRecords: 100 })
    ).resolves.toMatchObject({
      records: [
        expect.objectContaining({
          vendor: "claude",
          sessionId: SESSION_ID,
          title: "Claude session"
        })
      ]
    });
  });

  it("marks a bounded history edge scan as truncated", async () => {
    const content = Array.from({ length: 1_100 }, (_, index) =>
      claudeUser(
        `history ${index}`,
        `2026-08-02T00:${String(index % 60).padStart(2, "0")}:00Z`
      )
    ).join("");

    await expect(
      createSession(new FakeMetadataRuntime(content)).scanHistory({
        maxRecords: 100
      })
    ).resolves.toMatchObject({
      truncated: true,
      records: [expect.objectContaining({ sessionId: SESSION_ID })]
    });
  });

  it("merges a truncated inventory without deleting omitted sources or claims", async () => {
    const runtime = new FakeMetadataRuntime(initialClaudeLog());
    const session = createSession(runtime);
    await session.scanUsage({ startAtUnixMs: 0, maxRecords: 64 });
    await session.scanHistory({ maxRecords: 100 });

    runtime.append(
      claudeAssistant("request-partial", "2026-08-02T00:00:02Z", 7)
    );
    runtime.inventoryTruncated = true;
    const partialUsage = await session.scanUsage({
      startAtUnixMs: 0,
      maxRecords: 64
    });
    const partialHistory = await session.scanHistory({ maxRecords: 100 });
    expect(partialUsage).toMatchObject({
      truncated: true,
      records: [expect.objectContaining({ inputTokens: "17" })]
    });
    expect(partialHistory).toMatchObject({
      truncated: true,
      records: [expect.objectContaining({ sessionId: SESSION_ID })]
    });

    runtime.removeSource();
    runtime.removeClaim();
    await expect(
      session.scanUsage({ startAtUnixMs: 0, maxRecords: 64 })
    ).resolves.toEqual(partialUsage);
    await expect(session.scanHistory({ maxRecords: 100 })).resolves.toEqual(
      partialHistory
    );

    runtime.inventoryTruncated = false;
    await expect(
      session.scanUsage({ startAtUnixMs: 0, maxRecords: 64 })
    ).resolves.toMatchObject({ records: [] });
    await expect(
      session.scanHistory({ maxRecords: 100 })
    ).resolves.toMatchObject({ records: [] });
  });

  it("resets a same-inode source rewritten beyond the previous cursor", async () => {
    const initial = `${claudeUser("x".repeat(5_000), "2026-08-02T00:00:00Z")}${claudeAssistant(
      "request-old",
      "2026-08-02T00:00:01Z",
      10
    )}`;
    const runtime = new FakeMetadataRuntime(initial);
    const session = createSession(runtime);
    await session.scanUsage({ startAtUnixMs: 0, maxRecords: 64 });
    const oldSize = Buffer.byteLength(initial, "utf8");

    const replacement = `${claudeUser("y".repeat(6_000), "2026-08-02T00:00:02Z")}${claudeAssistant(
      "request-new",
      "2026-08-02T00:00:03Z",
      31
    )}`;
    expect(Buffer.byteLength(replacement, "utf8")).toBeGreaterThan(oldSize);
    const readsBeforeRewrite = runtime.readOffsets.length;
    runtime.replace(replacement);

    const rewritten = await session.scanUsage({
      startAtUnixMs: 0,
      maxRecords: 64
    });
    expect(rewritten.records).toEqual([
      expect.objectContaining({ inputTokens: "31" })
    ]);
    expect(runtime.readOffsets.slice(readsBeforeRewrite)).toEqual([
      oldSize - 4 * 1024,
      0
    ]);
  });

  it("commits append parsing only after every source read succeeds", async () => {
    const runtime = new FakeMetadataRuntime(initialClaudeLog());
    const session = createSession(runtime, {
      continuityBytes: 32,
      maxReadBytes: 128
    });
    const cold = await session.scanUsage({ startAtUnixMs: 0, maxRecords: 64 });
    const oldSize = Buffer.byteLength(initialClaudeLog(), "utf8");
    runtime.append(
      `${claudeAssistant("request-2", "2026-08-02T00:00:02Z", 7)}${claudeAssistant(
        "request-3",
        "2026-08-02T00:00:03Z",
        9
      )}`
    );
    runtime.failReadAtOrAfterOffset = oldSize + 128;

    await expect(
      session.scanUsage({ startAtUnixMs: 0, maxRecords: 64 })
    ).resolves.toEqual({ ...cold, truncated: true });
    runtime.failReadAtOrAfterOffset = undefined;
    const readsBeforeRecovery = runtime.readOffsets.length;
    await expect(
      session.scanUsage({ startAtUnixMs: 0, maxRecords: 64 })
    ).resolves.toMatchObject({
      records: [expect.objectContaining({ inputTokens: "26" })]
    });
    expect(runtime.readOffsets[readsBeforeRecovery]).toBe(oldSize - 32);
  });

  it("rejects permanent transfer and retained-state limit failures", async () => {
    const initial = initialClaudeLog();
    const initialBytes = Buffer.byteLength(initial, "utf8");
    const transferRuntime = new FakeMetadataRuntime(initial);
    const transferSession = createSession(transferRuntime, {
      continuityBytes: 32,
      maxRefreshBytes: initialBytes + 1_024,
      maxSourceBytesPerRefresh: initialBytes + 64
    });
    await transferSession.scanUsage({
      startAtUnixMs: 0,
      maxRecords: 64
    });
    transferRuntime.append(
      `${claudeUser("z".repeat(initialBytes), "2026-08-02T00:00:02Z")}${claudeAssistant(
        "request-over-budget",
        "2026-08-02T00:00:03Z",
        7
      )}`
    );
    await expect(
      transferSession.scanUsage({ startAtUnixMs: 0, maxRecords: 64 })
    ).rejects.toThrow("transfer budget");

    const sampleRuntime = new FakeMetadataRuntime(initial);
    const sampleSession = createSession(sampleRuntime, { maxUsageSamples: 1 });
    await sampleSession.scanUsage({
      startAtUnixMs: 0,
      maxRecords: 64
    });
    sampleRuntime.append(
      claudeAssistant("request-over-sample-cap", "2026-08-02T00:00:02Z", 3)
    );
    await expect(
      sampleSession.scanUsage({ startAtUnixMs: 0, maxRecords: 64 })
    ).rejects.toThrow("sample budget");

    const historyRuntime = new FakeMetadataRuntime(
      claudeUser("first", "2026-08-02T00:00:00Z")
    );
    const historySession = createSession(historyRuntime, {
      maxHistoryRecords: 1
    });
    await historySession.scanHistory({
      maxRecords: 100
    });
    historyRuntime.append(claudeUser("second", "2026-08-02T00:00:01Z"));
    await expect(
      historySession.scanHistory({ maxRecords: 100 })
    ).rejects.toThrow("record budget");
  });

  it("skips an oversized usage record and continues with later records", async () => {
    const runtime = new FakeMetadataRuntime(
      `${claudeUser("x".repeat(1_024), "2026-08-02T00:00:00Z")}${claudeAssistant(
        "after-oversized-record",
        "2026-08-02T00:00:01Z",
        7
      )}`
    );
    await expect(
      createSession(runtime, { maxJsonlLineBytes: 512 }).scanUsage({
        startAtUnixMs: 0,
        maxRecords: 64
      })
    ).resolves.toMatchObject({
      records: [expect.objectContaining({ inputTokens: "7" })]
    });
  });

  it("routes an open future agent source through its injected history projection", async () => {
    const content = `${JSON.stringify({ prompt: "Future agent request" })}\n`;
    const definitions = { "fixture-orbit": "fixture-orbit-v1" };
    const sourceContract = {
      ...METADATA_SOURCE_CONTRACT,
      sources: [
        ...METADATA_SOURCE_CONTRACT.sources,
        {
          vendor: "fixture-orbit",
          role: "fixture-orbit/session-jsonl",
          format: "jsonl",
          purposes: ["history"],
          pattern: "sessions/*.jsonl"
        }
      ]
    } satisfies MetadataSourceContract;
    const claim = {
      sessionId: "orbit-session",
      claimedAtUnixMs: "1700000000000",
      lastSeenAtUnixMs: "1700000000001",
      cwd: "/srv/orbit",
      workspacePaths: ["/srv/orbit"],
      launchTitle: "Orbit launch"
    };
    const runtime = {
      async listMetadataSources(options: {
        purpose: "usage" | "history" | "all";
      }): Promise<RemoteMetadataSourcesList> {
        return {
          type: "metadata.sources.listed",
          targetId: TARGET_ID,
          purpose: options.purpose,
          contractVersion: 2,
          agentDefinitions: definitions,
          truncated: false,
          claims: [{ vendor: "fixture-orbit", ...claim }],
          sources: [
            {
              sourceId: "orbit_source",
              vendor: "fixture-orbit",
              definitionRevision: "fixture-orbit-v1",
              role: "fixture-orbit/session-jsonl",
              format: "jsonl",
              logicalName: "sessions/orbit-session.jsonl",
              size: String(Buffer.byteLength(content, "utf8")),
              mtimeUnixMs: "1700000000000",
              fileIdentity: "orbit:1",
              claim
            }
          ]
        };
      },
      async readMetadataSource(request: {
        sourceId: string;
        offset: number;
        maxBytes: number;
      }): Promise<RemoteMetadataSourceRead> {
        const bytes = Buffer.from(content, "utf8");
        const end = Math.min(bytes.length, request.offset + request.maxBytes);
        return {
          type: "metadata.sources.read",
          sourceId: request.sourceId,
          offset: String(request.offset),
          nextOffset: String(end),
          eof: end === bytes.length,
          fileIdentity: "orbit:1",
          content: bytes.subarray(request.offset, end).toString("utf8")
        };
      },
      async queryMetadataSource(): Promise<RemoteMetadataSourceQuery> {
        throw new Error("unexpected query");
      }
    };
    const session = new RemoteMetadataSession({
      runtime,
      desktopInstallationId: "desktop_1",
      targetId: TARGET_ID,
      principal: { uid: 1_000, accountName: "kmux" },
      agentDefinitions: definitions,
      sourceContract,
      usageProjections: new Map(),
      historyProjections: new Map([
        [
          "fixture-orbit",
          {
            projectSource(input) {
              const record = input.records?.[0] as
                | { prompt?: unknown }
                | undefined;
              return [
                {
                  sessionId: input.claim?.sessionId ?? "missing",
                  title:
                    typeof record?.prompt === "string"
                      ? record.prompt
                      : "Orbit session",
                  updatedAtMs: input.mtimeMs
                }
              ];
            }
          }
        ]
      ])
    });

    await expect(
      session.scanHistory({ maxRecords: 100 })
    ).resolves.toMatchObject({
      records: [
        expect.objectContaining({
          vendor: "fixture-orbit",
          sessionId: "orbit-session",
          title: "Future agent request",
          cwd: "/srv/orbit"
        })
      ]
    });
  });

  it("reads shared Antigravity history once and filters it to owned claims", async () => {
    const runtime = new FakeAntigravityHistoryRuntime();
    const session = new RemoteMetadataSession({
      runtime,
      desktopInstallationId: "desktop_1",
      targetId: TARGET_ID,
      principal: { uid: 1_000, accountName: "kmux" },
      agentDefinitions: ANTIGRAVITY_DEFINITIONS,
      historyProjections: HISTORY_PROJECTIONS,
      usageProjections: USAGE_PROJECTIONS
    });

    const history = await session.scanHistory({ maxRecords: 100 });
    expect(history.records).toEqual([
      expect.objectContaining({
        vendor: "antigravity",
        sessionId: "conversation-2",
        title: "second"
      }),
      expect.objectContaining({
        vendor: "antigravity",
        sessionId: "conversation-1",
        title: "first"
      })
    ]);
    expect(runtime.readOffsets).toEqual([0]);
  });

  it("queries only Antigravity conversation edge prompts", async () => {
    const runtime = new FakeAntigravityConversationRuntime();
    const session = new RemoteMetadataSession({
      runtime,
      desktopInstallationId: "desktop_1",
      targetId: TARGET_ID,
      principal: { uid: 1_000, accountName: "kmux" },
      agentDefinitions: ANTIGRAVITY_DEFINITIONS,
      historyProjections: HISTORY_PROJECTIONS,
      usageProjections: USAGE_PROJECTIONS
    });

    await expect(
      session.scanHistory({ maxRecords: 100 })
    ).resolves.toMatchObject({
      records: [
        expect.objectContaining({
          vendor: "antigravity",
          sessionId: "conversation-1",
          title: "first prompt",
          recentConversation: "latest prompt"
        })
      ]
    });
    expect(runtime.queryRequests).toEqual([
      expect.objectContaining({ maxRows: 2 })
    ]);
    expect(runtime.queryRequests[0]).not.toHaveProperty("pageToken");
  });

  it("rejects paginated or over-budget Antigravity conversation queries", async () => {
    const paginated = new FakeAntigravityConversationRuntime();
    paginated.nextPageToken = "1";
    await expect(
      createAntigravityConversationSession(paginated).scanHistory({
        maxRecords: 100
      })
    ).rejects.toThrow("unbounded result");

    const overBudget = new FakeAntigravityConversationRuntime();
    await expect(
      createAntigravityConversationSession(overBudget, {
        maxSourceBytesPerRefresh: 128
      }).scanHistory({ maxRecords: 100 })
    ).rejects.toThrow("transfer budget");
  });
});

function createSession(
  runtime: FakeMetadataRuntime,
  limits?: Partial<RemoteMetadataSessionLimits>
): RemoteMetadataSession {
  return new RemoteMetadataSession({
    runtime,
    desktopInstallationId: "desktop_1",
    targetId: TARGET_ID,
    principal: { uid: 1_000, accountName: "kmux" },
    agentDefinitions: CLAUDE_DEFINITIONS,
    historyProjections: HISTORY_PROJECTIONS,
    usageProjections: USAGE_PROJECTIONS,
    ...(limits === undefined ? {} : { limits })
  });
}

function createAntigravityConversationSession(
  runtime: FakeAntigravityConversationRuntime,
  limits?: Partial<RemoteMetadataSessionLimits>
): RemoteMetadataSession {
  return new RemoteMetadataSession({
    runtime,
    desktopInstallationId: "desktop_1",
    targetId: TARGET_ID,
    principal: { uid: 1_000, accountName: "kmux" },
    agentDefinitions: ANTIGRAVITY_DEFINITIONS,
    historyProjections: HISTORY_PROJECTIONS,
    usageProjections: USAGE_PROJECTIONS,
    ...(limits === undefined ? {} : { limits })
  });
}

class FakeMetadataRuntime {
  readonly readOffsets: number[] = [];
  readonly inventoryPurposes: Array<"usage" | "history" | "all"> = [];
  maximumConcurrentInventories = 0;
  failInventories = false;
  failReadAtOrAfterOffset: number | undefined;
  inventoryTruncated = false;
  staleReadOnce = false;

  private content: string;
  private claimCwd = "/srv/project";
  private claimLastSeenAtUnixMs = "1700000000000";
  private claimLaunchTitle = "Claude session";
  private includeClaim = true;
  private includeSource = true;
  private identity = "1:1";
  private revision = 1;
  private activeInventories = 0;
  private readonly contentBySourceId = new Map<string, string>();

  constructor(content: string) {
    this.content = content;
  }

  append(content: string): void {
    this.content += content;
    this.revision += 1;
  }

  replace(content: string): void {
    this.content = content;
    this.revision += 1;
  }

  rotate(content: string): void {
    this.content = content;
    this.identity = "1:2";
    this.revision += 1;
  }

  removeSource(): void {
    this.includeSource = false;
    this.revision += 1;
  }

  removeClaim(): void {
    this.includeClaim = false;
    this.revision += 1;
  }

  updateClaim(options: {
    cwd: string;
    launchTitle: string;
    lastSeenAtUnixMs: string;
  }): void {
    this.claimCwd = options.cwd;
    this.claimLaunchTitle = options.launchTitle;
    this.claimLastSeenAtUnixMs = options.lastSeenAtUnixMs;
  }

  async listMetadataSources(options: {
    purpose: "usage" | "history" | "all";
  }): Promise<RemoteMetadataSourcesList> {
    this.inventoryPurposes.push(options.purpose);
    if (this.failInventories) {
      throw new RemoteRuntimeError(
        "bridge-unavailable",
        "bridge unavailable",
        true
      );
    }
    this.activeInventories += 1;
    this.maximumConcurrentInventories = Math.max(
      this.maximumConcurrentInventories,
      this.activeInventories
    );
    await Promise.resolve();
    this.activeInventories -= 1;
    const sourceId = `source_${options.purpose}_${this.revision}`;
    this.contentBySourceId.set(sourceId, this.content);
    return {
      type: "metadata.sources.listed",
      targetId: TARGET_ID,
      purpose: options.purpose,
      contractVersion: 2,
      agentDefinitions: CLAUDE_DEFINITIONS,
      truncated: this.inventoryTruncated,
      claims:
        options.purpose !== "usage" && this.includeClaim
          ? [{ vendor: "claude", ...this.sourceClaim() }]
          : [],
      sources: this.includeSource ? [this.source(sourceId)] : []
    };
  }

  async readMetadataSource(options: {
    sourceId: string;
    offset: number;
    maxBytes: number;
  }): Promise<RemoteMetadataSourceRead> {
    const content = this.contentBySourceId.get(options.sourceId);
    if (content === undefined) throw new Error("unknown source");
    this.readOffsets.push(options.offset);
    if (this.staleReadOnce) {
      this.staleReadOnce = false;
      this.identity = `1:${this.revision + 1}`;
      this.revision += 1;
      throw new RemoteRuntimeError(
        "stale_source",
        "injected metadata source rotation",
        true
      );
    }
    if (
      this.failReadAtOrAfterOffset !== undefined &&
      options.offset >= this.failReadAtOrAfterOffset
    ) {
      throw new RemoteRuntimeError(
        "bridge-unavailable",
        "injected metadata read failure",
        true
      );
    }
    const bytes = Buffer.from(content, "utf8");
    const end = Math.min(bytes.length, options.offset + options.maxBytes);
    return {
      type: "metadata.sources.read",
      sourceId: options.sourceId,
      offset: String(options.offset),
      nextOffset: String(end),
      eof: end === bytes.length,
      fileIdentity: this.identity,
      content: bytes.subarray(options.offset, end).toString("utf8")
    };
  }

  queryMetadataSource = vi.fn(async (): Promise<RemoteMetadataSourceQuery> => {
    throw new Error("unexpected SQLite query");
  });

  private source(sourceId: string): RemoteMetadataSourceDto {
    return {
      sourceId,
      vendor: "claude",
      definitionRevision: AGENT_DEFINITIONS.claude,
      role: "claude-session",
      format: "jsonl",
      logicalName: `projects/${SESSION_ID}.jsonl`,
      size: String(Buffer.byteLength(this.content, "utf8")),
      mtimeUnixMs: String(1_700_000_000_000 + this.revision),
      fileIdentity: this.identity,
      claim: this.sourceClaim()
    };
  }

  private sourceClaim(): RemoteMetadataSourceDto["claim"] {
    return {
      sessionId: SESSION_ID,
      claimedAtUnixMs: "1",
      lastSeenAtUnixMs: this.claimLastSeenAtUnixMs,
      cwd: this.claimCwd,
      workspacePaths: [this.claimCwd],
      launchTitle: this.claimLaunchTitle
    };
  }
}

class AgentScopedMetadataRuntime {
  readonly inventoryAgents: string[][] = [];
  readonly unsupportedAgents = new Set<string>();
  maximumConcurrentInventories = 0;
  staleReadOnce = true;

  private activeInventories = 0;
  private readonly generationByAgent = new Map<string, number>();
  private readonly handles = new Map<
    string,
    {
      agentId: string;
      purpose: "usage" | "history" | "all";
      content: string;
      fileIdentity: string;
    }
  >();

  async listMetadataSources(options: {
    purpose: "usage" | "history" | "all";
    agentDefinitions: Record<string, string>;
  }): Promise<RemoteMetadataSourcesList> {
    const requestedDefinitions = Object.entries(options.agentDefinitions).sort(
      ([left], [right]) => left.localeCompare(right)
    );
    if (requestedDefinitions.length === 0) {
      throw new Error("test runtime requires agent definitions");
    }
    this.inventoryAgents.push(requestedDefinitions.map(([agentId]) => agentId));
    const definitions = requestedDefinitions.filter(
      ([agentId]) => !this.unsupportedAgents.has(agentId)
    );
    this.activeInventories += 1;
    this.maximumConcurrentInventories = Math.max(
      this.maximumConcurrentInventories,
      this.activeInventories
    );
    await Promise.resolve();
    this.activeInventories -= 1;
    const requestedAgents = new Set(definitions.map(([agentId]) => agentId));
    for (const [sourceId, handle] of this.handles) {
      if (
        handle.purpose === options.purpose &&
        requestedAgents.has(handle.agentId)
      ) {
        this.handles.delete(sourceId);
      }
    }
    const claims: RemoteMetadataSourcesList["claims"] = [];
    const sources: RemoteMetadataSourcesList["sources"] = [];
    for (const [agentId, definitionRevision] of definitions) {
      const generation = (this.generationByAgent.get(agentId) ?? 0) + 1;
      this.generationByAgent.set(agentId, generation);
      const sourceId = `${agentId}_source_${generation}`;
      const fileIdentity = `${agentId}:${generation}`;
      const sessionId = agentId === "claude" ? SESSION_ID : "codex-session";
      const content =
        agentId === "claude"
          ? initialClaudeLog()
          : [
              JSON.stringify({
                type: "session_meta",
                timestamp: "2026-08-02T00:00:00Z",
                payload: { id: sessionId, cwd: "/srv/codex" }
              }),
              JSON.stringify({
                type: "event_msg",
                timestamp: "2026-08-02T00:00:01Z",
                payload: {
                  type: "user_message",
                  message: "hello from codex"
                }
              })
            ].join("\n") + "\n";
      this.handles.set(sourceId, {
        agentId,
        purpose: options.purpose,
        content,
        fileIdentity
      });
      const claim = {
        sessionId,
        claimedAtUnixMs: "1",
        lastSeenAtUnixMs: "1700000000001",
        cwd: agentId === "claude" ? "/srv/project" : "/srv/codex",
        workspacePaths: [agentId === "claude" ? "/srv/project" : "/srv/codex"],
        launchTitle: `${agentId} session`
      };
      claims.push({ vendor: agentId, ...claim });
      sources.push({
        sourceId,
        vendor: agentId,
        definitionRevision,
        role: agentId === "claude" ? "claude-session" : "codex-session",
        format: "jsonl",
        logicalName: `${agentId}/${sessionId}.jsonl`,
        size: String(Buffer.byteLength(content, "utf8")),
        mtimeUnixMs: String(1_700_000_000_000 + generation),
        fileIdentity,
        claim
      });
    }
    return {
      type: "metadata.sources.listed",
      targetId: TARGET_ID,
      purpose: options.purpose,
      contractVersion: 2,
      agentDefinitions: Object.fromEntries(definitions),
      truncated: false,
      claims: options.purpose === "usage" ? [] : claims,
      sources
    };
  }

  async readMetadataSource(options: {
    sourceId: string;
    offset: number;
    maxBytes: number;
  }): Promise<RemoteMetadataSourceRead> {
    const handle = this.handles.get(options.sourceId);
    if (!handle) {
      throw new RemoteRuntimeError(
        "stale_source",
        "metadata source handle is stale",
        true
      );
    }
    if (this.staleReadOnce) {
      this.staleReadOnce = false;
      this.handles.delete(options.sourceId);
      throw new RemoteRuntimeError(
        "stale_source",
        "injected metadata source rotation",
        true
      );
    }
    const bytes = Buffer.from(handle.content, "utf8");
    const end = Math.min(bytes.length, options.offset + options.maxBytes);
    return {
      type: "metadata.sources.read",
      sourceId: options.sourceId,
      offset: String(options.offset),
      nextOffset: String(end),
      eof: end === bytes.length,
      fileIdentity: handle.fileIdentity,
      content: bytes.subarray(options.offset, end).toString("utf8")
    };
  }

  queryMetadataSource = vi.fn(async (): Promise<RemoteMetadataSourceQuery> => {
    throw new Error("unexpected SQLite query");
  });
}

class FakeAntigravityHistoryRuntime {
  readonly readOffsets: number[] = [];
  private readonly content = [
    JSON.stringify({
      conversationId: "conversation-1",
      display: "first",
      timestamp: 1_700_000_000_001
    }),
    JSON.stringify({
      conversationId: "conversation-2",
      display: "second",
      timestamp: 1_700_000_000_002
    }),
    JSON.stringify({
      conversationId: "not-owned",
      display: "must not escape",
      timestamp: 1_700_000_000_003
    })
  ].join("\n");

  async listMetadataSources(options: {
    purpose: "usage" | "history" | "all";
  }): Promise<RemoteMetadataSourcesList> {
    const claims = ["conversation-1", "conversation-2"].map((sessionId) => ({
      vendor: "antigravity" as const,
      sessionId,
      claimedAtUnixMs: "1",
      lastSeenAtUnixMs:
        sessionId === "conversation-1" ? "1700000000001" : "1700000000002",
      cwd: `/srv/${sessionId}`,
      workspacePaths: [`/srv/${sessionId}`]
    }));
    return {
      type: "metadata.sources.listed",
      targetId: TARGET_ID,
      purpose: options.purpose,
      contractVersion: 2,
      agentDefinitions: ANTIGRAVITY_DEFINITIONS,
      truncated: false,
      claims,
      sources: claims.map((claim, index) => ({
        sourceId: `antigravity_history_${index}`,
        vendor: "antigravity",
        definitionRevision: AGENT_DEFINITIONS.antigravity,
        role: "antigravity-history",
        format: "jsonl",
        logicalName: "history.jsonl",
        size: String(Buffer.byteLength(this.content, "utf8")),
        mtimeUnixMs: "1700000000003",
        fileIdentity: "2:1",
        claim
      }))
    };
  }

  async readMetadataSource(options: {
    sourceId: string;
    offset: number;
    maxBytes: number;
  }): Promise<RemoteMetadataSourceRead> {
    this.readOffsets.push(options.offset);
    const bytes = Buffer.from(this.content, "utf8");
    const end = Math.min(bytes.length, options.offset + options.maxBytes);
    return {
      type: "metadata.sources.read",
      sourceId: options.sourceId,
      offset: String(options.offset),
      nextOffset: String(end),
      eof: end === bytes.length,
      fileIdentity: "2:1",
      content: bytes.subarray(options.offset, end).toString("utf8")
    };
  }

  queryMetadataSource = vi.fn(async (): Promise<RemoteMetadataSourceQuery> => {
    throw new Error("unexpected SQLite query");
  });
}

class FakeAntigravityConversationRuntime {
  readonly queryRequests: Array<{
    sourceId: string;
    queryId: string;
    maxRows: number;
    pageToken?: string;
  }> = [];
  nextPageToken: string | undefined;

  async listMetadataSources(options: {
    purpose: "usage" | "history" | "all";
  }): Promise<RemoteMetadataSourcesList> {
    const claim = {
      vendor: "antigravity" as const,
      sessionId: "conversation-1",
      claimedAtUnixMs: "1",
      lastSeenAtUnixMs: "1700000000002",
      cwd: "/srv/conversation-1",
      workspacePaths: ["/srv/conversation-1"]
    };
    return {
      type: "metadata.sources.listed",
      targetId: TARGET_ID,
      purpose: options.purpose,
      contractVersion: 2,
      agentDefinitions: ANTIGRAVITY_DEFINITIONS,
      truncated: false,
      claims: [claim],
      sources: [
        {
          sourceId: "antigravity_conversation",
          vendor: "antigravity",
          definitionRevision: AGENT_DEFINITIONS.antigravity,
          role: "antigravity-conversation",
          format: "sqlite",
          logicalName: "conversations/conversation-1.db",
          size: "1024",
          mtimeUnixMs: "1700000000002",
          fileIdentity: "3:1",
          claim
        }
      ]
    };
  }

  async readMetadataSource(): Promise<RemoteMetadataSourceRead> {
    throw new Error("unexpected JSONL read");
  }

  async queryMetadataSource(options: {
    sourceId: string;
    queryId: string;
    maxRows: number;
    pageToken?: string;
  }): Promise<RemoteMetadataSourceQuery> {
    this.queryRequests.push({ ...options });
    return {
      type: "metadata.sources.queried",
      sourceId: options.sourceId,
      queryId: options.queryId,
      fileIdentity: "3:1",
      rows: [
        {
          index: 0,
          stepType: 14,
          payloadBase64: antigravityPromptPayload("first prompt")
        },
        {
          index: 9,
          stepType: 14,
          payloadBase64: antigravityPromptPayload("latest prompt")
        }
      ],
      ...(this.nextPageToken === undefined
        ? {}
        : { nextPageToken: this.nextPageToken })
    };
  }
}

function initialClaudeLog(): string {
  return `${claudeUser("hello from user", "2026-08-02T00:00:00Z")}${claudeAssistant(
    "request-1",
    "2026-08-02T00:00:01Z",
    10
  )}`;
}

function claudeUser(content: string, timestamp: string): string {
  return `${JSON.stringify({
    type: "user",
    sessionId: SESSION_ID,
    uuid: `user-${timestamp}`,
    timestamp,
    cwd: "/srv/project",
    message: { role: "user", content }
  })}\n`;
}

function claudeAssistant(
  requestId: string,
  timestamp: string,
  inputTokens: number
): string {
  return `${JSON.stringify({
    type: "assistant",
    sessionId: SESSION_ID,
    uuid: `assistant-${requestId}`,
    requestId,
    timestamp,
    cwd: "/srv/project",
    message: {
      id: `message-${requestId}`,
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: "assistant reply",
      usage: { input_tokens: inputTokens, output_tokens: 4 }
    }
  })}\n`;
}

function antigravityPromptPayload(prompt: string): string {
  const text = Buffer.from(prompt, "utf8");
  return Buffer.from([
    0x12,
    ...encodeVarint(text.byteLength),
    ...text
  ]).toString("base64");
}

function encodeVarint(value: number): number[] {
  const output: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    output.push(byte);
  } while (remaining > 0);
  return output;
}
