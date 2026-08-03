import { Buffer } from "node:buffer";

import type { RemoteMetadataSourceDto } from "@kmux/proto";
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

  it("coalesces simultaneous usage and history refreshes and preserves the last successful snapshots", async () => {
    const runtime = new FakeMetadataRuntime(initialClaudeLog());
    const session = createSession(runtime);

    const [usage, history] = await Promise.all([
      session.scanUsage({ startAtUnixMs: 0, maxRecords: 64 }),
      session.scanHistory({ maxRecords: 100 })
    ]);
    expect(runtime.maximumConcurrentInventories).toBe(1);
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

  it("rejects a JSONL record larger than the configured parser bound", async () => {
    const runtime = new FakeMetadataRuntime(
      claudeUser("x".repeat(512), "2026-08-02T00:00:00Z")
    );
    await expect(
      createSession(runtime, { maxJsonlLineBytes: 128 }).scanUsage({
        startAtUnixMs: 0,
        maxRecords: 64
      })
    ).rejects.toThrow("usage JSONL record exceeds its byte bound");
  });

  it("reads shared Antigravity history once and filters it to owned claims", async () => {
    const runtime = new FakeAntigravityHistoryRuntime();
    const session = new RemoteMetadataSession({
      runtime,
      desktopInstallationId: "desktop_1",
      targetId: TARGET_ID,
      principal: { uid: 1_000, accountName: "kmux" }
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
      principal: { uid: 1_000, accountName: "kmux" }
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
    ...(limits === undefined ? {} : { limits })
  });
}

class FakeMetadataRuntime {
  readonly readOffsets: number[] = [];
  maximumConcurrentInventories = 0;
  failInventories = false;
  failReadAtOrAfterOffset: number | undefined;
  inventoryTruncated = false;

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
    purpose: "usage" | "history";
  }): Promise<RemoteMetadataSourcesList> {
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
      contractVersion: 1,
      truncated: this.inventoryTruncated,
      claims:
        options.purpose === "history" && this.includeClaim
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

  async listMetadataSources(): Promise<RemoteMetadataSourcesList> {
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
      purpose: "history",
      contractVersion: 1,
      truncated: false,
      claims,
      sources: claims.map((claim, index) => ({
        sourceId: `antigravity_history_${index}`,
        vendor: "antigravity",
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

  async listMetadataSources(): Promise<RemoteMetadataSourcesList> {
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
      purpose: "history",
      contractVersion: 1,
      truncated: false,
      claims: [claim],
      sources: [
        {
          sourceId: "antigravity_conversation",
          vendor: "antigravity",
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
