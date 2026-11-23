import { WorkerTerminalLifecycle } from "./workerTerminalLifecycle";
import { randomUUID } from "node:crypto";
import {
  admitNode,
  agentTerminalTransferSource,
  workflowExpressionValues,
  isCallerNode,
  markCallerUnavailable,
  startCallerTask,
  submitCallerTaskResult,
  prepareWorkflowInvocation,
  applyGraphPatch,
  bindShellExecution,
  canonicalJson,
  claimMailboxDelivery,
  checkpointRunForHostShutdown,
  commitCoordinatorTurn,
  confirmAttemptCancellation,
  contentHash,
  createAdaptiveRun,
  coordinatorMailboxConsumer,
  failAttemptPreparation,
  failNodeAdmission,
  fireDueTimers,
  dispatchMailboxConsumer,
  materializeWorkflowRun,
  markCancellationUncertain,
  markAttemptPreparationNeedsAttention,
  markShellExecutionOutcomeUnknown,
  parseCreateAdaptiveRunCommand,
  openHumanGate,
  observeAgentExecutionLost,
  postOrchestrationMessage,
  prepareAgentPromptDelivery,
  prepareAttemptInputControl,
  recoverRun,
  recordShellExecutionIntent,
  requestAttemptCancellation,
  requestAttemptInputDisposition,
  requestAttemptRetry,
  resolveHumanGate,
  resolveUncertainAttempt,
  retainWorkerTerminalAfterTakeover,
  selectWorkflowConditionPort,
  sealRunGraph,
  settleAgentPromptDelivery,
  settleControlNode,
  settleShellExecution,
  startStructuredLoop,
  acknowledgeMailboxDelivery,
  mailboxEventsForDelivery,
  mailboxDeliveryForAcknowledgement,
  reviewedWorkerTerminalDisposition,
  pendingDispatchMailboxCount,
  submitAttemptResult,
  terminalExecutionRefSchema,
  terminalExecutionIdentity,
  type AgentLaunchReceipt,
  type AgentBindingDefinition,
  type AgentReadinessReceipt,
  type AgentResultSubmission,
  type AdHocTask,
  type AttemptInputControl,
  type CapabilityGrant,
  type CoordinatorAttachment,
  type ContentHash,
  type CreateAdaptiveRunCommand,
  type Dispatch,
  type GraphPatch,
  type JsonValue,
  type MailboxConsumer,
  type MailboxEventType,
  type NodeAttempt,
  type OrchestrationSnapshot,
  type OrchestrationStore,
  type PromptDelivery,
  type RepositoryStateRef,
  type ResultSubmitIngress,
  type RuntimeContext,
  type TerminalExecutionRef,
  type WorkflowRun,
  type OrchestrationRunSummary,
  type OrchestrationMethod,
  type OrchestrationResponse
} from "@kmux/orchestration";
import {
  FileOrchestrationStore,
  type FileWorkerOutputArchives
} from "@kmux/orchestration/node";
import { OrchestrationError } from "@kmux/orchestration";
import { ownsAgentTerminal } from "./localAgentNodeExecutor";
import { boundWorkerOutput } from "@kmux/orchestration/node";
import { LocalWorkflowCatalog } from "./localWorkflowCatalog";
import type {
  LocalOrchestrationRequest,
  LocalAgentExecutionDriver,
  LocalShellExecutionDriver,
  TrustedResultAssembler
} from "./orchestrationContracts";
export type {
  LocalOrchestrationRequest,
  LocalAgentExecutionDriver,
  LocalShellExecutionDriver,
  TrustedResultAssembler
} from "./orchestrationContracts";
import {
  summarize,
  taskProjection,
  workerProjection,
  locateDispatch,
  requireRun,
  visibleRuns,
  requireVisibleRun,
  requireAttempt,
  requireDelivery,
  requireShellOperation,
  assertWithinHostLimits
} from "./orchestrationQueries";

/** Attachments and heartbeats are verified host context, never public RPC inputs. */

export type { OrchestrationRunSummary } from "@kmux/orchestration";

export class LocalOrchestrationHost {
  private readonly catalog: LocalWorkflowCatalog;
  private readonly workerTerminals: WorkerTerminalLifecycle;
  private resolveCallerRepositoryIdentity?: (
    attachment: CoordinatorAttachment
  ) => Promise<string>;
  private resolveRunWorkspaceId?: (principal: string) => string;
  private executionDriver?: LocalAgentExecutionDriver;
  private shellExecutionDriver?: LocalShellExecutionDriver;
  private trustedResultAssembler?: TrustedResultAssembler;
  private isExecutionCurrent?: (execution: TerminalExecutionRef) => boolean;
  private getWorkerTerminalPolicy?: () => WorkflowRun["workerTerminalPolicy"];
  private verifyCoordinatorCaller?: (
    attachment: CoordinatorAttachment,
    callerPid?: number
  ) => Promise<void>;
  private drivePromise: Promise<void> | null = null;
  private shuttingDown = false;
  private driveRequested = false;
  private readonly cancelInFlight = new Map<string, Promise<void>>();
  private timerHandle: ReturnType<typeof setTimeout> | null = null;
  private constructor(
    private readonly store: OrchestrationStore,
    private readonly context: RuntimeContext,
    private readonly workerOutputArchives: FileWorkerOutputArchives
  ) {
    this.catalog = new LocalWorkflowCatalog(store, context);
    this.workerTerminals = new WorkerTerminalLifecycle(
      store,
      context,
      workerOutputArchives,
      () => this.executionDriver
    );
  }

  static async open(options: {
    filePath: string;
    artifactRoot?: string;
    now?: () => string;
    id?: (kind: string) => string;
  }): Promise<LocalOrchestrationHost> {
    const context: RuntimeContext = {
      now: options.now ?? (() => new Date().toISOString()),
      id: options.id ?? ((kind) => `${kind}:${randomUUID()}`)
    };
    const store = await FileOrchestrationStore.open({
      filePath: options.filePath,
      artifactRoot: options.artifactRoot,
      now: context.now,
      id: context.id
    });
    const host = new LocalOrchestrationHost(
      store,
      context,
      store.workerOutputArchives
    );
    await host.recover();
    return host;
  }

  configureExecution(options: {
    readonly getWorkerTerminalPolicy?: () => WorkflowRun["workerTerminalPolicy"];
    readonly resolveRunWorkspaceId?: (principal: string) => string;
    readonly resolveCallerRepositoryIdentity?: (
      attachment: CoordinatorAttachment
    ) => Promise<string>;
    readonly driver: LocalAgentExecutionDriver;
    readonly shellDriver?: LocalShellExecutionDriver;
    readonly trustedResultAssembler: TrustedResultAssembler;
    readonly isExecutionCurrent: (execution: TerminalExecutionRef) => boolean;
    readonly verifyCoordinatorCaller?: (
      attachment: CoordinatorAttachment,
      callerPid?: number
    ) => Promise<void>;
  }): void {
    this.resolveCallerRepositoryIdentity =
      options.resolveCallerRepositoryIdentity;
    this.resolveRunWorkspaceId = options.resolveRunWorkspaceId;
    this.getWorkerTerminalPolicy = options.getWorkerTerminalPolicy;
    this.executionDriver = options.driver;
    this.shellExecutionDriver = options.shellDriver;
    this.trustedResultAssembler = options.trustedResultAssembler;
    this.isExecutionCurrent = options.isExecutionCurrent;
    this.verifyCoordinatorCaller = options.verifyCoordinatorCaller;
  }

  async observeLocalSessionExit(sessionId: string): Promise<void> {
    const snapshot = await this.store.read();
    const callers = Object.values(snapshot.runs).filter(
      (run) =>
        run.source.kind === "workflow-version" &&
        run.coordinatorAttachment?.sessionId === sessionId
    );
    for (const run of callers)
      await this.store.transact(
        {
          type: "workflow.caller.unavailable",
          principal: "runtime:local",
          runId: run.runId,
          payload: { sessionId }
        },
        (current) => ({
          snapshot: {
            ...current,
            runs: {
              ...current.runs,
              [run.runId]: markCallerUnavailable(
                requireRun(current, run.runId),
                "Calling Agent terminal exited",
                this.context
              )
            }
          },
          value: undefined
        })
      );
    const executions = Object.values(snapshot.runs).flatMap((run) =>
      Object.values(run.dispatches)
        .filter((dispatch) => {
          const attempt = run.attempts[dispatch.attemptId];
          return (
            dispatch.execution?.sessionId === sessionId &&
            attempt !== undefined &&
            [
              "preparing",
              "delivery-pending",
              "running",
              "waiting-input",
              "cancel-requested"
            ].includes(attempt.status)
          );
        })
        .flatMap((dispatch) => (dispatch.execution ? [dispatch.execution] : []))
    );
    const unique = new Map(
      executions.map((execution) => [
        terminalExecutionIdentity(execution),
        execution
      ])
    );
    for (const execution of unique.values()) {
      await this.observeAgentExecutionLost({
        execution,
        reason: "Worker terminal exited before explicit settlement"
      });
    }
  }

  async observeUserTerminalInput(input: {
    readonly surfaceId: string;
    readonly sessionId: string;
    readonly runtimeEpoch: string;
  }): Promise<void> {
    const owners = await this.store.takeoverCandidates(
      input.surfaceId,
      input.sessionId,
      input.runtimeEpoch
    );
    if (!owners.length) return;
    await this.store.transact(
      {
        type: "orchestration.worker.user-takeover",
        principal: "user:local",
        payload: input
      },
      (snapshot) => {
        const runs = { ...snapshot.runs };
        for (const { runId, dispatchId } of owners) {
          const run = runs[runId];
          const dispatch = run?.dispatches[dispatchId];
          const execution = dispatch?.execution;
          if (
            !run ||
            !dispatch ||
            execution?.generation.kind !== "local" ||
            execution.generation.runtimeEpoch !== input.runtimeEpoch ||
            execution.sessionId !== input.sessionId ||
            execution.surfaceId !== input.surfaceId ||
            !["reclaimable", "release-pending"].includes(
              dispatch.terminalState ?? "active"
            )
          )
            continue;
          runs[runId] = retainWorkerTerminalAfterTakeover({
            run,
            dispatchId,
            context: this.context
          });
        }
        return { snapshot: { ...snapshot, runs }, value: undefined };
      }
    );
  }

  async observeAgentExecutionLost(input: {
    readonly execution: TerminalExecutionRef;
    readonly reason: string;
  }): Promise<void> {
    await this.store.transact(
      {
        type: "orchestration.agent.execution-lost",
        principal: "host:electron-main",
        payload: {
          execution: input.execution as unknown as JsonValue,
          reason: input.reason.slice(0, 4_096)
        }
      },
      (snapshot) => {
        const runs = Object.fromEntries(
          Object.entries(snapshot.runs).map(([runId, run]) => [
            runId,
            observeAgentExecutionLost({ run, ...input, context: this.context })
          ])
        );
        return { snapshot: { ...snapshot, runs }, value: undefined };
      }
    );
    if (this.executionDriver) void this.drive().catch(() => undefined);
  }

  async handle<M extends OrchestrationMethod>(
    request: Extract<LocalOrchestrationRequest, { method: M }>,
    principal: string,
    callerPid?: number
  ): Promise<OrchestrationResponse<M>>;
  async handle(
    request: LocalOrchestrationRequest,
    principal: string,
    callerPid?: number
  ): Promise<OrchestrationResponse> {
    request = await this.authorizeCoordinatorRequest(
      request,
      principal,
      callerPid
    );
    switch (request.method) {
      case "orchestration.run.create":
        return this.createLocalRun(
          parseAdaptiveHostCommand(request.params),
          principal
        );
      case "orchestration.run.use":
        return this.useRun(request.params.runId, principal);
      case "orchestration.run.current":
        return this.currentRun(
          principal,
          (request.params as { runId?: string }).runId
        );
      case "orchestration.task.create":
        return this.createTask(request.params, principal);
      case "orchestration.task.list":
        return this.listTasks(request.params.runId, principal);
      case "orchestration.worker.start":
        return this.startWorker(request.params, principal);
      case "orchestration.worker.list":
        return this.listWorkers(request.params, principal);
      case "orchestration.worker.show":
        return this.showWorker(request.params.dispatchId, principal);
      case "orchestration.worker.read":
        return this.readWorker(request.params, principal);
      case "orchestration.worker.done":
        return this.workerDone(request.params, principal);
      case "orchestration.worker.heartbeat":
        return this.workerHeartbeat(request.params, principal);
      case "orchestration.inbox.check":
        return this.checkMailbox(request.params, principal);
      case "orchestration.message.send":
        return this.sendWorkerMessage(request.params, principal);
      case "orchestration.message.ask":
        return this.askCoordinator(request.params, principal, "question");
      case "orchestration.message.escalate":
        return this.askCoordinator(request.params, principal, "escalation");
      case "orchestration.status":
        return this.status(request.params.runId, principal);
      case "orchestration.run.list":
        return this.listRuns(principal);
      case "orchestration.run.get":
        return this.getRun(request.params.runId, principal);
      case "orchestration.gate.resolve":
        return this.resolveGate(request.params, principal);
      case "orchestration.gate.create":
        return this.createTaskGate(request.params, principal);
      case "orchestration.gate.list":
        return this.listTaskGates(request.params, principal);
      case "orchestration.message.post":
        return this.postMessage(request.params, principal);
      case "orchestration.attempt.cancel":
        return this.cancelAttempt(request.params, principal);
      case "orchestration.attempt.recover":
        return this.recoverAttempt(request.params, principal);
      case "orchestration.attempt.retry":
        return this.retryAttempt(request.params, principal);
      case "orchestration.input.disposition":
        return this.setInputDisposition(request.params, principal);
      case "workflow.list":
      case "workflow.version.get":
      case "workflow.template.list":
      case "workflow.template.get":
      case "workflow.draft.initialize":
      case "workflow.draft.create_from_template":
      case "workflow.draft.create":
      case "workflow.draft.get":
      case "workflow.draft.create_from_run":
      case "workflow.draft.update":
      case "workflow.draft.delete":
      case "workflow.draft.validate":
      case "workflow.publish":
        return this.catalog.handle(request, principal);
      case "workflow.caller.done":
        return this.completeCallerTask(request.params, principal);
      case "workflow.run":
        return this.runWorkflow(request.params, principal);
    }
  }

