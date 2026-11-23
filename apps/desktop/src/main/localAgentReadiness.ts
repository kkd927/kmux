import type {
  AgentReadinessReceipt,
  TerminalExecutionRef
} from "@kmux/orchestration";
import type { NormalizedAgentEvent, TerminalSessionRef } from "@kmux/proto";
import type { AgentTerminalReadiness } from "@kmux/agents";

export const DEFAULT_AGENT_READINESS_TIMEOUT_MS = 60_000;

interface ReadyInstance {
  readonly receipt: AgentReadinessReceipt;
  readonly state: "available" | "claimed" | "invalidated";
}

export type AgentTuiObservation =
  | (Exclude<AgentTerminalReadiness, null> & {
      readonly observationId?: string;
    })
  | null;

const BLOCKED_TUI_STABILITY_MS = 1_500;

export class AgentReadinessBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentReadinessBlockedError";
  }
}

interface ReadinessWaiter {
  readonly sessionId: string;
  readonly executionIdentity: string;
  readonly agentId: string;
  readonly excludedReceiptIds: ReadonlySet<string>;
  readonly observedAfter?: string;
  readonly resolve: (receipt: AgentReadinessReceipt) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly cleanup: () => void;
}

export class LocalAgentReadinessRegistry {
  private readonly instances = new Map<string, ReadyInstance>();
  private readonly waiters = new Set<ReadinessWaiter>();
  private readonly tuiReadyLatches = new Map<string, string | null>();
  private readySequence = 0;

  constructor(
    private readonly options: {
      readonly targetAuthority: string;
      readonly sessionRef: (
        surfaceId: string,
        sessionId: string
      ) => TerminalSessionRef | null;
      readonly observeTui?: (
        execution: TerminalExecutionRef,
        agentId: string
      ) => Promise<AgentTuiObservation>;
    }
  ) {}

  observe(input: {
    readonly event: NormalizedAgentEvent;
    readonly authenticatedSessionId?: string;
  }): AgentReadinessReceipt | null {
    const surfaceId = input.event.surfaceId;
    const sessionId = input.event.sessionId;
    if (
      !surfaceId ||
      !sessionId ||
      input.authenticatedSessionId !== sessionId
    ) {
      return null;
    }
    const session = this.options.sessionRef(surfaceId, sessionId);
    if (!session) return null;
    const execution: TerminalExecutionRef = {
      targetId: "local",
      targetAuthority: this.options.targetAuthority,
      surfaceId,
      sessionId,
      generation: { kind: "local", runtimeEpoch: session.epoch },
      inputAuthorityRef: "unclaimed"
    };
    const key = identity(execution);
    const current = this.instances.get(key);
    if (
      input.event.event === "needs_input" ||
      input.event.event === "session_end" ||
      (input.event.vendorSessionId &&
        current?.receipt.verifiedProviderSessionId &&
        input.event.vendorSessionId !==
          current.receipt.verifiedProviderSessionId)
    ) {
      this.tuiReadyLatches.delete(key);
      if (!current || current.receipt.agentId !== input.event.agent)
        return null;
      this.instances.set(key, { ...current, state: "invalidated" });
      return null;
    }
    if (input.event.event !== "idle" && input.event.event !== "turn_complete") {
      this.tuiReadyLatches.delete(key);
      return null;
    }
    const receipt: AgentReadinessReceipt = {
      receiptId: `readiness:${sessionId}:${++this.readySequence}`,
      execution,
      agentId: input.event.agent,
      agentInstanceId: `agent-instance:${sessionId}`,
      readyEpoch: `ready:${this.readySequence}`,
      ...(input.event.vendorSessionId
        ? { verifiedProviderSessionId: input.event.vendorSessionId }
        : {}),
      state: "ready-for-input",
      observedAt: new Date().toISOString()
    };
    this.instances.set(key, { receipt, state: "available" });
    if (!this.tuiReadyLatches.has(key)) this.tuiReadyLatches.set(key, null);
    this.notify(receipt);
    return receipt;
  }

  current(input: {
    readonly execution: TerminalExecutionRef;
    readonly agentId: string;
    readonly excludedReceiptIds?: ReadonlySet<string>;
    readonly observedAfter?: string;
  }): AgentReadinessReceipt | null {
    if (!this.isCurrentExecution(input.execution)) return null;
    const instance = this.instances.get(identity(input.execution));
    const receipt = instance?.receipt;
    if (
      !instance ||
      !receipt ||
      instance.state !== "available" ||
      receipt.agentId !== input.agentId ||
      input.excludedReceiptIds?.has(receipt.receiptId) ||
      (input.observedAfter !== undefined &&
        receipt.observedAt <= input.observedAfter)
    ) {
      return null;
    }
    return withInputAuthority(receipt, input.execution.inputAuthorityRef);
  }

