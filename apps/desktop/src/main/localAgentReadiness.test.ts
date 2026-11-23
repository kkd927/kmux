import { describe, expect, it, vi } from "vitest";

import {
  LocalAgentReadinessRegistry,
  type AgentTuiObservation
} from "./localAgentReadiness";

const execution = {
  targetId: "local",
  targetAuthority: "desktop:1",
  surfaceId: "surface:1",
  sessionId: "session:1",
  generation: { kind: "local" as const, runtimeEpoch: "epoch:1" },
  inputAuthorityRef: "authority:1"
};

const event = {
  surfaceId: execution.surfaceId,
  sessionId: execution.sessionId,
  agent: "antigravity",
  event: "idle" as const
};

function registry(
  observeTui?: ConstructorParameters<
    typeof LocalAgentReadinessRegistry
  >[0]["observeTui"]
) {
  return new LocalAgentReadinessRegistry({
    targetAuthority: "desktop:1",
    sessionRef: (surfaceId, sessionId) => ({
      surfaceId,
      sessionId,
      epoch: execution.generation.runtimeEpoch
    }),
    observeTui
  });
}

describe("LocalAgentReadinessRegistry", () => {
  it("discards a TUI observation returned after its readiness wait timed out", async () => {
    vi.useFakeTimers();
    try {
      const observation = Promise.withResolvers<AgentTuiObservation>();
      const subject = registry(() => observation.promise);
      const waiting = subject.waitForReadiness({
        execution,
        agentId: event.agent,
        timeoutMs: 1_000
      });
      const rejected = expect(waiting).rejects.toThrow(/timed out/u);
      await vi.advanceTimersByTimeAsync(1_000);
      await rejected;
      observation.resolve({ state: "ready", observationId: "late:1" });
      await vi.advanceTimersByTimeAsync(0);
      expect(subject.current({ execution, agentId: event.agent })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  it("skips a busy nudge immediately and claims a ready screen only once", async () => {
    const observeTui = vi
      .fn<
        NonNullable<
          ConstructorParameters<
            typeof LocalAgentReadinessRegistry
          >[0]["observeTui"]
        >
      >()
      .mockResolvedValue(null);
    const subject = registry(observeTui);
    // A prior hook is not enough when the live TUI is busy again.
    subject.observe({ event, authenticatedSessionId: event.sessionId });
    await expect(
      subject.claimReadyNow({ execution, agentId: event.agent })
    ).resolves.toBeNull();
    observeTui.mockResolvedValue({ state: "ready", observationId: "ready:1" });
    await expect(
      subject.claimReadyNow({ execution, agentId: event.agent })
    ).resolves.toMatchObject({ state: "ready-for-input" });
    await expect(
      subject.claimReadyNow({ execution, agentId: event.agent })
    ).resolves.toBeNull();
  });

  it("derives readiness from an authenticated ordinary Agent hook and invalidates it on input", () => {
    const subject = registry();
    expect(
      subject.observe({ event, authenticatedSessionId: "another-session" })
    ).toBeNull();
    expect(
      subject.observe({ event, authenticatedSessionId: event.sessionId })
    ).toMatchObject({ agentId: event.agent, state: "ready-for-input" });
    expect(subject.current({ execution, agentId: event.agent })).toMatchObject({
      execution: { inputAuthorityRef: execution.inputAuthorityRef }
    });
    subject.observe({
      event: { ...event, event: "needs_input" },
      authenticatedSessionId: event.sessionId
    });
    expect(subject.current({ execution, agentId: event.agent })).toBeNull();
  });

  it("does not treat process start as proof that the Agent accepts task input", () => {
    const subject = registry();
    expect(
      subject.observe({
        event: { ...event, event: "session_start" },
        authenticatedSessionId: event.sessionId
      })
    ).toBeNull();
    expect(subject.current({ execution, agentId: event.agent })).toBeNull();
  });

  it("issues a new epoch for a later hook and never reuses an excluded receipt", async () => {
    const subject = registry();
    const first = subject.observe({
      event,
      authenticatedSessionId: event.sessionId
    })!;
    const waiting = subject.waitForReadiness({
      execution,
      agentId: event.agent,
      excludedReceiptIds: new Set([first.receiptId]),
      timeoutMs: 1_000
    });
    const second = subject.observe({
      event: { ...event, event: "turn_complete" },
      authenticatedSessionId: event.sessionId
    })!;
    expect(second.receiptId).not.toBe(first.receiptId);
    await expect(waiting).resolves.toMatchObject({
      receiptId: second.receiptId,
      execution: { inputAuthorityRef: execution.inputAuthorityRef }
    });
  });

  it("claims each readiness receipt for only one delivery waiter", async () => {
    const subject = registry();
    const firstWait = subject.waitForReadiness({
      execution,
      agentId: event.agent,
      timeoutMs: 1_000
    });
    const secondWait = subject.waitForReadiness({
      execution,
      agentId: event.agent,
      timeoutMs: 1_000
    });
    const first = subject.observe({
      event,
      authenticatedSessionId: event.sessionId
    })!;
    await expect(firstWait).resolves.toMatchObject({
      receiptId: first.receiptId
    });
    expect(subject.current({ execution, agentId: event.agent })).toBeNull();

    const second = subject.observe({
      event: { ...event, event: "turn_complete" },
      authenticatedSessionId: event.sessionId
    })!;
    await expect(secondWait).resolves.toMatchObject({
      receiptId: second.receiptId
    });
  });

  it("returns an unused reservation without creating a new readiness epoch", async () => {
    vi.useFakeTimers();
    try {
      const subject = registry(async () => ({
        state: "ready",
        observationId: "idle:1"
      }));
      const waiting = subject.waitForReadiness({
        execution,
        agentId: event.agent
      });
      await vi.advanceTimersByTimeAsync(500);
      const receipt = await waiting;
      subject.releaseUnused(receipt);
      await expect(
        subject.waitForReadiness({ execution, agentId: event.agent })
      ).resolves.toMatchObject({
        receiptId: receipt.receiptId
      });
      subject.releaseUnused(receipt);
      const used = subject.waitForReadiness({
        execution,
        agentId: event.agent,
        excludedReceiptIds: new Set([receipt.receiptId]),
        timeoutMs: 1_000
      });
      const excluded = expect(used).rejects.toThrow(/timed out/u);
      await vi.advanceTimersByTimeAsync(1_000);
      await excluded;
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["blocked", "superseded", "replaced"] as const)(
    "does not restore a %s readiness reservation",
    async (mode) => {
      let epoch = "epoch:1";
      const subject = new LocalAgentReadinessRegistry({
        targetAuthority: "desktop:1",
        sessionRef: (surfaceId, sessionId) => ({ surfaceId, sessionId, epoch })
      });
      subject.observe({ event, authenticatedSessionId: event.sessionId });
      const receipt = await subject.waitForReadiness({
        execution,
        agentId: event.agent
      });
      if (mode === "blocked") {
        subject.observe({
          event: { ...event, event: "needs_input" },
          authenticatedSessionId: event.sessionId
        });
      } else if (mode === "superseded") {
        const newer = subject.observe({
          event,
          authenticatedSessionId: event.sessionId
        })!;
        await expect(
          subject.waitForReadiness({ execution, agentId: event.agent })
        ).resolves.toMatchObject({
          receiptId: newer.receiptId
        });
      } else epoch = "epoch:2";
      subject.releaseUnused(receipt);
      expect(subject.current({ execution, agentId: event.agent })).toBeNull();
    }
  );

  it("does not restore a reservation after the live TUI stops accepting input", async () => {
    const subject = registry(async () => ({
      state: "blocked",
      reason: "Login required"
    }));
    subject.observe({ event, authenticatedSessionId: event.sessionId });
    const receipt = await subject.waitForReadiness({
      execution,
      agentId: event.agent
    });
    await expect(
      subject.claimReadyNow({ execution, agentId: event.agent })
    ).resolves.toBeNull();
    subject.releaseUnused(receipt);
    expect(subject.current({ execution, agentId: event.agent })).toBeNull();
  });

  it("keeps polling when the first ready observation predates input intervention", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
    try {
      const subject = registry(async () => ({
        state: "ready",
        observationId: String(Date.now())
      }));
      const waiting = subject.waitForReadiness({
        execution,
        agentId: event.agent,
        observedAfter: "2026-08-26T00:00:00.600Z",
        timeoutMs: 1_000
      });
      await vi.advanceTimersByTimeAsync(750);
      await expect(waiting).resolves.toMatchObject({
        observedAt: "2026-08-26T00:00:00.750Z"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires the polled TUI to leave readiness before issuing another receipt", async () => {
    vi.useFakeTimers();
    try {
      let observation: AgentTuiObservation = {
        state: "ready"
      };
      const subject = registry(async () => observation);
      const firstWait = subject.waitForReadiness({
        execution,
        agentId: event.agent,
        timeoutMs: 2_000
      });
      const secondWait = subject.waitForReadiness({
        execution,
        agentId: event.agent,
        timeoutMs: 2_000
      });

      await vi.advanceTimersByTimeAsync(500);
      const first = await firstWait;
      expect(first.receiptId).toBeTruthy();

      observation = null;
      await vi.advanceTimersByTimeAsync(250);
      observation = { state: "ready" };
      await vi.advanceTimersByTimeAsync(250);
      await expect(secondWait).resolves.not.toMatchObject({
        receiptId: first.receiptId
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts a new TUI receipt after an excluded hook receipt", async () => {
    vi.useFakeTimers();
    try {
      const subject = registry(async () => ({
        state: "ready",
        observationId: "sequence:2"
      }));
      const hook = subject.observe({
        event,
        authenticatedSessionId: event.sessionId
      })!;
      const waiting = subject.waitForReadiness({
        execution,
        agentId: event.agent,
        excludedReceiptIds: new Set([hook.receiptId]),
        timeoutMs: 1_000
      });
      await vi.advanceTimersByTimeAsync(500);
      await expect(waiting).resolves.not.toMatchObject({
        receiptId: hook.receiptId
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts a later ready TUI snapshot when terminal output advanced", async () => {
    vi.useFakeTimers();
    try {
      let observation = {
        state: "ready" as const,
        observationId: "sequence:1"
      };
      const subject = registry(async () => observation);
      const firstWait = subject.waitForReadiness({
        execution,
        agentId: event.agent,
        timeoutMs: 2_000
      });
      await vi.advanceTimersByTimeAsync(500);
      const first = await firstWait;

      const secondWait = subject.waitForReadiness({
        execution,
        agentId: event.agent,
        timeoutMs: 2_000
      });
      await vi.advanceTimersByTimeAsync(500);
      observation = { state: "ready", observationId: "sequence:2" };
      await vi.advanceTimersByTimeAsync(250);
      await expect(secondWait).resolves.not.toMatchObject({
        receiptId: first.receiptId
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("distinguishes a visible login block from an input-ready TUI", async () => {
    vi.useFakeTimers();
    try {
      const blocked = registry(async () => ({
        state: "blocked",
        reason: "Agent CLI is waiting for login"
      }));
      const blockedWait = blocked.waitForReadiness({
        execution,
        agentId: event.agent,
        timeoutMs: 3_000
      });
      const blockedExpectation = expect(blockedWait).rejects.toThrow(/login/u);
      await vi.advanceTimersByTimeAsync(2_000);
      await blockedExpectation;

      const ready = registry(async () => ({ state: "ready" }));
      const readyWait = ready.waitForReadiness({
        execution,
        agentId: event.agent,
        timeoutMs: 1_000
      });
      await vi.advanceTimersByTimeAsync(500);
      await expect(readyWait).resolves.toMatchObject({
        agentId: event.agent,
        state: "ready-for-input"
      });

      const observations = [
        { state: "blocked" as const, reason: "Signing in" },
        { state: "ready" as const }
      ];
      const transient = registry(async () => observations.shift() ?? null);
      const transientWait = transient.waitForReadiness({
        execution,
        agentId: event.agent,
        timeoutMs: 2_000
      });
      await vi.advanceTimersByTimeAsync(750);
      await expect(transientWait).resolves.toMatchObject({
        agentId: event.agent,
        state: "ready-for-input"
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