  private async authorizeCoordinatorRequest(
    request: LocalOrchestrationRequest,
    principal: string,
    callerPid?: number
  ): Promise<LocalOrchestrationRequest> {
    if (!principal.startsWith("session:") || !this.verifyCoordinatorCaller)
      return request;
    const snapshot = await this.store.read();
    const params = (request.params ?? {}) as {
      runId?: string;
      dispatchId?: string;
      attemptId?: string;
    };
    const explicit =
      "runId" in params && typeof params.runId === "string"
        ? params.runId
        : undefined;
    let run = explicit ? snapshot.runs[explicit] : undefined;
    if (!explicit) {
      if (
        typeof params.dispatchId === "string" &&
        request.method !== "orchestration.message.send"
      ) {
        run = locateDispatch(snapshot, params.dispatchId).run;
      } else if (typeof params.attemptId === "string") {
        run = requireAttempt(snapshot, params.attemptId).run;
      } else {
        switch (request.method) {
          case "orchestration.run.current":
          case "orchestration.task.create":
          case "orchestration.task.list":
          case "orchestration.gate.create":
          case "orchestration.gate.list":
          case "orchestration.worker.start":
          case "orchestration.worker.list":
          case "orchestration.inbox.check":
          case "orchestration.message.send": {
            const id = snapshot.currentRunByPrincipal[principal];
            if (!id)
              throw new OrchestrationError(
                "not-found",
                "No current orchestration Run is selected in this terminal"
              );
            run = requireRun(snapshot, id);
            // Pin the target before the asynchronous process check. A concurrent
            // run-use cannot redirect the authorized request to another Run.
            request = {
              ...request,
              params: { ...request.params, runId: id }
            } as LocalOrchestrationRequest;
            break;
          }
        }
      }
    }
    if (
      run?.coordinatorAttachment?.transport === "terminal" &&
      principal === `session:${run.coordinatorAttachment.sessionId}`
    ) {
      await this.verifyCoordinatorCaller(run.coordinatorAttachment, callerPid);
    }
    return request;
  }

  async recordShellIntent(input: {
    readonly attemptId: string;
    readonly operationId: string;
    readonly commandHash: ContentHash;
  }): Promise<void> {
    await this.store.transact(
      {
        type: "orchestration.shell.intent-recorded",
        principal: "host:electron-main",
        payload: { attemptId: input.attemptId, operationId: input.operationId }
      },
      (snapshot) => {
        const located = requireAttempt(snapshot, input.attemptId);
        const run = recordShellExecutionIntent({
          run: located.run,
          ...input,
          context: this.context
        });
        return {
          snapshot: {
            ...snapshot,
            runs: { ...snapshot.runs, [run.runId]: run }
          },
          value: undefined
        };
      }
    );
  }

  async bindShellExecution(input: {
    readonly operationId: string;
    readonly execution: TerminalExecutionRef;
    readonly processId: number;
  }): Promise<void> {
    await this.store.transact(
      {
        type: "orchestration.shell.executing",
        principal: "host:electron-main",
        payload: { operationId: input.operationId, processId: input.processId }
      },
      (snapshot) => {
        const located = requireShellOperation(snapshot, input.operationId);
        const run = bindShellExecution({
          run: located.run,
          ...input,
          startedAt: this.context.now()
        });
        return {
          snapshot: {
            ...snapshot,
            runs: { ...snapshot.runs, [run.runId]: run }
          },
          value: undefined
        };
      }
    );
  }

  async settleShell(input: {
    readonly operationId: string;
    readonly exitCode: number;
    readonly outputHash: ContentHash;
    readonly outputBytes: number;
    readonly outcome: "succeeded" | "failed";
    readonly summary: string;
    readonly data?: JsonValue;
  }): Promise<void> {
    await this.store.transact(
      {
        type: "orchestration.shell.settled",
        principal: "host:electron-main",
        payload: { operationId: input.operationId, exitCode: input.exitCode }
      },
      (snapshot) => {
        const located = requireShellOperation(snapshot, input.operationId);
        const run = settleShellExecution({
          run: located.run,
          operationId: input.operationId,
          exitCode: input.exitCode,
          outputHash: input.outputHash,
          outputBytes: input.outputBytes,
          submission: {
            outcome: input.outcome,
            ...(input.outcome === "failed"
              ? { failureClass: "executor-error" as const }
              : {}),
            summary: input.summary,
            ...(input.data === undefined ? {} : { data: input.data })
          },
          context: this.context
        });
        return {
          snapshot: {
            ...snapshot,
            runs: { ...snapshot.runs, [run.runId]: run }
          },
          value: undefined
        };
      }
    );
    void this.drive().catch(() => undefined);
  }

  async markShellOutcomeUnknown(input: {
    readonly operationId: string;
    readonly reason?: string;
  }): Promise<void> {
    await this.store.transact(
      {
        type: "orchestration.shell.outcome-unknown",
        principal: "host:electron-main",
        payload: {
          operationId: input.operationId,
          ...(input.reason ? { reason: input.reason.slice(0, 4_096) } : {})
        }
      },
      (snapshot) => {
        const located = requireShellOperation(snapshot, input.operationId);
        const run = markShellExecutionOutcomeUnknown({
          run: located.run,
          operationId: input.operationId,
          reason: input.reason,
          context: this.context
        });
        return {
          snapshot: {
            ...snapshot,
            runs: { ...snapshot.runs, [run.runId]: run }
          },
          value: undefined
        };
      }
    );
  }

  async persistAttemptInputControl(input: {
    readonly attemptId: string;
    readonly execution: TerminalExecutionRef;
    readonly launchReceipt: AgentLaunchReceipt;
    readonly priorOwnership?: {
      readonly owner: "user" | "runtime";
      readonly mode?: "orchestrated" | "interactive-recorded";
      readonly consentReceiptId?: string;
    };
  }): Promise<void> {
    const located = requireAttempt(await this.store.read(), input.attemptId);
    if (!located.run.inputControls[input.attemptId]) {
      const prior = agentTerminalTransferSource(
        located.run,
        input.attemptId,
        input.execution
      );
      if (prior?.terminalState === "reclaimable")
        await this.workerTerminals.preserve(prior.attemptId);
    }
    await this.store.transact(
      {
        type: "orchestration.input-ownership.prepared",
        principal: "host:electron-main",
        payload: { attemptId: input.attemptId }
      },
      (snapshot) => {
        const located = requireAttempt(snapshot, input.attemptId);
        const run = prepareAttemptInputControl({
          run: located.run,
          attemptId: input.attemptId,
          execution: input.execution,
          launchReceipt: input.launchReceipt,
          ...(input.priorOwnership
            ? { priorOwnership: input.priorOwnership }
            : {}),
          context: this.context
        });
        return {
          snapshot: {
            ...snapshot,
            runs: { ...snapshot.runs, [run.runId]: run }
          },
          value: undefined
        };
      }
    );
  }

