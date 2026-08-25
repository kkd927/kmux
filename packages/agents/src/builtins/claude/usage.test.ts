import { dedupeCoreUsageSamples } from "@kmux/metadata";
import { describe, expect, it } from "vitest";

import { createClaudeUsageSourceProjection } from "./usage";

describe("Claude usage projection", () => {
  it("prefers the parent transcript for an equal request duplicated by a subagent", () => {
    const session = createClaudeUsageSourceProjection().createSession();
    const parentPath = "/tmp/project/session.jsonl";
    const record = `${JSON.stringify({
      type: "assistant",
      sessionId: "session-1",
      requestId: "request-1",
      timestamp: "2026-08-22T00:00:00.000Z",
      message: {
        id: "message-1",
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 10, output_tokens: 5 }
      }
    })}\n`;
    const range = { fromMs: 0 };
    const parse = (
      sourcePath: string,
      role: "claude-subagent" | "claude-session"
    ) =>
      session
        .createParser({
          role,
          format: "jsonl",
          sourcePath,
          maximumPendingBytes: 256 * 1024
        })
        .append(record, range, { eof: true });

    const samples = dedupeCoreUsageSamples([
      ...parse(
        "/tmp/project/session/subagents/agent-a.jsonl",
        "claude-subagent"
      ),
      ...parse(parentPath, "claude-session")
    ]);

    expect(samples).toEqual([
      expect.objectContaining({
        sourcePath: parentPath,
        totalTokens: 15
      })
    ]);
  });
});
