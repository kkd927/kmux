import {
  normalizeAgentHookInvocation,
  normalizeHookNotificationInvocation
} from "./agentHooks";

describe("agent hook normalization", () => {
  it("does not treat Claude notification hooks as needs_input events", () => {
    expect(
      normalizeAgentHookInvocation(
        "claude",
        "notification",
        { message: "Needs input" },
        {
          KMUX_WORKSPACE_ID: "workspace_1",
          KMUX_SURFACE_ID: "surface_1"
        }
      )
    ).toBeNull();
  });

  it("normalizes Claude notification hooks as generic kmux notifications", () => {
    expect(
      normalizeHookNotificationInvocation(
        "claude",
        "notification",
        {
          title: "Task complete",
          message: "Task completed successfully"
        },
        {
          KMUX_WORKSPACE_ID: "workspace_1",
          KMUX_SURFACE_ID: "surface_1"
        }
      )
    ).toMatchObject({
      workspaceId: "workspace_1",
      surfaceId: "surface_1",
      sessionId: "surface_1",
      agent: "claude",
      source: "agent",
      title: "Task complete",
      message: "Task completed successfully"
    });
  });

  it("extracts Claude AskUserQuestion prompts from tool input", () => {
    expect(
      normalizeAgentHookInvocation("claude", "PreToolUse", {
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [
            {
              question: "Continue?",
              options: [{ label: "Yes" }, { label: "No" }]
            }
          ]
        }
      })
    ).toMatchObject({
      event: "needs_input",
      message: "Continue? (Yes, No)"
    });
  });

  it("maps Claude PreToolUse ExitPlanMode prompts to needs_input events", () => {
    expect(
      normalizeAgentHookInvocation("claude", "PreToolUse", {
        tool_name: "ExitPlanMode",
        tool_input: {
          plan: "Implement the requested change"
        }
      })
    ).toMatchObject({
      agent: "claude",
      event: "needs_input",
      title: "Claude needs input",
      message: "Plan ready for approval"
    });
  });

  it("ignores deprecated Claude PostToolUse AskUserQuestion hooks", () => {
    expect(
      normalizeAgentHookInvocation("claude", "PostToolUse", {
        tool_name: "AskUserQuestion"
      })
    ).toBeNull();
  });

  it("ignores deprecated Claude PostToolUse hooks for other tools", () => {
    expect(
      normalizeAgentHookInvocation("claude", "PostToolUse", {
        tool_name: "Read"
      })
    ).toBeNull();
  });

  it("ignores deprecated Claude PostToolUse ExitPlanMode hooks", () => {
    expect(
      normalizeAgentHookInvocation("claude", "PostToolUse", {
        tool_name: "ExitPlanMode"
      })
    ).toBeNull();
  });

  it("maps Claude permission requests to needs_input events", () => {
    expect(
      normalizeAgentHookInvocation("claude", "PermissionRequest", {
        message: "Approve tool use?"
      })
    ).toMatchObject({
      agent: "claude",
      event: "needs_input",
      title: "Claude needs input",
      message: "Approve tool use?"
    });
  });

  it("only treats Gemini tool-permission notifications as needs_input", () => {
    expect(
      normalizeAgentHookInvocation("gemini", "Notification", {
        notification_type: "ToolPermission",
        tool_name: "WriteFile"
      })
    ).toMatchObject({
      agent: "gemini",
      event: "needs_input",
      title: "Gemini needs input",
      message: "Tool permission requested: WriteFile"
    });

    expect(
      normalizeAgentHookInvocation("gemini", "Notification", {
        notification_type: "Info"
      })
    ).toBeNull();
  });

  it("extracts Gemini tool permission names from notification details", () => {
    expect(
      normalizeAgentHookInvocation("gemini", "Notification", {
        notification_type: "ToolPermission",
        details: {
          tool_name: "run_shell_command"
        }
      })
    ).toMatchObject({
      agent: "gemini",
      event: "needs_input",
      title: "Gemini needs input",
      message: "Tool permission requested: run_shell_command"
    });
  });

  it("treats Claude stop hooks as turn completion events", () => {
    expect(normalizeAgentHookInvocation("claude", "stop")).toMatchObject({
      agent: "claude",
      event: "turn_complete"
    });
  });

  it("treats Gemini after-agent hooks as turn completion events", () => {
    expect(normalizeAgentHookInvocation("gemini", "AfterAgent")).toMatchObject({
      agent: "gemini",
      event: "turn_complete"
    });
  });

  it("ignores deprecated Gemini before-agent hooks", () => {
    expect(normalizeAgentHookInvocation("gemini", "BeforeAgent")).toBeNull();
  });

  it("ignores deprecated Gemini BeforeTool / AfterTool hooks", () => {
    expect(normalizeAgentHookInvocation("gemini", "BeforeTool")).toBeNull();
    expect(normalizeAgentHookInvocation("gemini", "AfterTool")).toBeNull();
  });

  it("treats Codex stop hooks as turn completion events", () => {
    expect(normalizeAgentHookInvocation("codex", "stop")).toMatchObject({
      agent: "codex",
      event: "turn_complete"
    });
  });

  it("normalizes Antigravity aliases and preserves conversation metadata", () => {
    expect(
      normalizeAgentHookInvocation("agy", "PreInvocation", {
        conversationId: "9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890",
        transcriptPath: "/Users/test/project/.gemini/jetski/transcript.jsonl",
        artifactDirectoryPath: "/Users/test/project/.gemini/jetski/artifacts",
        workspacePaths: ["/Users/test/project"]
      })
    ).toMatchObject({
      agent: "antigravity",
      event: "session_start",
      details: {
        conversationId: "9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890",
        transcriptPath: "/Users/test/project/.gemini/jetski/transcript.jsonl",
        artifactDirectoryPath: "/Users/test/project/.gemini/jetski/artifacts",
        workspacePaths: ["/Users/test/project"],
        kmux_hook_event_arg: "PreInvocation"
      }
    });

    expect(
      normalizeAgentHookInvocation("antigravity-cli", "PostInvocation")
    ).toBeNull();
  });

  it("maps Antigravity permission and question tools to needs_input", () => {
    expect(
      normalizeAgentHookInvocation("antigravity", "PreToolUse", {
        toolCall: {
          name: "ask_permission",
          args: {
            Reason: "Needs command access"
          }
        }
      })
    ).toMatchObject({
      agent: "antigravity",
      event: "needs_input",
      title: "Antigravity needs input"
    });

    expect(
      normalizeAgentHookInvocation("antigravity", "PreToolUse", {
        tool_name: "ask_question"
      })
    ).toMatchObject({
      agent: "antigravity",
      event: "needs_input"
    });
  });

  it("maps Antigravity stop hooks by fullyIdle state", () => {
    expect(
      normalizeAgentHookInvocation("antigravity", "Stop", {
        fullyIdle: true
      })
    ).toMatchObject({
      agent: "antigravity",
      event: "turn_complete"
    });

    expect(
      normalizeAgentHookInvocation("antigravity", "Stop", {
        fullyIdle: false
      })
    ).toBeNull();
  });
});
