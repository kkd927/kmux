import { describe, expect, it } from "vitest";

import { IncrementalCoreHistoryJsonlParser } from "./history";

describe("metadata history core", () => {
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
