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

  it("parses Linux ps -axo output for nested CLI descendants", async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout: [
        " 400 1 /usr/bin/bash",
        " 401 400 /usr/bin/node /usr/local/bin/codex -s read-only",
        " 402 400 /usr/bin/zsh -lc gemini",
        " 403 402 /home/test/.local/bin/gemini-cli --model pro"
      ].join("\n"),
      stderr: ""
    });

    const matches = await resolveAiCliProcessMatches([
      { parentPid: 400, vendor: "codex" },
      { parentPid: 402, vendor: "gemini" }
    ]);

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      "ps",
      ["-axo", "pid=,ppid=,command="],
      expect.objectContaining({ maxBuffer: 10 * 1024 * 1024 })
    );
    expect(matches.get(400)).toMatchObject({
      parentPid: 400,
      pid: 401,
      vendor: "codex"
    });
    expect(matches.get(402)).toMatchObject({
      parentPid: 402,
      pid: 403,
      vendor: "gemini"
    });
  });

  it("detects CLIs launched through env, node_modules package paths, and script files", async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout: [
        " 500 1 /usr/bin/zsh",
        " 501 500 /usr/bin/env KMUX=1 node /home/test/.npm/_npx/abc/node_modules/@openai/codex/bin/codex.js --model gpt-5",
        " 510 1 /usr/bin/zsh",
        " 511 510 /usr/bin/node /home/test/.local/share/pnpm/global/5/node_modules/@anthropic-ai/claude-code/cli.js --continue",
        " 520 1 /usr/bin/zsh",
        " 521 520 pnpm dlx @google/gemini-cli --model pro"
      ].join("\n"),
      stderr: ""
    });

    const matches = await resolveAiCliProcessMatches([
      { parentPid: 500, vendor: "codex" },
      { parentPid: 510, vendor: "claude" },
      { parentPid: 520, vendor: "gemini" }
    ]);

    expect(matches.get(500)).toMatchObject({
      parentPid: 500,
      pid: 501,
      vendor: "codex"
    });
    expect(matches.get(510)).toMatchObject({
      parentPid: 510,
      pid: 511,
      vendor: "claude"
    });
    expect(matches.get(520)).toMatchObject({
      parentPid: 520,
      pid: 521,
      vendor: "gemini"
    });
  });
});
