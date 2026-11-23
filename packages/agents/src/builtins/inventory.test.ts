import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { collectSessionInventory } from "@kmux/metadata";
import {
  classifyAntigravityMetadataPath,
  shouldDescendAntigravityMetadataDirectory
} from "./antigravity/inventory";
import { classifyClaudeMetadataPath } from "./claude/inventory";
import { classifyCodexMetadataPath } from "./codex/inventory";

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("built-in metadata source classification", () => {
  it("keeps each built-in's source policy in its owning module", () => {
    expect(classifyCodexMetadataPath("/tmp/codex/rollout.jsonl")).toBe(
      "codex-session"
    );
    expect(classifyClaudeMetadataPath("/tmp/claude/session.jsonl")).toBe(
      "claude-session"
    );
    expect(
      classifyClaudeMetadataPath("/tmp/claude/subagents/worker.jsonl")
    ).toBe("claude-subagent");

    const antigravityRoot = resolve("/tmp/antigravity");
    expect(
      classifyAntigravityMetadataPath(
        [antigravityRoot],
        resolve(
          antigravityRoot,
          "brain/conversation/.system_generated/logs/transcript.jsonl"
        )
      )
    ).toBe("antigravity-transcript");
  });

  it("prunes Antigravity step/chunk/scratch subtrees before hitting maxDirectories", () => {
    const root = realpathSync.native(
      mkdtempSync(join(tmpdir(), "kmux-agy-prune-"))
    );
    sandboxes.push(root);
    const convId = "11111111-1111-4111-8111-111111111111";

    mkdirSync(join(root, "cache"), { recursive: true });
    mkdirSync(join(root, "conversations"), { recursive: true });
    mkdirSync(join(root, "presence"), { recursive: true });
    mkdirSync(
      join(
        root,
        "brain",
        convId,
        ".system_generated",
        "logs",
        "chunks",
        "transcript"
      ),
      {
        recursive: true
      }
    );
    mkdirSync(join(root, "brain", convId, "scratch"), { recursive: true });
    for (let step = 0; step < 12; step += 1) {
      const stepDir = join(
        root,
        "brain",
        convId,
        ".system_generated",
        "steps",
        String(step)
      );
      mkdirSync(stepDir, { recursive: true });
      writeFileSync(join(stepDir, "output.txt"), "step output", "utf8");
    }
    writeFileSync(join(root, "history.jsonl"), "{}\n", "utf8");
    writeFileSync(join(root, "cache", "projects.json"), "{}\n", "utf8");
    writeFileSync(join(root, "conversations", `${convId}.db`), "db", "utf8");
    writeFileSync(join(root, "presence", "lock"), "p", "utf8");
    writeFileSync(
      join(
        root,
        "brain",
        convId,
        ".system_generated",
        "logs",
        "transcript.jsonl"
      ),
      "{}\n",
      "utf8"
    );
    writeFileSync(
      join(
        root,
        "brain",
        convId,
        ".system_generated",
        "logs",
        "chunks",
        "transcript",
        "0001.jsonl"
      ),
      "{}\n",
      "utf8"
    );

    const inventory = collectSessionInventory(
      [root],
      { maxDirectories: 8 },
      { shouldDescendDirectory: shouldDescendAntigravityMetadataDirectory }
    );

    expect(inventory.truncated).toBe(false);
    expect(inventory.diagnostics).toEqual([]);
    expect(
      inventory.candidates
        .map((candidate) => relative(root, candidate.path).replace(/\\/gu, "/"))
        .sort()
    ).toEqual([
      `brain/${convId}/.system_generated/logs/transcript.jsonl`,
      "cache/projects.json",
      `conversations/${convId}.db`,
      "history.jsonl"
    ]);
  });
});
