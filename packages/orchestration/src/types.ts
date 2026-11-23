export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export type Id = string;
export type IsoTimestamp = string;
export type ContentHash = `sha256:${string}`;

export interface JsonSchemaRef {
  readonly ref?: string;
  readonly schema?: Readonly<Record<string, JsonValue>>;
}

export type SessionPolicy = "fresh" | "reuse" | "prefer-reuse" | "existing";
export type SurfacePolicy = "create" | "create-or-reuse" | "existing";
export type WorktreePolicy =
  | "current"
  | "dedicated-child"
  | "dedicated-top-level"
  | "target-repository-new"
  | "from-input"
  | "advisory-read-only";
export type AuthorityMode = "restricted" | "ambient";
export type InputMode = "orchestrated" | "interactive-recorded";

export interface AgentLaunchPreferences {
  readonly model?: string;
  readonly effort?: string;
}

export interface AgentLaunchReceipt {
  readonly requested: AgentLaunchPreferences;
  readonly effective: AgentLaunchPreferences;
  readonly evidence: "provider-verified" | "executor-applied" | "unknown";
  readonly agentDescriptorRevision: string;
}

export type AgentSelector =
  | { readonly kind: "caller" }
  | { readonly kind: "agent-id"; readonly agentId: string }
  | {
      readonly kind: "run-input";
      readonly inputId: string;
      readonly requiredCapabilities?: readonly string[];
    };

export type AgentBindingScope =
  | { readonly kind: "run" }
  | { readonly kind: "loop-iteration"; readonly loopNodeId: string };

export interface AgentBindingDefinition {
  readonly agent: AgentSelector;
  readonly scope: AgentBindingScope;
  readonly authorityMode: AuthorityMode;
  /** Required execution features, retained independently of Agent selection. */
  readonly capabilities?: readonly string[];
  readonly launch?: AgentLaunchPreferences;
  readonly targetPolicy: "local" | "selected" | "workflow-input";
  readonly targetRef?: string;
  readonly surfacePolicy: SurfacePolicy;
  readonly sessionPolicy: SessionPolicy;
  readonly existingSurfaceId?: string;
  readonly worktreePolicy: WorktreePolicy;
  readonly worktreeInput?: InputMapping;
  readonly inputMode: InputMode;
  readonly allowSharedWrite?: boolean;
}

export interface RunLimits {
  readonly maxNodes: number;
  readonly maxEdges: number;
  readonly maxGraphDepth: number;
  readonly maxFanOut: number;
  readonly maxLoopIterations: number;
  readonly maxActiveAttempts: number;
  readonly maxAttemptsPerSession: number;
  readonly maxDispatches: number;
  readonly maxCoordinatorTurns: number;
  readonly maxGraphPatches: number;
  readonly maxWallClockMs: number;
  readonly maxActiveExecutionMs: number;
  readonly maxArtifactBytes: number;
  readonly maxStructuredResultBytes: number;
}

export interface WorkflowPolicies {
  readonly limits: RunLimits;
  readonly failure: "fail-run" | "wake-coordinator" | "needs-attention";
  readonly cancellation: "cancel-active" | "wait-active";
}

export interface WorkflowInputDefinition {
  readonly id: string;
  readonly required: boolean;
  readonly schema?: JsonSchemaRef;
  readonly default?: JsonValue;
}

export type DataSource =
  | { readonly kind: "loop-index"; readonly loopNodeId: string }
  | {
      readonly kind: "run-input";
      readonly inputId: string;
      readonly path?: readonly string[];
    }
  | {
      readonly kind: "loop-item";
      readonly loopNodeId: string;
      readonly path?: readonly string[];
    }
  | {
      readonly kind: "loop-carry";
      readonly loopNodeId: string;
      readonly inputId: string;
      readonly path?: readonly string[];
    }
  | { readonly kind: "repository-state"; readonly nodeId: string }
  | {
      readonly kind: "node-result";
      readonly nodeId: string;
      readonly path?: readonly string[];
    }
  | {
      readonly kind: "node-outcome";
      readonly nodeId: string;
      readonly path?: readonly string[];
    }
  | { readonly kind: "literal"; readonly value: JsonValue };

export interface InputMapping {
  readonly target: string;
  readonly source: DataSource;
  readonly required: boolean;
  readonly missing: "fail" | "use-default" | "omit";
  readonly default?: JsonValue;
}

export interface WorkflowOutputDefinition {
  readonly id: string;
  readonly required: boolean;
  readonly source: DataSource;
  readonly schema?: JsonSchemaRef;
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly retryable: readonly (
    | "executor-error"
    | "invalid-result"
    | "timeout"
    | "lost-worker"
  )[];
  readonly backoffMs: number;
  readonly placement: "same" | "allow-fresh" | "approval-for-change";
}