  async observePreparationInput(input: {
    readonly attemptId: string;
    readonly execution: TerminalExecutionRef;
    readonly onChange: (control: AttemptInputControl | null) => void;
  }): Promise<() => void> {
    let observedRevision = -1;
    const observe = (snapshot: OrchestrationSnapshot) => {
      if (snapshot.revision <= observedRevision) return;
      observedRevision = snapshot.revision;
      const located = requireAttempt(snapshot, input.attemptId);
      const control = located.run.inputControls[input.attemptId];
      const current =
        located.attempt.status === "preparing" &&
        control &&
        canonicalJson(control.execution as unknown as JsonValue) ===
          canonicalJson(input.execution as unknown as JsonValue);
      input.onChange(current ? control : null);
    };
    const unsubscribe = this.store.subscribe(observe);
    try {
      observe(await this.store.read());
      return unsubscribe;
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }

  async persistPendingPromptDelivery(input: {
    readonly attemptId: string;
    readonly execution: TerminalExecutionRef;
    readonly readiness: AgentReadinessReceipt;
    readonly expectedInputControlRevision?: number;
    readonly payloadHash: ContentHash;
    readonly repositoryStateInput?: RepositoryStateRef;
    readonly operationId: string;
  }): Promise<PromptDelivery> {
    const result = await this.store.transact(
      {
        type: "orchestration.prompt-delivery.pending",
        principal: "host:electron-main",
        payload: {
          attemptId: input.attemptId,
          operationId: input.operationId,
          payloadHash: input.payloadHash
        }
      },
      (snapshot) => {
        const located = requireAttempt(snapshot, input.attemptId);
        const node = located.run.graph.nodes[located.attempt.nodeId];
        if (
          node?.definition.kind === "agent" &&
          node.definition.config.coding &&
          !input.repositoryStateInput
        ) {
          throw new OrchestrationError(
            "unsupported",
            "coding Agent execution requires trusted Git Repository State capture"
          );
        }
        const prepared = prepareAgentPromptDelivery({
          leaseRuns: Object.values(snapshot.runs),
          run: located.run,
          attemptId: input.attemptId,
          execution: input.execution,
          readiness: input.readiness,
          expectedInputControlRevision: input.expectedInputControlRevision,
          launchReceipt:
            located.run.dispatches[located.attempt.dispatchId!]
              ?.launchReceipt ??
            (() => {
              throw new OrchestrationError(
                "conflict",
                "Agent execution has no durable launch receipt"
              );
            })(),
          payloadHash: input.payloadHash,
          ...(input.repositoryStateInput
            ? { repositoryStateInput: input.repositoryStateInput }
            : {}),
          operationId: input.operationId,
          context: this.context
        });
        const capabilityRef = this.context.id("worker-capability");
        const expiresAt = new Date(
          Date.parse(prepared.run.createdAt) +
            prepared.run.limits.maxWallClockMs
        ).toISOString();
        const capability: CapabilityGrant = {
          capabilityRef,
          kind: "worker-lifecycle",
          principal: `session:${input.execution.sessionId}`,
          runId: prepared.run.runId,
          authorityEpoch: prepared.run.coordinationAuthorityEpoch,
          nodeId: located.attempt.nodeId,
          attemptId: located.attempt.attemptId,
          targetId: input.execution.targetId,
          generationIdentity: terminalExecutionIdentity(input.execution),
          expiresAt,
          state: "active"
        };
        return {
          snapshot: {
            ...snapshot,
            runs: { ...snapshot.runs, [located.run.runId]: prepared.run },
            capabilities: {
              ...snapshot.capabilities,
              [capabilityRef]: capability
            }
          },
          value: prepared.delivery
        };
      }
    );
    return result;
  }

  async settlePromptDelivery(input: {
    readonly operationId: string;
    readonly payloadHash: ContentHash;
    readonly outcome: "written" | "uncertain" | "fenced" | "failed";
    readonly receiptId?: string;
    readonly launchReceipt?: AgentLaunchReceipt;
  }): Promise<void> {
    await this.store.transact(
      {
        type: "orchestration.prompt-delivery.settled",
        principal: "host:electron-main",
        payload: {
          operationId: input.operationId,
          payloadHash: input.payloadHash,
          outcome: input.outcome
        }
      },
      (snapshot) => {
        const located = requireDelivery(snapshot, input.operationId);
        const run = settleAgentPromptDelivery({
          run: located.run,
          operationId: input.operationId,
          payloadHash: input.payloadHash,
          outcome: input.outcome,
          ...(input.receiptId ? { receiptId: input.receiptId } : {}),
          ...(input.launchReceipt
            ? { launchReceipt: input.launchReceipt }
            : {}),
          context: this.context
        });
        return {
          snapshot: {
            ...snapshot,
            runs: { ...snapshot.runs, [run.runId]: run }
          },
          value: undefined
        };
      }
    );
  }

  async failPreparation(input: {
    readonly attemptId: string;
    readonly reason: string;
    readonly code?: string;
  }): Promise<void> {
    await this.store.transact(
      {
        type: "orchestration.attempt.preparation-failed",
        principal: "host:electron-main",
        payload: {
          attemptId: input.attemptId,
          code: input.code ?? "executor-preparation-failed",
          reason: input.reason.slice(0, 4_096)
        }
      },
      (snapshot) => {
        const located = requireAttempt(snapshot, input.attemptId);
        const run = failAttemptPreparation({
          run: located.run,
          attemptId: input.attemptId,
          reason: input.reason,
          code: input.code,
          context: this.context
        });
        return {
          snapshot: {
            ...snapshot,
            runs: { ...snapshot.runs, [run.runId]: run }
          },
          value: undefined
        };
      }
    );
    await this.workerTerminals.settle(input.attemptId).catch(() => undefined);
  }

  async requirePreparationAttention(input: {
    readonly attemptId: string;
    readonly code: string;
    readonly reason: string;
  }): Promise<void> {
    await this.store.transact(
      {
        type: "orchestration.attempt.preparation-needs-attention",
        principal: "host:electron-main",
        payload: {
          attemptId: input.attemptId,
          code: input.code.slice(0, 128),
          reason: input.reason.slice(0, 4_096)
        }
      },
      (snapshot) => {
        const located = requireAttempt(snapshot, input.attemptId);
        const run = markAttemptPreparationNeedsAttention({
          run: located.run,
          attemptId: input.attemptId,
          code: input.code,
          reason: input.reason,
          context: this.context
        });
        return {
          snapshot: {
            ...snapshot,
            runs: { ...snapshot.runs, [run.runId]: run }
          },
          value: undefined
        };
      }
    );
    await this.workerTerminals.settle(input.attemptId).catch(() => undefined);
  }

  drive(): Promise<void> {
    if (this.shuttingDown) return this.drivePromise ?? Promise.resolve();
    this.driveRequested = true;
    if (this.drivePromise) return this.drivePromise;
    if (this.timerHandle) {
      clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
    this.drivePromise = (async () => {
      do {
        this.driveRequested = false;
        await this.driveUntilQuiescent();
      } while (this.driveRequested && !this.shuttingDown);
    })().finally(() => {
      this.drivePromise = null;
      void this.armNextTimer().catch(() => undefined);
    });
    return this.drivePromise;
  }

  async checkpointForShutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.timerHandle) {
      clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
    // Drain an in-flight scheduler transaction before taking the durable
    // checkpoint. Driver completions may still arrive, but cannot admit work.
    await this.drivePromise?.catch(() => undefined);
    const snapshot = await this.store.read();
    const nonterminal = Object.values(snapshot.runs).filter(
      (run) =>
        run.status !== "succeeded" &&
        run.status !== "failed" &&
        run.status !== "canceled"
    );
    if (nonterminal.length === 0) return;
    await this.store.transact(
      {
        type: "orchestration.host.shutdown-checkpoint",
        principal: "host:electron-main",
        payload: { runIds: nonterminal.map((run) => run.runId) }
      },
      (current) => ({
        snapshot: {
          ...current,
          runs: {
            ...current.runs,
            ...Object.fromEntries(
              nonterminal.map((run) => [
                run.runId,
                checkpointRunForHostShutdown(current.runs[run.runId] ?? run)
              ])
            )
          }
        },
        value: undefined
      })
    );
  }

  private async createLocalRun(
    command: CreateAdaptiveRunCommand & {
      readonly coordinatorAttachment?: NonNullable<
        WorkflowRun["coordinatorAttachment"]
      >;
    },
    principal: string
  ): Promise<OrchestrationResponse<"orchestration.run.create">> {
    const created = await this.createAdaptive(command, principal);
    await this.useRun(created.run.runId, principal);
    return { run: created.run };
  }

  private async useRun(
    runId: string,
    principal: string
  ): Promise<OrchestrationResponse<"orchestration.run.use">> {
    return this.store.transact(
      {
        type: "orchestration.run.selected",
        principal,
        runId,
        payload: { runId }
      },
      (snapshot) => {
        const run = requireVisibleRun(snapshot, runId, principal);
        assertLocalCoordinator(run, principal);
        return {
          snapshot: {
            ...snapshot,
            currentRunByPrincipal: {
              ...snapshot.currentRunByPrincipal,
              [principal]: runId
            }
          },
          value: { run: summarize(run) }
        };
      }
    );
  }

  private async currentRun(
    principal: string,
    pinnedRunId?: string
  ): Promise<OrchestrationResponse<"orchestration.run.current">> {
    const runId = await this.resolveCurrentRunId(pinnedRunId, principal);
    const snapshot = await this.store.read();
    return { run: summarize(requireVisibleRun(snapshot, runId, principal)) };
  }

  private async resolveCurrentRunId(
    requestedRunId: string | undefined,
    principal: string
  ): Promise<string> {
    const snapshot = await this.store.read();
    const runId = requestedRunId ?? snapshot.currentRunByPrincipal[principal];
    if (!runId) {
      throw new OrchestrationError(
        "not-found",
        "No current orchestration Run is selected in this terminal"
      );
    }
    const run = requireVisibleRun(snapshot, runId, principal);
    assertLocalCoordinator(run, principal);
    return runId;
  }

  private async createTask(
    params: Extract<
      LocalOrchestrationRequest,
      { readonly method: "orchestration.task.create" }
    >["params"],
    principal: string
  ): Promise<OrchestrationResponse<"orchestration.task.create">> {
    const runId = await this.resolveCurrentRunId(params.runId, principal);
    return this.store.transact(
      {
        type: "orchestration.task.created",
        principal,
        runId,
        payload: { taskId: params.taskId, requestId: params.requestId }
      },
      (snapshot) => {
        const run = requireRun(snapshot, runId);
        assertLocalCoordinator(run, principal);
        const existing = run.tasks[params.taskId];
        const task: AdHocTask = {
          taskId: params.taskId,
          runId,
          spec: params.spec.trim(),
          title: params.title?.trim() || params.taskId,
          dependencies: [...new Set(params.dependencies)],
          createdAt: this.context.now()
        };
        if (!task.spec) {
          throw new OrchestrationError(
            "invalid",
            "Task spec must not be empty"
          );
        }
        if (task.dependencies.includes(task.taskId)) {
          throw new OrchestrationError(
            "invalid",
            "A Task cannot depend on itself"
          );
        }
        if (existing) {
          if (
            existing.spec !== task.spec ||
            existing.title !== task.title ||
            canonicalJson(existing.dependencies as unknown as JsonValue) !==
              canonicalJson(task.dependencies as unknown as JsonValue)
          ) {
            throw new OrchestrationError(
              "conflict",
              `Task '${params.taskId}' already exists with another spec`
            );
          }
          return { snapshot, value: taskProjection(run, existing) };
        }
        const next: WorkflowRun = {
          ...run,
          tasks: { ...run.tasks, [task.taskId]: task }
        };
        return {
          snapshot: {
            ...snapshot,
            runs: { ...snapshot.runs, [runId]: next }
          },
          value: taskProjection(next, task)
        };
      }
    );
  }

  private async createTaskGate(
    params: Extract<
      LocalOrchestrationRequest,
      { readonly method: "orchestration.gate.create" }
    >["params"],
    principal: string
  ): Promise<OrchestrationResponse<"orchestration.gate.create">> {
    const runId = await this.resolveCurrentRunId(params.runId, principal);
    const payloadHash = contentHash(params as unknown as JsonValue);
    const result = await this.store.transact(
      {
        type: "orchestration.gate.created",
        principal,
        runId,
        payload: { taskId: params.taskId, requestId: params.requestId }
      },
      (snapshot) => {
        let run = requireRun(snapshot, runId);
        assertLocalCoordinator(run, principal);
        const scope = `${principal}:gate-create:${params.requestId}`;
        const replay = snapshot.idempotency[scope];
        if (replay) {
          if (replay.payloadHash !== payloadHash)
            throw new OrchestrationError(
              "conflict",
              "gate-create request ID was reused with different content"
            );
          return {
            snapshot,
            value: taskProjection(run, run.tasks[params.taskId]!)
          };
        }
        const task = run.tasks[params.taskId];
        if (!task)
          throw new OrchestrationError(
            "not-found",
            "Decision Task was not found"
          );
        if (task.nodeId || run.graph.nodes[task.taskId])
          throw new OrchestrationError(
            "conflict",
            "Decision Task is already dispatched"
          );
        for (const dependency of task.dependencies) {
          if (!run.graph.nodes[dependency])
            throw new OrchestrationError(
              "conflict",
              `Task dependency '${dependency}' has not been dispatched`
            );
        }
        run = applyGraphPatch(
          run,
          {
            runId,
            expectedGraphRevision: run.graph.revision,
            authorityEpoch: run.coordinationAuthorityEpoch,
            authorPrincipal: principal,
            capabilityRef: "internal:local-orchestration",
            idempotencyKey: params.requestId,
            operations: [
              {
                kind: "add-node",
                node: {
                  id: task.taskId,
                  kind: "human-gate",
                  title: task.title,
                  config: {
                    version: 1,
                    question: params.question,
                    resolutions: params.options,
                    approverPolicy: "local-user"
                  },
                  completionRoot: true,
                  onFailure: "wake-coordinator",
                  onCancel: "wake-coordinator"
                }
              },
              ...task.dependencies.map((dependency, index) => ({
                kind: "add-edge" as const,
                edge: {
                  id: `dependency:${dependency}:${task.taskId}`,
                  from: { nodeId: dependency },
                  to: { nodeId: task.taskId }
                },
                expectedTargetNodeStateRevision: index
              }))
            ]
          },
          this.context
        ).run;
        const initial = run.coordinatorTurns.find(
          (turn) => turn.status === "active" && turn.wakeReason === "objective"
        );
        if (initial)
          run = commitCoordinatorTurn({
            run,
            turnId: initial.turnId,
            resultingGraphRevision: run.graph.revision,
            context: this.context
          });
        run = {
          ...run,
          tasks: {
            ...run.tasks,
            [task.taskId]: { ...task, nodeId: task.taskId }
          }
        };
        return {
          snapshot: {
            ...snapshot,
            runs: { ...snapshot.runs, [runId]: run },
            idempotency: {
              ...snapshot.idempotency,
              [scope]: { payloadHash, receipt: { taskId: task.taskId } }
            }
          },
          value: taskProjection(run, run.tasks[task.taskId]!)
        };
      }
    );
    void this.drive().catch(() => undefined);
    return result;
  }

  private async listTaskGates(
    params: Extract<
      LocalOrchestrationRequest,
      { readonly method: "orchestration.gate.list" }
    >["params"],
    principal: string
  ): Promise<OrchestrationResponse<"orchestration.gate.list">> {
    const runId = await this.resolveCurrentRunId(params.runId, principal);
    const run = requireVisibleRun(await this.store.read(), runId, principal);
    const task = params.taskId ? run.tasks[params.taskId] : undefined;
    if (params.taskId && !task)
      throw new OrchestrationError("not-found", "Decision Task was not found");
    return {
      runId,
      gates: Object.values(run.gates).filter(
        (gate) =>
          (!params.taskId || gate.nodeId === task?.nodeId) &&
          (!params.state || gate.state === params.state)
      )
    };
  }

  private async listTasks(
    runId: string | undefined,
    principal: string
  ): Promise<OrchestrationResponse<"orchestration.task.list">> {
    const resolvedRunId = await this.resolveCurrentRunId(runId, principal);
    const run = requireRun(await this.store.read(), resolvedRunId);
    return {
      runId: resolvedRunId,
      tasks: Object.values(run.tasks).map((task) => taskProjection(run, task))
    };
  }

  private async startWorker(
    params: Extract<
      LocalOrchestrationRequest,
      { readonly method: "orchestration.worker.start" }
    >["params"],
    principal: string
  ): Promise<OrchestrationResponse<"orchestration.worker.start">> {
    const runId = await this.resolveCurrentRunId(params.runId, principal);
    if (params.reuseDispatchId && params.worktree !== undefined) {
      throw new OrchestrationError(
        "invalid",
        "Worker reuse inherits its exact worktree; omit --worktree"
      );
    }
    if (params.retryDispatchId) {
      return this.retryWorker(params, runId, principal);
    }
    const payloadHash = contentHash(params as unknown as JsonValue);
    if (params.reuseDispatchId) {
      const snapshot = await this.store.read();
      const run = requireRun(snapshot, runId);
      assertLocalCoordinator(run, principal);
      if (
        !snapshot.idempotency[`${principal}:worker-start:${params.requestId}`]
      ) {
        const priorDispatch = requireReusableWorkerDispatch(
          run,
          params.reuseDispatchId,
          params.agentId
        );
        await this.workerTerminals.preserve(priorDispatch.attemptId);
      }
    }
    const started = await this.store.transact(
      {
        type: "orchestration.worker.start-requested",
        principal,
        runId,
        payload: { requestId: params.requestId, payloadHash }
      },
      (snapshot) => {
        let run = requireRun(snapshot, runId);
        assertLocalCoordinator(run, principal);
        const idempotencyScope = `${principal}:worker-start:${params.requestId}`;
        const replay = snapshot.idempotency[idempotencyScope];
        if (replay) {
          if (replay.payloadHash !== payloadHash) {
            throw new OrchestrationError(
              "conflict",
              "worker-start request ID was reused with different content"
            );
          }
          const receipt = replay.receipt as unknown as {
            taskId: string;
            nodeId: string;
          };
          return { snapshot, value: receipt };
        }

        const taskId = params.taskId ?? this.context.id("task");
        let task = run.tasks[taskId];
        if (params.spec) {
          if (task) {
            throw new OrchestrationError(
              "conflict",
              `Task '${taskId}' already exists`
            );
          }
          task = {
            taskId,
            runId,
            spec: params.spec.trim(),
            title: params.title?.trim() || taskId,
            dependencies: [],
            createdAt: this.context.now()
          };
        }
        if (!task) {
          throw new OrchestrationError(
            "not-found",
            `Task '${taskId}' was not found`
          );
        }
        if (!task.spec) {
          throw new OrchestrationError(
            "invalid",
            "Task spec must not be empty"
          );
        }
        if (task.nodeId || run.graph.nodes[taskId]) {
          throw new OrchestrationError(
            "conflict",
            `Task '${taskId}' already has a Dispatch`
          );
        }

        const priorDispatch = params.reuseDispatchId
          ? requireReusableWorkerDispatch(
              run,
              params.reuseDispatchId,
              params.agentId
            )
          : undefined;

        if (!params.allowParallelAgent && !priorDispatch) {
          const existing = Object.values(run.dispatches).find((candidate) => {
            if (candidate.selectedAgentId !== params.agentId) return false;
            const existingAttempt = run.attempts[candidate.attemptId];
            return Boolean(
              existingAttempt &&
              (!["succeeded", "failed", "canceled"].includes(
                existingAttempt.status
              ) ||
                !["released"].includes(candidate.terminalState ?? "active"))
            );
          });
          if (existing) {
            throw new OrchestrationError(
              "conflict",
              `Agent '${params.agentId}' already has active or retained Worker '${existing.dispatchId}' in this Run; inspect it, retry its Task with --retry-of, reuse it, release it, or pass --allow-parallel-agent for intentional fan-out`
            );
          }
        }

        for (const dependency of task.dependencies) {
          if (!run.graph.nodes[dependency]) {
            throw new OrchestrationError(
              "conflict",
              `Task dependency '${dependency}' has not been dispatched`
            );
          }
        }
        const agentRef = `worker:${taskId}`;
        const binding: AgentBindingDefinition = {
          agent: { kind: "agent-id", agentId: params.agentId },
          scope: { kind: "run" },
          authorityMode: "ambient",
          targetPolicy: "local",
          surfacePolicy: priorDispatch ? "existing" : "create",
          sessionPolicy: priorDispatch ? "existing" : "fresh",
          ...(priorDispatch?.execution
            ? { existingSurfaceId: priorDispatch.execution.surfaceId }
            : {}),
          worktreePolicy:
            priorDispatch?.requestedBinding.worktreePolicy ??
            (params.worktree === "new-child"
              ? "dedicated-child"
              : params.worktree === "new-top-level"
                ? "dedicated-top-level"
                : "current"),
          ...(priorDispatch?.requestedBinding.worktreeInput
            ? { worktreeInput: priorDispatch.requestedBinding.worktreeInput }
            : {}),
          inputMode: "interactive-recorded",
          ...(Object.keys(params.preferences).length > 0
            ? { launch: { ...params.preferences } }
            : {})
        };
        const operations: GraphPatch["operations"][number][] = [
          { kind: "add-binding", agentRef, binding },
          {
            kind: "add-node",
            node: {
              id: taskId,
              kind: "agent",
              title: task.title,
              config: {
                version: 1,
                agentRef,
                prompt: task.spec,
                lifecycleMode: "managed",
                coding: params.coding
              },
              completionRoot: true,
              onFailure: "wake-coordinator",
              onCancel: "wake-coordinator"
            }
          },
          ...task.dependencies.map((dependency, index) => ({
            kind: "add-edge" as const,
            edge: {
              id: `dependency:${dependency}:${taskId}`,
              from: { nodeId: dependency },
              to: { nodeId: taskId }
            },
            expectedTargetNodeStateRevision: index
          }))
        ];
        const applied = applyGraphPatch(
          run,
          {
            runId,
            expectedGraphRevision: run.graph.revision,
            authorityEpoch: run.coordinationAuthorityEpoch,
            authorPrincipal: principal,
            capabilityRef: "internal:local-orchestration",
            idempotencyKey: params.requestId,
            operations
          },
          this.context
        );
        run = applied.run;
        const activeInitial = run.coordinatorTurns.find(
          (turn) => turn.status === "active" && turn.wakeReason === "objective"
        );
        if (activeInitial) {
          run = commitCoordinatorTurn({
            run,
            turnId: activeInitial.turnId,
            resultingGraphRevision: run.graph.revision,
            context: this.context
          });
        }
        const linkedTask: AdHocTask = { ...task, nodeId: taskId };
        run = { ...run, tasks: { ...run.tasks, [taskId]: linkedTask } };
        const receipt = { taskId, nodeId: taskId };
        return {
          snapshot: {
            ...snapshot,
            runs: { ...snapshot.runs, [runId]: run },
            idempotency: {
              ...snapshot.idempotency,
              [idempotencyScope]: { payloadHash, receipt }
            }
          },
          value: receipt
        };
      }
    );
    void this.drive().catch(() => undefined);
    return this.waitForWorkerStart(runId, started.taskId, 65_000);
  }

  private async retryWorker(
    params: Extract<
      LocalOrchestrationRequest,
      { readonly method: "orchestration.worker.start" }
    >["params"],
    runId: string,
    principal: string
  ): Promise<OrchestrationResponse<"orchestration.worker.start">> {
    if (!params.taskId || params.spec || !params.retryDispatchId) {
      throw new OrchestrationError(
        "invalid",
        "Worker retry requires --task and --retry-of without --spec"
      );
    }
    if (
      params.reuseDispatchId ||
      params.worktree !== undefined ||
      params.title ||
      Object.keys(params.preferences).length > 0
    ) {
      throw new OrchestrationError(
        "invalid",
        "Worker retry cannot change title, launch preferences, worktree, or reuse policy"
      );
    }
    const snapshot = await this.store.read();
    const run = requireRun(snapshot, runId);
    assertLocalCoordinator(run, principal);
    const task = run.tasks[params.taskId];
    const dispatch = run.dispatches[params.retryDispatchId];
    const attempt = dispatch ? run.attempts[dispatch.attemptId] : undefined;
    if (
      !task?.nodeId ||
      !dispatch ||
      !attempt ||
      dispatch.nodeId !== task.nodeId ||
      dispatch.selectedAgentId !== params.agentId
    ) {
      throw new OrchestrationError(
        "conflict",
        "Worker retry must name the exact prior Dispatch, Task, and Agent"
      );
    }
    await this.retryAttempt(
      {
        attemptId: attempt.attemptId,
        idempotencyKey: params.requestId
      },
      principal
    );
    return this.waitForWorkerStart(
      runId,
      task.taskId,
      65_000,
      attempt.attemptId
    );
  }

  private async waitForWorkerStart(
    runId: string,
    taskId: string,
    timeoutMs: number,
    afterAttemptId?: string
  ): Promise<OrchestrationResponse<"orchestration.worker.start">> {
    return this.store.waitFor((snapshot, timedOut) => {
      const run = requireRun(snapshot, runId);
      const projection = taskProjection(run, run.tasks[taskId]!);
      const attempt = projection.attemptId
        ? run.attempts[projection.attemptId]
        : undefined;
      const waiting =
        (afterAttemptId !== undefined &&
          projection.attemptId === afterAttemptId) ||
        (!projection.dispatchId &&
          !["failed", "needs-attention", "uncertain"].includes(
            projection.status
          )) ||
        (attempt &&
          ["preparing", "delivery-pending", "cancel-requested"].includes(
            attempt.status
          ));
      if (waiting && !timedOut) return undefined;
      return {
        ...projection,
        reachedStage:
          attempt?.status === "running"
            ? "task-delivered"
            : (attempt?.status ?? projection.status),
        ...(timedOut && waiting ? { timedOut: true } : {}),
        ...(attempt?.preparationIssue
          ? { failedStage: attempt.preparationIssue.code }
          : {})
      };
    }, timeoutMs);
  }

  private async listWorkers(
    params: {
      readonly runId?: string;
      readonly terminalState?: Dispatch["terminalState"];
    },
    principal: string
  ): Promise<OrchestrationResponse<"orchestration.worker.list">> {
    const resolvedRunId = await this.resolveCurrentRunId(
      params.runId,
      principal
    );
    const run = requireRun(await this.store.read(), resolvedRunId);
    return {
      runId: resolvedRunId,
      workers: Object.values(run.dispatches)
        .filter(
          (dispatch) =>
            !params.terminalState ||
            dispatch.terminalState === params.terminalState
        )
        .map((dispatch) => workerProjection(run, dispatch.dispatchId))
    };
  }

  private async showWorker(
    dispatchId: string,
    principal: string
  ): Promise<OrchestrationResponse<"orchestration.worker.show">> {
    const { run } = locateDispatch(await this.store.read(), dispatchId);
    requireVisibleRun(await this.store.read(), run.runId, principal);
    return workerProjection(run, dispatchId);
  }

  private async readWorker(
    params: Extract<
      LocalOrchestrationRequest,
      { readonly method: "orchestration.worker.read" }
    >["params"],
    principal: string
  ): Promise<OrchestrationResponse<"orchestration.worker.read">> {
    const snapshot = await this.store.read();
    const { run } = locateDispatch(snapshot, params.dispatchId);
    requireVisibleRun(snapshot, run.runId, principal);
    const archived = run.dispatches[params.dispatchId]?.terminalHistory;
    if (archived !== undefined) {
      try {
        const bounded = boundWorkerOutput(
          await this.workerOutputArchives.read(archived),
          params.lines,
          params.maxBytes
        );
        return bounded && typeof bounded === "object" && !Array.isArray(bounded)
          ? { ...bounded, archived: true }
          : bounded;
      } catch (cause) {
        return {
          archived: true,
          source: archived.source,
          status: "unreadable",
          truncated: archived.truncated,
          reason: cause instanceof Error ? cause.message : String(cause)
        };
      }
    }
    if (!this.executionDriver?.readWorker) {
      throw new OrchestrationError(
        "unsupported",
        "Worker terminal history is unavailable"
      );
    }
    return this.executionDriver.readWorker({ run, ...params });
  }

  private async workerDone(
    params: Extract<
      LocalOrchestrationRequest,
      { readonly method: "orchestration.worker.done" }
    >["params"],
    principal: string
  ): Promise<OrchestrationResponse<"orchestration.worker.done">> {
    const snapshot = await this.store.read();
    const { dispatch } = locateDispatch(snapshot, params.dispatchId);
    if (dispatch.nodeId !== params.taskId) {
      throw new OrchestrationError(
        "unauthorized",
        "worker_done Task and Dispatch do not match"
      );
    }
    const result: AgentResultSubmission = {
      outcome: params.outcome,
      summary: params.summary,
      ...(params.reportPath === undefined
        ? {}
        : { reportPath: params.reportPath }),
      ...(params.data === undefined ? {} : { data: params.data })
    };
    const submissionHash = contentHash(result as unknown as JsonValue);
    return this.submitResult(
      {
        attemptId: dispatch.attemptId,
        idempotencyKey: `worker-done:${dispatch.dispatchId}:${submissionHash.slice(7, 23)}`,
        submissionHash,
        capabilityRef: "session-bound",
        result
      },
      principal
    );
  }

  private async workerHeartbeat(
    params: Extract<
      LocalOrchestrationRequest,
      { readonly method: "orchestration.worker.heartbeat" }
    >["params"],
    principal: string
  ): Promise<OrchestrationResponse<"orchestration.worker.heartbeat">> {
    const { run, dispatch } = locateDispatch(
      await this.store.read(),
      params.dispatchId
    );
    if (dispatch.nodeId !== params.taskId) {
      throw new OrchestrationError(
        "unauthorized",
        "heartbeat Task and Dispatch do not match"
      );
    }
    if (!principal.startsWith("session:")) {
      throw new OrchestrationError(
        "unauthorized",
        "heartbeat requires the exact Worker terminal"
      );
    }
    return this.postMessage(
      {
        runId: run.runId,
        kind: "heartbeat",
        attemptId: dispatch.attemptId,
        body: { phase: params.phase }
      },
      principal
    );
  }

  private async sendWorkerMessage(
    params: Extract<
      LocalOrchestrationRequest,
      { readonly method: "orchestration.message.send" }
    >["params"],
    principal: string
  ): Promise<OrchestrationResponse<"orchestration.message.send">> {
    const runId = await this.resolveCurrentRunId(params.runId, principal);
    const snapshot = await this.store.read();
    const run = requireRun(snapshot, runId);
    const dispatch = run.dispatches[params.dispatchId];
    if (!dispatch) {
      throw new OrchestrationError(
        "not-found",
        "Worker Dispatch was not found"
      );
    }
    return this.postMessage(
      {
        runId,
        kind: params.kind,
        attemptId: dispatch.attemptId,
        body: { text: params.text },
        ...(params.replyToMessageId
          ? { replyToMessageId: params.replyToMessageId }
          : {})
      },
      principal
    );
  }

  private async askCoordinator(
    params: { readonly dispatchId: string; readonly text: string },
    principal: string,
    kind: "question" | "escalation"
  ): Promise<OrchestrationResponse<"orchestration.message.ask">> {
    const snapshot = await this.store.read();
    const { run, dispatch } = locateDispatch(snapshot, params.dispatchId);
    return this.postMessage(
      {
        runId: run.runId,
        kind,
        attemptId: dispatch.attemptId,
        body: { text: params.text }
      },
      principal
    );
  }

  private async createAdaptive(
    command: CreateAdaptiveRunCommand & {
      readonly coordinatorAttachment?: NonNullable<
        WorkflowRun["coordinatorAttachment"]
      >;
    },
    principal: string
  ): Promise<{
    readonly run: OrchestrationRunSummary;
    readonly graphCapabilityRef: string;
  }> {
    assertWithinHostLimits(command.limits);
    if (command.coordinatorAttachment?.transport !== "terminal") {
      throw new OrchestrationError(
        "invalid",
        "ad-hoc Run creation requires the invoking Agent terminal"
      );
    }
    const payloadHash = contentHash(command as unknown as JsonValue);
    const idempotencyScope = `${principal}:create:${command.idempotencyKey}`;
    const result = await this.store.transact(
      {
        type: "orchestration.run.created",
        principal,
        runId: command.runId,
        payload: { payloadHash }
      },
      (snapshot) => {
        const replay = snapshot.idempotency[idempotencyScope];
        if (replay) {
          if (replay.payloadHash !== payloadHash) {
            throw new OrchestrationError(
              "conflict",
              "Run creation idempotency key was reused with different content"
            );
          }
          return {
            snapshot,
            value: replay.receipt as unknown as {
              run: OrchestrationRunSummary;
              graphCapabilityRef: string;
            }
          };
        }
        if (snapshot.runs[command.runId]) {
          throw new OrchestrationError(
            "conflict",
            `Run '${command.runId}' already exists`
          );
        }
        const shared = {
          runId: command.runId,
          objective: command.objective,
          inputs: command.inputs,
          limits: command.limits,
          ...(command.coordinatorAttachment
            ? { coordinatorAttachment: command.coordinatorAttachment }
            : {}),
          context: this.context
        };
        const created = createAdaptiveRun(shared);
        const run = {
          ...created,
          workerTerminalPolicy: {
            ...(this.getWorkerTerminalPolicy?.() ??
              created.workerTerminalPolicy)
          },
          workspaceId: this.resolveRunWorkspaceId?.(principal)
        };
        const capabilityRef = this.context.id("graph-capability");
        const expiresAt = new Date(
          Date.parse(run.createdAt) + command.limits.maxWallClockMs
        ).toISOString();
        const capability: CapabilityGrant = {
          capabilityRef,
          kind: "graph-author",
          principal,
          runId: run.runId,
          authorityEpoch: run.coordinationAuthorityEpoch,
          ...(command.coordinatorAttachment
            ? {
                targetId: command.coordinatorAttachment.execution.targetId,
                generationIdentity: terminalExecutionIdentity(
                  command.coordinatorAttachment.execution
                ),
                execution: command.coordinatorAttachment.execution,
                constraints: {
                  allowAddAgentNodes: true,
                  allowAddControlNodes: true,
                  allowReplacePendingNodes: true,
                  allowedAgentRefs: []
                }
              }
            : {}),
          expiresAt,
          state: "active"
        };
        const value = {
          run: summarize(run),
          // The authenticated invoking Agent uses a generation-bound
          // out-of-band alias. Never print the bearer capability into its
          // terminal transcript or provider conversation.
          graphCapabilityRef: command.coordinatorAttachment
            ? "session-bound"
            : capabilityRef
        };
        return {
          snapshot: {
            ...snapshot,
            runs: { ...snapshot.runs, [run.runId]: run },
            capabilities: {
              ...snapshot.capabilities,
              [capabilityRef]: capability
            },
            idempotency: {
              ...snapshot.idempotency,
              [idempotencyScope]: {
                payloadHash,
                receipt: value as unknown as JsonValue
              }
            }
          },
          value
        };
      }
    );
    if (this.executionDriver) void this.drive().catch(() => undefined);
    return result;
  }

  private async completeCallerTask(
    params: Extract<
      LocalOrchestrationRequest,
      { method: "workflow.caller.done" }
    >["params"],
    principal: string
  ): Promise<OrchestrationResponse<"workflow.caller.done">> {
    if (params.result.artifacts?.length)
      throw new OrchestrationError(
        "unsupported",
        "Calling Agent artifact references require trusted ingestion; use structured data instead"
      );
    const receipt = await this.store.transact(
      {
        type: "workflow.caller.completed",
        principal,
        runId: params.runId,
        payload: { attemptId: params.attemptId, requestId: params.requestId }
      },
      (snapshot) => {
        const run = requireRun(snapshot, params.runId);
        if (
          principal !== `session:${run.coordinatorAttachment?.sessionId}` ||
          !run.coordinatorAttachment ||
          !this.isExecutionCurrent?.(run.coordinatorAttachment.execution)
        )
          throw new OrchestrationError(
            "unauthorized",
            "Only the original calling Agent can complete this task"
          );
        const completed = submitCallerTaskResult({
          run,
          attemptId: params.attemptId,
          requestId: params.requestId,
          submission: params.result,
          context: this.context
        });
        return {
          snapshot: {
            ...snapshot,
            runs: { ...snapshot.runs, [run.runId]: completed.run }
          },
          value: completed.receipt
        };
      }
    );
    void this.drive().catch(() => undefined);
    return receipt;
  }

  private async runWorkflow(
    params: Extract<
      LocalOrchestrationRequest,
      { readonly method: "workflow.run" }
    >["params"],
    principal: string
  ): Promise<OrchestrationResponse<"workflow.run">> {
    const summary = await this.store.transact(
      {
        type: "workflow.run.created",
        principal,
        runId: params.runId,
        payload: {
          workflow: params.workflow ?? params.workflowVersionId ?? null
        }
      },
      (snapshot) => {
        if (params.callerAttachment) {
          if (
            principal !== `session:${params.callerAttachment.sessionId}` ||
            !this.isExecutionCurrent?.(params.callerAttachment.execution)
          )
            throw new OrchestrationError(
              "unauthorized",
              "Calling Agent attachment requires its authenticated live terminal"
            );
        } else if (
          !["user:local", "client:local"].includes(principal) &&
          !principal.startsWith("session:")
        ) {
          throw new OrchestrationError(
            "unauthorized",
            "Workflow execution requires a local user or an authenticated calling Agent"
          );
        }
        if (!!params.workflow === !!params.workflowVersionId)
          throw new OrchestrationError(
            "invalid",
            "Specify exactly one Workflow title/ID or internal version ID"
          );
        if (snapshot.runs[params.runId]) {
          throw new OrchestrationError(
            "conflict",
            `Run '${params.runId}' already exists`
          );
        }
        const version = params.workflow
          ? prepareWorkflowInvocation(
              snapshot,
              params.workflow,
              this.context,
              params.expectedDraft
            )
          : snapshot.workflowVersions[params.workflowVersionId!];
        if (!version) {
          throw new OrchestrationError(
            "not-found",
            `Workflow Version '${params.workflowVersionId}' was not found`
          );
        }
        assertWithinHostLimits(version.definition.policies.limits);
        const run = {
          ...materializeWorkflowRun({
            runId: params.runId,
            version,
            inputs: params.inputs,
            ...(params.callerAttachment
              ? { callerAttachment: params.callerAttachment }
              : {}),
            context: this.context
          }),
          workerTerminalPolicy: {
            ...(this.getWorkerTerminalPolicy?.() ?? {
              succeeded: "retain" as const,
              failed: "retain" as const
            })
          },
          workspaceId: this.resolveRunWorkspaceId?.(principal)
        };
        const attachment = params.callerAttachment;
        const capabilityRef = this.context.id("caller-capability");
        const capability: CapabilityGrant | undefined = attachment
          ? {
              capabilityRef,
              kind: "graph-author",
              principal,
              runId: run.runId,
              authorityEpoch: run.coordinationAuthorityEpoch,
              targetId: attachment.execution.targetId,
              generationIdentity: terminalExecutionIdentity(
                attachment.execution
              ),
              execution: attachment.execution,
              constraints: {
                allowAddAgentNodes: false,
                allowAddControlNodes: false,
                allowReplacePendingNodes: false,
                allowedAgentRefs: []
              },
              expiresAt: new Date(
                Date.parse(run.createdAt) + run.limits.maxWallClockMs
              ).toISOString(),
              state: "active"
            }
          : undefined;
        return {
          snapshot: {
            ...snapshot,
            workflowVersions: {
              ...snapshot.workflowVersions,
              [version.workflowVersionId]: version
            },
            capabilities: capability
              ? { ...snapshot.capabilities, [capabilityRef]: capability }
              : snapshot.capabilities,
            runs: { ...snapshot.runs, [run.runId]: run }
          },
          value: summarize(run)
        };
      }
    );
    if (this.executionDriver) void this.drive().catch(() => undefined);
    return summary;
  }

  private async status(
    runId: string,
    principal: string
  ): Promise<OrchestrationResponse<"orchestration.status">> {
    const snapshot = await this.store.read();
    return summarize(requireVisibleRun(snapshot, runId, principal));
  }

  private async listRuns(
    principal: string
  ): Promise<OrchestrationResponse<"orchestration.run.list">> {
    const snapshot = await this.store.read();
    return visibleRuns(snapshot, principal)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(summarize);
  }

  private async getRun(
    runId: string,
    principal: string
  ): Promise<OrchestrationResponse<"orchestration.run.get">> {
    const snapshot = await this.store.read();
    return requireVisibleRun(snapshot, runId, principal);
  }

  private async resolveGate(
    params: Extract<
      LocalOrchestrationRequest,
      { readonly method: "orchestration.gate.resolve" }
    >["params"],
    principal: string
  ): Promise<OrchestrationResponse<"orchestration.gate.resolve">> {
    if (principal !== "user:local") {
      throw new OrchestrationError(
        "unauthorized",
        "Human Gates require an explicit local-user action"
      );
    }
    const summary = await this.store.transact(
      {
        type: "orchestration.gate.resolved",
        principal,
        runId: params.runId,
        payload: { gateId: params.gateId, resolution: params.resolution }
      },
      (snapshot) => {
        const run = resolveHumanGate({
          run: requireRun(snapshot, params.runId),
          gateId: params.gateId,
          resolution: params.resolution,
          principal,
          context: this.context
        });
        return {
          snapshot: {
            ...snapshot,
            runs: { ...snapshot.runs, [run.runId]: run }
          },
          value: summarize(run)
        };
      }
    );
    void this.drive().catch(() => undefined);
    return summary;
  }

  private async postMessage(
    params: Extract<
      LocalOrchestrationRequest,
      { readonly method: "orchestration.message.post" }
    >["params"],
    principal: string
  ): Promise<OrchestrationResponse<"orchestration.message.post">> {
    const result = await this.store.transact(
      {
        type: "orchestration.message.posted",
        principal,
        runId: params.runId,
        payload: {
          kind: params.kind,
          ...(params.nodeId ? { nodeId: params.nodeId } : {}),
          ...(params.attemptId ? { attemptId: params.attemptId } : {})
        }
      },
      (snapshot) => {
        const run = requireRun(snapshot, params.runId);
        const coordinator =
          run.coordinatorAttachment?.transport === "terminal" &&
          principal === `session:${run.coordinatorAttachment.sessionId}`;
        if (coordinator) {
          const capability = resolveGraphCapability(snapshot, {
            requestedRef: "session-bound",
            principal,
            runId: run.runId,
            authorityEpoch: run.coordinationAuthorityEpoch,
            now: this.context.now()
          });
          this.assertCapabilityGeneration(snapshot, capability);
          if (
            params.kind !== "guidance" &&
            params.kind !== "reply" &&
            params.kind !== "status"
          )
            throw new OrchestrationError(
              "invalid",
              "Coordinator messages must be guidance, replies, or status"
            );
        } else if (principal !== "user:local") {
          if (!principal.startsWith("session:") || !params.attemptId) {
            throw new OrchestrationError(
              "unauthorized",
              "Agent messages require an exact session-bound attempt"
            );
          }
          const located = requireAttempt(snapshot, params.attemptId);
          if (located.run.runId !== run.runId) {
            throw new OrchestrationError(
              "unauthorized",
              "message attempt belongs to another Run"
            );
          }
          const dispatch = located.attempt.dispatchId
            ? run.dispatches[located.attempt.dispatchId]
            : undefined;
          if (!dispatch?.execution) {
            throw new OrchestrationError(
              "unauthorized",
              "message attempt has no proven terminal execution"
            );
          }
          const capability = resolveWorkerCapability(snapshot, {
            principal,
            run,
            attempt: located.attempt,
            executionIdentity: terminalExecutionIdentity(dispatch.execution),
            now: this.context.now()
          });
          if (params.kind === "heartbeat")
            this.assertCapabilityGeneration(snapshot, capability);
        }
        const targetDispatch = params.attemptId
          ? run.attempts[params.attemptId]?.dispatchId
          : undefined;
        const posted = postOrchestrationMessage({
          run,
          kind: params.kind,
          principal,
          body: params.body,
          ...(params.nodeId ? { nodeId: params.nodeId } : {}),
          ...(params.attemptId ? { attemptId: params.attemptId } : {}),
          ...(params.replyToMessageId
            ? { replyToMessageId: params.replyToMessageId }
            : {}),
          ...(coordinator ? { wakeCoordinator: false } : {}),
          context: this.context
        });
        return {
          snapshot: {
            ...snapshot,
            runs: { ...snapshot.runs, [run.runId]: posted.run }
          },
          value: {
            message: posted.message,
            ...(targetDispatch ? { dispatchId: targetDispatch } : {})
          }
        };
      }
    );
    if (
      result.dispatchId &&
      (result.message.kind === "guidance" || result.message.kind === "reply")
    ) {
      void this.nudgeWorker(
        params.runId,
        result.dispatchId,
        result.message.messageId
      );
    }
    void this.drive().catch(() => undefined);
    return {
      status: "queued" as const,
      runId: params.runId,
      messageId: result.message.messageId,
      ...(result.dispatchId ? { dispatchId: result.dispatchId } : {})
    };
  }

  private async nudgeWorker(
    runId: string,
    dispatchId: string,
    messageId: string
  ): Promise<void> {
    const snapshot = await this.store.read();
    const run = requireRun(snapshot, runId);
    const driver = this.executionDriver;
    const dispatch = run.dispatches[dispatchId];
    const attempt = dispatch ? run.attempts[dispatch.attemptId] : undefined;
    if (
      !driver?.nudgeWorker ||
      !dispatch?.execution ||
      !attempt ||
      !["running", "waiting-input"].includes(attempt.status) ||
      dispatch.terminalState !== "active"
    ) {
      return;
    }
    try {
      await driver.nudgeWorker({
        run,
        dispatchId,
        messageCount: pendingDispatchMailboxCount(run, dispatchId),
        operationId: `mailbox-nudge:${messageId}`,
        isStillPending: async () => {
          const latest = (await this.store.read()).runs[runId];
          const current = latest?.dispatches[dispatchId];
          const currentAttempt = current && latest.attempts[current.attemptId];
          return Boolean(
            current?.execution &&
            current.terminalState === "active" &&
            currentAttempt &&
            ["running", "waiting-input"].includes(currentAttempt.status) &&
            terminalExecutionIdentity(current.execution) ===
              terminalExecutionIdentity(dispatch.execution!) &&
            latest.inputControls[current.attemptId]?.owner === "runtime" &&
            pendingDispatchMailboxCount(latest, dispatchId) > 0
          );
        }
      });
    } catch {
      // A nudge is best-effort and is never retried. The durable mailbox and
      // Worker preamble polling remain the source of truth.
    }
  }

  private async retryAttempt(
    params: Extract<
      LocalOrchestrationRequest,
      { readonly method: "orchestration.attempt.retry" }
    >["params"],
    principal: string
  ): Promise<OrchestrationResponse<"orchestration.attempt.retry">> {
    if (params.placementChangeApproved && principal !== "user:local") {
      throw new OrchestrationError(
        "unauthorized",
        "retry placement changes require an explicit local-user action"
      );
    }
    const summary = await this.store.transact(
      {
        type: "orchestration.attempt.retry-requested",
        principal,
        payload: { attemptId: params.attemptId }
      },
      (snapshot) => {
        const located = requireAttempt(snapshot, params.attemptId);
        assertLocalCoordinator(located.run, principal);
        const retried = requestAttemptRetry({
          run: located.run,
          attemptId: params.attemptId,
          idempotencyKey: params.idempotencyKey,
          ...(params.placementChangeApproved
            ? { placementChangeApproved: true }
            : {}),
          principal,
          context: this.context
        });
        return {
          snapshot: {
            ...snapshot,
            runs: { ...snapshot.runs, [located.run.runId]: retried.run }
          },
          value: summarize(retried.run)
        };
      }
    );
    void this.drive().catch(() => undefined);
    return summary;
  }

  private async setInputDisposition(
    params: Extract<
      LocalOrchestrationRequest,
      { readonly method: "orchestration.input.disposition" }
    >["params"],
    principal: string
  ): Promise<OrchestrationResponse<"orchestration.input.disposition">> {
    const initial = await this.store.read();
    const owned = requireAttempt(initial, params.attemptId);
    assertLocalCoordinator(owned.run, principal);
    const summary = await this.store.transact(
      {
        type: "orchestration.input.disposition-requested",
        principal,
        payload: {
          attemptId: params.attemptId,
          disposition: params.disposition
        }
      },
      (snapshot) => {
        const located = requireAttempt(snapshot, params.attemptId);
        const run = requestAttemptInputDisposition({
          run: located.run,
          attemptId: params.attemptId,
          disposition:
            params.disposition === "retain"
              ? "retain"
              : reviewedWorkerTerminalDisposition(
                  located.run,
                  params.attemptId
                ),
          idempotencyKey: params.idempotencyKey,
          context: this.context
        });
        return {
          snapshot: {
            ...snapshot,
            runs: { ...snapshot.runs, [run.runId]: run }
          },
          value: summarize(run)
        };
      }
    );
    const current = await this.store.read();
    const located = requireAttempt(current, params.attemptId);
    if (["succeeded", "failed", "canceled"].includes(located.attempt.status)) {
      await this.workerTerminals.settle(params.attemptId);
      const settled = await this.store.read();
      return summarize(requireAttempt(settled, params.attemptId).run);
    }
    return summary;
  }

  private async cancelAttempt(
    params: Extract<
      LocalOrchestrationRequest,
      { readonly method: "orchestration.attempt.cancel" }
    >["params"],
    principal: string
  ): Promise<OrchestrationResponse<"orchestration.attempt.cancel">> {
    const before = await this.store.read();
    const located = requireAttempt(before, params.attemptId);
    assertLocalCoordinator(located.run, principal);
    if (
      Object.values(located.run.cancellations).some(
        (operation) => operation.idempotencyKey === params.idempotencyKey
      )
    ) {
      // Replay durable cancellation even after the terminal generation exited.
      const { operation } = requestAttemptCancellation({
        run: located.run,
        attemptId: params.attemptId,
        idempotencyKey: params.idempotencyKey,
        context: this.context
      });
      return {
        outcome: operation.state,
        operationId: operation.operationId,
        run: summarize(located.run)
      };
    }
    const node = located.run.graph.nodes[located.attempt.nodeId];
    const dispatch = located.attempt.dispatchId
      ? located.run.dispatches[located.attempt.dispatchId]
      : undefined;
    const shellOperation = Object.values(located.run.shellOperations).find(
      (candidate) => candidate.attemptId === located.attempt.attemptId
    );
    const shellCancellation = node?.definition.kind === "shell";
    const controlCancellation =
      node !== undefined &&
      node.definition.kind !== "agent" &&
      !shellCancellation;
    const driver = shellCancellation
      ? this.shellExecutionDriver
      : this.executionDriver;
    const execution = shellCancellation
      ? shellOperation?.execution
      : dispatch?.execution;
    const safelyOwned = shellCancellation
      ? shellOperation?.state === "executing" &&
        node.definition.config.surfacePolicy === "create"
      : ownsAgentTerminal(located.run, params.attemptId);
    if (
      !controlCancellation &&
      (!driver?.cancel || !execution || !safelyOwned)
    ) {
      throw new OrchestrationError(
        "unsupported",
        "local cancellation requires proven kmux ownership of the Agent or Shell terminal"
      );
    }
    if (!controlCancellation && !this.isExecutionCurrent?.(execution!)) {
      throw new OrchestrationError(
        "uncertain",
        "the exact terminal generation is no longer current"
      );
    }
    const operation = await this.store.transact(
      {
        type: "orchestration.attempt.cancel-requested",
        principal,
        runId: located.run.runId,
        payload: {
          attemptId: params.attemptId,
          idempotencyKey: params.idempotencyKey
        }
      },
      (snapshot) => {
        const current = requireAttempt(snapshot, params.attemptId);
        const requested = requestAttemptCancellation({
          run: current.run,
          attemptId: params.attemptId,
          idempotencyKey: params.idempotencyKey,
          context: this.context
        });
        return {
          snapshot: {
            ...snapshot,
            runs: {
              ...snapshot.runs,
              [current.run.runId]: requested.run
            }
          },
          value: requested.operation
        };
      }
    );
    try {
      await this.settleRequestedCancellation(
        located.run.runId,
        operation.operationId
      );
      const run = requireRun(await this.store.read(), located.run.runId);
      const settled = run.cancellations[operation.operationId]!;
      return {
        outcome: settled.state,
        operationId: settled.operationId,
        run: summarize(run),
        ...(settled.issue ? { message: settled.issue } : {})
      };
    } finally {
      // Confirmation can request sibling cancellations through the failure
      // policy. Resume the Scheduler only after that transition is durable.
      if (this.executionDriver || this.shellExecutionDriver)
        void this.drive().catch(() => undefined);
    }
  }

  private async recoverAttempt(
    params: Extract<
      LocalOrchestrationRequest,
      { readonly method: "orchestration.attempt.recover" }
    >["params"],
    principal: string
  ): Promise<OrchestrationResponse<"orchestration.attempt.recover">> {
    if (principal !== "user:local") {
      throw new OrchestrationError(
        "unauthorized",
        "uncertain attempt recovery requires an explicit local-user action"
      );
    }
    const summary = await this.store.transact(
      {
        type: "orchestration.attempt.recovered",
        principal,
        payload: {
          attemptId: params.attemptId,
          resolution: params.resolution
        }
      },
      (snapshot) => {
        const located = requireAttempt(snapshot, params.attemptId);
        const run = resolveUncertainAttempt({
          run: located.run,
          attemptId: params.attemptId,
          resolution: params.resolution,
          summary: params.summary,
          context: this.context
        });
        return {
          snapshot: {
            ...snapshot,
            runs: { ...snapshot.runs, [run.runId]: run },
            capabilities: revokeAttemptCapabilities(
              snapshot.capabilities,
              params.attemptId
            )
          },
          value: summarize(run)
        };
      }
    );
    void this.drive().catch(() => undefined);
    return summary;
  }

  private async checkMailbox(
    params: Extract<
      LocalOrchestrationRequest,
      { readonly method: "orchestration.inbox.check" }
    >["params"],
    principal: string
  ): Promise<OrchestrationResponse<"orchestration.inbox.check">> {
    if (params.runId && params.dispatchId) {
      throw new OrchestrationError(
        "invalid",
        "check --run and --dispatch are mutually exclusive"
      );
    }
    const initial = await this.store.read();
    const runId = params.dispatchId
      ? locateDispatch(initial, params.dispatchId).run.runId
      : await this.resolveCurrentRunId(params.runId, principal);
    const deadline = Date.now() + params.timeoutMs;
    if (params.ack && !params.dispatchId) {
      await this.settleReviewedMailboxWorkers(
        runId,
        params.ack,
        params.types,
        principal
      );
    }
    let ack = params.ack;
    for (;;) {
      let notify!: () => void;
      const changed = new Promise<void>((resolve) => {
        notify = resolve;
      });
      const unsubscribe = this.store.subscribe((snapshot) => {
        const event = snapshot.auditEvents.at(-1);
        if (
          event?.type !== "orchestration.coordinator.checked" &&
          (!event?.runId || event.runId === runId)
        )
          notify();
      });
      try {
        const result = await this.store.transact(
          {
            type: "orchestration.coordinator.checked",
            principal,
            runId,
            payload: {
              ack: ack ?? null,
              consumer: params.dispatchId ?? "coordinator"
            }
          },
          (snapshot) => {
            let run = requireRun(snapshot, runId);
            let consumer: MailboxConsumer;
            const allowedTypes: readonly MailboxEventType[] = params.dispatchId
              ? ["guidance", "reply"]
              : ["caller_task", "worker_done", "question", "escalation"];
            if (params.types?.some((type) => !allowedTypes.includes(type))) {
              throw new OrchestrationError(
                "invalid",
                `check types for this consumer are limited to ${allowedTypes.join(",")}`
              );
            }
            if (params.dispatchId) {
              const dispatch = run.dispatches[params.dispatchId];
              const attempt = dispatch
                ? run.attempts[dispatch.attemptId]
                : undefined;
              if (!dispatch?.execution || !attempt) {
                throw new OrchestrationError(
                  "not-found",
                  "Worker Dispatch was not found"
                );
              }
              resolveWorkerCapability(snapshot, {
                requestedRef: "session-bound",
                principal,
                run,
                attempt,
                executionIdentity: terminalExecutionIdentity(
                  dispatch.execution
                ),
                now: this.context.now(),
                allowConsumedReplay: true
              });
              if (
                this.isExecutionCurrent &&
                !this.isExecutionCurrent(dispatch.execution)
              ) {
                throw new OrchestrationError(
                  "unauthorized",
                  "Worker mailbox terminal generation is stale or unavailable"
                );
              }
              consumer = dispatchMailboxConsumer(run, params.dispatchId);
            } else {
              run = requireVisibleRun(snapshot, runId, principal);
              const capability = resolveGraphCapability(snapshot, {
                requestedRef: "session-bound",
                principal,
                runId: run.runId,
                authorityEpoch: run.coordinationAuthorityEpoch,
                now: this.context.now()
              });
              this.assertCapabilityGeneration(snapshot, capability);
              consumer = coordinatorMailboxConsumer(run);
            }
            if (ack) {
              run = acknowledgeMailboxDelivery({
                run,
                consumer,
                deliveryId: ack,
                context: this.context
              });
            }
            const claimed = claimMailboxDelivery({
              run,
              consumer,
              ...(params.types ? { types: params.types } : {}),
              context: this.context
            });
            run = autoSealCompletedCoordination(claimed.run, this.context);
            const delivery = claimed.delivery;
            const value = {
              run: summarize(run),
              delivery: delivery
                ? {
                    deliveryId: delivery.deliveryId,
                    consumer: delivery.consumer,
                    cursorStart: delivery.cursorStart,
                    cursorEnd: delivery.cursorEnd,
                    replayed: claimed.replayed,
                    events: mailboxEventsForDelivery(run, delivery).map(
                      (event) => {
                        const message = event.messageId
                          ? run.messages.find(
                              (candidate) =>
                                candidate.messageId === event.messageId
                            )
                          : undefined;
                        const result = event.attemptId
                          ? run.attemptResults[event.attemptId]
                          : undefined;
                        return {
                          eventId: event.eventId,
                          sequence: event.sequence,
                          type: event.type,
                          target: event.target,
                          ...(event.type === "caller_task" && event.attemptId
                            ? {
                                callerTask: (() => {
                                  const attempt =
                                    run.attempts[event.attemptId!];
                                  const node = run.graph.nodes[attempt.nodeId];
                                  return {
                                    runId: run.runId,
                                    attemptId: attempt.attemptId,
                                    requestId: attempt.callerTask!.requestId,
                                    state: attempt.callerTask!.state,
                                    nodeId: node.nodeId,
                                    title: node.definition.title,
                                    prompt:
                                      node.definition.kind === "agent"
                                        ? node.definition.config.prompt
                                        : "",
                                    inputs: attempt.resolvedInputs,
                                    resultSchema: node.definition.resultSchema,
                                    coding:
                                      node.definition.kind === "agent" &&
                                      node.definition.config.coding
                                  };
                                })()
                              }
                            : {}),
                          ...(message ? { message } : {}),
                          ...(result ? { result } : {})
                        };
                      }
                    )
                  }
                : null,
              timedOut: false
            };
            return {
              snapshot: {
                ...snapshot,
                runs: { ...snapshot.runs, [run.runId]: run }
              },
              value
            };
          }
        );
        ack = undefined;
        if (
          result.delivery ||
          [
            "succeeded",
            "failed",
            "canceled",
            "needs-attention",
            "settling"
          ].includes(result.run.status) ||
          !params.wait
        )
          return result;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { ...result, timedOut: true };
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = await Promise.race([
          changed.then(() => false),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(true), remaining);
          })
        ]);
        if (timer) clearTimeout(timer);
        if (timedOut) return { ...result, timedOut: true };
      } finally {
        unsubscribe();
      }
    }
  }

  private async submitResult(ingress: ResultSubmitIngress, principal: string) {
    const assembler = this.trustedResultAssembler;
    if (!assembler) {
      throw new OrchestrationError(
        "unsupported",
        "trusted local Agent result assembly is unavailable"
      );
    }
    const initial = await this.store.read();
    const located = requireAttempt(initial, ingress.attemptId);
    const dispatch = located.attempt.dispatchId
      ? located.run.dispatches[located.attempt.dispatchId]
      : undefined;
    if (!dispatch?.execution || !dispatch.readinessReceiptId) {
      throw new OrchestrationError(
        "conflict",
        "attempt has no proven terminal execution and readiness receipt"
      );
    }
    if (
      ingress.expectedExecution &&
      canonicalJson(ingress.expectedExecution as unknown as JsonValue) !==
        canonicalJson(dispatch.execution as unknown as JsonValue)
    ) {
      throw new OrchestrationError(
        "unauthorized",
        "result submission terminal generation differs from the Dispatch"
      );
    }
    const replay = located.run.resultReceipts[ingress.idempotencyKey];
    const capability = resolveWorkerCapability(initial, {
      requestedRef: ingress.capabilityRef,
      principal,
      run: located.run,
      attempt: located.attempt,
      executionIdentity: terminalExecutionIdentity(dispatch.execution),
      now: this.context.now(),
      allowConsumedReplay: Boolean(replay)
    });
    if (replay) {
      if (
        replay.attemptId !== ingress.attemptId ||
        replay.submissionHash !== ingress.submissionHash ||
        contentHash(ingress.result as unknown as JsonValue) !==
          ingress.submissionHash
      ) {
        throw new OrchestrationError(
          "conflict",
          "result submission replay differs from its durable receipt"
        );
      }
      await this.workerTerminals
        .settle(ingress.attemptId)
        .catch(() => undefined);
      return replay;
    }
    const trusted = await assembler.assemble({
      run: located.run,
      attempt: located.attempt,
      submission: ingress.result
    });

    const receipt = await this.store.transact(
      {
        type: "orchestration.result.submitted",
        principal,
        runId: located.run.runId,
        payload: {
          attemptId: ingress.attemptId,
          submissionHash: ingress.submissionHash,
          idempotencyKey: ingress.idempotencyKey
        }
      },
      (snapshot) => {
        const current = requireAttempt(snapshot, ingress.attemptId);
        const currentDispatch = current.attempt.dispatchId
          ? current.run.dispatches[current.attempt.dispatchId]
          : undefined;
        if (
          !currentDispatch?.execution ||
          !currentDispatch.readinessReceiptId
        ) {
          throw new OrchestrationError(
            "conflict",
            "attempt lost its terminal execution binding"
          );
        }
        resolveWorkerCapability(snapshot, {
          requestedRef: capability.capabilityRef,
          principal,
          run: current.run,
          attempt: current.attempt,
          executionIdentity: terminalExecutionIdentity(
            currentDispatch.execution
          ),
          now: this.context.now(),
          allowConsumedReplay: Boolean(
            current.run.resultReceipts[ingress.idempotencyKey]
          )
        });
        const readiness =
          current.run.readinessReceipts[currentDispatch.readinessReceiptId];
        if (!readiness) {
          throw new OrchestrationError(
            "conflict",
            "Dispatch readiness receipt is unavailable"
          );
        }
        const submitted = submitAttemptResult({
          run: current.run,
          attemptId: ingress.attemptId,
          idempotencyKey: ingress.idempotencyKey,
          submissionHash: ingress.submissionHash,
          submission: ingress.result,
          trusted: {
            ...trusted,
            executionReceipt: {
              dispatchId: currentDispatch.dispatchId,
              execution: currentDispatch.execution,
              readinessReceiptId: readiness.receiptId,
              agentInstanceId: readiness.agentInstanceId,
              effectiveDefinitionHash: current.attempt.effectiveDefinitionHash,
              effectiveInputMode:
                current.attempt.effectiveInputMode ?? "orchestrated",
              inputInterventionIds: [...current.attempt.inputInterventionIds],
              resultSubmissionHash: ingress.submissionHash
            }
          },
          context: this.context
        });
        const finalizedRun = autoSealCompletedCoordination(
          submitted.run,
          this.context
        );
        const nextCapabilities = Object.fromEntries(
          Object.entries(snapshot.capabilities).map(([ref, grant]) => [
            ref,
            grant.capabilityRef === capability.capabilityRef ||
            (grant.kind === "graph-author" &&
              grant.attemptId === current.attempt.attemptId)
              ? { ...grant, state: "consumed" as const }
              : grant
          ])
        );
        return {
          snapshot: {
            ...snapshot,
            runs: {
              ...snapshot.runs,
              [finalizedRun.runId]: finalizedRun
            },
            capabilities: nextCapabilities
          },
          value: submitted.receipt
        };
      }
    );
    await this.workerTerminals.settle(ingress.attemptId).catch(() => undefined);
    if (this.executionDriver) void this.drive().catch(() => undefined);
    return receipt;
  }

  private async driveUntilQuiescent(): Promise<void> {
    const launch = (execution: Promise<void>): void => {
      // Attach each wake immediately: a later admission failure or a slow
      // sibling must not lose this execution's completion notification.
      const wake = () => this.drive();
      void execution.then(wake, wake).catch(() => undefined);
    };
    for (;;) {
      if (this.shuttingDown) return;
      const snapshot = await this.store.read();
      if (this.shuttingDown) return;
      const unavailable = Object.values(snapshot.runs).find(
        (run) =>
          run.source.kind === "workflow-version" &&
          run.coordinatorAttachment &&
          !run.callerUnavailable &&
          !["succeeded", "failed", "canceled"].includes(run.status) &&
          this.isExecutionCurrent &&
          !this.isExecutionCurrent(run.coordinatorAttachment.execution)
      );
      if (unavailable) {
        await this.store.transact(
          {
            type: "workflow.caller.unavailable",
            principal: "runtime:local",
            runId: unavailable.runId,
            payload: {}
          },
          (current) => ({
            snapshot: {
              ...current,
              runs: {
                ...current.runs,
                [unavailable.runId]: markCallerUnavailable(
                  requireRun(current, unavailable.runId),
                  "Calling Agent terminal generation changed or is unavailable",
                  this.context
                )
              }
            },
            value: undefined
          })
        );
        continue;
      }
      const observedAt = this.context.now();
      const dueRunIds = Object.values(snapshot.runs)
        .filter(
          (run) =>
            !["succeeded", "failed", "canceled"].includes(run.status) &&
            Object.values(run.timers).some(
              (timer) =>
                timer.state === "pending" &&
                Date.parse(timer.dueAt) <= Date.parse(observedAt)
            )
        )
        .map((run) => run.runId);
      if (dueRunIds.length > 0) {
        await this.store.transact(
          {
            type: "orchestration.timers.fired",
            principal: "host:electron-main",
            payload: { runIds: dueRunIds, observedAt }
          },
          (current) => ({
            snapshot: {
              ...current,
              runs: {
                ...current.runs,
                ...Object.fromEntries(
                  dueRunIds.map((runId) => [
                    runId,
                    fireDueTimers({
                      run: requireRun(current, runId),
                      observedAt,
                      context: this.context
                    })
                  ])
                )
              }
            },
            value: undefined
          })
        );
        continue;
      }
      const requestedCancellation = Object.values(snapshot.runs).flatMap(
        (run) =>
          Object.values(run.cancellations)
            .filter((operation) => operation.state === "requested")
            .map((operation) => ({ runId: run.runId, operation }))
      )[0];
      if (requestedCancellation) {
        await this.settleRequestedCancellation(
          requestedCancellation.runId,
          requestedCancellation.operation.operationId
        );
        continue;
      }
      const candidate = Object.values(snapshot.runs)
        .filter(
          (run) =>
            !["settling", "succeeded", "failed", "canceled"].includes(
              run.status
            ) &&
            !run.callerUnavailable &&
            !run.coordinatorTurns.some((turn) => turn.status === "active") &&
            run.counters.activeAttempts < run.limits.maxActiveAttempts
        )
        .sort((a, b) =>
          a.createdAt === b.createdAt
            ? a.runId.localeCompare(b.runId)
            : a.createdAt.localeCompare(b.createdAt)
        )
        .flatMap((run) =>
          Object.values(run.graph.nodes)
            .filter((node) => node.status === "ready")
            .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
            .map((node) => ({ run, node }))
        )[0];
      if (!candidate) break;
      const admitted = await this.store.transact(
        {
          type: "orchestration.node.admission-evaluated",
          principal: "host:electron-main",
          runId: candidate.run.runId,
          payload: { nodeId: candidate.node.nodeId }
        },
        (current) => {
          const run = requireRun(current, candidate.run.runId);
          const node = run.graph.nodes[candidate.node.nodeId];
          if (
            this.shuttingDown ||
            run.callerUnavailable ||
            !node ||
            node.status !== "ready" ||
            ["settling", "succeeded", "failed", "canceled"].includes(
              run.status
            ) ||
            run.counters.activeAttempts >= run.limits.maxActiveAttempts ||
            run.coordinatorTurns.some((turn) => turn.status === "active")
          ) {
            return { snapshot: current, value: undefined };
          }
          let next;
          try {
            next = admitNode({
              run,
              nodeId: node.nodeId,
              expectedGraphRevision: run.graph.revision,
              expectedNodeStateRevision: node.stateRevision,
              context: this.context
            });
          } catch (error) {
            if (!(error instanceof OrchestrationError)) throw error;
            const failed = failNodeAdmission({
              run,
              nodeId: node.nodeId,
              error,
              context: this.context
            });
            return {
              snapshot: {
                ...current,
                runs: { ...current.runs, [run.runId]: failed }
              },
              value: undefined
            };
          }
          return {
            snapshot: {
              ...current,
              runs: { ...current.runs, [run.runId]: next.run }
            },
            value: { run: next.run, attempt: next.attempt }
          };
        }
      );
      if (this.shuttingDown) return;
      if (!admitted) continue;
      const node = admitted.run.graph.nodes[admitted.attempt.nodeId];
      if (!node) continue;
      if (isCallerNode(admitted.run, node)) {
        try {
          const attachment = admitted.run.coordinatorAttachment!;
          if (!this.isExecutionCurrent?.(attachment.execution))
            throw new OrchestrationError(
              "unauthorized",
              "Calling Agent terminal generation is unavailable"
            );
          if (!this.resolveCallerRepositoryIdentity)
            throw new OrchestrationError(
              "unsupported",
              "Calling Agent repository resolution is unavailable"
            );
          const repositoryIdentity =
            await this.resolveCallerRepositoryIdentity(attachment);
          await this.store.transact(
            {
              type: "workflow.caller.requested",
              principal: "runtime:local",
              runId: admitted.run.runId,
              payload: { attemptId: admitted.attempt.attemptId }
            },
            (snapshot) => {
              const run = requireRun(snapshot, admitted.run.runId);
              if (!this.isExecutionCurrent?.(attachment.execution))
                throw new OrchestrationError(
                  "unauthorized",
                  "Calling Agent terminal generation changed during preparation"
                );
              const waiting = startCallerTask({
                leaseRuns: Object.values(snapshot.runs),
                run,
                attemptId: admitted.attempt.attemptId,
                repositoryIdentity,
                context: this.context
              });
              return {
                snapshot: {
                  ...snapshot,
                  runs: { ...snapshot.runs, [run.runId]: waiting }
                },
                value: undefined
              };
            }
          );
        } catch (error) {
          await this.failPreparation({
            attemptId: admitted.attempt.attemptId,
            reason: error instanceof Error ? error.message : String(error)
          });
        }
        continue;
      }
      if (node.definition.kind === "agent") {
        if (this.executionDriver) {
          launch(
            this.executionDriver.execute({
              run: admitted.run,
              attemptId: admitted.attempt.attemptId
            })
          );
        } else {
          launch(
            this.failPreparation({
              attemptId: admitted.attempt.attemptId,
              reason: "local Agent execution driver is unavailable"
            })
          );
        }
        continue;
      }
      if (node.definition.kind === "shell") {
        if (this.shellExecutionDriver) {
          launch(
            this.shellExecutionDriver.execute({
              run: admitted.run,
              attemptId: admitted.attempt.attemptId
            })
          );
        } else {
          launch(
            this.failPreparation({
              attemptId: admitted.attempt.attemptId,
              reason: "local Shell execution driver is unavailable"
            })
          );
        }
        continue;
      }
      await this.executeControlAttempt(admitted.run, admitted.attempt);
    }
  }

  private async armNextTimer(): Promise<void> {
    if (this.shuttingDown || this.drivePromise || this.timerHandle) return;
    const snapshot = await this.store.read();
    if (this.shuttingDown) return;
    const nextDueAt = Object.values(snapshot.runs)
      .filter(
        (run) => !["succeeded", "failed", "canceled"].includes(run.status)
      )
      .flatMap((run) =>
        Object.values(run.timers)
          .filter((timer) => timer.state === "pending")
          .map((timer) => Date.parse(timer.dueAt))
      )
      .filter(Number.isFinite)
      .sort((left, right) => left - right)[0];
    if (nextDueAt === undefined) return;
    const delay = Math.min(
      2_147_483_647,
      Math.max(0, nextDueAt - Date.parse(this.context.now()))
    );
    this.timerHandle = setTimeout(() => {
      this.timerHandle = null;
      void this.drive().catch(() => undefined);
    }, delay);
    this.timerHandle.unref?.();
  }

  private settleRequestedCancellation(
    runId: string,
    operationId: string
  ): Promise<void> {
    const pending = this.cancelInFlight.get(operationId);
    if (pending) return pending;
    const operation = this.performRequestedCancellation(
      runId,
      operationId
    ).finally(() => this.cancelInFlight.delete(operationId));
    this.cancelInFlight.set(operationId, operation);
    return operation;
  }

  private async performRequestedCancellation(
    runId: string,
    operationId: string
  ): Promise<void> {
    const snapshot = await this.store.read();
    const run = requireRun(snapshot, runId);
    const operation = run.cancellations[operationId];
    if (!operation || operation.state !== "requested") return;
    const attempt = run.attempts[operation.attemptId];
    const node = attempt ? run.graph.nodes[attempt.nodeId] : undefined;
    const dispatch = attempt?.dispatchId
      ? run.dispatches[attempt.dispatchId]
      : undefined;
    const shellOperation = Object.values(run.shellOperations).find(
      (candidate) => candidate.attemptId === attempt?.attemptId
    );
    const shellCancellation = node?.definition.kind === "shell";
    const controlCancellation =
      node !== undefined &&
      node.definition.kind !== "agent" &&
      !shellCancellation;
    const driver = shellCancellation
      ? this.shellExecutionDriver
      : this.executionDriver;
    const execution = shellCancellation
      ? shellOperation?.execution
      : dispatch?.execution;
    const safelyOwned = shellCancellation
      ? shellOperation?.state === "executing" &&
        node.definition.config.surfacePolicy === "create" &&
        execution !== undefined &&
        this.isExecutionCurrent?.(execution)
      : dispatch?.execution !== undefined &&
        ownsAgentTerminal(run, operation.attemptId) &&
        this.isExecutionCurrent?.(dispatch.execution);
    try {
      if (
        !attempt ||
        (!controlCancellation && (!safelyOwned || !driver?.cancel))
      ) {
        throw new Error(
          "exact kmux-owned terminal cancellation is unavailable"
        );
      }
      if (!controlCancellation && !shellCancellation)
        await this.workerTerminals.preserve(attempt.attemptId);
      const currentRun = requireAttempt(
        await this.store.read(),
        attempt.attemptId
      ).run;
      const receipt = controlCancellation
        ? { executorReceiptId: `control:${operationId}` }
        : await driver!.cancel!({
            run: currentRun,
            attemptId: attempt.attemptId
          });
      await this.store.transact(
        {
          type: "orchestration.attempt.cancel-confirmed",
          principal: "host:electron-main",
          runId,
          payload: { operationId, executorReceiptId: receipt.executorReceiptId }
        },
        (current) => {
          const currentRun = requireRun(current, runId);
          const currentOperation = currentRun.cancellations[operationId];
          if (!currentOperation || currentOperation.state !== "requested") {
            return { snapshot: current, value: undefined };
          }
          const settled = confirmAttemptCancellation({
            run: currentRun,
            operationId,
            executorReceiptId: receipt.executorReceiptId,
            context: this.context
          });
          return {
            snapshot: {
              ...current,
              runs: { ...current.runs, [runId]: settled },
              capabilities: revokeAttemptCapabilities(
                current.capabilities,
                operation.attemptId
              )
            },
            value: undefined
          };
        }
      );
      await this.workerTerminals
        .settle(operation.attemptId)
        .catch(() => undefined);
    } catch (cause) {
      await this.store.transact(
        {
          type: "orchestration.attempt.cancel-uncertain",
          principal: "host:electron-main",
          runId,
          payload: { operationId }
        },
        (current) => {
          const currentRun = requireRun(current, runId);
          const currentOperation = currentRun.cancellations[operationId];
          if (!currentOperation || currentOperation.state !== "requested") {
            return { snapshot: current, value: undefined };
          }
          const settled = markCancellationUncertain({
            run: currentRun,
            issue: cause instanceof Error ? cause.message : String(cause),
            operationId
          });
          return {
            snapshot: {
              ...current,
              runs: { ...current.runs, [runId]: settled }
            },
            value: undefined
          };
        }
      );
    }
  }

  private async settleReviewedMailboxWorkers(
    runId: string,
    deliveryId: string,
    types: readonly MailboxEventType[] | undefined,
    principal: string
  ): Promise<void> {
    const snapshot = await this.store.read();
    const run = requireVisibleRun(snapshot, runId, principal);
    const capability = resolveGraphCapability(snapshot, {
      requestedRef: "session-bound",
      principal,
      runId,
      authorityEpoch: run.coordinationAuthorityEpoch,
      now: this.context.now()
    });
    this.assertCapabilityGeneration(snapshot, capability);
    if (
      types?.some(
        (type) =>
          !["caller_task", "worker_done", "question", "escalation"].includes(
            type
          )
      )
    ) {
      throw new OrchestrationError(
        "invalid",
        "check types for this consumer are limited to caller_task,worker_done,question,escalation"
      );
    }
    const delivery = mailboxDeliveryForAcknowledgement({
      run,
      consumer: coordinatorMailboxConsumer(run),
      deliveryId
    });
    for (const event of mailboxEventsForDelivery(run, delivery)) {
      if (event.type !== "worker_done" || !event.attemptId) continue;
      const current = requireRun(await this.store.read(), runId);
      const attempt = current.attempts[event.attemptId];
      const dispatch = attempt?.dispatchId
        ? current.dispatches[attempt.dispatchId]
        : undefined;
      if (dispatch?.terminalState !== "reclaimable") continue;
      await this.setInputDisposition(
        {
          attemptId: event.attemptId,
          disposition: reviewedWorkerTerminalDisposition(
            current,
            event.attemptId
          ),
          idempotencyKey: `${deliveryId}:${event.attemptId}:terminal-policy`
        },
        principal
      );
    }
  }

  private async executeControlAttempt(
    run: WorkflowRun,
    attempt: NodeAttempt
  ): Promise<void> {
    const node = run.graph.nodes[attempt.nodeId];
    if (!node) return;
    try {
      await this.store.transact(
        {
          type: "orchestration.control-node.executed",
          principal: "host:electron-main",
          runId: run.runId,
          payload: { nodeId: node.nodeId, attemptId: attempt.attemptId }
        },
        (snapshot) => {
          const current = requireRun(snapshot, run.runId);
          const currentNode = current.graph.nodes[node.nodeId];
          const currentAttempt = current.attempts[attempt.attemptId];
          if (!currentNode || !currentAttempt) {
            throw new OrchestrationError(
              "not-found",
              "control attempt disappeared"
            );
          }
          if (currentAttempt.status !== "preparing")
            return { snapshot, value: undefined };
          if (currentNode.definition.kind === "human-gate") {
            const opened = openHumanGate({
              run: current,
              attemptId: currentAttempt.attemptId,
              context: this.context
            });
            return {
              snapshot: {
                ...snapshot,
                runs: { ...snapshot.runs, [current.runId]: opened.run }
              },
              value: undefined
            };
          }
          if (currentNode.definition.kind === "loop") {
            const started = startStructuredLoop({
              run: current,
              attemptId: currentAttempt.attemptId,
              context: this.context
            });
            return {
              snapshot: {
                ...snapshot,
                runs: { ...snapshot.runs, [current.runId]: started }
              },
              value: undefined
            };
          }
          let selectedPort: string | undefined;
          if (currentNode.definition.kind === "condition") {
            const definition = currentNode.definition;
            selectedPort = selectWorkflowConditionPort({
              config: definition.config,
              inputs: currentAttempt.resolvedInputs,
              values: workflowExpressionValues(current, currentAttempt)
            });
          }
          const settled = settleControlNode({
            run: current,
            attemptId: currentAttempt.attemptId,
            outcome: "succeeded",
            ...(selectedPort ? { selectedPort } : {}),
            context: this.context
          });
          return {
            snapshot: {
              ...snapshot,
              runs: { ...snapshot.runs, [current.runId]: settled }
            },
            value: undefined
          };
        }
      );
    } catch (error) {
      const current = requireAttempt(
        await this.store.read(),
        attempt.attemptId
      );
      if (current.attempt.status === "preparing")
        await this.failPreparation({
          attemptId: attempt.attemptId,
          code: "control-evaluation-failed",
          reason: error instanceof Error ? error.message : String(error)
        });
    }
  }

  private assertCapabilityGeneration(
    snapshot: OrchestrationSnapshot,
    capability: CapabilityGrant
  ): void {
    if (!capability.generationIdentity) return;
    if (capability.execution) {
      if (
        terminalExecutionIdentity(capability.execution) !==
          capability.generationIdentity ||
        !this.isExecutionCurrent?.(capability.execution)
      ) {
        throw new OrchestrationError(
          "unauthorized",
          "orchestration capability terminal generation is stale or unavailable"
        );
      }
      return;
    }
    const attempt = capability.attemptId
      ? requireAttempt(snapshot, capability.attemptId).attempt
      : undefined;
    const run = attempt
      ? requireAttempt(snapshot, attempt.attemptId).run
      : undefined;
    const dispatch = attempt?.dispatchId
      ? run?.dispatches[attempt.dispatchId]
      : undefined;
    if (
      !dispatch?.execution ||
      terminalExecutionIdentity(dispatch.execution) !==
        capability.generationIdentity ||
      !this.isExecutionCurrent?.(dispatch.execution)
    ) {
      throw new OrchestrationError(
        "unauthorized",
        "orchestration capability terminal generation is stale or unavailable"
      );
    }
  }

  private async recover(): Promise<void> {
    const snapshot = await this.store.read();
    const recoverable = Object.values(snapshot.runs).filter(
      (run) =>
        run.status !== "succeeded" &&
        run.status !== "failed" &&
        run.status !== "canceled"
    );
    if (recoverable.length === 0) return;
    await this.store.transact(
      {
        type: "orchestration.host.recovered",
        principal: "host:electron-main",
        payload: { runIds: recoverable.map((run) => run.runId) }
      },
      (current) => ({
        snapshot: {
          ...current,
          runs: {
            ...current.runs,
            ...Object.fromEntries(
              recoverable.map((run) => [
                run.runId,
                recoverRun(current.runs[run.runId] ?? run, this.context)
              ])
            )
          }
        },
        value: undefined
      })
    );
  }
}