  /** Best-effort nudges must not wait for a busy Worker to finish its task. */
  async claimReadyNow(input: {
    readonly execution: TerminalExecutionRef;
    readonly agentId: string;
    readonly excludedReceiptIds?: ReadonlySet<string>;
  }): Promise<AgentReadinessReceipt | null> {
    if (!this.isCurrentExecution(input.execution)) return null;
    const observation = await this.options.observeTui?.(
      input.execution,
      input.agentId
    );
    if (!this.isCurrentExecution(input.execution)) return null;
    const key = identity(input.execution);
    if (this.options.observeTui && observation?.state !== "ready") {
      this.invalidate(key);
      return null;
    }
    const current = this.current(input);
    if (current && this.claim(current)) {
      if (observation?.state === "ready") {
        this.tuiReadyLatches.set(key, observation.observationId ?? null);
      }
      return current;
    }
    if (
      observation?.state !== "ready" ||
      (this.tuiReadyLatches.has(key) &&
        this.tuiReadyLatches.get(key) === (observation.observationId ?? null))
    )
      return null;
    const receipt: AgentReadinessReceipt = {
      receiptId: `readiness:${input.execution.sessionId}:${++this.readySequence}`,
      execution: input.execution,
      agentId: input.agentId,
      agentInstanceId: `agent-instance:${input.execution.sessionId}`,
      readyEpoch: `ready:${this.readySequence}`,
      state: "ready-for-input",
      observedAt: new Date().toISOString()
    };
    this.instances.set(key, { receipt, state: "claimed" });
    this.tuiReadyLatches.set(key, observation.observationId ?? null);
    return receipt;
  }

  /** Return a reservation only when no terminal input was attempted. */
  releaseUnused(receipt: AgentReadinessReceipt): void {
    if (!this.isCurrentExecution(receipt.execution)) return;
    const key = identity(receipt.execution);
    const current = this.instances.get(key);
    if (
      current?.state !== "claimed" ||
      current.receipt.receiptId !== receipt.receiptId
    )
      return;
    // Keep the same receipt: durable deliveries still exclude it. Releasing
    // preparation must never manufacture a fresh epoch for a used input.
    this.instances.set(key, { ...current, state: "available" });
    this.notify(current.receipt);
  }

