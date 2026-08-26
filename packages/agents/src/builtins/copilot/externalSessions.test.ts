import { readFileSync } from "node:fs";

import { createCopilotSessionSourceProjection } from "./externalSessions";
import { classifyCopilotMetadataPath } from "./inventory";

const fixture = readFileSync(
  new URL("./fixtures/session.jsonl", import.meta.url),
  "utf8"
)
  .split("\n")
  .flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line) as unknown] : [];
    } catch {
      return [];
    }
  });

describe("Copilot external sessions", () => {
  it("projects resumed JSONL history with cwd and message metadata", async () => {
    const records = await createCopilotSessionSourceProjection().projectSource({
      role: "copilot-session",
      format: "jsonl",
      logicalName:
        "/session-state/11111111-1111-4111-8111-111111111111/events.jsonl",
      mtimeMs: Date.parse("2026-08-25T00:01:04.000Z"),
      records: fixture
    });

    expect(records).toEqual([
      expect.objectContaining({
        sessionId: "11111111-1111-4111-8111-111111111111",
        title: "Completed synthetic task",
        recentConversation: "Follow-up complete",
        model: "gpt-5.4",
        cwd: "/workspace/kmux-resumed",
        createdAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-25T00:01:04.000Z"
      })
    ]);
  });

  it("uses root model changes without leaking subagent messages", async () => {
    const records = await createCopilotSessionSourceProjection().projectSource({
      role: "copilot-session",
      format: "jsonl",
      logicalName: "/session-state/session-1/events.jsonl",
      mtimeMs: Date.parse("2026-08-25T00:00:04.000Z"),
      records: [
        {
          type: "session.start",
          timestamp: "2026-08-25T00:00:00.000Z",
          data: { sessionId: "session-1", selectedModel: "gpt-old" }
        },
        {
          type: "user.message",
          timestamp: "2026-08-25T00:00:01.000Z",
          data: { content: "Root prompt" }
        },
        {
          type: "session.model_change",
          timestamp: "2026-08-25T00:00:02.000Z",
          data: { previousModel: "gpt-old", newModel: "gpt-new" }
        },
        {
          type: "assistant.message",
          agentId: "subagent-1",
          timestamp: "2026-08-25T00:00:03.000Z",
          data: {
            messageId: "subagent-message",
            content: "Subagent response",
            model: "subagent-model"
          }
        }
      ]
    });

    expect(records).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        model: "gpt-new",
        recentConversation: "Root prompt"
      })
    ]);
  });

  it("matches only direct session event logs below the declared root", () => {
    const roots = ["/session-state"];
    expect(
      classifyCopilotMetadataPath(
        roots,
        "/session-state/session-1/events.jsonl"
      )
    ).toBe("copilot-session");
    expect(
      classifyCopilotMetadataPath(
        roots,
        "/session-state/session-1/nested/events.jsonl"
      )
    ).toBeNull();
    expect(
      classifyCopilotMetadataPath(roots, "/other/session-1/events.jsonl")
    ).toBeNull();
    expect(
      classifyCopilotMetadataPath(
        roots,
        "/session-state/session-1/EVENTS.JSONL"
      )
    ).toBeNull();
  });

  it("rejects a source whose claim disagrees with the persisted id", async () => {
    expect(
      await createCopilotSessionSourceProjection().projectSource({
        role: "copilot-session",
        format: "jsonl",
        logicalName: "/session-state/other/events.jsonl",
        mtimeMs: 1,
        records: fixture,
        claim: { sessionId: "different" }
      })
    ).toEqual([]);
  });
});
