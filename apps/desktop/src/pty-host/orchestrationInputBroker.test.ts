import { vi } from "vitest";
import { contentHash } from "@kmux/orchestration";

import {
  hasNewOrchestrationPaste,
  completeOrchestrationInputDelivery,
  createOrchestrationInputBrokerState,
  directTerminalInputObservedAtOrAfter,
  deliverOrchestrationInput,
  hasNewCollapsedPasteReceipt,
  visibleContainsVerificationText,
  observeDirectTerminalInput,
  orchestrationDeliveryWasInterruptedByDirectInput,
  queryOrchestrationDelivery,
  registerOrchestrationReadiness
} from "./orchestrationInputBroker";

const payloadHash = contentHash("task\n");

describe("generation-local orchestration input broker", () => {
  it("accepts a fresh character-count receipt only for this payload in the current composer", () => {
    const text = "Inspect 한글 🧪\n[kmux-dispatch:dispatch:1]";
    const count = Array.from(text).length;
    const pasted = `›[Pasted Content ${count} chars]\nGPT-6-Luna ·/tmp/worker`;
    const check = (before: string, after: string, payload = text) =>
      hasNewOrchestrationPaste(
        before,
        after,
        "[kmux-dispatch:dispatch:1]",
        payload
      );
    expect(check("›Ask Codex to do anything", pasted)).toBe(true);
    expect(check(pasted, pasted)).toBe(false);
    expect(check("›Ask Codex to do anything", pasted, text + "x")).toBe(false);
    expect(check(pasted + "\n›Ask Codex to do anything", pasted)).toBe(true);
    expect(
      check("›Ask Codex to do anything", pasted + "\n›Ask Codex to do anything")
    ).toBe(false);
    expect(
      check("›Ask Codex to do anything", `›[Pasted Content ${count}\n chars]`)
    ).toBe(true);
    expect(
      hasNewOrchestrationPaste("›", pasted, "[kmux-dispatch:dispatch:1]")
    ).toBe(false);
  });
  it("requires a newly reflected operation before submitting a paste", () => {
    const oldPointer =
      "Run check --dispatch dispatch:1\n[kmux-mailbox:nudge:1]";
    expect(
      hasNewOrchestrationPaste(
        oldPointer,
        oldPointer,
        "check --dispatch dispatch:1"
      )
    ).toBe(false);
    expect(
      hasNewOrchestrationPaste(
        oldPointer,
        `${oldPointer}\n❯`,
        "[kmux-mailbox:nudge:2]"
      )
    ).toBe(false);
    expect(
      hasNewOrchestrationPaste(
        oldPointer,
        `${oldPointer}\n[kmux-mailbox:nudge:\n 2]`,
        "[kmux-mailbox:nudge:2]"
      )
    ).toBe(true);
    expect(
      hasNewOrchestrationPaste(
        oldPointer,
        `${oldPointer}\n[Pasted text #2 +4 lines]`,
        "[kmux-mailbox:nudge:2]"
      )
    ).toBe(true);
  });
  it("writes an operation at most once and retains same-generation delivery evidence", () => {
    const state = createOrchestrationInputBrokerState();
    const write = vi.fn();
    expect(
      registerOrchestrationReadiness(state, {
        authorityRef: "input-authority:1",
        receiptId: "ready:1",
        agentId: "codex",
        agentInstanceId: "agent-instance:1",
        readyEpoch: "turn:1"
      })
    ).toBe("registered");

    const delivery = {
      authorityRef: "input-authority:1",
      readinessReceiptId: "ready:1",
      readyEpoch: "turn:1",
      operationId: "delivery:1",
      payloadHash,
      text: "task\n"
    };
    expect(
      deliverOrchestrationInput(
        state,
        { ...delivery, text: "different task\n" },
        write
      )
    ).toEqual({
      outcome: "fenced",
      replay: false
    });
    expect(write).not.toHaveBeenCalled();
    expect(deliverOrchestrationInput(state, delivery, write)).toEqual({
      outcome: "accepted",
      replay: false
    });
    expect(deliverOrchestrationInput(state, delivery, write)).toEqual({
      outcome: "unknown",
      replay: true
    });
    expect(
      completeOrchestrationInputDelivery(
        state,
        delivery.operationId,
        delivery.payloadHash,
        "written"
      )
    ).toBe("written");
    expect(deliverOrchestrationInput(state, delivery, write)).toEqual({
      outcome: "written",
      replay: true
    });
    expect(
      deliverOrchestrationInput(
        state,
        { ...delivery, text: "tampered replay\n" },
        write
      )
    ).toEqual({
      outcome: "fenced",
      replay: false
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(queryOrchestrationDelivery(state, "delivery:1", payloadHash)).toBe(
      "written"
    );
    expect(
      queryOrchestrationDelivery(
        state,
        "delivery:1",
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      )
    ).toBe("conflict");
  });

  it("accepts only a newly reflected collapsed paste receipt", () => {
    const first = "> [Pasted text #1 +37 lines]";
    expect(hasNewCollapsedPasteReceipt("> ", first)).toBe(true);
    expect(hasNewCollapsedPasteReceipt(first, first)).toBe(false);
    expect(
      hasNewCollapsedPasteReceipt(
        first,
        `${first}\n> [Pasted text #2 +4 lines]`
      )
    ).toBe(true);
    expect(
      hasNewCollapsedPasteReceipt(first, `${first}\n❯ [Paste #2 - 4 lines]`)
    ).toBe(true);
    // Actual AGY receipt at narrow split width: joining wrapped lines removes
    // the space between the count and "lines". It must still be operation-new.
    const wrapped = ">\u001b[1C[Pasted text #1 +22\n  lines]";
    expect(hasNewCollapsedPasteReceipt("> ", wrapped)).toBe(true);
    expect(hasNewCollapsedPasteReceipt(first, wrapped)).toBe(false);
  });

  it("verifies an indented pointer across narrow TUI line wraps", () => {
    const visible =
      "Run `kmux orchestration\n  check --dispatch\n  dispatch:abcd-\n  1234`.";
    expect(
      visibleContainsVerificationText(
        visible,
        "check --dispatch dispatch:abcd-1234"
      )
    ).toBe(true);
    expect(
      visibleContainsVerificationText(
        visible,
        "check --dispatch dispatch:abcd-9999"
      )
    ).toBe(false);
  });

  it("consumes readiness after an ambiguous delivery", () => {
    const state = createOrchestrationInputBrokerState();
    registerOrchestrationReadiness(state, {
      authorityRef: "input-authority:1",
      receiptId: "ready:1",
      agentId: "codex",
      agentInstanceId: "agent-instance:1",
      readyEpoch: "turn:1"
    });
    const first = {
      authorityRef: "input-authority:1",
      readinessReceiptId: "ready:1",
      readyEpoch: "turn:1",
      operationId: "delivery:1",
      payloadHash,
      text: "task\n"
    };
    expect(
      deliverOrchestrationInput(state, first, () => {
        throw new Error("write outcome is ambiguous");
      })
    ).toEqual({ outcome: "unknown", replay: false });
    expect(queryOrchestrationDelivery(state, "delivery:1", payloadHash)).toBe(
      "unknown"
    );
    expect(
      deliverOrchestrationInput(
        state,
        { ...first, operationId: "delivery:2" },
        vi.fn()
      )
    ).toEqual({ outcome: "fenced", replay: false });

    expect(
      registerOrchestrationReadiness(state, {
        authorityRef: "input-authority:1",
        receiptId: "ready:2",
        agentId: "codex",
        agentInstanceId: "agent-instance:1",
        readyEpoch: "turn:2"
      })
    ).toBe("registered");
  });

  it("fences Enter when direct user input races an accepted orchestration paste", () => {
    const state = createOrchestrationInputBrokerState();
    registerOrchestrationReadiness(state, {
      authorityRef: "input-authority:1",
      receiptId: "ready:1",
      agentId: "codex",
      agentInstanceId: "agent-instance:1",
      readyEpoch: "turn:1"
    });
    const delivery = {
      authorityRef: "input-authority:1",
      readinessReceiptId: "ready:1",
      readyEpoch: "turn:1",
      operationId: "delivery:1",
      payloadHash,
      text: "task\n"
    };
    expect(deliverOrchestrationInput(state, delivery, vi.fn())).toMatchObject({
      outcome: "accepted"
    });
    expect(
      orchestrationDeliveryWasInterruptedByDirectInput(
        state,
        delivery.operationId,
        delivery.payloadHash
      )
    ).toBe(false);

    observeDirectTerminalInput(state);

    expect(
      orchestrationDeliveryWasInterruptedByDirectInput(
        state,
        delivery.operationId,
        delivery.payloadHash
      )
    ).toBe(true);
    expect(
      completeOrchestrationInputDelivery(
        state,
        delivery.operationId,
        delivery.payloadHash,
        "unknown"
      )
    ).toBe("unknown");
  });

  it("fences terminal release when direct input was observed after settlement", () => {
    const state = createOrchestrationInputBrokerState();
    observeDirectTerminalInput(state, Date.parse("2026-09-20T00:00:02.000Z"));

    expect(
      directTerminalInputObservedAtOrAfter(state, "2026-09-20T00:00:01.000Z")
    ).toBe(true);
    expect(
      directTerminalInputObservedAtOrAfter(state, "2026-09-20T00:00:03.000Z")
    ).toBe(false);
  });
});
