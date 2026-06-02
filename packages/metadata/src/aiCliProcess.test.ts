import { describe, expect, it, vi } from "vitest";

const execFileAsyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: vi.fn()
}));

vi.mock("node:util", () => ({
  promisify: () => execFileAsyncMock
}));

import { resolveAiCliProcessMatches } from "./aiCliProcess";

describe("resolveAiCliProcessMatches", () => {
  it("detects Antigravity CLI aliases under the probed shell process", async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout: [
        " 100 1 /bin/zsh",
        " 101 100 /usr/local/bin/agy --conversation 9a8b7c6d",
        " 200 1 /bin/zsh",
        " 201 200 antigravity-cli --continue",
        " 300 1 /bin/zsh",
        " 301 300 antigravity"
      ].join("\n"),
      stderr: ""
    });

    const matches = await resolveAiCliProcessMatches([
      { parentPid: 100, vendor: "antigravity" },
      { parentPid: 200, vendor: "antigravity" },
      { parentPid: 300, vendor: "antigravity" }
    ]);

    expect(matches.get(100)).toMatchObject({
      parentPid: 100,
      pid: 101,
      vendor: "antigravity",
      commandLine: "/usr/local/bin/agy --conversation 9a8b7c6d"
    });
    expect(matches.get(200)).toMatchObject({
      parentPid: 200,
      pid: 201,
      vendor: "antigravity",
      commandLine: "antigravity-cli --continue"
    });
    expect(matches.get(300)).toMatchObject({
      parentPid: 300,
      pid: 301,
      vendor: "antigravity",
      commandLine: "antigravity"
    });
  });
});
