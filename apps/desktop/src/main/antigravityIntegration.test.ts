import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  antigravitySessionIndexPath,
  recordAntigravitySessionFromHook
} from "@kmux/agents/antigravity-session-index";

const sandboxDirs: string[] = [];

afterEach(() => {
  for (const sandboxDir of sandboxDirs.splice(0)) {
    rmSync(sandboxDir, { force: true, recursive: true });
  }
});

describe("antigravitySessionIndexPath", () => {
  it("treats a blank KMUX_CONFIG_DIR as absent", () => {
    expect(
      antigravitySessionIndexPath("/home/test", {
        KMUX_CONFIG_DIR: "   "
      })
    ).toBe("/home/test/.config/kmux/antigravity-sessions.json");
  });

  it("trims a configured KMUX_CONFIG_DIR before deriving the index path", () => {
    expect(
      antigravitySessionIndexPath("/home/test", {
        KMUX_CONFIG_DIR: " /profiles/kmux/config "
      })
    ).toBe("/profiles/kmux/config/antigravity-sessions.json");
  });

  it("ignores relative config and home paths instead of deriving cwd-relative indexes", () => {
    expect(
      antigravitySessionIndexPath("relative-home", {
        KMUX_CONFIG_DIR: " profiles/kmux/config "
      })
    ).toBe(join(homedir(), ".config", "kmux", "antigravity-sessions.json"));
  });
});

describe("recordAntigravitySessionFromHook", () => {
  it("records only Antigravity hook metadata in the kmux session index", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "kmux-antigravity-index-"));
    sandboxDirs.push(homeDir);
    const indexPath = join(
      homeDir,
      ".config",
      "kmux",
      "antigravity-sessions.json"
    );

    recordAntigravitySessionFromHook({
      indexPath,
      agent: "antigravity-cli",
      payload: {
        conversationId: "9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890",
        workspacePaths: ["/Users/test/project"],
        transcriptPath: "/Users/test/project/.gemini/jetski/transcript.jsonl",
        artifactDirectoryPath: "/Users/test/project/.gemini/jetski/artifacts",
        ignoredPrompt: "Do not write this"
      },
      now: () => new Date("2026-06-02T02:00:00.000Z")
    });

    recordAntigravitySessionFromHook({
      indexPath,
      agent: "agy",
      payload: {
        conversationId: "9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890"
      },
      now: () => new Date("2026-06-02T02:05:00.000Z")
    });

    const index = JSON.parse(readFileSync(indexPath, "utf8")) as {
      sessions: Array<Record<string, unknown>>;
    };

    expect(index.sessions).toEqual([
      {
        conversationId: "9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890",
        cwd: "/Users/test/project",
        workspacePaths: ["/Users/test/project"],
        transcriptPath: "/Users/test/project/.gemini/jetski/transcript.jsonl",
        artifactDirectoryPath: "/Users/test/project/.gemini/jetski/artifacts",
        createdAt: "2026-06-02T02:00:00.000Z",
        updatedAt: "2026-06-02T02:05:00.000Z"
      }
    ]);
    expect(JSON.stringify(index)).not.toContain("Do not write this");
  });
});
