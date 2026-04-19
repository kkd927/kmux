import { normalizeAgentHookInvocation } from "./agentHooks";

describe("agent hook normalization", () => {
  it("maps Claude notification hooks to needs_input events", () => {
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
    ).toMatchObject({
      workspaceId: "workspace_1",
      surfaceId: "surface_1",
      sessionId: "surface_1",
      agent: "claude",
      event: "needs_input",
      title: "Claude needs input",
      message: "Needs input"
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

  it("treats Gemini before-agent hooks as running events", () => {
    expect(normalizeAgentHookInvocation("gemini", "BeforeAgent")).toMatchObject({
      agent: "gemini",
      event: "running",
      message: "Running"
    });
  });

  it("treats Codex stop hooks as turn completion events", () => {
    expect(normalizeAgentHookInvocation("codex", "stop")).toMatchObject({
      agent: "codex",
      event: "turn_complete"
    });
  });
});
