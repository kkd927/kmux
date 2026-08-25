import { describe, expect, it } from "vitest";

import {
  formatAgentCommandForShell,
  resolveAgentScopeSettings
} from "./agentCommands";

describe("agent command resolver", () => {
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

    expect(local?.claude?.command).toBe("ccs");
    expect(ssh?.claude?.command).toBe("claude-remote");
    expect(ssh?.codex).toBeUndefined();
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
