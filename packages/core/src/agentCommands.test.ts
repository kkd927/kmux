import { describe, expect, it } from "vitest";

import {
  formatAgentCommandForShell,
  resolveAgentCommand,
  resolveAgentResumeCommand,
  resolveAgentScopeSettings
} from "./agentCommands";

describe("agent command resolver", () => {
  it("uses native commands when no scoped launcher is configured", () => {
    expect(resolveAgentCommand(undefined, "claude")).toEqual(["claude"]);
    expect(resolveAgentResumeCommand(undefined, "claude", "session-1")).toEqual(
      ["claude", "--resume", "session-1"]
    );
    expect(resolveAgentResumeCommand(undefined, "codex", "session-1")).toEqual([
      "codex",
      "resume",
      "session-1"
    ]);
    expect(
      resolveAgentResumeCommand(undefined, "antigravity", "session-1")
    ).toEqual(["agy", "--conversation", "session-1"]);
  });

  it("selects local and SSH profiles without inheriting between them", () => {
    const agents = {
      claude: {
        command: "ccs",
        args: ["enterprise", "--profile", "shared profile", "--"]
      },
      codex: {
        command: "local-codex"
      },
      ssh: {
        claude: {
          command: "claude-remote"
        }
      }
    };
    const local = resolveAgentScopeSettings(agents, "local");
    const ssh = resolveAgentScopeSettings(agents, "ssh");

    expect(resolveAgentResumeCommand(local, "claude", "session id")).toEqual([
      "ccs",
      "enterprise",
      "--profile",
      "shared profile",
      "--",
      "--resume",
      "session id"
    ]);
    expect(resolveAgentResumeCommand(ssh, "claude", "session id")).toEqual([
      "claude-remote",
      "--resume",
      "session id"
    ]);
    expect(resolveAgentCommand(ssh, "codex")).toEqual(["codex"]);
  });

  it("quotes every shell-sensitive command part without changing argument order", () => {
    expect(
      formatAgentCommandForShell([
        "/opt/Agent Wrapper",
        "profile's",
        "--resume",
        "session id"
      ])
    ).toBe(`'/opt/Agent Wrapper' 'profile'\\''s' --resume 'session id'`);
  });
});
