import type {
  AgentLaunchReceipt,
  AgentReadinessReceipt,
  AttemptInputControl,
  ContentHash,
  JsonValue,
  NodeAttempt,
  PromptDelivery,
  RepositoryStateRef,
  TerminalExecutionRef,
  WorkflowRun
} from "@kmux/orchestration";
import {
  assertRuntimeInputAuthority,
  canonicalJson,
  contentHash,
  terminalExecutionIdentity
} from "@kmux/orchestration";

import type { PtyHostManager } from "./ptyHost";
import type { AgentSessionTranscriptReadResult } from "@kmux/agents";
import { boundWorkerOutput } from "@kmux/orchestration/node";
import {
  AgentReadinessBlockedError,
  type LocalAgentReadinessRegistry
} from "./localAgentReadiness";

export interface LocalAgentSurfaceBinding {
  readonly execution: TerminalExecutionRef;
  readonly cwd: string;
  readonly launchReceipt: AgentLaunchReceipt;
  /** Fresh launches run only after the exact Surface identity is durable. */
  readonly start?: () => Promise<void>;
  readonly priorOwnership?: {
    readonly owner: "user" | "runtime";
    readonly mode?: "orchestrated" | "interactive-recorded";
    readonly consentReceiptId?: string;
  };
}

export interface LocalAgentExecutorMutationPort {
  observePreparationInput(input: {
    readonly attemptId: string;
    readonly execution: TerminalExecutionRef;
    readonly onChange: (control: AttemptInputControl | null) => void;
  }): Promise<() => void>;
  persistInputControl(input: {
    readonly attemptId: string;
    readonly execution: TerminalExecutionRef;
    readonly launchReceipt: AgentLaunchReceipt;
    readonly priorOwnership?: LocalAgentSurfaceBinding["priorOwnership"];
  }): Promise<void>;
  persistPending(input: {
    readonly attemptId: string;
    readonly execution: TerminalExecutionRef;
    readonly readiness: AgentReadinessReceipt;
    readonly expectedInputControlRevision: number;
    readonly payloadHash: ContentHash;
    readonly repositoryStateInput?: RepositoryStateRef;
    readonly operationId: string;
  }): Promise<PromptDelivery>;
  settleDelivery(input: {
    readonly operationId: string;
    readonly payloadHash: ContentHash;
    readonly outcome: "written" | "uncertain" | "fenced" | "failed";
    readonly receiptId?: string;
    readonly launchReceipt?: AgentLaunchReceipt;
  }): Promise<void>;
  markPreparationFailed(input: {
    readonly attemptId: string;
    readonly reason: string;
    readonly code?: string;
  }): Promise<void>;
  markPreparationNeedsAttention(input: {
    readonly attemptId: string;
    readonly code: string;
    readonly reason: string;
  }): Promise<void>;
}

export class AgentPreparationError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AgentPreparationError";
  }
}

export class AgentPreparationNeedsAttentionError extends AgentPreparationError {}

/** Session reuse policy does not transfer ownership of an existing terminal. */
export function ownsAgentTerminal(
  run: WorkflowRun,
  attemptId: string
): boolean {
  const control = run.inputControls[attemptId];
  const attempt = run.attempts[attemptId];
  const execution = attempt?.dispatchId
    ? run.dispatches[attempt.dispatchId]?.execution
    : undefined;
  if (!control || !execution || control.priorOwner !== "runtime") return false;
  const identity = terminalExecutionIdentity(execution);
  if (terminalExecutionIdentity(control.execution) !== identity) return false;
  // Retain the original ownership even when older persisted reuse receipts
  // predate propagation of that ownership to each subsequent Dispatch.
  return !Object.values(run.inputControls).some(
    (entry) =>
      terminalExecutionIdentity(entry.execution) === identity &&
      entry.priorOwner === "user"
  );
}

