import type { Id } from "@kmux/proto";
import { contentHash } from "@kmux/orchestration";
import { stripVTControlCharacters } from "node:util";

export interface OrchestrationInputBrokerState {
  readiness?: {
    authorityRef: Id;
    receiptId: Id;
    agentId: Id;
    agentInstanceId: Id;
    readyEpoch: Id;
  };
  directInputRevision: number;
  lastDirectInputAt: number;
  deliveries: Map<
    Id,
    {
      payloadHash: string;
      outcome: "written" | "unknown";
      directInputRevision: number;
    }
  >;
}

export function createOrchestrationInputBrokerState(): OrchestrationInputBrokerState {
  return {
    directInputRevision: 0,
    lastDirectInputAt: 0,
    deliveries: new Map()
  };
}

/** Record input that came from the user's normal terminal data plane. */
export function observeDirectTerminalInput(
  state: OrchestrationInputBrokerState,
  observedAt = Date.now()
): void {
  state.directInputRevision += 1;
  state.lastDirectInputAt = observedAt;
}

export function directTerminalInputObservedAtOrAfter(
  state: OrchestrationInputBrokerState,
  timestamp: string
): boolean {
  const threshold = Date.parse(timestamp);
  return Number.isFinite(threshold) && state.lastDirectInputAt >= threshold;
}

export function registerOrchestrationReadiness(
  state: OrchestrationInputBrokerState,
  readiness: NonNullable<OrchestrationInputBrokerState["readiness"]>
): "registered" | "fenced" {
  state.readiness = { ...readiness };
  return "registered";
}

export function deliverOrchestrationInput(
  state: OrchestrationInputBrokerState,
  input: {
    authorityRef: Id;
    readinessReceiptId: Id;
    readyEpoch: Id;
    operationId: Id;
    payloadHash: string;
    text: string;
  },
  write: (text: string) => void
): {
  outcome: "accepted" | "written" | "conflict" | "fenced" | "unknown";
  replay: boolean;
} {
  // Use the same canonical string hash as the Runtime before acknowledging a
  // replay or writing any bytes. A caller-supplied digest is not evidence of
  // the actual payload, even when the operation ID has already been seen.
  if (
    Buffer.byteLength(input.text, "utf8") > 256 * 1024 ||
    contentHash(input.text) !== input.payloadHash
  ) {
    return { outcome: "fenced", replay: false };
  }
  const existing = state.deliveries.get(input.operationId);
  if (existing) {
    return {
      outcome:
        existing.payloadHash === input.payloadHash
          ? existing.outcome
          : "conflict",
      replay: true
    };
  }
  if (state.deliveries.size >= 16_384) {
    return { outcome: "fenced", replay: false };
  }
  const readiness = state.readiness;
  if (
    !readiness ||
    readiness.authorityRef !== input.authorityRef ||
    readiness.receiptId !== input.readinessReceiptId ||
    readiness.readyEpoch !== input.readyEpoch
  ) {
    return { outcome: "fenced", replay: false };
  }

  state.deliveries.set(input.operationId, {
    payloadHash: input.payloadHash,
    outcome: "unknown",
    directInputRevision: state.directInputRevision
  });
  state.readiness = undefined;
  try {
    write(input.text);
    return { outcome: "accepted", replay: false };
  } catch {
    return { outcome: "unknown", replay: false };
  }
}

export function completeOrchestrationInputDelivery(
  state: OrchestrationInputBrokerState,
  operationId: Id,
  payloadHash: string,
  outcome: "written" | "unknown"
): "written" | "unknown" | "conflict" {
  const delivery = state.deliveries.get(operationId);
  if (!delivery || delivery.payloadHash !== payloadHash) return "conflict";
  if (delivery.outcome === "written") return "written";
  state.deliveries.set(operationId, {
    payloadHash,
    outcome,
    directInputRevision: delivery.directInputRevision
  });
  return outcome;
}

export function orchestrationDeliveryWasInterruptedByDirectInput(
  state: OrchestrationInputBrokerState,
  operationId: Id,
  payloadHash: string
): boolean {
  const delivery = state.deliveries.get(operationId);
  return Boolean(
    delivery &&
    delivery.payloadHash === payloadHash &&
    delivery.directInputRevision !== state.directInputRevision
  );
}

export function queryOrchestrationDelivery(
  state: OrchestrationInputBrokerState,
  operationId: Id,
  payloadHash: string
): "not-seen" | "written" | "conflict" | "unknown" {
  const existing = state.deliveries.get(operationId);
  if (!existing) return "not-seen";
  if (existing.payloadHash !== payloadHash) return "conflict";
  return existing.outcome;
}

export function hasNewCollapsedPasteReceipt(
  beforePaste: string,
  afterPaste: string
): boolean {
  const before = collapsedPasteReceiptIds(beforePaste);
  return [...collapsedPasteReceiptIds(afterPaste)].some(
    (receiptId) => !before.has(receiptId)
  );
}

export function hasNewOrchestrationPaste(
  beforePaste: string,
  afterPaste: string,
  verificationText: string,
  pastedText?: string
): boolean {
  return (
    (!visibleContainsVerificationText(beforePaste, verificationText) &&
      visibleContainsVerificationText(afterPaste, verificationText)) ||
    hasNewCollapsedPasteReceipt(beforePaste, afterPaste) ||
    (pastedText !== undefined &&
      characterCountPasteReceipt(afterPaste) ===
        Array.from(pastedText).length &&
      characterCountPasteReceipt(beforePaste) !==
        characterCountPasteReceipt(afterPaste))
  );
}

/** An unnumbered receipt must appear in the current composer and match this
 * operation's payload size. Old output or an unchanged composer is no receipt.
 */
function characterCountPasteReceipt(value: string): number | undefined {
  const lines = stripVTControlCharacters(value).replace(/\r/gu, "").split("\n");
  const composer = lines.findLastIndex((line) => /^\s*[>❯›]/u.test(line));
  if (composer === -1) return;
  const match = lines
    .slice(composer)
    .join("")
    .replace(/\s/gu, "")
    .match(/^[>❯›]\[PastedContent(\d+)chars?\]/u);
  return match ? Number(match[1]) : undefined;
}

export function visibleContainsVerificationText(
  visible: string,
  verificationText: string
): boolean {
  // Native TUIs wrap and indent their input fields, including pointer nudges.
  // Match the exact non-whitespace marker, not its presentation width/style.
  const normalized = (value: string) =>
    stripVTControlCharacters(value).replace(/\s/gu, "");
  const expected = normalized(verificationText);
  return expected.length > 0 && normalized(visible).includes(expected);
}

function collapsedPasteReceiptIds(value: string): Set<string> {
  const visible = value.replace(/\r?\n[ \t]*/gu, "");
  return new Set(
    [
      ...visible.matchAll(
        /\[(?:Pasted\s*text|Paste)\s*#(\d+)(?:\s*[+-]\s*\d+\s*lines?)?\]/gu
      )
    ].map((match) => match[1]!)
  );
}