function assertLocalCoordinator(run: WorkflowRun, principal: string): void {
  if (principal === "user:local") return;
  const sessionId = principal.startsWith("session:")
    ? principal.slice("session:".length)
    : undefined;
  const attached =
    sessionId !== undefined &&
    run.coordinatorAttachment?.transport === "terminal" &&
    run.coordinatorAttachment.sessionId === sessionId;
  if (!attached) {
    throw new OrchestrationError(
      "unauthorized",
      "This command must come from the Run's exact Coordinator terminal"
    );
  }
}

function resolveWorkerCapability(
  snapshot: OrchestrationSnapshot,
  expected: {
    readonly requestedRef?: string;
    readonly principal: string;
    readonly run: WorkflowRun;
    readonly attempt: NodeAttempt;
    readonly executionIdentity: string;
    readonly now: string;
    readonly allowConsumedReplay?: boolean;
  }
): CapabilityGrant {
  const candidates = Object.values(snapshot.capabilities).filter(
    (capability) =>
      (expected.requestedRef === undefined ||
        expected.requestedRef === "session-bound" ||
        capability.capabilityRef === expected.requestedRef) &&
      capability.kind === "worker-lifecycle" &&
      capability.principal === expected.principal &&
      capability.runId === expected.run.runId &&
      capability.authorityEpoch === expected.run.coordinationAuthorityEpoch &&
      capability.attemptId === expected.attempt.attemptId &&
      capability.nodeId === expected.attempt.nodeId &&
      capability.generationIdentity === expected.executionIdentity &&
      (capability.state === "active" ||
        (expected.allowConsumedReplay && capability.state === "consumed")) &&
      Date.parse(capability.expiresAt) >= Date.parse(expected.now)
  );
  if (candidates.length !== 1) {
    throw new OrchestrationError(
      "unauthorized",
      "worker lifecycle authority is missing, stale, or not bound to this terminal generation"
    );
  }
  return candidates[0]!;
}