export class LocalAgentNodeExecutor {
  constructor(
    private readonly options: {
      readonly ptyHost: PtyHostManager;
      readonly readiness: LocalAgentReadinessRegistry;
      readonly readTranscript?: (input: {
        readonly run: WorkflowRun;
        readonly dispatchId: string;
      }) => Promise<AgentSessionTranscriptReadResult>;
      readonly capabilitiesForAgent?: (
        agentId: string
      ) => readonly string[] | undefined;
      readonly bindSurface: (input: {
        readonly run: WorkflowRun;
        readonly attempt: NodeAttempt;
      }) => Promise<LocalAgentSurfaceBinding>;
      readonly captureRepositoryState: (input: {
        readonly cwd: string;
        readonly execution: TerminalExecutionRef;
        readonly phase: "input" | "result";
      }) => Promise<RepositoryStateRef | undefined>;
      readonly mutations: LocalAgentExecutorMutationPort;
      readonly id: (kind: string) => string;
      readonly readinessTimeoutMs?: number;
      readonly lastUserInputAt?: (
        execution: TerminalExecutionRef
      ) => string | undefined;
      /** Remove the released kmux-owned Surface after its exact PTY is gone. */
      readonly removeReleasedSurface?: (
        execution: TerminalExecutionRef
      ) => void;
    }
  ) {}

