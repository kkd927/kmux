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

  it("does not infer Codex stop hooks as input requests", () => {
    expect(normalizeAgentHookInvocation("codex", "stop")).toMatchObject({
      agent: "codex",
      event: "idle"
    });
  });
});