export interface TimeoutPolicy {
  readonly timeoutMs: number;
  readonly onTimeout:
    | "checkpoint"
    | "needs-attention"
    | "wake-coordinator"
    | "cancel-and-retry"
    | "fail";
}

export type JoinPolicy = "all-successful" | "all-settled" | "any-successful";

export interface WorkflowNodeBase {
  readonly id: string;
  readonly title: string;
  readonly inputMappings?: readonly InputMapping[];
  readonly resultSchema?: JsonSchemaRef;
  readonly retryPolicy?: RetryPolicy;
  readonly timeoutPolicy?: TimeoutPolicy;
  readonly joinPolicy?: JoinPolicy;
  readonly anySuccessfulDisposition?: "wait" | "cancel";
  readonly completionRoot?: boolean;
  readonly requiredSideEffect?: boolean;
  readonly onFailure?: "fail-run" | "skip-descendants" | "wake-coordinator";
  readonly onCancel?: "fail-run" | "skip-descendants" | "wake-coordinator";
}

export interface StartNodeDefinition extends WorkflowNodeBase {
  readonly kind: "start";
  readonly config: { readonly version: 1 };
}

export interface EndNodeDefinition extends WorkflowNodeBase {
  readonly kind: "end";
  readonly config: { readonly version: 1 };
}

export interface AgentNodeDefinition extends WorkflowNodeBase {
  readonly kind: "agent";
  readonly config: {
    readonly version: 1;
    readonly agentRef: string;
    readonly launch?: AgentLaunchPreferences;
    readonly prompt: string;
    readonly lifecycleMode: "managed";
    readonly coding: boolean;
  };
}

export type ShellArgument =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "input"; readonly input: string }
  | { readonly kind: "secret"; readonly secretRef: string };

export type ShellCommand =
  | {
      readonly kind: "structured";
      readonly executable: string;
      readonly args: readonly ShellArgument[];
    }
  | {
      readonly kind: "script";
      readonly script: string;
      readonly args: readonly ShellArgument[];
    };

export interface ShellNodeDefinition extends WorkflowNodeBase {
  readonly kind: "shell";
  readonly config: {
    readonly version: 1;
    readonly command: ShellCommand;
    readonly targetPolicy: "local" | "selected" | "workflow-input";
    readonly targetRef?: string;
    readonly surfacePolicy: "create";
    readonly cwdPolicy: "workspace" | "from-input";
    readonly cwdInput?: InputMapping;
    readonly resultMode: "exit-code" | "json-stdout" | "result-file";
    readonly resultFileInput?: string;
    readonly maxOutputBytes: number;
  };
}

export type ConditionOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "not_contains"
  | "in"
  | "nin"
  | "is_empty"
  | "is_not_empty"
  | "is_true"
  | "is_false";

export interface WorkflowCondition {
  readonly key: string;
  readonly left: DataSource;
  readonly operator: ConditionOperator;
  readonly right?: DataSource;
}

export interface LoopOutputDefinition {
  readonly name: string;
  readonly source: DataSource;
  readonly mode: "last" | "collect";
}

export interface LoopControlNodeDefinition extends WorkflowNodeBase {
  readonly kind: "break" | "continue";
  readonly config: { readonly version: 1 };
}

export interface ConditionNodeDefinition extends WorkflowNodeBase {
  readonly kind: "condition";
  readonly config: {
    readonly version: 1;
    readonly expressionVersion: 1;
    readonly expression: string;
    readonly conditions?: readonly WorkflowCondition[];
    readonly ports: readonly string[];
    readonly errorPort?: string;
  };
}

export interface LoopNodeDefinition extends WorkflowNodeBase {
  readonly kind: "loop";
  readonly config:
    | {
        readonly version: 1;
        readonly mode: "for-each";
        readonly collection: DataSource;
        readonly itemInputId: string;
        readonly maxItems: number;
        readonly concurrency: number;
        readonly body: LoopBodyDefinition;
        readonly completedPort: string;
        readonly maxReachedPort: string;
        readonly loopOutputs?: readonly LoopOutputDefinition[];
        readonly accumulator?: {
          readonly outputId: string;
          readonly source: DataSource;
        };
      }
    | {
        readonly version: 1;
        readonly mode: "while";
        readonly maxIterations: number;
        readonly body: LoopBodyDefinition;
        readonly repeatOutcome: string;
        readonly completedOutcomes: readonly string[];
        readonly completedPort: string;
        readonly maxReachedPort: string;
        readonly loopOutputs?: readonly LoopOutputDefinition[];
        readonly maxGate?: {
          readonly nodeId: string;
          readonly retryResolution: string;
          readonly completedResolutions: readonly {
            readonly resolution: string;
            readonly port: string;
          }[];
          readonly abortResolution: string;
        };
        readonly carry?: readonly {
          readonly inputId: string;
          readonly initial: DataSource;
          readonly next: DataSource;
        }[];
      };
}

