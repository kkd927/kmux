import { describe, expect, it } from "vitest";

import {
  IncrementalCoreHistoryJsonlParser,
  parseAntigravityConversationRows,
  parseCoreHistorySource
} from "./history";

describe("metadata history core", () => {
  it("uses only step zero and the actual latest Antigravity prompt", () => {
    const record = parseAntigravityConversationRows({
      logicalName: "/conversations/conversation-1.db",
      mtimeMs: 123,
      rows: [
        { index: 0, stepType: 14, payloadBase64: promptPayload("first") },
        { index: 1, stepType: 14, payloadBase64: promptPayload("older") },
        { index: 2, stepType: 14, payloadBase64: "" }
      ]
    });

    expect(record).toMatchObject({
      sessionId: "conversation-1",
      title: "first"
    });
    expect(record).not.toHaveProperty("recentConversation");
  });

  it("rejects an Antigravity transcript linked to another claimed session", () => {
    expect(
      parseCoreHistorySource({
        vendor: "antigravity",
        role: "antigravity-transcript",
        logicalName:
          "/brain/conversation-other/.system_generated/logs/transcript.jsonl",
        mtimeMs: 123,
        claim: { sessionId: "conversation-owned" },
        records: [{ source: "USER", content: "do not attribute this" }]
      })
    ).toEqual([]);
  });

  it("retains the first and latest records within a fixed bound", () => {
    const parser = new IncrementalCoreHistoryJsonlParser(2);
    parser.append(
      Array.from({ length: 6 }, (_, index) => JSON.stringify({ index })).join(
        "\n"
      ),
      { eof: true }
    );

    expect(parser.records()).toEqual([
      { index: 0 },
      { index: 1 },
      { index: 4 },
      { index: 5 }
    ]);
    expect(parser.truncated).toBe(true);

    const cloned = parser.clone();
    cloned.append(`${JSON.stringify({ index: 6 })}\n`);
    expect(cloned.records()).toEqual([
      { index: 0 },
      { index: 1 },
      { index: 5 },
      { index: 6 }
    ]);
    expect(parser.records()).toEqual([
      { index: 0 },
      { index: 1 },
      { index: 4 },
      { index: 5 }
    ]);
  });
});

function promptPayload(prompt: string): string {
  const text = new TextEncoder().encode(prompt);
  const bytes = Uint8Array.from([0x12, ...encodeVarint(text.length), ...text]);
  return btoa(String.fromCharCode(...bytes));
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