  waitForReadiness(input: {
    readonly execution: TerminalExecutionRef;
    readonly agentId: string;
    readonly excludedReceiptIds?: ReadonlySet<string>;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly observedAfter?: string;
  }): Promise<AgentReadinessReceipt> {
    input.signal?.throwIfAborted();
    if (!this.isCurrentExecution(input.execution)) {
      return Promise.reject(
        new Error("Agent terminal generation changed before readiness")
      );
    }
    const current = this.current(input);
    if (current && this.claim(current)) return Promise.resolve(current);
    const timeoutMs = input.timeoutMs ?? DEFAULT_AGENT_READINESS_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      let blockedSince: number | undefined;
      let blockedReason: string | undefined;
      let settled = false;
      const finish = (result: {
        readonly receipt?: AgentReadinessReceipt;
        readonly error?: Error;
      }) => {
        if (settled) return;
        settled = true;
        this.waiters.delete(waiter);
        clearTimeout(waiter.timeout);
        if (pollTimer) clearTimeout(pollTimer);
        waiter.cleanup();
        if (result.error) reject(result.error);
        else if (result.receipt)
          resolve(
            withInputAuthority(
              result.receipt,
              input.execution.inputAuthorityRef
            )
          );
      };
      const abort = () => {
        finish({
          error:
            input.signal?.reason ?? new Error("Agent readiness wait canceled")
        });
      };
      const waiter: ReadinessWaiter = {
        sessionId: input.execution.sessionId,
        executionIdentity: identity(input.execution),
        agentId: input.agentId,
        excludedReceiptIds: input.excludedReceiptIds ?? new Set(),
        observedAfter: input.observedAfter,
        cleanup: () => input.signal?.removeEventListener("abort", abort),
        resolve: (receipt) => finish({ receipt }),
        reject: (error) => finish({ error }),
        timeout: setTimeout(() => {
          finish({
            error: new Error("timed out waiting for Agent CLI input readiness")
          });
        }, timeoutMs)
      };
      waiter.timeout.unref?.();
      this.waiters.add(waiter);
      input.signal?.addEventListener("abort", abort, { once: true });
      const poll = async () => {
        if (settled || !this.options.observeTui) return;
        try {
          const observation = await this.options.observeTui(
            input.execution,
            input.agentId
          );
          if (settled) return;
          if (!this.isCurrentExecution(input.execution)) {
            finish({
              error: new Error(
                "Agent terminal generation changed before readiness"
              )
            });
            return;
          }
          if (observation?.state !== "ready") {
            this.invalidate(identity(input.execution));
          }
          if (observation?.state === "blocked") {
            const observedAt = Date.now();
            if (blockedReason !== observation.reason) {
              blockedReason = observation.reason;
              blockedSince = observedAt;
            } else if (
              blockedSince !== undefined &&
              observedAt - blockedSince >= BLOCKED_TUI_STABILITY_MS
            ) {
              finish({
                error: new AgentReadinessBlockedError(observation.reason)
              });
              return;
            }
          } else {
            blockedSince = undefined;
            blockedReason = undefined;
          }
          const executionIdentity = identity(input.execution);
          const priorObservationId =
            this.tuiReadyLatches.get(executionIdentity);
          if (
            observation?.state === "ready" &&
            (!this.tuiReadyLatches.has(executionIdentity) ||
              (observation.observationId !== undefined &&
                observation.observationId !== priorObservationId))
          ) {
            const receipt: AgentReadinessReceipt = {
              receiptId: `readiness:${input.execution.sessionId}:${++this.readySequence}`,
              execution: input.execution,
              agentId: input.agentId,
              agentInstanceId: `agent-instance:${input.execution.sessionId}`,
              readyEpoch: `ready:${this.readySequence}`,
              state: "ready-for-input",
              observedAt: new Date().toISOString()
            };
            this.instances.set(identity(input.execution), {
              receipt,
              state: "available"
            });
            this.tuiReadyLatches.set(
              executionIdentity,
              observation.observationId ?? null
            );
            this.notify(receipt);
            if (settled) return;
          }
        } catch {
          // A missing snapshot is not evidence of readiness or failure.
        }
        pollTimer = setTimeout(poll, 250);
        pollTimer.unref?.();
      };
      pollTimer = setTimeout(poll, 500);
      pollTimer.unref?.();
    });
  }

  forgetSession(sessionId: string): void {
    for (const [key, instance] of this.instances) {
      if (instance.receipt.execution.sessionId === sessionId) {
        this.instances.delete(key);
        this.tuiReadyLatches.delete(key);
      }
    }
    for (const waiter of this.waiters) {
      if (waiter.sessionId !== sessionId) continue;
      this.waiters.delete(waiter);
      clearTimeout(waiter.timeout);
      waiter.cleanup();
      waiter.reject(new Error("Agent terminal exited before readiness"));
    }
  }

  clear(): void {
    this.instances.clear();
    this.tuiReadyLatches.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timeout);
      waiter.cleanup();
      waiter.reject(new Error("Agent readiness registry was stopped"));
    }
    this.waiters.clear();
  }

  private notify(receipt: AgentReadinessReceipt): void {
    const receiptIdentity = identity(receipt.execution);
    for (const waiter of [...this.waiters]) {
      if (
        waiter.executionIdentity !== receiptIdentity ||
        waiter.agentId !== receipt.agentId ||
        waiter.excludedReceiptIds.has(receipt.receiptId) ||
        (waiter.observedAfter !== undefined &&
          receipt.observedAt <= waiter.observedAfter)
      ) {
        continue;
      }
      if (!this.claim(receipt)) return;
      this.waiters.delete(waiter);
      clearTimeout(waiter.timeout);
      waiter.cleanup();
      waiter.resolve(receipt);
      return;
    }
  }

  private claim(receipt: AgentReadinessReceipt): boolean {
    const key = identity(receipt.execution);
    const instance = this.instances.get(key);
    if (
      !instance ||
      instance.state !== "available" ||
      instance.receipt.receiptId !== receipt.receiptId
    ) {
      return false;
    }
    this.instances.set(key, { ...instance, state: "claimed" });
    return true;
  }

  private invalidate(key: string): void {
    this.tuiReadyLatches.delete(key);
    const current = this.instances.get(key);
    if (current) this.instances.set(key, { ...current, state: "invalidated" });
  }

  private isCurrentExecution(execution: TerminalExecutionRef): boolean {
    const session = this.options.sessionRef(
      execution.surfaceId,
      execution.sessionId
    );
    return (
      execution.targetId === "local" &&
      execution.targetAuthority === this.options.targetAuthority &&
      execution.generation.kind === "local" &&
      session?.epoch === execution.generation.runtimeEpoch &&
      session.sessionId === execution.sessionId &&
      session.surfaceId === execution.surfaceId
    );
  }
}

function identity(execution: TerminalExecutionRef): string {
  if (execution.generation.kind !== "local") return "remote:unsupported";
  return [
    execution.targetAuthority,
    execution.surfaceId,
    execution.sessionId,
    execution.generation.runtimeEpoch
  ].join("|");
}

function withInputAuthority(
  receipt: AgentReadinessReceipt,
  inputAuthorityRef: string
): AgentReadinessReceipt {
  return {
    ...receipt,
    execution: { ...receipt.execution, inputAuthorityRef }
  };
}