export interface LoopBodyDefinition {
  readonly nodeIds: readonly string[];
  readonly entryNodeIds: readonly string[];
  readonly exits: readonly {
    readonly nodeId: string;
    readonly port?: string;
    readonly outcome: string;
    readonly action?: "break" | "continue";
  }[];
}

export interface HumanGateNodeDefinition extends WorkflowNodeBase {
  readonly kind: "human-gate";
  readonly config: {
    readonly version: 1;
    readonly question: string;
    readonly resolutions: readonly string[];
    readonly approverPolicy: "run-owner" | "local-user";
  };
}

export type WorkflowNodeDefinition =
  | StartNodeDefinition
  | EndNodeDefinition
  | ShellNodeDefinition
  | AgentNodeDefinition
  | ConditionNodeDefinition
  | LoopControlNodeDefinition
  | LoopNodeDefinition
  | HumanGateNodeDefinition;

export interface WorkflowControlEdge {
  readonly id: string;
  readonly from: { readonly nodeId: string; readonly port?: string };
  readonly to: { readonly nodeId: string; readonly port?: string };
}

export interface WorkflowDefinitionV1 {
  readonly schemaVersion: 1;
  readonly definitionId: string;
  readonly version: number;
  readonly name: string;
  readonly description?: string;
  readonly inputs: readonly WorkflowInputDefinition[];
  readonly outputs: readonly WorkflowOutputDefinition[];
  readonly agentBindings: Readonly<Record<string, AgentBindingDefinition>>;
  readonly nodes: readonly WorkflowNodeDefinition[];
  readonly edges: readonly WorkflowControlEdge[];
  readonly policies: WorkflowPolicies;
}

export interface WorkflowVersion {
  readonly workflowVersionId: Id;
  readonly definitionId: Id;
  readonly version: number;
  readonly schemaVersion: 1;
  readonly compilerVersion: 1;
  readonly expressionVersion: 1;
  readonly reachabilityVersion: 1;
  readonly contentHash: ContentHash;
  readonly definition: WorkflowDefinitionV1;
  /** Immutable presentation snapshot; never authoritative for execution or its hash. */
  readonly editorDocument?: JsonValue;
  readonly publishedAt: IsoTimestamp;
}