function revokeAttemptCapabilities(
  capabilities: OrchestrationSnapshot["capabilities"],
  attemptId: string
): OrchestrationSnapshot["capabilities"] {
  return Object.fromEntries(
    Object.entries(capabilities).map(([ref, capability]) => [
      ref,
      capability.attemptId === attemptId && capability.state === "active"
        ? { ...capability, state: "revoked" as const }
        : capability
    ])
  );
}

function requireCapability(
  snapshot: OrchestrationSnapshot,
  expected: {
    capabilityRef: string;
    kind: CapabilityGrant["kind"];
    principal: string;
    runId: string;
    authorityEpoch: number;
    now: string;
  }
): CapabilityGrant {
  const capability = snapshot.capabilities[expected.capabilityRef];
  if (
    !capability ||
    capability.state !== "active" ||
    capability.kind !== expected.kind ||
    capability.principal !== expected.principal ||
    capability.runId !== expected.runId ||
    capability.authorityEpoch !== expected.authorityEpoch ||
    Date.parse(capability.expiresAt) < Date.parse(expected.now)
  ) {
    throw new OrchestrationError(
      "unauthorized",
      "orchestration capability is missing, expired, stale, or outside its scope"
    );
  }
  return capability;
}

function resolveGraphCapability(
  snapshot: OrchestrationSnapshot,
  expected: {
    readonly requestedRef: string;
    readonly principal: string;
    readonly runId: string;
    readonly authorityEpoch: number;
    readonly now: string;
  }
): CapabilityGrant {
  if (expected.requestedRef !== "session-bound") {
    return requireCapability(snapshot, {
      capabilityRef: expected.requestedRef,
      kind: "graph-author",
      principal: expected.principal,
      runId: expected.runId,
      authorityEpoch: expected.authorityEpoch,
      now: expected.now
    });
  }
  if (!expected.principal.startsWith("session:")) {
    throw new OrchestrationError(
      "unauthorized",
      "session-bound graph authority requires an authenticated Agent session"
    );
  }
  const candidates = Object.values(snapshot.capabilities).filter(
    (capability) =>
      capability.kind === "graph-author" &&
      capability.principal === expected.principal &&
      capability.runId === expected.runId &&
      capability.authorityEpoch === expected.authorityEpoch &&
      capability.state === "active" &&
      Date.parse(capability.expiresAt) >= Date.parse(expected.now)
  );
  if (candidates.length !== 1) {
    throw new OrchestrationError(
      "unauthorized",
      "session-bound graph authority is missing or ambiguous"
    );
  }
  return candidates[0]!;
}

