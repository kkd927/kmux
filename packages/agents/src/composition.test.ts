import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  listBuiltinAgentDescriptors,
  resolveBuiltinAgentLaunchPolicy,
  resolveBuiltinAgentResumePolicy,
  resolveBuiltinAgentSkillPlacement,
  resolveBuiltinDetectedProcessAgent
} from "./builtinRuntime";
import { createInternalAgentModuleRegistry } from "./composition";
import { normalizeAgentScopeSettings } from "./settings";
import { resolveAgentLaunchPolicy, resolveAgentResumePolicy } from "./command";
import type { AgentModule, AgentSessionsCapability } from "./contracts";

const fixture = (id: string, aliases: string[] = []): AgentModule => ({
  descriptor: { id, displayName: id, aliases },
  definitionRevision: `${id}-v1`,
  command: { executable: id },
  resume: { build: (args, sessionId) => [...args, "--resume", sessionId] }
});

describe("agent composition contracts", () => {
  it("keeps syntax-valid unknown identities while authorizing only registered capabilities", () => {
    const registry = createInternalAgentModuleRegistry([
      fixture("known", ["legacy-known"])
    ]);

    expect(registry.catalog.resolveOperationalIngress(" LEGACY-KNOWN ")).toBe(
      "known"
    );
    expect(registry.catalog.descriptor("future-agent")).toBeUndefined();
    expect(registry.resolver("resume").resolve("future-agent")).toBeUndefined();

    const settings = normalizeAgentScopeSettings({
      value: {
        "future-agent": { command: "future" },
        known: { command: "known-wrapper" }
      },
      catalog: registry.catalog
    });
    expect(settings.has("future-agent")).toBe(false);
    expect(settings.get("known")).toEqual({
      command: "known-wrapper"
    });
  });

  it("projects skill placement support while keeping path resolution agent-owned", () => {
    const descriptors = listBuiltinAgentDescriptors();
    for (const agentId of ["codex", "claude", "copilot", "antigravity"]) {
      expect(descriptors.find((agent) => agent.id === agentId)).toMatchObject({
        capabilities: expect.arrayContaining(["skillPlacement"]),
        skillPlacement: { scopes: ["global"] }
      });
    }
    expect(
      resolveBuiltinAgentSkillPlacement("codex")?.resolveRoot({
        scope: "global",
        homeDir: "/Users/test",
        env: { CODEX_HOME: "/Users/test/custom-codex" }
      })
    ).toBe(join("/Users/test/custom-codex", "skills"));
    expect(
      resolveBuiltinAgentSkillPlacement("copilot")?.resolveRoot({
        scope: "global",
        homeDir: "/Users/test",
        env: { COPILOT_HOME: "/Users/test/custom-copilot" }
      })
    ).toBe(join("/Users/test/custom-copilot", "skills"));
    expect(
      resolveBuiltinAgentSkillPlacement("antigravity")?.resolveRoot({
        scope: "global",
        homeDir: "/Users/test"
      })
    ).toBe(join("/Users/test", ".gemini", "config", "skills"));
    expect(resolveBuiltinAgentSkillPlacement("future-agent")).toBeUndefined();
  });

  it("rejects identity collisions and metadata references without declarations", () => {
    expect(() => createInternalAgentModuleRegistry([fixture("ssh")])).toThrow(
      /reserved for the settings scope/u
    );
    expect(() =>
      createInternalAgentModuleRegistry([
        fixture("one", ["two"]),
        fixture("two")
      ])
    ).toThrow(/collides/u);
    expect(() =>
      createInternalAgentModuleRegistry([
        {
          ...fixture("direct"),
          sessions: {} as AgentSessionsCapability
        }
      ])
    ).toThrow(/no metadata sources/u);
    expect(() =>
      createInternalAgentModuleRegistry([
        {
          ...fixture("duplicate-source"),
          metadataSources: {
            revision: "v1",
            defaultRoot: ".duplicate",
            sources: [
              {
                role: "duplicate/session",
                format: "jsonl",
                pattern: "*.jsonl",
                purposes: ["sessions"]
              },
              {
                role: "duplicate/session",
                format: "jsonl",
                pattern: "**/*.jsonl",
                purposes: ["sessions"]
              }
            ]
          }
        }
      ])
    ).toThrow(/duplicate roles/u);
    expect(() =>
      createInternalAgentModuleRegistry([
        {
          ...fixture("wrong-purpose"),
          metadataSources: {
            revision: "v1",
            defaultRoot: ".wrong-purpose",
            sources: [
              {
                role: "wrong-purpose/session",
                format: "jsonl",
                pattern: "*.jsonl",
                purposes: ["usage"]
              }
            ]
          },
          sessions: {} as AgentSessionsCapability
        }
      ])
    ).toThrow(/no metadata source for sessions/u);
    expect(() =>
      createInternalAgentModuleRegistry([
        {
          ...fixture("missing-projection"),
          metadataSources: {
            revision: "v1",
            defaultRoot: ".missing-projection",
            sources: [
              {
                role: "missing-projection/session",
                format: "jsonl",
                pattern: "*.jsonl",
                purposes: ["sessions"]
              }
            ]
          },
          sessions: {} as AgentSessionsCapability
        }
      ])
    ).toThrow(/sessions has no projection factory/u);
  });

  it("rejects hook session claims that are not backed by a managed event", () => {
    expect(() =>
      createInternalAgentModuleRegistry([
        {
          ...fixture("invalid-hook"),
          hooks: {
            portable: {
              relativePath: ".invalid/hooks.json",
              document: { eventsPath: ["hooks"] },
              entry: {
                commandField: "command",
                wrapper: { field: "hooks", when: "always" }
              },
              marker: "KMUX_INVALID_HOOK=1",
              managed: [{ event: "Stop" }],
              deprecated: [],
              outputMode: "silent",
              successResponse: {},
              fallbackResponse: {},
              sessionClaim: {
                startEvents: ["SessionStart"],
                sessionIdFields: ["session_id"]
              }
            },
            normalize: () => null
          }
        }
      ])
    ).toThrow(/hook session claim/u);
  });

  it("builds bounded resume argv from agent-owned syntax and generic settings", () => {
    const module = fixture("known");
    expect(
      resolveAgentResumePolicy({
        agentId: "known",
        command: module.command!,
        resume: module.resume!,
        sessionId: "session id",
        settings: {
          command: "/opt/agent wrapper",
          args: ["--profile", "shared"]
        }
      })
    ).toEqual({
      agentId: "known",
      command: "/opt/agent wrapper",
      args: ["--profile", "shared", "--resume", "session id"]
    });
  });

  it("translates structured launch preferences through the trusted Agent capability", () => {
    const command = { executable: "codex" };
    const capability = {
      supportedEfforts: ["low", "high"],
      buildArgs: (preferences: { model?: string; effort?: string }) => [
        "--model",
        preferences.model!,
        "--config",
        `model_reasoning_effort=${preferences.effort}`
      ]
    };
    expect(
      resolveAgentLaunchPolicy({
        agentId: "codex",
        command,
        settings: { args: ["--profile", "shared"] },
        preferences: { model: "gpt-5.5", effort: "high" },
        preferencesCapability: capability
      })
    ).toMatchObject({
      args: [
        "--profile",
        "shared",
        "--model",
        "gpt-5.5",
        "--config",
        "model_reasoning_effort=high"
      ],
      preferenceArgs: [
        "--model",
        "gpt-5.5",
        "--config",
        "model_reasoning_effort=high"
      ],
      launchPreferences: {
        requested: { model: "gpt-5.5", effort: "high" },
        effective: { model: "gpt-5.5", effort: "high" },
        evidence: "executor-applied"
      }
    });
    expect(() =>
      resolveAgentLaunchPolicy({
        agentId: "codex",
        command,
        preferences: { effort: "high" },
        preferencesCapability: capability
      })
    ).toThrow(/requires a model/u);
    expect(() =>
      resolveAgentLaunchPolicy({
        agentId: "codex",
        command,
        preferences: { model: "--danger", effort: "high" },
        preferencesCapability: capability
      })
    ).toThrow(/opaque provider identifier/u);
  });

  it("encodes Antigravity tiers while keeping model and effort stable for session reuse", () => {
    expect(
      resolveBuiltinAgentLaunchPolicy({
        agentId: "antigravity",
        preferences: { model: "gemini-3.8-flash", effort: "low" }
      })
    ).toMatchObject({
      args: [
        "--dangerously-skip-permissions",
        "--model",
        "gemini-3.8-flash-low"
      ],
      launchPreferences: {
        requested: { model: "gemini-3.8-flash", effort: "low" },
        effective: { model: "gemini-3.8-flash", effort: "low" },
        evidence: "executor-applied"
      }
    });
    expect(() =>
      resolveBuiltinAgentLaunchPolicy({
        agentId: "antigravity",
        preferences: { model: "gemini-3.8-flash", effort: "unsupported" }
      })
    ).toThrow(/does not support effort/u);
  });

  it("uses Agent-owned permission defaults unless the user configured args", () => {
    expect(
      resolveBuiltinAgentLaunchPolicy({ agentId: "copilot" })?.args
    ).toEqual(["--yolo"]);
    expect(
      resolveBuiltinAgentLaunchPolicy({ agentId: "antigravity" })?.args
    ).toEqual(["--dangerously-skip-permissions"]);
    expect(
      resolveBuiltinAgentLaunchPolicy({
        agentId: "copilot",
        settings: { args: [] }
      })?.args
    ).toEqual([]);
    expect(
      resolveBuiltinAgentResumePolicy({
        agentId: "copilot",
        sessionId: "existing-session"
      })?.args
    ).not.toContain("--yolo");
  });

  it("uses the production process matchers for legacy, quoted, and package commands", () => {
    expect(
      resolveBuiltinDetectedProcessAgent(
        "/usr/local/bin/claude-code --continue"
      )
    ).toBe("claude");
    expect(
      resolveBuiltinDetectedProcessAgent('"/usr/local/bin/claude" --continue')
    ).toBe("claude");
    expect(
      resolveBuiltinDetectedProcessAgent('"/usr/local/bin/codex" resume')
    ).toBe("codex");
    expect(resolveBuiltinDetectedProcessAgent('"C:\\\\bin\\\\agy"')).toBe(
      "antigravity"
    );
    expect(
      resolveBuiltinDetectedProcessAgent(
        "node /opt/node_modules/@anthropic-ai/claude-code/cli.cjs"
      )
    ).toBe("claude");
    expect(
      resolveBuiltinDetectedProcessAgent(
        "node /opt/node_modules/@anthropic-ai/claude-code-malicious/cli.js"
      )
    ).toBeUndefined();
  });
});
