import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createExternalSessionIndexer } from "./externalSessions";

const sandboxDirs: string[] = [];

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

afterEach(() => {
  for (const sandboxDir of sandboxDirs.splice(0)) {
    rmSync(sandboxDir, { force: true, recursive: true });
  }
});

describe("external session indexer", () => {
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

      writeJson(
        join(
          homeDir,
          ".gemini",
          "tmp",
          "gemini-project",
          "chats",
          `session-2026-04-26T11-${padded}-gemini-session.json`
        ),
        {
          kind: "chat",
          sessionId: `gemini-session-${padded}`,
          summary: `Gemini session ${padded}`,
          startTime: mtime.toISOString(),
          lastUpdated: mtime.toISOString(),
          messages: [
            {
              type: "user",
              timestamp: mtime.toISOString(),
              content: [{ text: `Gemini session ${padded}` }]
            }
          ]
        },
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

    const snapshot = createExternalSessionIndexer({
      homeDir,
      now: () => now
    }).listExternalAgentSessions();

    expect(
      snapshot.sessions.filter((session) => session.vendor === "codex")
    ).toHaveLength(100);
    expect(
      snapshot.sessions.filter((session) => session.vendor === "gemini")
    ).toHaveLength(100);
    expect(
      snapshot.sessions.filter((session) => session.vendor === "claude")
    ).toHaveLength(100);
    expect(snapshot.sessions).toHaveLength(300);
    expect(snapshot.sessions.map((session) => session.key)).not.toContain(
      "codex:codex-session-101"
    );
    expect(snapshot.sessions.map((session) => session.key)).not.toContain(
      "gemini:gemini-session-101"
    );
    expect(snapshot.sessions.map((session) => session.key)).not.toContain(
      "claude:claude-session-101"
    );
  });

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

    writeJson(
      join(
        homeDir,
        ".gemini",
        "tmp",
        "gemini-project",
        "chats",
        "session-2026-03-27T12-00-gemini-recent.json"
      ),
      {
        kind: "chat",
        sessionId: "gemini-recent",
        summary: "Recent Gemini session",
        startTime: cutoffMtime.toISOString(),
        lastUpdated: cutoffMtime.toISOString(),
        messages: [
          {
            type: "user",
            timestamp: cutoffMtime.toISOString(),
            content: [{ text: "Recent Gemini session" }]
          }
        ]
      },
      cutoffMtime
    );
    writeJson(
      join(
        homeDir,
        ".gemini",
        "tmp",
        "gemini-project",
        "chats",
        "session-2026-03-26T11-59-gemini-old.json"
      ),
      {
        kind: "chat",
        sessionId: "gemini-old",
        summary: "Old Gemini session",
        startTime: oldMtime.toISOString(),
        lastUpdated: oldMtime.toISOString(),
        messages: [
          {
            type: "user",
            timestamp: oldMtime.toISOString(),
            content: [{ text: "Old Gemini session" }]
          }
        ]
      },
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

    const indexer = createExternalSessionIndexer({
      homeDir,
      now: () => now
    });
    const snapshot = indexer.listExternalAgentSessions();

    expect(snapshot.sessions.map((session) => session.key).sort()).toEqual([
      "claude:claude-recent",
      "codex:codex-recent",
      "gemini:gemini-recent"
    ]);
    expect(indexer.resolveExternalAgentSession("codex:codex-old")).toBeNull();
    expect(indexer.resolveExternalAgentSession("gemini:gemini-old")).toBeNull();
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
                text:
                  "<environment_context>\n  <cwd>/Users/test/codex-project</cwd>\n</environment_context>"
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

    const snapshot = createExternalSessionIndexer({
      homeDir,
      now: () => now
    }).listExternalAgentSessions();

    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0].title).toBe("Actual Codex request");
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

    const snapshot = createExternalSessionIndexer({
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

    const snapshot = createExternalSessionIndexer({
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

  it("lists Codex, Gemini, and Claude sessions newest first with sanitized titles", () => {
    const homeDir = createSandboxHome();
    const now = new Date("2026-04-26T12:00:00.000Z");
    const codexMtime = new Date("2026-04-26T11:00:00.000Z");
    const geminiMtime = new Date("2026-04-26T10:00:00.000Z");
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

    mkdirSync(join(homeDir, ".gemini", "tmp", "gemini-project"), {
      recursive: true
    });
    writeFileSync(
      join(homeDir, ".gemini", "tmp", "gemini-project", ".project_root"),
      "/Users/test/gemini-project",
      "utf8"
    );
    writeJson(
      join(
        homeDir,
        ".gemini",
        "tmp",
        "gemini-project",
        "chats",
        "session-2026-04-26T10-00-gemini-session.json"
      ),
      {
        kind: "chat",
        sessionId: "gemini-session",
        summary: "Package v0.2.4 update",
        startTime: "2026-04-26T09:30:00.000Z",
        lastUpdated: geminiMtime.toISOString(),
        messages: [
          {
            type: "user",
            timestamp: "2026-04-26T09:30:00.000Z",
            content: [{ text: "This should lose to summary" }]
          }
        ]
      },
      geminiMtime
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

    const snapshot = createExternalSessionIndexer({
      homeDir,
      now: () => now
    }).listExternalAgentSessions();

    expect(snapshot.sessions.map((session) => session.vendor)).toEqual([
      "codex",
      "gemini",
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
      key: "gemini:gemini-session",
      vendorLabel: "GEMINI",
      title: "Package v0.2.4 update",
      cwd: "/Users/test/gemini-project",
      relativeTimeLabel: "2h",
      resumeCommandPreview: "gemini --resume gemini-session"
    });
    expect(snapshot.sessions[2]).toMatchObject({
      key: "claude:claude-session",
      vendorLabel: "CLAUDE",
      title: "Review sidebar behavior",
      cwd: "/Users/test/claude-project",
      relativeTimeLabel: "3h",
      resumeCommandPreview: "claude --resume claude-session"
    });
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

    const snapshot = createExternalSessionIndexer({
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

    const snapshot = createExternalSessionIndexer({
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

    const snapshot = createExternalSessionIndexer({
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

    const snapshot = createExternalSessionIndexer({
      homeDir,
      now: () => now
    }).listExternalAgentSessions();

    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0].title).toBe("CLAUDE abcdef12");
  });

  it("falls back to a vendor and short id title when no safe title is available", () => {
    const homeDir = createSandboxHome();
    const now = new Date("2026-04-26T12:00:00.000Z");
    const mtime = new Date("2026-04-26T11:59:00.000Z");

    writeJsonl(
      join(
        homeDir,
        ".gemini",
        "tmp",
        "empty-project",
        "chats",
        "session-2026-04-26T11-59-abcdef12.jsonl"
      ),
      [
        {
          kind: "chat",
          sessionId: "abcdef12-3456-7890-abcd-ef1234567890",
          startTime: mtime.toISOString(),
          lastUpdated: mtime.toISOString()
        },
        {
          type: "gemini",
          timestamp: mtime.toISOString(),
          content: "Assistant-only restored content"
        }
      ],
      mtime
    );

    const snapshot = createExternalSessionIndexer({
      homeDir,
      now: () => now
    }).listExternalAgentSessions();

    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0].title).toBe("GEMINI abcdef12");
  });

  it("omits Gemini JSONL sessions that only contain metadata updates", () => {
    const homeDir = createSandboxHome();
    const now = new Date("2026-04-26T12:00:00.000Z");
    const mtime = new Date("2026-04-26T11:59:00.000Z");

    writeJsonl(
      join(
        homeDir,
        ".gemini",
        "tmp",
        "fresh-project",
        "chats",
        "session-2026-04-26T11-59-fresh123.jsonl"
      ),
      [
        {
          kind: "main",
          sessionId: "fresh1234-3456-7890-abcd-ef1234567890",
          startTime: mtime.toISOString(),
          lastUpdated: mtime.toISOString()
        },
        {
          $set: {
            sessionId: "fresh1234-3456-7890-abcd-ef1234567890"
          }
        }
      ],
      mtime
    );

    const snapshot = createExternalSessionIndexer({
      homeDir,
      now: () => now
    }).listExternalAgentSessions();

    expect(snapshot.sessions).toHaveLength(0);
  });

  it("skips unreadable Gemini JSON session files", () => {
    const homeDir = createSandboxHome();
    const now = new Date("2026-04-26T12:00:00.000Z");
    const codexMtime = new Date("2026-04-26T11:00:00.000Z");
    const geminiMtime = new Date("2026-04-26T10:00:00.000Z");

    writeJson(
      join(
        homeDir,
        ".gemini",
        "tmp",
        "gemini-project",
        "chats",
        "session-2026-04-26T10-00-unreadable.json"
      ),
      {
        kind: "chat",
        sessionId: "unreadable-gemini-session",
        summary: "Unreadable Gemini session",
        startTime: geminiMtime.toISOString(),
        lastUpdated: geminiMtime.toISOString(),
        messages: [
          {
            type: "user",
            timestamp: geminiMtime.toISOString(),
            content: [{ text: "Should be skipped" }]
          }
        ]
      },
      geminiMtime
    );
    chmodSync(
      join(
        homeDir,
        ".gemini",
        "tmp",
        "gemini-project",
        "chats",
        "session-2026-04-26T10-00-unreadable.json"
      ),
      0
    );

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
            cwd: "/Users/test/codex-project"
          }
        },
        {
          type: "event_msg",
          timestamp: codexMtime.toISOString(),
          payload: {
            type: "user_message",
            message: "Readable Codex session"
          }
        }
      ],
      codexMtime
    );

    const snapshot = createExternalSessionIndexer({
      homeDir,
      now: () => now
    }).listExternalAgentSessions();

    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]).toMatchObject({
      key: "codex:codex-session",
      title: "Readable Codex session"
    });
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

    const snapshot = createExternalSessionIndexer({
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

    const indexer = createExternalSessionIndexer({
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
    expect(indexer.resolveExternalAgentSession("codex:codex-session")).toBeNull();
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

    const resolved = createExternalSessionIndexer({
      homeDir,
      now: () => new Date("2026-04-26T12:00:00.000Z")
    }).resolveExternalAgentSession("codex:codex-session");

    expect(resolved).toMatchObject({
      key: "codex:codex-session",
      vendor: "codex",
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