function requireReusableWorkerDispatch(
  run: WorkflowRun,
  dispatchId: string,
  agentId: string
): Dispatch {
  const dispatch = run.dispatches[dispatchId];
  if (!dispatch) {
    throw new OrchestrationError(
      "not-found",
      `Dispatch '${dispatchId}' was not found in this Run`
    );
  }
  const attempt = run.attempts[dispatch.attemptId];
  if (
    dispatch.selectedAgentId !== agentId ||
    !dispatch.execution ||
    !attempt ||
    !["succeeded", "failed", "canceled"].includes(attempt.status) ||
    dispatch.terminalState !== "reclaimable"
  ) {
    throw new OrchestrationError(
      "conflict",
      "Only the exact settled Dispatch of the same Agent can be reused"
    );
  }
  return dispatch;
}

function autoSealCompletedCoordination(
  run: WorkflowRun,
  context: RuntimeContext
): WorkflowRun {
  if (run.graph.authoringState !== "open") return run;
  if (run.coordinatorAttachment?.transport === "terminal") {
    const consumer = run.mailboxConsumers.coordinator;
    const cursor = consumer?.acknowledgedCursor ?? 0;
    if (
      consumer?.activeDelivery ||
      run.mailboxEvents.some(
        (event) =>
          event.target.kind === "coordinator" && event.sequence > cursor
      )
    ) {
      return run;
    }
  }
  if (
    run.coordinatorTurns.some(
      (turn) => turn.status === "pending" || turn.status === "active"
    )
  ) {
    return run;
  }
  // task-create persists the plan before worker-start materializes graph nodes.
  // Acknowledging one result must not seal away those undispatched Tasks.
  if (Object.values(run.tasks).some((task) => !task.nodeId)) return run;
  const workNodes = Object.values(run.graph.nodes);
  if (
    workNodes.length === 0 ||
    workNodes.some(
      (node) =>
        !["succeeded", "failed", "canceled", "skipped"].includes(node.status)
    )
  ) {
    return run;
  }
  return sealRunGraph({
    run,
    expectedGraphRevision: run.graph.revision,
    consumedEventCursor: run.coordinatorEventCursor,
    authorityEpoch: run.coordinationAuthorityEpoch,
    idempotencyKey: `runtime:auto-seal:${run.graph.revision}:${run.coordinatorEventCursor}`,
    context
  });
}

