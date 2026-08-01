import type { UsageVendor } from "@kmux/proto";

export type CodexTerminalInputReason =
  | "plan-mode-prompt"
  | "enter-to-submit-answer"
  | "needs-input"
  | "waiting-for-input"
  | "question-unanswered"
  | "question-submit";

export type AgentTerminalNotificationDecision =
  | {
      disposition: "needs_input";
      reason: CodexTerminalInputReason;
      inferredFromUnknownVendor: boolean;
    }
  | { disposition: "suppressed"; reason: "codex-terminal-chatter" }
  | { disposition: "generic" };

/**
 * Applies the shared local/SSH policy to terminal-originated agent signals.
 * Structured hooks remain authoritative; Codex terminal notifications only
 * fill needs-input gaps that are not covered by every Codex hook version.
 */
export function classifyAgentTerminalNotification(
  vendor: UsageVendor,
  title: string,
  message: string
): AgentTerminalNotificationDecision {
  if (vendor !== "codex" && vendor !== "unknown") {
    return { disposition: "generic" };
  }

  const match = matchCodexInputAttention(title, message, {
    allowGenericInputPhrases: vendor === "codex"
  });
  if (match) {
    return {
      disposition: "needs_input",
      reason: match.reason,
      inferredFromUnknownVendor: vendor === "unknown"
    };
  }
  return vendor === "codex"
    ? { disposition: "suppressed", reason: "codex-terminal-chatter" }
    : { disposition: "generic" };
}

function matchCodexInputAttention(
  title: string,
  message: string,
  options: { allowGenericInputPhrases: boolean }
): { reason: CodexTerminalInputReason } | null {
  const normalized = `${title}\n${message}`.trim();
  if (!normalized) {
    return null;
  }

  const hasQuestion = /\bquestion \d+\/\d+\b/i.test(normalized);
  const hasEnterToSubmit = /\benter to submit answer\b/i.test(normalized);
  if (hasQuestion) {
    if (/\bunanswered\b/i.test(normalized)) {
      return { reason: "question-unanswered" };
    }
    if (hasEnterToSubmit) {
      return { reason: "question-submit" };
    }
  }
  if (/\bplan mode prompt:/i.test(normalized)) {
    return { reason: "plan-mode-prompt" };
  }
  if (hasEnterToSubmit) {
    return { reason: "enter-to-submit-answer" };
  }
  if (options.allowGenericInputPhrases) {
    if (/\bneeds input\b/i.test(normalized)) {
      return { reason: "needs-input" };
    }
    if (/\bwaiting for input\b/i.test(normalized)) {
      return { reason: "waiting-for-input" };
    }
  }
  return null;
}
