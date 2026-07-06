import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync as NodeSqliteDatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { resolveAgentStorageRoots } from "@kmux/metadata";

import { createExternalSessionIndexer } from "./externalSessions";

const sandboxDirs: string[] = [];
const nodeRequire = createRequire(import.meta.url);

type DatabaseSyncConstructor = typeof NodeSqliteDatabaseSync;

function createSandboxHome(): string {
  const homeDir = mkdtempSync(join(tmpdir(), "kmux-external-sessions-"));
  sandboxDirs.push(homeDir);
  return homeDir;
}

function writeJsonl(path: string, records: unknown[], mtime: Date): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8"
  );
  utimesSync(path, mtime, mtime);
}

function writeJson(path: string, record: unknown, mtime: Date): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  utimesSync(path, mtime, mtime);
}

function loadTestDatabaseSync(): DatabaseSyncConstructor | undefined {
  try {
    return (
      nodeRequire("node:sqlite") as {
        DatabaseSync?: DatabaseSyncConstructor;
      }
    ).DatabaseSync;
  } catch {
    return undefined;
  }
}

function createTestExternalSessionIndexer(
  options: Parameters<typeof createExternalSessionIndexer>[0]
): ReturnType<typeof createExternalSessionIndexer> {
  return createExternalSessionIndexer({
    ...options,
    antigravitySessionIndexPath:
      options.antigravitySessionIndexPath ??
      join(options.homeDir, ".config", "kmux", "antigravity-sessions.json")
  });
}

function writeAntigravitySqliteConversation(
  path: string,
  prompt: string,
  mtime: Date
): boolean {
  const DatabaseSync = loadTestDatabaseSync();
  if (!DatabaseSync) {
    return false;
  }

  mkdirSync(join(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "CREATE TABLE steps (idx INTEGER NOT NULL, step_type INTEGER NOT NULL, step_payload BLOB)"
    );
    db.prepare(
      "INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)"
    ).run(0, 14, encodePromptPayload(prompt));
  } finally {
    db.close();
  }
  utimesSync(path, mtime, mtime);
  return true;
}

function encodePromptPayload(prompt: string): Buffer {
  const promptBytes = Buffer.from(prompt, "utf8");
  return Buffer.concat([
    Buffer.from([0x12]),
    encodeVarint(promptBytes.length),
    promptBytes
  ]);
}

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

afterEach(() => {
  for (const sandboxDir of sandboxDirs.splice(0)) {
    rmSync(sandboxDir, { force: true, recursive: true });
  }
});

