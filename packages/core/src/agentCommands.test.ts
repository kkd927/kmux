import { describe, expect, it } from "vitest";

import {
  formatAgentCommandForShell,
  resolveAgentCommand,
  resolveAgentResumeCommand
} from "./agentCommands";

describe("agent command resolver", () => {
  it("uses native commands when no scoped launcher is configured", () => {
    expect(resolveAgentCommand(undefined, "local", "claude")).toEqual([
      "claude"
    ]);
    expect(
      resolveAgentResumeCommand(undefined, "ssh", "codex", "session-1")
    ).toEqual(["codex", "resume", "session-1"]);
  });

  it("keeps scope-specific fixed args ahead of operation args", () => {
    const settings = {
      agents: {
        local: {
          claude: {
            command: "ccs",
            args: ["enterprise", "--profile", "shared profile"]
          }
        },
        ssh: {
          claude: {
            command: "claude-remote"
          }
        }
      }
    };

    expect(
      resolveAgentResumeCommand(settings, "local", "claude", "session id")
    ).toEqual([
      "ccs",
      "enterprise",
      "--profile",
      "shared profile",
      "--resume",
      "session id"
    ]);
    expect(
      resolveAgentResumeCommand(settings, "ssh", "claude", "session id")
    ).toEqual(["claude-remote", "--resume", "session id"]);
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
