import type { AgentId, UsageVendor } from "@kmux/proto";
import {
  builtinAgentDescriptor,
  classifyBuiltinTerminalNotification
} from "@kmux/agents/builtin-runtime";

export type TerminalInputReason =
  | "plan-mode-prompt"
  | "enter-to-submit-answer"
  | "needs-input"
  | "waiting-for-input"
  | "question-unanswered"
  | "question-submit";

export type AgentTerminalNotificationDecision =
  | {
      disposition: "needs_input";
      reason: string;
      inferredFromUnknownVendor: boolean;
      agentId?: AgentId;
      displayName?: string;
    }
  | { disposition: "suppressed"; reason: string }
  | { disposition: "generic" };

/**
 * Applies the shared local/SSH policy to terminal-originated agent signals.
 * Structured hooks remain authoritative; terminal notifications only fill
 * needs-input gaps that are not covered by every agent hook version.
 */
export function classifyAgentTerminalNotification(
  vendor: UsageVendor,
  title: string,
  message: string
): AgentTerminalNotificationDecision {
  const descriptor =
    vendor === "unknown" ? undefined : builtinAgentDescriptor(vendor);
  if (vendor === "unknown") {
    const match = matchStrongGenericInputAttention(title, message);
    return match
      ? {
          disposition: "needs_input",
          reason: match.reason,
          inferredFromUnknownVendor: true,
          agentId: "codex",
          displayName: "Codex"
        }
      : { disposition: "generic" };
  }
  if (!descriptor) return { disposition: "generic" };
  const decision = classifyBuiltinTerminalNotification(vendor, title, message);
  if (decision?.disposition === "needs_input") {
    return {
      disposition: "needs_input",
      reason: decision.reason,
      inferredFromUnknownVendor: false,
      agentId: vendor,
      displayName: descriptor.displayName
    };
  }
  if (decision?.disposition === "suppressed") {
    return { disposition: "suppressed", reason: decision.reason };
  }
  return { disposition: "generic" };
}

function matchStrongGenericInputAttention(
  title: string,
  message: string
): { reason: TerminalInputReason } | null {
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
  return null;
}
