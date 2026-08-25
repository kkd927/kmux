import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { classifyAntigravityMetadataPath } from "./antigravity/inventory";
import { classifyClaudeMetadataPath } from "./claude/inventory";
import { classifyCodexMetadataPath } from "./codex/inventory";

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
});