  async execute(input: {
    readonly run: WorkflowRun;
    readonly attemptId: string;
  }): Promise<void> {
    const attempt = input.run.attempts[input.attemptId];
    const node = attempt ? input.run.graph.nodes[attempt.nodeId] : undefined;
    const dispatch = attempt?.dispatchId
      ? input.run.dispatches[attempt.dispatchId]
      : undefined;
    if (!attempt || !node || !dispatch || node.definition.kind !== "agent") {
      throw new Error("Agent executor received a non-Agent attempt");
    }
    const requiredCapabilities = [
      ...(dispatch.requestedBinding.capabilities ?? []),
      ...(dispatch.requestedBinding.agent.kind === "run-input"
        ? (dispatch.requestedBinding.agent.requiredCapabilities ?? [])
        : [])
    ];
    const availableCapabilities =
      this.options.capabilitiesForAgent?.(dispatch.selectedAgentId) ?? [];
    const unsupported = [...new Set(requiredCapabilities)].filter(
      (capability) => !availableCapabilities.includes(capability)
    );
    if (unsupported.length > 0) {
      await this.options.mutations.markPreparationFailed({
        attemptId: attempt.attemptId,
        code: "agent-capability-unsupported",
        reason: `Agent '${dispatch.selectedAgentId}' does not advertise required execution capabilities: ${unsupported.join(", ")}`
      });
      return;
    }
    if (dispatch.requestedBinding.targetPolicy !== "local") {
      await this.options.mutations.markPreparationFailed({
        attemptId: attempt.attemptId,
        code: "agent-target-unsupported",
        reason:
          "SSH Agent execution is not enabled until the Phase 6 target gate"
      });
      return;
    }
    if (dispatch.requestedBinding.authorityMode !== "ambient") {
      await this.options.mutations.markPreparationFailed({
        attemptId: attempt.attemptId,
        code: "agent-authority-unsupported",
        reason:
          "restricted local Agent authority is unsupported without an enforceable sandbox"
      });
      return;
    }
    if (
      ![
        "current",
        "from-input",
        "target-repository-new",
        "dedicated-child",
        "dedicated-top-level",
        "advisory-read-only"
      ].includes(dispatch.requestedBinding.worktreePolicy)
    ) {
      await this.options.mutations.markPreparationFailed({
        attemptId: attempt.attemptId,
        reason: `worktree placement '${dispatch.requestedBinding.worktreePolicy}' is unsupported by the local executor`
      });
      return;
    }
    if (dispatch.requestedBinding.allowSharedWrite) {
      await this.options.mutations.markPreparationFailed({
        attemptId: attempt.attemptId,
        reason:
          "shared-write Agent placement is unsupported; local v1 enforces an exclusive repository lease"
      });
      return;
    }
    if (
      dispatch.requestedBinding.worktreePolicy === "advisory-read-only" &&
      node.definition.kind === "agent" &&
      node.definition.config.coding
    ) {
      await this.options.mutations.markPreparationFailed({
        attemptId: attempt.attemptId,
        reason:
          "advisory read-only placement cannot run a write-capable Agent task"
      });
      return;
    }
    let preparationCode = "agent-admission-failed";
    const preparation = new PreparationInput();
    let unsubscribe: (() => void) | undefined;
    try {
      const binding = await this.options.bindSurface({
        run: input.run,
        attempt
      });
      if (binding.execution.generation.kind !== "local") {
        throw new Error("local Agent executor received a remote generation");
      }
      const session = {
        surfaceId: binding.execution.surfaceId,
        sessionId: binding.execution.sessionId,
        runtimeEpoch: binding.execution.generation.runtimeEpoch
      };
      await this.options.mutations.persistInputControl({
        attemptId: attempt.attemptId,
        execution: binding.execution,
        launchReceipt: binding.launchReceipt,
        ...(binding.priorOwnership
          ? { priorOwnership: binding.priorOwnership }
          : {})
      });
      unsubscribe = await this.options.mutations.observePreparationInput({
        attemptId: attempt.attemptId,
        execution: binding.execution,
        onChange: (control) => preparation.observe(control)
      });
      preparationCode = "agent-launch-failed";
      await binding.start?.();

      const excluded = new Set(
        Object.values(input.run.deliveries)
          .filter(
            (delivery) =>
              delivery.execution.surfaceId === binding.execution.surfaceId &&
              delivery.execution.sessionId === binding.execution.sessionId
          )
          .map((delivery) => delivery.readinessReceiptId)
      );
      const prompt = formatWorkerTaskPrompt({
        run: input.run,
        attempt,
        taskPrompt:
          !node.definition.config.coding ||
          dispatch.requestedBinding.worktreePolicy === "advisory-read-only"
            ? `Use this shared worktree for read-only inspection. Do not modify files or Git state.\n\n${node.definition.config.prompt}`
            : node.definition.config.prompt
      });
      const payloadHash = contentHash(prompt);
      const operationId = this.options.id("prompt-delivery");
      let readiness: AgentReadinessReceipt;
      for (;;) {
        const { control, signal } = await preparation.waitForRuntime();
        let reserved: AgentReadinessReceipt | undefined;
        let pending = false;
        try {
          preparationCode = "agent-readiness-failed";
          readiness = await this.options.readiness.waitForReadiness({
            execution: binding.execution,
            agentId: dispatch.selectedAgentId,
            excludedReceiptIds: excluded,
            timeoutMs: this.options.readinessTimeoutMs,
            signal,
            observedAfter: control.readinessInvalidatedAt
          });
          reserved = readiness;
          signal.throwIfAborted();
          const registered = await this.options.ptyHost.registerAgentReadiness({
            session,
            authorityRef: binding.execution.inputAuthorityRef,
            receiptId: readiness.receiptId,
            agentId: readiness.agentId,
            agentInstanceId: readiness.agentInstanceId,
            readyEpoch: readiness.readyEpoch
          });
          if (registered.outcome !== "registered") {
            throw new Error(`Agent readiness was ${registered.outcome}`);
          }

          preparationCode = "repository-state-capture-failed";
          const repositoryStateInput =
            await this.options.captureRepositoryState({
              cwd: binding.cwd,
              execution: binding.execution,
              phase: "input"
            });
          signal.throwIfAborted();
          preparationCode = "agent-prompt-delivery-failed";
          await this.options.mutations.persistPending({
            attemptId: attempt.attemptId,
            execution: binding.execution,
            readiness,
            expectedInputControlRevision: control.revision,
            payloadHash,
            ...(repositoryStateInput ? { repositoryStateInput } : {}),
            operationId
          });
          pending = true;
          break;
        } catch (error) {
          // No delivery intent was committed: only a changed input revision
          // permits another preparation pass, never a second CLI launch.
          if (signal.aborted) continue;
          throw error;
        } finally {
          if (reserved && !pending)
            this.options.readiness.releaseUnused(reserved);
        }
      }
      await this.deliver({
        session,
        authorityRef: binding.execution.inputAuthorityRef,
        readiness,
        operationId,
        payloadHash,
        prompt,
        verificationText: dispatchMarker(dispatch.dispatchId)
      });
    } catch (error) {
      if (
        error instanceof PreparationEndedError ||
        preparation.control === null
      )
        return;
      if (error instanceof AgentReadinessBlockedError) {
        await this.options.mutations.markPreparationNeedsAttention({
          attemptId: attempt.attemptId,
          code: "agent-input-required",
          reason: error.message
        });
        return;
      }
      if (error instanceof AgentPreparationNeedsAttentionError) {
        await this.options.mutations.markPreparationNeedsAttention({
          attemptId: attempt.attemptId,
          code: error.code,
          reason: error.message
        });
        return;
      }
      await this.options.mutations.markPreparationFailed({
        attemptId: attempt.attemptId,
        code:
          error instanceof AgentPreparationError ? error.code : preparationCode,
        reason: error instanceof Error ? error.message : String(error)
      });
    } finally {
      unsubscribe?.();
      preparation.dispose();
    }
  }

