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

  it("treats Claude stop hooks as turn completion events", () => {
    expect(normalizeAgentHookInvocation("claude", "stop")).toMatchObject({
      agent: "claude",
      event: "turn_complete"
    });
  });

  it("treats Codex stop hooks as turn completion events", () => {
    expect(normalizeAgentHookInvocation("codex", "stop")).toMatchObject({
      agent: "codex",
      event: "turn_complete"
    });
  });

  it("summarizes the closing assistant message on Claude and Codex stop hooks", () => {
    expect(
      normalizeAgentHookInvocation("claude", "Stop", {
        last_assistant_message: "PR #5943 is fully green."
      })
    ).toMatchObject({
      event: "turn_complete",
      message: "PR #5943 is fully green."
    });

    expect(
      normalizeAgentHookInvocation("codex", "Stop", {
        last_assistant_message: "Rebased onto main and pushed."
      })
    ).toMatchObject({
      event: "turn_complete",
      message: "Rebased onto main and pushed."
    });
  });

  it("keeps only the opening line of a multi-line completion message", () => {
    expect(
      normalizeAgentHookInvocation("claude", "Stop", {
        last_assistant_message:
          "\n\n- PR #5943 is **fully green**; `sonar` passed too.\nsecond line"
      })
    ).toMatchObject({
      event: "turn_complete",
      message: "PR #5943 is fully green; sonar passed too."
    });
  });

  it("joins a bare section heading with the line that follows it", () => {
    expect(
      normalizeAgentHookInvocation("claude", "Stop", {
        last_assistant_message:
          "## Summary\n\nPR #5943 is **fully green**; `sonar` passed too.\n\n- runner died twice"
      })?.message
    ).toBe("Summary — PR #5943 is fully green; sonar passed too.");

    expect(
      normalizeAgentHookInvocation("codex", "Stop", {
        last_assistant_message:
          "### Strengths\n- Clear separation between transport and reducer"
      })?.message
    ).toBe("Strengths — Clear separation between transport and reducer");

    expect(
      normalizeAgentHookInvocation("codex", "Stop", {
        last_assistant_message:
          "**Findings**\n\n1. The reducer drops the stale epoch."
      })?.message
    ).toBe("Findings — The reducer drops the stale epoch.");
  });

  it("does not treat a partially bold line as a section label", () => {
    expect(
      normalizeAgentHookInvocation("claude", "Stop", {
        last_assistant_message:
          "PR #5943 is **fully green**.\nSonarQube passed too."
      })?.message
    ).toBe("PR #5943 is fully green.");
  });

  it("keeps a descriptive heading when nothing follows it", () => {
    expect(
      normalizeAgentHookInvocation("claude", "Stop", {
        last_assistant_message: "## Review: one-release-per-minor gate"
      })?.message
    ).toBe("Review: one-release-per-minor gate");
  });

  it("skips structural-only lines when picking the completion summary", () => {
    expect(
      normalizeAgentHookInvocation("claude", "Stop", {
        last_assistant_message: "---\nDone."
      })?.message
    ).toBe("Done.");

    expect(
      normalizeAgentHookInvocation("claude", "Stop", {
        last_assistant_message: "***\n___\nRebase finished."
      })?.message
    ).toBe("Rebase finished.");

    expect(
      normalizeAgentHookInvocation("claude", "Stop", {
        last_assistant_message: "```bash\nnpm test\n```"
      })?.message
    ).toBe("npm test");
  });

  it("unwraps markdown links in the completion summary", () => {
    expect(
      normalizeAgentHookInvocation("claude", "Stop", {
        last_assistant_message:
          "[PR #12](https://example.com/pr/12) is merged; `*.ts` untouched."
      })?.message
    ).toBe("PR #12 is merged; *.ts untouched.");
  });

  it("truncates long completion messages", () => {
    const event = normalizeAgentHookInvocation("claude", "Stop", {
      last_assistant_message: "x".repeat(400)
    });

    expect(event?.message).toHaveLength(100);
    expect(event?.message?.endsWith("…")).toBe(true);
  });

  it("truncates on code point boundaries so emoji are never split", () => {
    const message = normalizeAgentHookInvocation("claude", "Stop", {
      last_assistant_message: `${"x".repeat(98)}🎉 all tests pass`
    })?.message;

    expect(Array.from(message ?? "")).toHaveLength(100);
    expect(message).toMatch(/…$/);
    expect(message).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(message).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("keeps the Codex turn id in hook details", () => {
    expect(
      normalizeAgentHookInvocation("codex", "Stop", {
        turn_id: "turn_789",
        last_assistant_message: "Done."
      })
    ).toMatchObject({
      event: "turn_complete",
      details: { turn_id: "turn_789" }
    });
  });

  it("omits the completion message when no assistant text is available", () => {
    expect(
      normalizeAgentHookInvocation("codex", "Stop", {
        last_assistant_message: null
      })?.message
    ).toBeUndefined();

    expect(
      normalizeAgentHookInvocation("claude", "Stop", {
        last_assistant_message: "   \n  \n"
      })?.message
    ).toBeUndefined();

    expect(
      normalizeAgentHookInvocation("antigravity", "Stop", { fullyIdle: true })
        ?.message
    ).toBeUndefined();
  });

  it("maps Codex permission requests to needs_input events", () => {
    expect(
      normalizeAgentHookInvocation("codex", "PermissionRequest", {
        hook_event_name: "PermissionRequest",
        turn_id: "turn_123",
        tool_name: "Bash",
        tool_input: {
          command: "npm test",
          description: "Run tests outside the sandbox?"
        }
      })
    ).toMatchObject({
      agent: "codex",
      event: "needs_input",
      title: "Codex needs input",
      message: "Run tests outside the sandbox?"
    });
  });

  it("keeps a generic fallback for Codex permission requests without descriptions", () => {
    expect(
      normalizeAgentHookInvocation("codex", "PermissionRequest", {
        hook_event_name: "PermissionRequest",
        turn_id: "turn_456",
        tool_name: "apply_patch",
        tool_input: {
          command: "*** Begin Patch"
        }
      })
    ).toMatchObject({
      agent: "codex",
      event: "needs_input",
      title: "Codex needs input",
      message: "Needs input"
    });
  });

  it("normalizes Antigravity aliases and preserves conversation metadata", () => {
    expect(
      normalizeAgentHookInvocation(
        "agy",
        "PreInvocation",
        {
          conversationId: "9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890",
          transcriptPath: "/Users/test/project/.gemini/jetski/transcript.jsonl",
          artifactDirectoryPath: "/Users/test/project/.gemini/jetski/artifacts",
          workspacePaths: ["/Users/test/project"]
        },
        {
          KMUX_WORKSPACE_ID: "workspace_1",
          KMUX_SURFACE_ID: "surface_1",
          KMUX_SESSION_ID: "kmux-session_1"
        }
      )
    ).toMatchObject({
      workspaceId: "workspace_1",
      surfaceId: "surface_1",
      sessionId: "kmux-session_1",
      vendorSessionId: "9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890",
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

  it("keeps Antigravity routing session ids separate from conversation ids", () => {
    const event = normalizeAgentHookInvocation(
      "agy",
      "PreInvocation",
      {
        conversationId: "9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890",
        workspacePaths: ["/Users/test/project"]
      },
      {
        KMUX_WORKSPACE_ID: "workspace_1",
        KMUX_SESSION_ID: "kmux-session_1"
      }
    );

    expect(event).toMatchObject({
      workspaceId: "workspace_1",
      sessionId: "kmux-session_1",
      vendorSessionId: "9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890",
      agent: "antigravity",
      event: "session_start",
      details: {
        conversationId: "9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890"
      }
    });
    expect(event?.surfaceId).toBeUndefined();
  });

  it("keeps Codex routing and vendor session ids separate", () => {
    expect(
      normalizeAgentHookInvocation(
        "codex",
        "SessionStart",
        { session_id: "codex-session_1" },
        {
          KMUX_SURFACE_ID: "surface_1",
          KMUX_SESSION_ID: "kmux-session_1"
        }
      )
    ).toMatchObject({
      surfaceId: "surface_1",
      sessionId: "kmux-session_1",
      vendorSessionId: "codex-session_1",
      agent: "codex",
      event: "session_start"
    });
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
