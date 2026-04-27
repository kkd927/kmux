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
        shell: "codex",
        args: ["resume", "codex-session"],
        title: "Fix terminal focus"
      }
    });
  });
});