  async readWorker(input: {
    readonly run: WorkflowRun;
    readonly dispatchId: string;
    readonly lines: number;
    readonly maxBytes: number;
  }): Promise<JsonValue> {
    const dispatch = input.run.dispatches[input.dispatchId];
    const execution = dispatch?.execution;
    if (!dispatch || !execution || execution.generation.kind !== "local") {
      return {
        dispatchId: input.dispatchId,
        source: null,
        status: "missing",
        truncated: false,
        vt: "",
        reason: "Worker has no exact local terminal execution"
      };
    }
    const runtimeEpoch = execution.generation.runtimeEpoch;
    const isCurrent = () =>
      this.options.ptyHost.sessionRef(execution.surfaceId, execution.sessionId)
        ?.epoch === runtimeEpoch;
    const base = {
      dispatchId: dispatch.dispatchId,
      surfaceId: execution.surfaceId,
      sessionId: execution.sessionId,
      capturedAt: new Date().toISOString()
    };
    const missing = () => ({
      ...base,
      source: null,
      status: "missing",
      truncated: false,
      vt: "",
      reason: "Worker terminal generation is no longer current"
    });
    if (!isCurrent()) return missing();
    let transcript: AgentSessionTranscriptReadResult;
    try {
      transcript = (await this.options.readTranscript?.({
        run: input.run,
        dispatchId: input.dispatchId
      })) ?? {
        status: "unsupported",
        text: "",
        truncated: false,
        reason: "provider transcript reader is unavailable"
      };
    } catch (error) {
      transcript = {
        status: "unreadable",
        text: "",
        truncated: false,
        reason: error instanceof Error ? error.message : String(error)
      };
    }
    if (!isCurrent()) return missing();
    if (transcript.status === "available" && transcript.text) {
      return boundWorkerOutput(
        {
          ...base,
          source: "transcript",
          status: "available",
          vt: transcript.text,
          truncated: transcript.truncated,
          ...(transcript.reason ? { reason: transcript.reason } : {})
        },
        input.lines,
        input.maxBytes
      );
    }
    if (dispatch.reusedByDispatchId) {
      return {
        ...base,
        source: transcript.status === "unsupported" ? null : "transcript",
        status: transcript.status === "unreadable" ? "unreadable" : "missing",
        transcriptStatus: transcript.status,
        vt: "",
        truncated: transcript.truncated,
        reason: `Requested Dispatch history is unavailable after terminal reuse${transcript.reason ? `: ${transcript.reason}` : ""}`
      };
    }
    const fallback = {
      transcriptStatus: transcript.status,
      ...(transcript.reason ? { fallbackReason: transcript.reason } : {})
    };
    try {
      const snapshot = await this.options.ptyHost.snapshot(
        execution.sessionId,
        execution.surfaceId,
        // Archives need a coherent frame, not an idle CLI. Animated native
        // TUIs can keep emitting output after explicit worker-done.
        { timeoutMs: 2_000, includeRawOutputTail: true }
      );
      if (!isCurrent()) return missing();
      if (!snapshot)
        return {
          ...base,
          ...fallback,
          source: null,
          status: transcript.status === "unreadable" ? "unreadable" : "missing",
          vt: "",
          truncated: false,
          reason: "Worker terminal history is unavailable"
        };
      return boundWorkerOutput(
        {
          ...base,
          ...fallback,
          source: "terminal",
          vt: snapshot.vt,
          truncated: snapshot.rawOutputTailTruncated === true,
          ...(snapshot.cwd === undefined ? {} : { cwd: snapshot.cwd }),
          ...(snapshot.rawOutputTail === undefined
            ? {}
            : { rawOutputTail: snapshot.rawOutputTail })
        },
        input.lines,
        input.maxBytes
      );
    } catch (error) {
      return {
        ...base,
        ...fallback,
        source: "terminal",
        status: "unreadable",
        vt: "",
        truncated: false,
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async cancel(input: {
    readonly run: WorkflowRun;
    readonly attemptId: string;
  }): Promise<{ readonly executorReceiptId: string }> {
    const attempt = input.run.attempts[input.attemptId];
    const dispatch = attempt?.dispatchId
      ? input.run.dispatches[attempt.dispatchId]
      : undefined;
    const execution = dispatch?.execution;
    if (!attempt || !dispatch || !execution) {
      throw new Error("Agent cancellation has no exact terminal execution");
    }
    if (!ownsAgentTerminal(input.run, input.attemptId)) {
      throw new Error(
        "Agent cancellation requires proven kmux ownership of the terminal"
      );
    }
    if (execution.generation.kind !== "local") {
      throw new Error("remote Agent cancellation is not enabled in local v1");
    }
    const outcome = await this.options.ptyHost.closeSessionGeneration({
      surfaceId: execution.surfaceId,
      sessionId: execution.sessionId,
      epoch: execution.generation.runtimeEpoch
    });
    return {
      executorReceiptId: `${this.options.id("executor-cancel")}:${outcome}`
    };
  }

  async releaseWorkerTerminal(input: {
    readonly run: WorkflowRun;
    readonly attemptId: string;
  }): Promise<"released" | "retained" | "unknown"> {
    const attempt = input.run.attempts[input.attemptId];
    const dispatch = attempt?.dispatchId
      ? input.run.dispatches[attempt.dispatchId]
      : undefined;
    const execution = dispatch?.execution;
    if (
      !attempt?.settledAt ||
      !execution ||
      execution.generation.kind !== "local"
    ) {
      throw new Error("attempt has no settled exact local terminal execution");
    }
    const control = input.run.inputControls[input.attemptId];
    if (control?.priorOwner === "user") return "retained";
    if (!ownsAgentTerminal(input.run, input.attemptId)) {
      return "unknown";
    }
    const lastUserInputAt = this.options.lastUserInputAt?.(execution);
    if (
      lastUserInputAt &&
      (!attempt.settledAt || lastUserInputAt > attempt.settledAt)
    ) {
      return "retained";
    }
    const outcome = await this.options.ptyHost.closeSessionGeneration(
      {
        surfaceId: execution.surfaceId,
        sessionId: execution.sessionId,
        epoch: execution.generation.runtimeEpoch
      },
      10_000,
      attempt.settledAt
    );
    if (outcome === "input-observed") return "retained";
    if (outcome === "terminated" || outcome === "already-exited") {
      this.options.removeReleasedSurface?.(execution);
      return "released";
    }
    return "unknown";
  }

  async nudgeWorker(input: {
    readonly run: WorkflowRun;
    readonly dispatchId: string;
    readonly messageCount: number;
    readonly operationId: string;
    readonly isStillPending: () => Promise<boolean>;
  }): Promise<{
    readonly outcome: "written" | "uncertain" | "fenced" | "failed";
  }> {
    const dispatch = input.run.dispatches[input.dispatchId];
    const attempt = dispatch
      ? input.run.attempts[dispatch.attemptId]
      : undefined;
    const execution = dispatch?.execution;
    if (
      !attempt ||
      !execution ||
      input.messageCount < 1 ||
      execution.generation.kind !== "local"
    ) {
      throw new Error("mailbox nudge has no exact active local Agent delivery");
    }
    assertRuntimeInputAuthority({
      run: input.run,
      attemptId: attempt.attemptId,
      expectedExecution: execution
    });
    const prompt = formatWorkerMailboxNudge({
      dispatchId: dispatch.dispatchId,
      operationId: input.operationId,
      messageCount: input.messageCount
    });
    const payloadHash = contentHash(prompt);
    const readiness = await this.options.readiness.claimReadyNow({
      execution,
      agentId: dispatch.selectedAgentId,
      excludedReceiptIds: new Set(Object.keys(input.run.readinessReceipts))
    });
    if (!readiness) return { outcome: "fenced" };
    let inputAttempted = false;
    try {
      if (!(await input.isStillPending())) return { outcome: "fenced" };
      const session = {
        surfaceId: execution.surfaceId,
        sessionId: execution.sessionId,
        runtimeEpoch: execution.generation.runtimeEpoch
      };
      const registered = await this.options.ptyHost.registerAgentReadiness({
        session,
        authorityRef: execution.inputAuthorityRef,
        receiptId: readiness.receiptId,
        agentId: readiness.agentId,
        agentInstanceId: readiness.agentInstanceId,
        readyEpoch: readiness.readyEpoch
      });
      if (
        registered.outcome !== "registered" ||
        !(await input.isStillPending())
      ) {
        return { outcome: "fenced" };
      }
      try {
        inputAttempted = true;
        const acknowledgement =
          await this.options.ptyHost.deliverOrchestratedInput({
            session,
            authorityRef: execution.inputAuthorityRef,
            readinessReceiptId: readiness.receiptId,
            readyEpoch: readiness.readyEpoch,
            operationId: input.operationId,
            payloadHash,
            text: prompt,
            verificationText: mailboxNudgeMarker(input.operationId)
          });
        return {
          outcome:
            acknowledgement.outcome === "written"
              ? "written"
              : acknowledgement.outcome === "unknown"
                ? "uncertain"
                : acknowledgement.outcome === "fenced" ||
                    acknowledgement.outcome === "generation-mismatch" ||
                    acknowledgement.outcome === "conflict"
                  ? "fenced"
                  : "failed"
        };
      } catch {
        const status = await this.options.ptyHost
          .queryOrchestratedDelivery({
            session,
            operationId: input.operationId,
            payloadHash
          })
          .catch(() => undefined);
        return {
          outcome: status?.outcome === "written" ? "written" : "uncertain"
        };
      }
    } finally {
      if (!inputAttempted) this.options.readiness.releaseUnused(readiness);
    }
  }

  private async deliver(input: {
    readonly session: {
      readonly surfaceId: string;
      readonly sessionId: string;
      readonly runtimeEpoch: string;
    };
    readonly authorityRef: string;
    readonly readiness: AgentReadinessReceipt;
    readonly operationId: string;
    readonly payloadHash: ContentHash;
    readonly prompt: string;
    readonly verificationText: string;
  }): Promise<void> {
    try {
      const acknowledgement =
        await this.options.ptyHost.deliverOrchestratedInput({
          session: input.session,
          authorityRef: input.authorityRef,
          readinessReceiptId: input.readiness.receiptId,
          readyEpoch: input.readiness.readyEpoch,
          operationId: input.operationId,
          payloadHash: input.payloadHash,
          text: input.prompt,
          verificationText: input.verificationText
        });
      await this.options.mutations.settleDelivery({
        operationId: input.operationId,
        payloadHash: input.payloadHash,
        outcome:
          acknowledgement.outcome === "written"
            ? "written"
            : acknowledgement.outcome === "unknown"
              ? "uncertain"
              : acknowledgement.outcome === "fenced" ||
                  acknowledgement.outcome === "generation-mismatch" ||
                  acknowledgement.outcome === "conflict"
                ? "fenced"
                : "failed",
        receiptId: acknowledgement.requestId
      });
    } catch {
      let status:
        | Awaited<ReturnType<PtyHostManager["queryOrchestratedDelivery"]>>
        | undefined;
      try {
        status = await this.options.ptyHost.queryOrchestratedDelivery({
          session: input.session,
          operationId: input.operationId,
          payloadHash: input.payloadHash
        });
      } catch {
        status = undefined;
      }
      await this.options.mutations.settleDelivery({
        operationId: input.operationId,
        payloadHash: input.payloadHash,
        outcome: status?.outcome === "written" ? "written" : "uncertain",
        ...(status ? { receiptId: status.requestId } : {})
      });
    }
  }
}

export function formatWorkerTaskPrompt(input: {
  readonly run: WorkflowRun;
  readonly attempt: NodeAttempt;
  readonly taskPrompt: string;
}): string {
  return [
    "[kmux worker task]",
    `Run: ${input.run.runId}`,
    `Task: ${input.attempt.nodeId}`,
    `Dispatch: ${input.attempt.dispatchId!}`,
    `Attempt: ${input.attempt.attemptId}`,
    "",
    input.taskPrompt.trim(),
    "",
    "Resolved inputs (canonical JSON):",
    canonicalJson(input.attempt.resolvedInputs as JsonValue),
    "",
    ...(input.run.graph.nodes[input.attempt.nodeId]?.definition.resultSchema
      ? [
          "Result data schema (canonical JSON):",
          canonicalJson(
            input.run.graph.nodes[input.attempt.nodeId]!.definition
              .resultSchema as unknown as JsonValue
          ),
          ""
        ]
      : []),
    "Completion is explicit. Terminal idle or a Stop hook does not finish this task.",
    "Mailbox protocol:",
    `- Before starting work on a new file (including reading it), immediately after running tests, and just before worker-done, run \`kmux orchestration check --dispatch ${shellToken(input.attempt.dispatchId!)}\` without --wait.`,
    "- Process every returned Delivery in FIFO order, then ack it yourself with `kmux orchestration check --dispatch <dispatch> --ack <delivery-id> --summary '<what you applied>'`.",
    "- For a blocking question use ask, or use escalate for a blocker, then wait with `kmux orchestration check --dispatch <dispatch> --wait --types reply,guidance`.",
    "- A pointer in the terminal never contains message content and never counts as read or acknowledged.",
    "Results printed only in this terminal are not delivered to the Coordinator. Your completion summary must describe the work performed, findings, and remaining work (or say none).",
    "If you wrote a detailed report, finish saving it first and add --report-path '<path>' to worker-done. The report is optional; its path is delivered with your result. For read-only Tasks, save any report outside the repository.",
    `While actively working, about every 5 minutes run \`kmux orchestration heartbeat --task ${shellToken(input.attempt.nodeId)} --dispatch ${shellToken(input.attempt.dispatchId!)} --phase '<current phase>'\`. Skip heartbeat while blocked on ask or check --wait. Heartbeat reports liveness, never completion.`,
    "Submit it from this exact kmux terminal generation:",
    `kmux orchestration worker-done --task ${shellToken(input.attempt.nodeId)} --dispatch ${shellToken(input.attempt.dispatchId!)} --outcome succeeded --summary '<summary>'`,
    "Use --data '<json>' only when this Task declares structured output.",
    "After worker-done succeeds, return to idle without further reports or polling. Resume on a direct user instruction or a new Dispatch preamble; do not submit another result for this completed Dispatch.",
    "Do not include or request an orchestration capability token; kmux binds worker_done to this terminal out of band.",
    dispatchMarker(input.attempt.dispatchId!),
    ""
  ].join("\n");
}

export function formatWorkerMailboxNudge(input: {
  readonly dispatchId: string;
  readonly operationId: string;
  readonly messageCount: number;
}): string {
  return [
    `You have ${input.messageCount} orchestration messages.`,
    `Run \`kmux orchestration check --dispatch ${input.dispatchId}\`.`,
    mailboxNudgeMarker(input.operationId),
    ""
  ].join("\n");
}

function mailboxNudgeMarker(operationId: string): string {
  return `[kmux-mailbox:${operationId}]`;
}

function dispatchMarker(dispatchId: string): string {
  return `[kmux-dispatch:${dispatchId}]`;
}

class PreparationEndedError extends Error {}

/** A view of durable ownership; never grants authority by itself. */
class PreparationInput {
  control: AttemptInputControl | null | undefined;
  private controller = new AbortController();
  private changed = Promise.withResolvers<void>();

  observe(control: AttemptInputControl | null): void {
    if (
      this.control !== undefined &&
      this.control?.revision === control?.revision
    )
      return;
    this.control = control;
    this.controller.abort();
    this.controller = new AbortController();
    this.changed.resolve();
    this.changed = Promise.withResolvers<void>();
  }

  async waitForRuntime(): Promise<{
    control: AttemptInputControl;
    signal: AbortSignal;
  }> {
    for (;;) {
      if (this.control === null)
        throw new PreparationEndedError("attempt is no longer preparing");
      if (this.control?.owner === "runtime") {
        return { control: this.control, signal: this.controller.signal };
      }
      await this.changed.promise;
    }
  }

  dispose(): void {
    this.controller.abort();
    this.changed.resolve();
  }
}

function shellToken(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