function parseAdaptiveHostCommand(input: unknown): CreateAdaptiveRunCommand & {
  readonly coordinatorAttachment?: NonNullable<
    WorkflowRun["coordinatorAttachment"]
  >;
} {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return parseCreateAdaptiveRunCommand(input);
  }
  const { coordinatorAttachment, ...publicCommand } = input as Record<
    string,
    unknown
  >;
  const command = parseCreateAdaptiveRunCommand(publicCommand);
  if (coordinatorAttachment === undefined) return command;
  if (
    coordinatorAttachment === null ||
    typeof coordinatorAttachment !== "object" ||
    Array.isArray(coordinatorAttachment) ||
    typeof (coordinatorAttachment as Record<string, unknown>).surfaceId !==
      "string" ||
    typeof (coordinatorAttachment as Record<string, unknown>).sessionId !==
      "string"
  ) {
    throw new OrchestrationError(
      "invalid",
      "attached Coordinator invocation context is malformed"
    );
  }
  const attachment = coordinatorAttachment as Record<string, unknown>;
  const execution = terminalExecutionRefSchema.safeParse(attachment.execution);
  if (attachment.transport === "terminal") {
    const owner = attachment.process as
      | { pid?: unknown; startedAt?: unknown }
      | undefined;
    if (
      !execution.success ||
      execution.data.surfaceId !== attachment.surfaceId ||
      execution.data.sessionId !== attachment.sessionId ||
      !owner ||
      typeof owner.pid !== "number" ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      typeof owner.startedAt !== "string" ||
      !owner.startedAt
    ) {
      throw new OrchestrationError(
        "invalid",
        "Terminal Coordinator requires a verified process and terminal generation"
      );
    }
    return {
      ...command,
      coordinatorAttachment: {
        transport: "terminal",
        surfaceId: attachment.surfaceId as string,
        sessionId: attachment.sessionId as string,
        execution: execution.data,
        process: { pid: owner.pid, startedAt: owner.startedAt }
      }
    };
  }
  throw new OrchestrationError(
    "invalid",
    "attached Coordinator requires one exact terminal process and generation"
  );
}
