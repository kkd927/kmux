import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveBuiltinAgentSkillPlacement } from "@kmux/agents/builtin-runtime";
import { KMUX_ORCHESTRATION_SKILL_DOCUMENT } from "@kmux/orchestration";

import { OrchestrationSkillManager } from "./orchestrationSkill";

describe("OrchestrationSkillManager", () => {
  it("keeps inspection read-only and installs only explicitly selected supported Agents", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "kmux-skill-manager-"));
    try {
      const manager = new OrchestrationSkillManager({
        homeDir,
        env: {},
        resolveSkillPlacement: resolveBuiltinAgentSkillPlacement
      });
      expect(
        await manager.inspect([
          "codex",
          "claude",
          "copilot",
          "antigravity",
          "future-agent"
        ])
      ).toEqual([
        expect.objectContaining({ agentId: "codex", state: "not-installed" }),
        expect.objectContaining({ agentId: "claude", state: "not-installed" }),
        expect.objectContaining({
          agentId: "copilot",
          state: "not-installed"
        }),
        expect.objectContaining({
          agentId: "antigravity",
          state: "not-installed"
        }),
        expect.objectContaining({
          agentId: "future-agent",
          state: "unsupported"
        })
      ]);
      expect(existsSync(join(homeDir, ".codex"))).toBe(false);

      const installed = await manager.installExplicit([
        "codex",
        "copilot",
        "antigravity"
      ]);
      expect(installed).toEqual([
        expect.objectContaining({ agentId: "codex", state: "installed" }),
        expect.objectContaining({ agentId: "copilot", state: "installed" }),
        expect.objectContaining({
          agentId: "antigravity",
          state: "installed"
        })
      ]);
      expect(
        existsSync(
          join(homeDir, ".codex", "skills", "kmux-orchestration", "SKILL.md")
        )
      ).toBe(true);
      expect(
        readFileSync(
          join(homeDir, ".codex", "skills", "kmux-orchestration", "SKILL.md"),
          "utf8"
        )
      ).toBe(KMUX_ORCHESTRATION_SKILL_DOCUMENT);
      expect(
        readFileSync(
          join(homeDir, ".copilot", "skills", "kmux-orchestration", "SKILL.md"),
          "utf8"
        )
      ).toBe(KMUX_ORCHESTRATION_SKILL_DOCUMENT);
      expect(
        readFileSync(
          join(
            homeDir,
            ".gemini",
            "config",
            "skills",
            "kmux-orchestration",
            "SKILL.md"
          ),
          "utf8"
        )
      ).toBe(KMUX_ORCHESTRATION_SKILL_DOCUMENT);
      expect(existsSync(join(homeDir, ".claude"))).toBe(false);

      writeFileSync(
        join(homeDir, ".codex", "skills", "kmux-orchestration", "SKILL.md"),
        "locally modified",
        "utf8"
      );
      expect(await manager.inspect(["codex"])).toEqual([
        expect.objectContaining({
          agentId: "codex",
          state: "update-available"
        })
      ]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("rejects a symlink anywhere inside the selected skill directory", async () => {
    if (process.platform === "win32") return;
    const homeDir = mkdtempSync(join(tmpdir(), "kmux-skill-manager-"));
    const outside = mkdtempSync(join(tmpdir(), "kmux-skill-outside-"));
    try {
      const skillParent = join(homeDir, ".codex", "skills");
      mkdirSync(skillParent, { recursive: true });
      symlinkSync(outside, join(skillParent, "kmux-orchestration"), "dir");
      const manager = new OrchestrationSkillManager({
        homeDir,
        env: {},
        resolveSkillPlacement: resolveBuiltinAgentSkillPlacement
      });

      await expect(manager.installExplicit(["codex"])).rejects.toThrow(
        "unsafe entry"
      );
      expect(existsSync(join(outside, "SKILL.md"))).toBe(false);
      expect(await manager.inspect(["codex"])).toEqual([
        expect.objectContaining({
          agentId: "codex",
          state: "needs-attention",
          reason: expect.stringContaining("unsafe entry")
        })
      ]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