describe("external session indexer", () => {
  it("uses AgentStorageRoots for vendor session discovery", () => {
    const homeDir = createSandboxHome();
    const storageHomeDir = createSandboxHome();
    const roots = resolveAgentStorageRoots({
      homeDir: storageHomeDir
    });
    const now = new Date("2026-04-26T12:00:00.000Z");
    const mtime = new Date("2026-04-26T11:00:00.000Z");

    writeJsonl(
      join(
        roots.codex.sessionsDir,
        "2026",
        "04",
        "26",
        "rollout-2026-04-26T11-00-00-codex-storage-root-session.jsonl"
      ),
      [
        {
          type: "session_meta",
          timestamp: mtime.toISOString(),
          payload: {
            id: "codex-storage-root-session",
            cwd: "/Users/test/codex-project"
          }
        },
        {
          type: "event_msg",
          timestamp: mtime.toISOString(),
          payload: {
            type: "user_message",
            message: "Codex storage root session"
          }
        }
      ],
      mtime
    );

    const indexer = createTestExternalSessionIndexer({
      homeDir,
      agentStorageRoots: roots,
      now: () => now,
      commandAvailability: () => true
    });

    const snapshot = indexer.listExternalAgentSessions();

    expect(snapshot.sessions).toEqual([
      expect.objectContaining({
        key: "codex:codex-storage-root-session",
        vendor: "codex",
        title: "Codex storage root session",
        cwd: "/Users/test/codex-project",
        canResume: true
      })
    ]);
    expect(
      indexer.resolveExternalAgentSession("codex:codex-storage-root-session")
    ).toEqual(
      expect.objectContaining({
        key: "codex:codex-storage-root-session",
        vendor: "codex",
        title: "Codex storage root session",
        cwd: "/Users/test/codex-project"
      })
    );
  });

  it("defaults to indexing at most 100 recent files per vendor", () => {
    const homeDir = createSandboxHome();
    const now = new Date("2026-04-26T12:00:00.000Z");

    for (let index = 0; index < 101; index += 1) {
      const sessionNumber = index + 1;
      const padded = String(sessionNumber).padStart(3, "0");
      const mtime = new Date(now.getTime() - index * 60_000);

      writeJsonl(
        join(
          homeDir,
          ".codex",
          "sessions",
          "2026",
          "04",
          "26",
          `rollout-2026-04-26T11-${padded}-codex-session.jsonl`
        ),
        [
          {
            type: "session_meta",
            timestamp: mtime.toISOString(),
            payload: {
              id: `codex-session-${padded}`,
              cwd: "/Users/test/codex-project"
            }
          },
          {
            type: "event_msg",
            timestamp: mtime.toISOString(),
            payload: {
              type: "user_message",
              message: `Codex session ${padded}`
            }
          }
        ],
        mtime
      );

      writeJsonl(
        join(
          homeDir,
          ".claude",
          "projects",
          "-Users-test-claude-project",
          `claude-session-${padded}.jsonl`
        ),
        [
          {
            sessionId: `claude-session-${padded}`,
            cwd: "/Users/test/claude-project",
            timestamp: mtime.toISOString()
          },
          {
            type: "user",
            timestamp: mtime.toISOString(),
            message: `Claude session ${padded}`
          }
        ],
        mtime
      );
    }

    const snapshot = createTestExternalSessionIndexer({
      homeDir,
      now: () => now
    }).listExternalAgentSessions();

    expect(
      snapshot.sessions.filter((session) => session.vendor === "codex")
    ).toHaveLength(100);
    expect(
      snapshot.sessions.filter((session) => session.vendor === "claude")
    ).toHaveLength(100);
    expect(snapshot.sessions).toHaveLength(200);
    expect(snapshot.sessions.map((session) => session.key)).not.toContain(
      "codex:codex-session-101"
    );
    expect(snapshot.sessions.map((session) => session.key)).not.toContain(
      "claude:claude-session-101"
    );
  }, 15_000);

  it("only lists sessions updated within the last 30 days", () => {
    const homeDir = createSandboxHome();
    const now = new Date("2026-04-26T12:00:00.000Z");
    const cutoffMtime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const oldMtime = new Date(cutoffMtime.getTime() - 1);

    writeJsonl(
      join(
        homeDir,
        ".codex",
        "sessions",
        "2026",
        "03",
        "27",
        "rollout-2026-03-27T12-00-codex-recent.jsonl"
      ),
      [
        {
          type: "session_meta",
          timestamp: cutoffMtime.toISOString(),
          payload: {
            id: "codex-recent",
            cwd: "/Users/test/codex-project"
          }
        },
        {
          type: "event_msg",
          timestamp: cutoffMtime.toISOString(),
          payload: {
            type: "user_message",
            message: "Recent Codex session"
          }
        }
      ],
      cutoffMtime
    );
    writeJsonl(
      join(
        homeDir,
        ".codex",
        "sessions",
        "2026",
        "03",
        "26",
        "rollout-2026-03-26T11-59-codex-old.jsonl"
      ),
      [
        {
          type: "session_meta",
          timestamp: oldMtime.toISOString(),
          payload: {
            id: "codex-old",
            cwd: "/Users/test/codex-project"
          }
        },
        {
          type: "event_msg",
          timestamp: oldMtime.toISOString(),
          payload: {
            type: "user_message",
            message: "Old Codex session"
          }
        }
      ],
      oldMtime
    );

    writeJsonl(
      join(
        homeDir,
        ".claude",
        "projects",
        "-Users-test-claude-project",
        "claude-recent.jsonl"
      ),
      [
        {
          sessionId: "claude-recent",
          cwd: "/Users/test/claude-project",
          timestamp: cutoffMtime.toISOString()
        },
        {
          type: "user",
          timestamp: cutoffMtime.toISOString(),
          message: "Recent Claude session"
        }
      ],
      cutoffMtime
    );
    writeJsonl(
      join(
        homeDir,
        ".claude",
        "projects",
        "-Users-test-claude-project",
        "claude-old.jsonl"
      ),
      [
        {
          sessionId: "claude-old",
          cwd: "/Users/test/claude-project",
          timestamp: oldMtime.toISOString()
        },
        {
          type: "user",
          timestamp: oldMtime.toISOString(),
          message: "Old Claude session"
        }
      ],
      oldMtime
    );

    const indexer = createTestExternalSessionIndexer({
      homeDir,
      now: () => now
    });
    const snapshot = indexer.listExternalAgentSessions();

    expect(snapshot.sessions.map((session) => session.key).sort()).toEqual([
      "claude:claude-recent",
      "codex:codex-recent"
    ]);
    expect(indexer.resolveExternalAgentSession("codex:codex-old")).toBeNull();
    expect(indexer.resolveExternalAgentSession("claude:claude-old")).toBeNull();
  });

  it("ignores Codex environment context when deriving session titles", () => {
    const homeDir = createSandboxHome();
    const now = new Date("2026-04-26T12:00:00.000Z");
    const mtime = new Date("2026-04-26T11:00:00.000Z");

    writeJsonl(
      join(
        homeDir,
        ".codex",
        "sessions",
        "2026",
        "04",
        "26",
        "rollout-2026-04-26T11-00-codex-context.jsonl"
      ),
      [
        {
          type: "session_meta",
          timestamp: mtime.toISOString(),
          payload: {
            id: "codex-context",
            cwd: "/Users/test/codex-project"
          }
        },
        {
          type: "response_item",
          timestamp: mtime.toISOString(),
          payload: {
            type: "message",
            role: "developer",
            content: [
              {
                type: "input_text",
                text: "<permissions instructions>Do not use as title</permissions instructions>"
              }
            ]
          }
        },
        {
          type: "response_item",
          timestamp: mtime.toISOString(),
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "<environment_context>\n  <cwd>/Users/test/codex-project</cwd>\n</environment_context>"
              }
            ]
          }
        },
        {
          type: "response_item",
          timestamp: mtime.toISOString(),
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Actual Codex request\nwith details"
              }
            ]
          }
        },
        {
          type: "event_msg",
          timestamp: mtime.toISOString(),
          payload: {
            type: "user_message",
            message: "Actual Codex request\nwith details"
          }
        }
      ],
      mtime
    );

    const snapshot = createTestExternalSessionIndexer({
      homeDir,
      now: () => now
    }).listExternalAgentSessions();

    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0].title).toBe("Actual Codex request");
  });

  it("ignores Codex repository instructions when deriving session titles", () => {
    const homeDir = createSandboxHome();
    const now = new Date("2026-05-28T12:00:00.000Z");
    const mtime = new Date("2026-05-28T11:00:00.000Z");

    writeJsonl(
      join(
        homeDir,
        ".codex",
        "sessions",
        "2026",
        "05",
        "28",
        "rollout-2026-05-28T11-00-codex-agents.jsonl"
      ),
      [
        {
          type: "session_meta",
          timestamp: mtime.toISOString(),
          payload: {
            id: "codex-agents",
            cwd: "/Users/test/codex-project"
          }
        },
        {
          type: "response_item",
          timestamp: mtime.toISOString(),
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  "# AGENTS.md instructions for /Users/test/codex-project\n\n" +
                  "<INSTRUCTIONS>\n" +
                  "# AGENTS.md\n\n" +
                  "Do not use this as a resume title.\n" +
                  "</INSTRUCTIONS>"
              }
            ]
          }
        },
        {
          type: "response_item",
          timestamp: mtime.toISOString(),
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Fix sessions panel Codex titles\nwith details"
              }
            ]
          }
        },
        {
          type: "event_msg",
          timestamp: mtime.toISOString(),
          payload: {
            type: "user_message",
            message: "Fix sessions panel Codex titles\nwith details"
          }
        }
      ],
      mtime
    );

    const snapshot = createTestExternalSessionIndexer({
      homeDir,
      now: () => now
    }).listExternalAgentSessions();

    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0].title).toBe("Fix sessions panel Codex titles");
  });

  it("prefers Codex thread names over sanitized prompt fallback titles", () => {
    const homeDir = createSandboxHome();
    const now = new Date("2026-04-26T12:00:00.000Z");
    const mtime = new Date("2026-04-26T11:00:00.000Z");

    writeJsonl(
      join(
        homeDir,
        ".codex",
        "sessions",
        "2026",
        "04",
        "26",
        "rollout-2026-04-26T11-00-codex-thread-name.jsonl"
      ),
      [
        {
          type: "session_meta",
          timestamp: mtime.toISOString(),
          payload: {
            id: "codex-thread-name",
            cwd: "/Users/test/codex-project"
          }
        },
        {
          type: "response_item",
          timestamp: mtime.toISOString(),
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Prompt fallback"
              }
            ]
          }
        },
        {
          type: "event_msg",
          timestamp: mtime.toISOString(),
          payload: {
            type: "thread_name_updated",
            thread_name: "Generated Codex thread title"
          }
        }
      ],
      mtime
    );

    const snapshot = createTestExternalSessionIndexer({
      homeDir,
      now: () => now
    }).listExternalAgentSessions();

    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0].title).toBe("Generated Codex thread title");
  });

  it("formats session times as compact seconds, minutes, hours, and days", () => {
    const homeDir = createSandboxHome();
    const now = new Date("2026-04-26T12:00:00.000Z");
    const cases = [
      { id: "seconds", ageMs: 10_000, expected: "10s" },
      { id: "minutes", ageMs: 10 * 60_000, expected: "10m" },
      { id: "hours", ageMs: 10 * 60 * 60_000, expected: "10h" },
      { id: "days", ageMs: 10 * 24 * 60 * 60_000, expected: "10d" }
    ];

    for (const testCase of cases) {
      const mtime = new Date(now.getTime() - testCase.ageMs);
      writeJsonl(
        join(
          homeDir,
          ".codex",
          "sessions",
          "2026",
          "04",
          "26",
          `rollout-2026-04-26T12-00-${testCase.id}.jsonl`
        ),
        [
          {
            type: "session_meta",
            timestamp: mtime.toISOString(),
            payload: {
              id: testCase.id,
              cwd: "/Users/test/codex-project"
            }
          },
          {
            type: "event_msg",
            timestamp: mtime.toISOString(),
            payload: {
              type: "user_message",
              message: testCase.id
            }
          }
        ],
        mtime
      );
    }

    const snapshot = createTestExternalSessionIndexer({
      homeDir,
      now: () => now
    }).listExternalAgentSessions();
    const labels = new Map(
      snapshot.sessions.map((session) => [
        session.key,
        session.relativeTimeLabel
      ])
    );

    expect(labels.get("codex:seconds")).toBe("10s");
    expect(labels.get("codex:minutes")).toBe("10m");
    expect(labels.get("codex:hours")).toBe("10h");
    expect(labels.get("codex:days")).toBe("10d");
  });

  it("lists Codex and Claude sessions newest first with sanitized titles", () => {
    const homeDir = createSandboxHome();
    const now = new Date("2026-04-26T12:00:00.000Z");
    const codexMtime = new Date("2026-04-26T11:00:00.000Z");
    const claudeMtime = new Date("2026-04-26T09:00:00.000Z");

    writeJsonl(
      join(
        homeDir,
        ".codex",
        "sessions",
        "2026",
        "04",
        "26",
        "rollout-2026-04-26T11-00-codex-session.jsonl"
      ),
      [
        {
          type: "session_meta",
          timestamp: codexMtime.toISOString(),
          payload: {
            id: "codex-session",
            cwd: "/Users/test/codex-project",
            source: "cli",
            originator: "codex-tui"
          }
        },
        {
          type: "event_msg",
          timestamp: codexMtime.toISOString(),
          payload: {
            type: "user_message",
            message: "Fix terminal focus\n\nwith details that should not leak"
          }
        },
        {
          type: "event_msg",
          timestamp: codexMtime.toISOString(),
          payload: {
            type: "thread_name_updated",
            thread_name: "Tab focus root cause"
          }
        }
      ],
      codexMtime
    );

    writeJsonl(
      join(
        homeDir,
        ".claude",
        "projects",
        "-Users-test-claude-project",
        "claude-session.jsonl"
      ),
      [
        {
          sessionId: "claude-session",
          cwd: "/Users/test/claude-project",
          timestamp: claudeMtime.toISOString()
        },
        {
          type: "user",
          timestamp: claudeMtime.toISOString(),
          message: {
            content: [{ type: "text", text: "Review sidebar behavior" }]
          }
        }
      ],
      claudeMtime
    );

    const snapshot = createTestExternalSessionIndexer({
      homeDir,
      now: () => now
    }).listExternalAgentSessions();

    expect(snapshot.sessions.map((session) => session.vendor)).toEqual([
      "codex",
      "claude"
    ]);
    expect(snapshot.sessions[0]).toMatchObject({
      key: "codex:codex-session",
      vendorLabel: "CODEX",
      title: "Tab focus root cause",
      cwd: "/Users/test/codex-project",
      relativeTimeLabel: "1h",
      canResume: true,
      resumeCommandPreview: "codex resume codex-session"
    });
    expect(snapshot.sessions[1]).toMatchObject({
      key: "claude:claude-session",
      vendorLabel: "CLAUDE",
      title: "Review sidebar behavior",
      cwd: "/Users/test/claude-project",
      relativeTimeLabel: "3h",
      resumeCommandPreview: "claude --resume claude-session"
    });
  });

  it("lists Antigravity sessions from the kmux-owned index and resumes with a deterministic conversation id", () => {
    const homeDir = createSandboxHome();
    const now = new Date("2026-06-02T02:30:00.000Z");
    const updatedAt = new Date("2026-06-02T02:05:00.000Z");
    writeJson(
      join(homeDir, ".config", "kmux", "antigravity-sessions.json"),
      {
        version: 1,
        sessions: [
          {
            conversationId: "9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890",
            cwd: "/Users/test/antigravity-project",
            workspacePaths: ["/Users/test/antigravity-project"],
            transcriptPath:
              "/Users/test/antigravity-project/.gemini/jetski/transcript.jsonl",
            artifactDirectoryPath:
              "/Users/test/antigravity-project/.gemini/jetski/artifacts",
            createdAt: "2026-06-02T02:00:00.000Z",
            updatedAt: updatedAt.toISOString()
          }
        ]
      },
      updatedAt
    );

    const indexer = createTestExternalSessionIndexer({
      homeDir,
      env: {},
      now: () => now,
      commandAvailability: (command) => command === "agy"
    });
    const snapshot = indexer.listExternalAgentSessions();

    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]).toMatchObject({
      key: "antigravity:9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890",
      vendor: "antigravity",
      vendorLabel: "AGY",
      title: "Antigravity 9a8b7c6d",
      cwd: "/Users/test/antigravity-project",
      relativeTimeLabel: "25m",
      canResume: true,
      resumeCommandPreview:
        "agy --conversation 9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890"
    });
    expect(
      indexer.resolveExternalAgentSession(
        "antigravity:9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890"
      )
    ).toMatchObject({
      key: "antigravity:9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890",
      vendor: "antigravity",
      cwd: "/Users/test/antigravity-project",
      launch: {
        cwd: "/Users/test/antigravity-project",
        initialInput:
          "agy --conversation 9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890\r"
      }
    });
  });

  it("lists existing Antigravity CLI conversations from local history and database files", () => {
    const homeDir = createSandboxHome();
    const now = new Date("2026-06-02T15:30:00.000Z");
    const firstConversationId = "4814da0a-b93c-41cc-837d-8a747e9d5b2e";
    const latestConversationId = "614e5204-a346-44fa-ba98-2cbf60cf574d";
    const dbOnlyConversationId = "8098bfd3-9fa8-4757-879b-949836ebdcc3";
    const workspace = "/Users/test/antigravity-project";
    const projectId = "5eef7b7d-2cfc-42f2-ab33-3bfe45d26cfe";
    const dbOnlyUpdatedAt = new Date("2026-06-02T12:18:34.000Z");
    const firstUpdatedAt = new Date("2026-06-02T12:55:54.000Z");
    const latestUpdatedAt = new Date("2026-06-02T14:57:53.000Z");
    const unattributedUpdatedAt = new Date("2026-06-02T14:58:53.000Z");

    writeJsonl(
      join(homeDir, ".gemini", "antigravity-cli", "history.jsonl"),
      [
        {
          conversationId: firstConversationId,
          workspace,
          display: "Investigate AGY sessions",
          timestamp: firstUpdatedAt.getTime()
        },
        {
          conversationId: latestConversationId,
          workspace,
          display: "Latest AGY local session",
          timestamp: latestUpdatedAt.getTime()
        },
        {
          workspace,
          display: "Unattributed AGY prompt",
          timestamp: unattributedUpdatedAt.getTime()
        }
      ],
      unattributedUpdatedAt
    );
    writeJson(
      join(
        homeDir,
        ".gemini",
        "antigravity-cli",
        "cache",
        "last_conversations.json"
      ),
      {
        [workspace]: firstConversationId
      },
      latestUpdatedAt
    );
    writeJson(
      join(homeDir, ".gemini", "antigravity-cli", "cache", "projects.json"),
      {
        [workspace]: projectId
      },
      latestUpdatedAt
    );
    writeJson(
      join(
        homeDir,
        ".gemini",
        "antigravity-cli",
        "conversations",
        `${firstConversationId}.db`
      ),
      {},
      firstUpdatedAt
    );
    writeJson(
      join(
        homeDir,
        ".gemini",
        "antigravity-cli",
        "conversations",
        `${latestConversationId}.db`
      ),
      {},
      latestUpdatedAt
    );
    writeJson(
      join(
        homeDir,
        ".gemini",
        "antigravity-cli",
        "conversations",
        `${dbOnlyConversationId}.db`
      ),
      {
        projectId
      },
      dbOnlyUpdatedAt
    );

    const indexer = createTestExternalSessionIndexer({
      homeDir,
      now: () => now,
      commandAvailability: (command) => command === "agy"
    });
    const snapshot = indexer.listExternalAgentSessions();

    expect(snapshot.sessions).toHaveLength(3);
    expect(snapshot.sessions[0]).toMatchObject({
      key: `antigravity:${latestConversationId}`,
      vendor: "antigravity",
      vendorLabel: "AGY",
      title: "Latest AGY local session",
      cwd: workspace,
      canResume: true,
      resumeCommandPreview: `agy --conversation ${latestConversationId}`
    });
    expect(snapshot.sessions[1]).toMatchObject({
      key: `antigravity:${firstConversationId}`,
      title: "Investigate AGY sessions",
      cwd: workspace,
      resumeCommandPreview: `agy --conversation ${firstConversationId}`
    });
    expect(snapshot.sessions[2]).toMatchObject({
      key: `antigravity:${dbOnlyConversationId}`,
      title: "Antigravity 8098bfd3",
      cwd: workspace,
      resumeCommandPreview: `agy --conversation ${dbOnlyConversationId}`
    });
    expect(
      indexer.resolveExternalAgentSession(`antigravity:${latestConversationId}`)
    ).toMatchObject({
      launch: {
        cwd: workspace,
        initialInput: `agy --conversation ${latestConversationId}\r`
      }
    });
  });

  it("uses sanitized prompt titles from Antigravity SQLite conversations", () => {
    const homeDir = createSandboxHome();
    const now = new Date("2026-06-02T15:30:00.000Z");
    const conversationId = "02bf2ec4-d6e4-4bf9-b5a0-66e7cc9176d8";
    const workspace = "/Users/test/antigravity-project";
    const updatedAt = new Date("2026-06-02T14:57:53.000Z");
    const prompt = `Database prompt title\n${"x".repeat(140)}`;
    const normalizedPrompt = prompt.replace(/\s+/gu, " ").trim();
    const expectedTitle = `${normalizedPrompt.slice(0, 93)}...`;

    writeJsonl(
      join(homeDir, ".gemini", "antigravity-cli", "history.jsonl"),
      [
        {
          conversationId,
          workspace,
          display: "History title should be replaced",
          timestamp: updatedAt.getTime()
        }
      ],
      updatedAt
    );
    const wroteDb = writeAntigravitySqliteConversation(
      join(
        homeDir,
        ".gemini",
        "antigravity-cli",
        "conversations",
        `${conversationId}.db`
      ),
      prompt,
      updatedAt
    );
    if (!wroteDb) {
      return;
    }

    const indexer = createTestExternalSessionIndexer({
      homeDir,
      now: () => now,
      commandAvailability: (command) => command === "agy"
    });
    const snapshot = indexer.listExternalAgentSessions();

    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]).toMatchObject({
      key: `antigravity:${conversationId}`,
      title: expectedTitle,
      cwd: workspace,
      resumeCommandPreview: `agy --conversation ${conversationId}`
    });
  });

  it("disables Antigravity resume when agy is not available", () => {
    const homeDir = createSandboxHome();
    const now = new Date("2026-06-02T02:30:00.000Z");
    writeJson(
      join(homeDir, ".config", "kmux", "antigravity-sessions.json"),
      {
        version: 1,
        sessions: [
          {
            conversationId: "9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890",
            cwd: "/Users/test/antigravity-project",
            updatedAt: "2026-06-02T02:05:00.000Z"
          }
        ]
      },
      new Date("2026-06-02T02:05:00.000Z")
    );

    const indexer = createTestExternalSessionIndexer({
      homeDir,
      env: {},
      now: () => now,
      commandAvailability: (command) => command !== "agy"
    });
    const snapshot = indexer.listExternalAgentSessions();

    expect(snapshot.sessions[0]).toMatchObject({
      key: "antigravity:9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890",
      canResume: false,
      resumeCommandPreview:
        "agy --conversation 9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890"
    });
    expect(
      indexer.resolveExternalAgentSession(
        "antigravity:9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890"
      )
    ).toBeNull();
  });

  it("only indexes Claude main session transcripts as top-level sessions", () => {
    const homeDir = createSandboxHome();
    const now = new Date("2026-04-26T12:00:00.000Z");
    const mainMtime = new Date("2026-04-26T09:00:00.000Z");
    const subagentMtime = new Date("2026-04-26T11:00:00.000Z");

    writeJsonl(
      join(
        homeDir,
        ".claude",
        "projects",
        "-Users-test-claude-project",
        "claude-session.jsonl"
      ),
      [
        {
          sessionId: "claude-session",
          cwd: "/Users/test/claude-project",
          timestamp: mainMtime.toISOString()
        },
        {
          type: "user",
          timestamp: mainMtime.toISOString(),
          message: "Review sidebar behavior"
        }
      ],
      mainMtime
    );

    writeJsonl(
      join(
        homeDir,
        ".claude",
        "projects",
        "-Users-test-claude-project",
        "claude-session",
        "subagents",
        "agent-a123.jsonl"
      ),
      [
        {
          sessionId: "claude-session",
          cwd: "/Users/test/claude-project",
          timestamp: subagentMtime.toISOString()
        },
        {
          type: "user",
          timestamp: subagentMtime.toISOString(),
          message: "Subagent transcript should not become a session row"
        }
      ],
      subagentMtime
    );

    const snapshot = createTestExternalSessionIndexer({
      homeDir,
      now: () => now
    }).listExternalAgentSessions();

    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]).toMatchObject({
      key: "claude:claude-session",
      title: "Review sidebar behavior",
      updatedAt: mainMtime.toISOString(),
      relativeTimeLabel: "3h"
    });
  });

  it("prefers Claude custom titles appended near the end of a transcript", () => {
    const homeDir = createSandboxHome();
    const now = new Date("2026-04-26T12:00:00.000Z");
    const mtime = new Date("2026-04-26T11:00:00.000Z");

    writeJsonl(
      join(
        homeDir,
        ".claude",
        "projects",
        "-Users-test-claude-project",
        "claude-custom.jsonl"
      ),
      [
        {
          sessionId: "claude-custom",
          cwd: "/Users/test/claude-project",
          timestamp: mtime.toISOString()
        },
        {
          type: "user",
          timestamp: mtime.toISOString(),
          message: "First prompt fallback"
        },
        {
          type: "assistant",
          timestamp: mtime.toISOString(),
          message: {
            role: "assistant",
            content: "x".repeat(300_000)
          }
        },
        {
          type: "custom-title",
          customTitle: "Hand named Claude session",
          sessionId: "claude-custom"
        }
      ],
      mtime
    );

    const snapshot = createTestExternalSessionIndexer({
      homeDir,
      now: () => now
    }).listExternalAgentSessions();

    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0].title).toBe("Hand named Claude session");
  });

  it("uses the first meaningful Claude user prompt as the title fallback", () => {
    const homeDir = createSandboxHome();
    const now = new Date("2026-04-26T12:00:00.000Z");
    const mtime = new Date("2026-04-26T11:00:00.000Z");

    writeJsonl(
      join(
        homeDir,
        ".claude",
        "projects",
        "-Users-test-claude-project",
        "claude-meaningful.jsonl"
      ),
      [
        {
          sessionId: "claude-meaningful",
          cwd: "/Users/test/claude-project",
          timestamp: mtime.toISOString()
        },
        {
          type: "user",
          isMeta: true,
          timestamp: mtime.toISOString(),
          message: {
            role: "user",
            content:
              "<local-command-caveat>Caveat: ignore local commands</local-command-caveat>"
          }
        },
        {
          type: "user",
          timestamp: mtime.toISOString(),
          message: {
            role: "user",
            content:
              "<command-message>review</command-message>\n<command-name>/review</command-name>"
          }
        },
        {
          type: "user",
          timestamp: mtime.toISOString(),
          message: {
            role: "user",
            content:
              "<local-command-stdout>Set model to claude-opus</local-command-stdout>"
          }
        },
        {
          type: "user",
          timestamp: mtime.toISOString(),
          message: {
            role: "user",
            content: [
              {
                tool_use_id: "toolu_123",
                type: "tool_result",
                content: "Tool output should not become the title"
              }
            ]
          }
        },
        {
          type: "user",
          timestamp: mtime.toISOString(),
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "<ide_opened_file>The user opened README.md</ide_opened_file>"
              },
              {
                type: "text",
                text: "Actual user request\nwith extra details"
              }
            ]
          }
        }
      ],
      mtime
    );

    const snapshot = createTestExternalSessionIndexer({
      homeDir,
      now: () => now
    }).listExternalAgentSessions();

    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0].title).toBe("Actual user request");
  });

  it("falls back to a short Claude session id when no safe title is available", () => {
    const homeDir = createSandboxHome();
    const now = new Date("2026-04-26T12:00:00.000Z");
    const mtime = new Date("2026-04-26T11:00:00.000Z");

    writeJsonl(
      join(
        homeDir,
        ".claude",
        "projects",
        "-Users-test-claude-project",
        "abcdef12-3456-7890-abcd-ef1234567890.jsonl"
      ),
      [
        {
          sessionId: "abcdef12-3456-7890-abcd-ef1234567890",
          cwd: "/Users/test/claude-project",
          timestamp: mtime.toISOString()
        },
        {
          type: "user",
          isMeta: true,
          timestamp: mtime.toISOString(),
          message: {
            role: "user",
            content:
              "<local-command-caveat>Caveat: ignore local commands</local-command-caveat>"
          }
        },
        {
          type: "user",
          timestamp: mtime.toISOString(),
          message: {
            role: "user",
            content:
              "<command-message>review</command-message>\n<command-name>/review</command-name>"
          }
        }
      ],
      mtime
    );

    const snapshot = createTestExternalSessionIndexer({
      homeDir,
      now: () => now
    }).listExternalAgentSessions();

    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0].title).toBe("CLAUDE abcdef12");
  });

  it("uses JSONL file mtime as recent activity when the bounded prefix scan is stale", () => {
    const homeDir = createSandboxHome();
    const now = new Date("2026-04-26T12:00:00.000Z");
    const activeMtime = new Date("2026-04-26T11:00:00.000Z");
    const otherMtime = new Date("2026-04-26T10:00:00.000Z");
    const stalePrefixTimestamp = new Date("2026-04-20T09:00:00.000Z");

    writeJsonl(
      join(
        homeDir,
        ".codex",
        "sessions",
        "2026",
        "04",
        "26",
        "rollout-2026-04-26T11-00-long-active-session.jsonl"
      ),
      [
        {
          type: "session_meta",
          timestamp: stalePrefixTimestamp.toISOString(),
          payload: {
            id: "long-active-session",
            cwd: "/Users/test/codex-project"
          }
        },
        {
          type: "event_msg",
          timestamp: stalePrefixTimestamp.toISOString(),
          payload: {
            type: "user_message",
            message: "Long active session"
          }
        }
      ],
      activeMtime
    );

    writeJsonl(
      join(
        homeDir,
        ".codex",
        "sessions",
        "2026",
        "04",
        "26",
        "rollout-2026-04-26T10-00-other-session.jsonl"
      ),
      [
        {
          type: "session_meta",
          timestamp: otherMtime.toISOString(),
          payload: {
            id: "other-session",
            cwd: "/Users/test/codex-project"
          }
        },
        {
          type: "event_msg",
          timestamp: otherMtime.toISOString(),
          payload: {
            type: "user_message",
            message: "Other session"
          }
        }
      ],
      otherMtime
    );

    const snapshot = createTestExternalSessionIndexer({
      homeDir,
      now: () => now
    }).listExternalAgentSessions();

    expect(snapshot.sessions.map((session) => session.key)).toEqual([
      "codex:long-active-session",
      "codex:other-session"
    ]);
    expect(snapshot.sessions[0]).toMatchObject({
      updatedAt: activeMtime.toISOString(),
      relativeTimeLabel: "1h"
    });
  });

  it("marks sessions unavailable and refuses resume resolution when the vendor command is missing", () => {
    const homeDir = createSandboxHome();
    const now = new Date("2026-04-26T12:00:00.000Z");
    const mtime = new Date("2026-04-26T11:00:00.000Z");

    writeJsonl(
      join(
        homeDir,
        ".codex",
        "sessions",
        "2026",
        "04",
        "26",
        "rollout-2026-04-26T11-00-codex-session.jsonl"
      ),
      [
        {
          type: "session_meta",
          timestamp: mtime.toISOString(),
          payload: {
            id: "codex-session",
            cwd: "/Users/test/codex-project"
          }
        },
        {
          type: "event_msg",
          timestamp: mtime.toISOString(),
          payload: {
            type: "user_message",
            message: "Fix terminal focus"
          }
        }
      ],
      mtime
    );

    const indexer = createTestExternalSessionIndexer({
      homeDir,
      now: () => now,
      commandAvailability: (command) => command !== "codex"
    });
    const snapshot = indexer.listExternalAgentSessions();

    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]).toMatchObject({
      key: "codex:codex-session",
      canResume: false,
      resumeCommandPreview: "codex resume codex-session"
    });
    expect(
      indexer.resolveExternalAgentSession("codex:codex-session")
    ).toBeNull();
  });

  it("resolves a session key to a vendor resume launch config", () => {
    const homeDir = createSandboxHome();
    const mtime = new Date("2026-04-26T11:00:00.000Z");

    writeJsonl(
      join(
        homeDir,
        ".codex",
        "sessions",
        "2026",
        "04",
        "26",
        "rollout-2026-04-26T11-00-codex-session.jsonl"
      ),
      [
        {
          type: "session_meta",
          timestamp: mtime.toISOString(),
          payload: {
            id: "codex-session",
            cwd: "/Users/test/codex-project"
          }
        },
        {
          type: "event_msg",
          timestamp: mtime.toISOString(),
          payload: {
            type: "user_message",
            message: "Fix terminal focus"
          }
        }
      ],
      mtime
    );

    const resolved = createTestExternalSessionIndexer({
      homeDir,
      now: () => new Date("2026-04-26T12:00:00.000Z")
    }).resolveExternalAgentSession("codex:codex-session");

    expect(resolved).toMatchObject({
      key: "codex:codex-session",
      vendor: "codex",
      agentSessionRef: {
        vendor: "codex",
        externalKey: "codex:codex-session",
        sessionId: "codex-session"
      },
      title: "Fix terminal focus",
      cwd: "/Users/test/codex-project",
      launch: {
        cwd: "/Users/test/codex-project",
        initialInput: "codex resume codex-session\r",
        title: "Fix terminal focus"
      }
    });
  });
});