export interface WorkflowDraft {
  readonly draftId: Id;
  readonly definitionId: Id;
  readonly revision: number;
  readonly canonicalDraft: JsonValue;
  readonly editorDocument: JsonValue;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export type GraphAuthoringState = "open" | "sealed";
export type RunStatus =
  | "created"
  | "running"
  | "waiting-for-coordinator"
  | "waiting-gate"
  | "needs-attention"
  | "settling"
  | "succeeded"
  | "failed"
  | "canceled";
export type RunNodeStatus =
  | "pending"
  | "ready"
  | "preparing"
  | "running"
  | "waiting-input"
  | "waiting-gate"
  | "needs-attention"
  | "cancel-requested"
  | "succeeded"
  | "failed"
  | "canceled"
  | "skipped"
  | "uncertain";

export type AttemptStatus =
  | "preparing"
  | "delivery-pending"
  | "running"
  | "waiting-input"
  | "cancel-requested"
  | "cancel-uncertain"
  | "succeeded"
  | "failed"
  | "canceled"
  | "uncertain";

export interface RunNode {
  readonly nodeId: Id;
  readonly definition: WorkflowNodeDefinition;
  readonly definitionHash: ContentHash;
  readonly stateRevision: number;
  readonly status: RunNodeStatus;
  readonly selectedPredecessors: readonly Id[];
  readonly skipProvenance?: {
    readonly sourceNodeId: Id;
    readonly selectedPort: string;
  };
  readonly admissionFailure?:
    | {
        readonly class: "input-mapping";
        readonly code: "missing-required-input";
        readonly mappingTarget: string;
        readonly message: string;
      }
    | {
        readonly class: "admission";
        readonly code: "invalid" | "unsupported" | "budget-exhausted";
        readonly message: string;
        readonly details?: Readonly<Record<string, JsonValue>>;
      };
  readonly attemptIds: readonly Id[];
  readonly activeAttemptId?: Id;
  readonly selectedPort?: string;
  readonly loopState?: {
    readonly iteration: number;
    readonly invocation?: number;
    readonly frozenItems?: readonly JsonValue[];
    readonly activeIterationIds?: readonly Id[];
    readonly completedIterationIds?: readonly Id[];
    readonly accumulated?: readonly JsonValue[];
    readonly breakRequested?: boolean;
    readonly outputHistory?: readonly {
      readonly invocation?: number;
      readonly iteration: number;
      readonly values: Readonly<Record<string, JsonValue>>;
    }[];
    readonly awaitingGateNodeId?: Id;
    readonly carry?: Readonly<Record<string, JsonValue>>;
    readonly outcome?: "break" | "max-reached";
  };
  readonly materialization?: {
    readonly templateNodeId: Id;
    readonly ownerLoopNodeId: Id;
    readonly iterationId: Id;
    readonly iteration: number;
    readonly path: readonly {
      readonly loopNodeId: Id;
      readonly iterationId: Id;
      readonly iteration: number;
    }[];
    readonly bodyEntry: boolean;
  };
  readonly joinResolution?: {
    readonly policy: JoinPolicy;
    readonly selectedPredecessors: readonly Id[];
    readonly outcome: "satisfied" | "unsatisfied";
    readonly winningPredecessorId?: Id;
    readonly otherPredecessorIds?: readonly Id[];
    readonly disposition?: "wait" | "cancel";
    readonly version: 1;
  };
  readonly joinDisposition?: {
    readonly joinNodeId: Id;
    readonly disposition: "cancel";
    readonly issue?: string;
  };
}

export interface TerminalExecutionRef {
  readonly targetId: Id;
  readonly targetAuthority: Id;
  readonly surfaceId: Id;
  readonly sessionId: Id;
  readonly generation:
    | { readonly kind: "local"; readonly runtimeEpoch: Id }
    | { readonly kind: "remote"; readonly keeperGeneration: Id };
  readonly inputAuthorityRef: Id;
  readonly providerSessionClaim?: {
    readonly id: string;
    readonly trust: "verified" | "inferred";
  };
}

export interface AgentReadinessReceipt {
  readonly receiptId: Id;
  readonly execution: TerminalExecutionRef;
  readonly agentId: string;
  readonly agentInstanceId: Id;
  readonly readyEpoch: Id;
  readonly verifiedProviderSessionId?: string;
  readonly state: "ready-for-input";
  readonly observedAt: IsoTimestamp;
}

export interface RepositoryStateRef {
  readonly targetId: Id;
  readonly repositoryId: Id;
  readonly worktreeRef?: {
    readonly targetId: Id;
    readonly worktreeId: Id;
    readonly pathToken: Id;
  };
  readonly headOid: string;
  readonly indexTreeHash?: string;
  readonly dirtyPatch?: ArtifactRef;
  readonly dirtyPatchHash?: ContentHash;
  readonly untrackedManifest?: ArtifactRef;
  readonly capturedAt: IsoTimestamp;
  readonly consistency: "immutable-snapshot" | "fenced-live-worktree";
}

export interface ArtifactRef {
  readonly artifactId: Id;
  readonly kind: string;
  readonly contentHash: ContentHash;
  readonly sizeBytes: number;
  readonly targetId?: Id;
  readonly retentionUntil?: IsoTimestamp;
}

export type WorkerTerminalState =
  | "active"
  | "reclaimable"
  | "retained"
  | "release-pending"
  | "release-unknown"
  | "released";

export interface WorkerOutputArchive {
  readonly artifact: ArtifactRef;
  readonly source: "transcript" | "terminal";
  readonly status: "available" | "empty";
  readonly truncated: boolean;
}

export interface Dispatch {
  readonly dispatchId: Id;
  readonly runId: Id;
  readonly nodeId: Id;
  readonly attemptId: Id;
  readonly agentRef: string;
  readonly selectedAgentId: string;
  readonly bindingInstanceKey: Id;
  readonly lifecycleMode: "managed";
  readonly requestedBinding: AgentBindingDefinition;
  readonly requestedLaunch: AgentLaunchPreferences;
  readonly launchReceipt?: AgentLaunchReceipt;
  readonly execution?: TerminalExecutionRef;
  readonly readinessReceiptId?: Id;
  readonly repositoryStateInput?: RepositoryStateRef;
  readonly deliveryOperationId?: Id;
  /** Lifecycle of the exact terminal generation owned by this Dispatch. */
  readonly terminalState?: WorkerTerminalState;
  readonly terminalStateChangedAt?: IsoTimestamp;
  readonly terminalDisposition?:
    | "reuse"
    | "retain"
    | "release"
    | "user-takeover";
  readonly reusedFromDispatchId?: Id;
  readonly reusedByDispatchId?: Id;
  /** Final history captured before the terminal is closed or handed to another Dispatch. */
  readonly terminalHistory?: WorkerOutputArchive;
  readonly historyIssue?: string;
  readonly lastHeartbeat?: {
    readonly receivedAt: IsoTimestamp;
    readonly phase: string;
  };
}

export interface PromptDelivery {
  readonly operationId: Id;
  readonly dispatchId: Id;
  readonly execution: TerminalExecutionRef;
  readonly readinessReceiptId: Id;
  readonly payloadHash: ContentHash;
  readonly state:
    | "pending"
    | "accepted"
    | "written"
    | "uncertain"
    | "fenced"
    | "failed";
  readonly receiptId?: Id;
}

export interface NodeAttempt {
  readonly attemptId: Id;
  readonly runId: Id;
  readonly nodeId: Id;
  readonly ordinal: number;
  readonly status: AttemptStatus;
  readonly createdAt: IsoTimestamp;
  readonly effectiveDefinitionHash: ContentHash;
  readonly effectiveGraphRevision: number;
  readonly effectiveNodeStateRevision: number;
  readonly resolvedInputs: Readonly<Record<string, JsonValue>>;
  readonly materializationPath?: NonNullable<
    RunNode["materialization"]
  >["path"];
  readonly effectiveInputMode?: InputMode;
  readonly inputInterventionIds: readonly Id[];
  readonly dispatchId?: Id;
  readonly callerTask?: {
    readonly requestId: Id;
    readonly state: "waiting" | "completed";
  };
  readonly retryOfAttemptId?: Id;
  readonly notBefore?: IsoTimestamp;
  readonly dueAt?: IsoTimestamp;
  readonly startedAt?: IsoTimestamp;
  readonly settledAt?: IsoTimestamp;
  readonly preparationIssue?: {
    readonly code: string;
    readonly message: string;
    readonly observedAt: IsoTimestamp;
  };
  readonly completionIssue?: {
    readonly code: "worker-lost";
    readonly message: string;
    readonly observedAt: IsoTimestamp;
  };
}

export interface AgentResultSubmission {
  readonly outcome: "succeeded" | "failed" | "canceled";
  readonly failureClass?:
    | "executor-error"
    | "invalid-result"
    | "timeout"
    | "lost-worker";
  readonly summary: string;
  /** Optional worker-authored report; never required for completion. */
  readonly reportPath?: string;
  readonly data?: JsonValue;
  readonly artifacts?: readonly ArtifactRef[];
}

export interface NodeResult extends AgentResultSubmission {
  readonly nodeId: Id;
  readonly attemptId: Id;
  readonly filesModified?: readonly string[];
  readonly repositoryState?: RepositoryStateRef;
  readonly transcriptRef?: ArtifactRef;
  readonly usage?: Readonly<Record<string, JsonValue>>;
  readonly executionReceipt?: {
    readonly dispatchId: Id;
    readonly execution: TerminalExecutionRef;
    readonly readinessReceiptId: Id;
    readonly agentInstanceId: Id;
    readonly effectiveDefinitionHash: ContentHash;
    readonly effectiveInputMode: InputMode;
    readonly inputInterventionIds: readonly Id[];
    readonly resultSubmissionHash: ContentHash;
  };
  readonly shellExecutionReceipt?: {
    readonly operationId: Id;
    readonly execution: TerminalExecutionRef;
    readonly commandHash: ContentHash;
    readonly exitCode: number;
    readonly outputHash: ContentHash;
    readonly outputBytes: number;
  };
}

export interface ShellExecutionOperation {
  readonly operationId: Id;
  readonly runId: Id;
  readonly nodeId: Id;
  readonly attemptId: Id;
  readonly commandHash: ContentHash;
  readonly state:
    | "intent-recorded"
    | "executing"
    | "applied"
    | "canceled"
    | "confirmed-absent"
    | "outcome-unknown"
    | "needs-attention";
  readonly execution?: TerminalExecutionRef;
  readonly processId?: number;
  readonly exitCode?: number;
  readonly outputHash?: ContentHash;
  readonly outputBytes?: number;
  readonly receiptId?: Id;
  readonly issue?: string;
  readonly createdAt: IsoTimestamp;
  readonly settledAt?: IsoTimestamp;
}

export interface ResultSubmissionReceipt {
  readonly receiptId: Id;
  readonly attemptId: Id;
  readonly idempotencyKey: Id;
  readonly submissionHash: ContentHash;
  readonly settledAt: IsoTimestamp;
}

export interface CancellationOperation {
  readonly issue?: string;
  readonly operationId: Id;
  readonly attemptId: Id;
  readonly idempotencyKey: Id;
  readonly requestedAt: IsoTimestamp;
  readonly state: "requested" | "confirmed" | "uncertain";
  readonly settledAt?: IsoTimestamp;
  readonly executorReceiptId?: Id;
  readonly joinNodeId?: Id;
  readonly timeout?: {
    readonly timerId: Id;
    readonly onTimeout: "fail" | "cancel-and-retry";
  };
}

export interface ManualRetryOperation {
  readonly operationId: Id;
  readonly priorAttemptId: Id;
  readonly nodeId: Id;
  readonly idempotencyKey: Id;
  readonly requestedBy: Id;
  readonly requestedAt: IsoTimestamp;
  readonly placementChangeApproved?: true;
  readonly state: "queued";
}

export interface ResourceLease {
  readonly leaseId: Id;
  readonly resource: {
    readonly kind: "terminal-session" | "worktree";
    readonly identity: string;
  };
  readonly revision: number;
  readonly ownerEpoch: number;
  readonly owner: {
    readonly kind: "attempt";
    readonly id: Id;
    readonly generation?: string;
  };
  readonly mode: "read" | "write" | "capacity";
  readonly capacityClaim: number;
  readonly state:
    | "active"
    | "uncertain"
    | "reconciling"
    | "released"
    | "abandoned";
}

export interface AttemptInputControl {
  readonly attemptId: Id;
  readonly execution: TerminalExecutionRef;
  readonly mode: InputMode;
  readonly owner: "runtime" | "released";
  readonly revision: number;
  readonly priorOwner: "user" | "runtime";
  readonly priorMode?: InputMode;
  readonly consentReceiptId?: Id;
  readonly claimedAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly readinessInvalidatedAt?: IsoTimestamp;
  readonly requestedDisposition?: "retain" | "release";
  readonly dispositionRequestId?: Id;
  readonly dispositionIdempotencyKey?: Id;
  readonly disposition?: "retain" | "release";
  readonly dispositionAt?: IsoTimestamp;
}

export interface InputIntervention {
  readonly interventionId: Id;
  readonly attemptId: Id;
  readonly execution: TerminalExecutionRef;
  readonly operationId: Id;
  readonly idempotencyKey: Id;
  readonly principal: Id;
  readonly kind: "interactive-input";
  readonly payloadHash?: ContentHash;
  readonly payloadBytes?: number;
  readonly occurredAt: IsoTimestamp;
}

export interface OrchestrationMessage {
  readonly messageId: Id;
  readonly runId: Id;
  readonly kind:
    | "status"
    | "heartbeat"
    | "guidance"
    | "question"
    | "reply"
    | "escalation"
    | "completion"
    | "gate-request"
    | "gate-resolution"
    | "handoff";
  readonly principal: Id;
  readonly nodeId?: Id;
  readonly attemptId?: Id;
  readonly replyToMessageId?: Id;
  readonly body: JsonValue;
  readonly createdAt: IsoTimestamp;
}

export type MailboxEventType =
  | "caller_task"
  | "worker_done"
  | "question"
  | "escalation"
  | "guidance"
  | "reply";

export type MailboxTarget =
  | { readonly kind: "coordinator" }
  | { readonly kind: "dispatch"; readonly dispatchId: Id };

/** Immutable routing record; message and result bodies remain authoritative elsewhere. */
export interface MailboxEvent {
  readonly eventId: Id;
  readonly runId: Id;
  readonly sequence: number;
  readonly type: MailboxEventType;
  readonly target: MailboxTarget;
  readonly messageId?: Id;
  readonly attemptId?: Id;
  readonly createdAt: IsoTimestamp;
}

export type MailboxConsumer =
  | {
      readonly kind: "coordinator";
      readonly surfaceId: Id;
      readonly sessionId: Id;
      readonly generation: TerminalExecutionRef["generation"];
    }
  | {
      readonly kind: "dispatch";
      readonly dispatchId: Id;
      readonly execution: TerminalExecutionRef;
    };

export interface MailboxDelivery {
  readonly deliveryId: Id;
  readonly consumer: MailboxConsumer;
  readonly cursorStart: number;
  readonly cursorEnd: number;
  readonly eventIds: readonly Id[];
  readonly claimedAt: IsoTimestamp;
}

export interface MailboxConsumerState {
  readonly consumerKey: string;
  readonly consumer: MailboxConsumer;
  readonly acknowledgedCursor: number;
  readonly activeDelivery?: MailboxDelivery;
}

export interface HumanGate {
  readonly gateId: Id;
  readonly runId: Id;
  readonly nodeId: Id;
  readonly question: string;
  readonly resolutions: readonly string[];
  readonly state: "open" | "resolved" | "canceled";
  readonly resolution?: string;
  readonly resolvedBy?: Id;
  readonly resolvedAt?: IsoTimestamp;
  readonly canceledAt?: IsoTimestamp;
}

export interface CoordinatorTurn {
  readonly turnId: Id;
  readonly runId: Id;
  readonly authorityEpoch: number;
  readonly wakeReason:
    | "objective"
    | "worker-result"
    | "question"
    | "gate"
    | "patch-rejected"
    | "user-reply";
  readonly eventCursorStart: number;
  readonly eventCursorEnd: number;
  readonly startingGraphRevision: number;
  readonly resultingGraphRevision?: number;
  readonly status: "pending" | "active" | "committed" | "failed" | "uncertain";
  readonly idempotencyKey: Id;
  readonly receiptId?: Id;
  readonly summary?: string;
}

export interface CoordinatorAttachment {
  readonly surfaceId: Id;
  readonly sessionId: Id;
  readonly execution: TerminalExecutionRef;
  readonly transport: "terminal";
  readonly process: { readonly pid: number; readonly startedAt: string };
}

export interface RunBudgetCounters {
  readonly nodes: number;
  readonly edges: number;
  readonly dispatches: number;
  readonly activeAttempts: number;
  readonly coordinatorTurns: number;
  readonly graphPatches: number;
  readonly loopIterations: number;
  readonly activeExecutionMs: number;
  readonly artifactBytes: number;
  readonly structuredResultBytes: number;
}

export interface RunTimer {
  readonly timerId: Id;
  readonly runId: Id;
  readonly attemptId?: Id;
  readonly kind: "retry" | "timeout" | "run-deadline";
  readonly dueAt: IsoTimestamp;
  readonly policyVersion: 1;
  readonly state: "pending" | "fired" | "canceled";
  readonly effectIdempotencyKey: Id;
}

export interface RunGraph {
  readonly revision: number;
  readonly authoringState: GraphAuthoringState;
  readonly nodes: Readonly<Record<Id, RunNode>>;
  readonly edges: readonly WorkflowControlEdge[];
  readonly bodyTemplates: Readonly<Record<Id, WorkflowNodeDefinition>>;
  readonly bodyTemplateEdges: readonly WorkflowControlEdge[];
  readonly agentBindings: Readonly<Record<string, AgentBindingDefinition>>;
  readonly patches: readonly GraphPatchReceipt[];
  readonly sealedAt?: IsoTimestamp;
  readonly sealReceiptId?: Id;
}

/**
 * A user-facing ad hoc Task. Workflow nodes remain their own durable Task
 * definitions; this record exists for Tasks authored incrementally through the
 * local orchestration CLI before (or while) they are dispatched.
 */
export interface AdHocTask {
  readonly taskId: Id;
  readonly runId: Id;
  readonly spec: string;
  readonly title: string;
  readonly dependencies: readonly Id[];
  readonly createdAt: IsoTimestamp;
  readonly nodeId?: Id;
}

export interface WorkerTerminalPolicy {
  readonly succeeded: "retain" | "release";
  readonly failed: "retain" | "release";
}

export interface WorkflowRun {
  readonly runId: Id;
  /** Settings snapshot. Applied when results are reviewed, never on submission. */
  readonly workerTerminalPolicy: WorkerTerminalPolicy;
  /** Host-selected execution workspace, fixed when the Run is created. */
  readonly workspaceId?: Id;
  readonly source:
    | {
        readonly kind: "workflow-version";
        readonly workflowVersionId: Id;
        readonly contentHash: ContentHash;
      }
    | { readonly kind: "ad-hoc"; readonly objective: string };
  readonly createdAt: IsoTimestamp;
  readonly startedAt?: IsoTimestamp;
  readonly settledAt?: IsoTimestamp;
  readonly status: RunStatus;
  readonly graph: RunGraph;
  readonly inputs: Readonly<Record<string, JsonValue>>;
  readonly declaredOutputs: readonly WorkflowOutputDefinition[];
  readonly outputs?: Readonly<Record<string, JsonValue>>;
  readonly limits: RunLimits;
  readonly counters: RunBudgetCounters;
  readonly coordinationAuthorityEpoch: number;
  readonly coordinatorEventCursor: number;
  readonly coordinatorConsumedCursor: number;
  readonly settlingTargetOutcome?: "failed" | "canceled";
  readonly attempts: Readonly<Record<Id, NodeAttempt>>;
  readonly shellOperations: Readonly<Record<Id, ShellExecutionOperation>>;
  readonly dispatches: Readonly<Record<Id, Dispatch>>;
  readonly readinessReceipts: Readonly<Record<Id, AgentReadinessReceipt>>;
  readonly deliveries: Readonly<Record<Id, PromptDelivery>>;
  readonly results: Readonly<Record<Id, NodeResult>>;
  readonly attemptResults: Readonly<Record<Id, NodeResult>>;
  readonly resultReceipts: Readonly<Record<Id, ResultSubmissionReceipt>>;
  readonly cancellations: Readonly<Record<Id, CancellationOperation>>;
  readonly manualRetries: Readonly<Record<Id, ManualRetryOperation>>;
  readonly leases: Readonly<Record<Id, ResourceLease>>;
  readonly inputControls: Readonly<Record<Id, AttemptInputControl>>;
  readonly inputInterventions: readonly InputIntervention[];
  readonly messages: readonly OrchestrationMessage[];
  readonly mailboxSequence: number;
  readonly mailboxEvents: readonly MailboxEvent[];
  readonly mailboxConsumers: Readonly<Record<string, MailboxConsumerState>>;
  readonly gates: Readonly<Record<Id, HumanGate>>;
  readonly coordinatorTurns: readonly CoordinatorTurn[];
  readonly coordinatorAttachment?: CoordinatorAttachment;
  readonly callerUnavailable?: {
    readonly reason: string;
    readonly observedAt: IsoTimestamp;
  };
  readonly tasks: Readonly<Record<Id, AdHocTask>>;
  readonly timers: Readonly<Record<Id, RunTimer>>;
}

export type GraphPatchOperation =
  | { readonly kind: "add-node"; readonly node: WorkflowNodeDefinition }
  | {
      readonly kind: "replace-pending-node";
      readonly node: WorkflowNodeDefinition;
      readonly expectedNodeStateRevision: number;
    }
  | {
      readonly kind: "add-edge";
      readonly edge: WorkflowControlEdge;
      readonly expectedTargetNodeStateRevision: number;
    }
  | {
      readonly kind: "add-binding";
      readonly agentRef: string;
      readonly binding: AgentBindingDefinition;
    };

export interface GraphPatch {
  readonly runId: Id;
  readonly expectedGraphRevision: number;
  readonly authorityEpoch: number;
  readonly authorPrincipal: Id;
  readonly capabilityRef: Id;
  readonly idempotencyKey: Id;
  readonly reason?: string;
  readonly operations: readonly GraphPatchOperation[];
}

export interface ResultSubmitCommand {
  readonly attemptId: Id;
  readonly expectedExecution: TerminalExecutionRef;
  readonly idempotencyKey: Id;
  readonly submissionHash: ContentHash;
  readonly capabilityRef: Id;
  readonly result: AgentResultSubmission;
}

export interface ResultSubmitIngress {
  readonly attemptId: Id;
  readonly expectedExecution?: TerminalExecutionRef;
  readonly idempotencyKey: Id;
  readonly submissionHash: ContentHash;
  readonly capabilityRef?: Id;
  readonly result: AgentResultSubmission;
}

export interface CreateAdaptiveRunCommand {
  readonly runId: Id;
  readonly objective: string;
  readonly inputs: Readonly<Record<string, JsonValue>>;
  readonly limits: RunLimits;
  readonly idempotencyKey: Id;
}

export interface GraphPatchReceipt {
  readonly receiptId: Id;
  readonly runId: Id;
  readonly idempotencyKey: Id;
  readonly patchHash: ContentHash;
  readonly previousGraphRevision: number;
  readonly graphRevision: number;
  readonly appliedAt: IsoTimestamp;
}

export interface AuditEvent {
  readonly eventId: Id;
  readonly sequence: number;
  readonly occurredAt: IsoTimestamp;
  readonly runId?: Id;
  readonly type: string;
  readonly principal: Id;
  readonly payload: JsonValue;
}

export interface CapabilityGrant {
  readonly capabilityRef: Id;
  readonly kind: "graph-author" | "worker-lifecycle";
  readonly principal: Id;
  readonly runId: Id;
  readonly authorityEpoch: number;
  readonly nodeId?: Id;
  readonly attemptId?: Id;
  readonly targetId?: Id;
  readonly generationIdentity?: Id;
  readonly execution?: TerminalExecutionRef;
  readonly constraints?: JsonValue;
  readonly expiresAt: IsoTimestamp;
  readonly state: "active" | "revoked" | "consumed";
}

export interface OrchestrationSnapshot {
  readonly storeVersion: 1;
  readonly revision: number;
  readonly workflowVersions: Readonly<Record<Id, WorkflowVersion>>;
  readonly workflowDrafts: Readonly<Record<Id, WorkflowDraft>>;
  readonly runs: Readonly<Record<Id, WorkflowRun>>;
  readonly auditEvents: readonly AuditEvent[];
  readonly capabilities: Readonly<Record<Id, CapabilityGrant>>;
  /** Durable per-terminal Run selection used by run-use/run-current. */
  readonly currentRunByPrincipal: Readonly<Record<Id, Id>>;
  readonly idempotency: Readonly<
    Record<
      string,
      { readonly payloadHash: ContentHash; readonly receipt: JsonValue }
    >
  >;
}

export interface ValidationIssue {
  readonly code: string;
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

export class OrchestrationError extends Error {
  constructor(
    readonly code:
      | "invalid"
      | "unsupported"
      | "not-found"
      | "conflict"
      | "stale-revision"
      | "sealed"
      | "immutable"
      | "budget-exhausted"
      | "unauthorized"
      | "uncertain",
    message: string,
    readonly details?: Readonly<Record<string, JsonValue>>
  ) {
    super(message);
    this.name = "OrchestrationError";
  }
}
