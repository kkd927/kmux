import { describe, expect, it } from "vitest";

import { classifyAgentTerminalNotification } from "./agentTerminalNotificationPolicy";

describe("agent terminal notification policy", () => {
  it("uses Codex terminal signals only for needs-input gaps", () => {
    expect(
      classifyAgentTerminalNotification(
        "codex",
        "kmux",
        "Plan mode prompt: Depth"
      )
    ).toEqual({
      disposition: "needs_input",
      reason: "plan-mode-prompt",
      inferredFromUnknownVendor: false
    });
    expect(
      classifyAgentTerminalNotification("codex", "kmux", "Waiting for input")
    ).toEqual({
      disposition: "needs_input",
      reason: "waiting-for-input",
      inferredFromUnknownVendor: false
    });
    expect(
      classifyAgentTerminalNotification(
        "codex",
        "kmux",
        "Work completed successfully"
      )
    ).toEqual({
      disposition: "suppressed",
      reason: "codex-terminal-chatter"
    });
  });

  it("keeps the restored-session unknown-vendor fallback strict", () => {
    expect(
      classifyAgentTerminalNotification(
        "unknown",
        "CodexBar",
        "Question 1/2: Depth unanswered"
      )
    ).toEqual({
      disposition: "needs_input",
      reason: "question-unanswered",
      inferredFromUnknownVendor: true
    });
    expect(
      classifyAgentTerminalNotification("unknown", "shell", "Needs input")
    ).toEqual({ disposition: "generic" });
    expect(
      classifyAgentTerminalNotification("claude", "shell", "Task complete")
    ).toEqual({ disposition: "generic" });
  });
});
