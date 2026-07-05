import { describe, expect, it } from "vitest";

import { assessContentConsistency } from "./surfaceCaptureConsistency";

const ESC = "\u001b";

function vtFrom(lines: string[]): string {
  return lines.join("\r\n");
}

describe("surface capture content consistency", () => {
  it("reports consistent when recent scrollback lines appear in the renderer", () => {
    const scrollback = Array.from(
      { length: 10 },
      (_, index) => `transcript line ${index} with enough characters`
    );
    const liveScreen = ["spinner frame A", "input box"];
    const result = assessContentConsistency({
      snapshotVt: vtFrom([...scrollback, ...liveScreen]),
      snapshotScreenRows: liveScreen.length,
      rendererRecentText: [
        ...scrollback,
        "spinner frame B (live region legitimately differs)"
      ].join("\n")
    });

    expect(result.verdict).toBe("consistent");
    expect(result.matchedLines).toBe(result.sampledLines);
  });

  it("reports behind when the renderer lacks the snapshot's recent scrollback", () => {
    const snapshotScrollback = Array.from(
      { length: 10 },
      (_, index) => `new content block ${index} streamed after the backlog`
    );
    const result = assessContentConsistency({
      snapshotVt: vtFrom([...snapshotScrollback, "live row"]),
      snapshotScreenRows: 1,
      rendererRecentText: Array.from(
        { length: 10 },
        (_, index) => `stale content from a minute ago ${index}`
      ).join("\n")
    });

    expect(result.verdict).toBe("behind");
    expect(result.matchedLines).toBe(0);
  });

  it("ignores spacing differences from cursor-positioned rendering and re-wraps", () => {
    const result = assessContentConsistency({
      snapshotVt: vtFrom([
        "사실관계로는반박할곳이없습니다전부정확합니다",
        "그래서공격지점은세곳으로옮겨갑니다닫을수있는",
        "결정을열어둔것수정안에스며드는골드플레이팅",
        "그리고이루프자체마지막줄입니다충분히길게",
        "live row"
      ]),
      snapshotScreenRows: 1,
      rendererRecentText: [
        "사실관계로는 반박할 곳이 없습니다 전부 정확합니다 그래서",
        "공격 지점은 세 곳으로 옮겨갑니다 닫을 수 있는 결정을",
        "열어둔 것 수정안에 스며드는 골드플레이팅 그리고 이",
        "루프 자체 마지막 줄입니다 충분히 길게"
      ].join("\n")
    });

    expect(result.verdict).toBe("consistent");
  });

  it("strips ANSI sequences from the snapshot before sampling", () => {
    const styled = `${ESC}[1m${ESC}[38;2;255;0;0mimportant styled content line${ESC}[0m`;
    const result = assessContentConsistency({
      snapshotVt: vtFrom([
        styled,
        "second stable line with characters",
        "third stable line with characters",
        "live row"
      ]),
      snapshotScreenRows: 1,
      rendererRecentText: [
        "important styled content line",
        "second stable line with characters",
        "third stable line with characters"
      ].join("\n")
    });

    expect(result.verdict).toBe("consistent");
  });

  it("returns indeterminate when there is too little stable content to sample", () => {
    const result = assessContentConsistency({
      snapshotVt: vtFrom(["hi", "live row"]),
      snapshotScreenRows: 1,
      rendererRecentText: "hi"
    });

    expect(result.verdict).toBe("indeterminate");
  });

  it("returns indeterminate when a layer is missing", () => {
    expect(
      assessContentConsistency({
        snapshotVt: null,
        snapshotScreenRows: 24,
        rendererRecentText: "content"
      }).verdict
    ).toBe("indeterminate");
    expect(
      assessContentConsistency({
        snapshotVt: "content",
        snapshotScreenRows: 24,
        rendererRecentText: undefined
      }).verdict
    ).toBe("indeterminate");
  });
});
