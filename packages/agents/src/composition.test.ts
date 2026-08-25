import { describe, expect, it } from "vitest";

import { resolveBuiltinDetectedProcessAgent } from "./builtinRuntime";
import { createInternalAgentModuleRegistry } from "./composition";
import { normalizeAgentScopeSettings } from "./settings";
import { resolveAgentResumePolicy } from "./command";
import type { AgentModule } from "./contracts";

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
          history: {}
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
                purposes: ["history"]
              },
              {
                role: "duplicate/session",
                format: "jsonl",
                pattern: "**/*.jsonl",
                purposes: ["history"]
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
          history: {}
        }
      ])
    ).toThrow(/no metadata source for history/u);
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
                purposes: ["history"]
              }
            ]
          },
          history: {}
        }
      ])
    ).toThrow(/history has no projection factory/u);
  });

  it("rejects hook session claims that are not backed by a managed event", () => {
    expect(() =>
      createInternalAgentModuleRegistry([
        {
          ...fixture("invalid-hook"),
          hooks: {
            portable: {
              format: "grouped-hooks",
              relativePath: ".invalid/hooks.json",
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
