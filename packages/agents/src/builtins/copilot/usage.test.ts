import { readFileSync } from "node:fs";

import { createCopilotUsageSourceProjection } from "./usage";

const sourcePath =
  "/session-state/11111111-1111-4111-8111-111111111111/events.jsonl";
const fixture = readFileSync(
  new URL("./fixtures/session.jsonl", import.meta.url),
  "utf8"
);

describe("Copilot usage", () => {
  it("emits per-model deltas from cumulative shutdown checkpoints", () => {
    const parser = createCopilotUsageSourceProjection()
      .createSession()
      .createParser({
        role: "copilot-session",
        format: "jsonl",
        sourcePath,
        maximumPendingBytes: 256 * 1024
      });
    const split = fixture.indexOf('{"type":"session.resume"');
    const first = parser.append(fixture.slice(0, split), { fromMs: 0 });
    const second = parser.append(
      fixture.slice(split),
      { fromMs: 0 },
      { eof: true }
    );

    expect(first).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          vendor: "copilot",
          model: "gpt-5.4",
          inputTokens: 75,
          outputTokens: 20,
          thinkingTokens: 10,
          cacheReadTokens: 20,
          cacheWriteTokens: 5,
          totalTokens: 130,
          estimatedCostUsd: 0,
          costSource: "unavailable"
        }),
        expect.objectContaining({
          model: "claude-sonnet-4.6",
          inputTokens: 40,
          outputTokens: 12,
          cacheReadTokens: 10,
          totalTokens: 62
        })
      ])
    );
    expect(second).toEqual([
      expect.objectContaining({
        model: "gpt-5.4",
        inputTokens: 50,
        outputTokens: 15,
        thinkingTokens: 5,
        cacheReadTokens: 10,
        cacheWriteTokens: 0,
        totalTokens: 80,
        cwd: "/workspace/kmux-resumed"
      })
    ]);
  });

  it("isolates malformed and truncated JSONL records", () => {
    const parser = createCopilotUsageSourceProjection()
      .createSession()
      .createParser({
        role: "copilot-session",
        format: "jsonl",
        sourcePath,
        maximumPendingBytes: 128
      });
    expect(
      parser.append('{"type":\nnot-json\n', { fromMs: 0 }, { eof: true })
    ).toEqual([]);
  });
});
