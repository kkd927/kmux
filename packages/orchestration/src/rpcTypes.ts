import type {
  AgentResultSubmission,
  AdHocTask,
  Dispatch,
  HumanGate,
  JsonValue,
  MailboxConsumer,
  MailboxEvent,
  NodeAttempt,
  NodeResult,
  OrchestrationMessage,
  ResultSubmissionReceipt,
  RunNode,
  TerminalExecutionRef,
  ValidationResult,
  WorkflowDefinitionV1,
  WorkflowDraft,
  WorkflowRun,
  WorkflowVersion
} from "./types";
import type { FlowEditorDocumentV1 } from "./editorDocument";

export interface OrchestrationRunSummary {
  readonly workerTerminalPolicy: WorkflowRun["workerTerminalPolicy"];
  readonly runId: string;
  readonly source: WorkflowRun["source"];
  readonly status: WorkflowRun["status"];
  readonly graphRevision: number;
  readonly authoringState: WorkflowRun["graph"]["authoringState"];
  readonly counters: WorkflowRun["counters"];
  readonly coordinationAuthorityEpoch: number;
  readonly coordinatorEventCursor: number;
  readonly coordinatorConsumedCursor: number;
  readonly coordinatorTransport?: NonNullable<
    WorkflowRun["coordinatorAttachment"]
  >["transport"];
  readonly activeCoordinatorTurn?: { readonly turnId: string };
  readonly outputs?: WorkflowRun["outputs"];
  readonly callerUnavailable?: WorkflowRun["callerUnavailable"];
  readonly nodeStates: Readonly<Record<string, RunNode["status"]>>;
  readonly workers: readonly {
    readonly nodeId: string;
    readonly stage: string;
    readonly terminalState?: Dispatch["terminalState"];
    readonly attemptId?: string;
    readonly dispatchId?: string;
    readonly surfaceId?: string;
    readonly sessionId?: string;
    readonly generation?: TerminalExecutionRef["generation"];
    readonly issue?: { readonly code: string; readonly message: string };
  }[];
}

type WorkerIssue =
  | NodeAttempt["preparationIssue"]
  | NodeAttempt["completionIssue"]
  | RunNode["admissionFailure"];

export interface OrchestrationTaskView extends Omit<
  AdHocTask,
  "createdAt" | "nodeId"
> {
  readonly status: RunNode["status"];
  readonly attemptId?: string;
  readonly dispatchId?: string;
  readonly issue?: WorkerIssue;
  readonly outcome?: AgentResultSubmission["outcome"];
  readonly summary?: string;
  readonly reportPath?: string;
}

export interface OrchestrationWorkerView {
  readonly runId: string;
  readonly taskId: string;
  readonly dispatchId: string;
  readonly attemptId: string;
  readonly agentId: string;
  readonly status: NodeAttempt["status"] | RunNode["status"];
  readonly terminalState?: Dispatch["terminalState"];
  readonly nextAction?: readonly string[];
  readonly surfaceId?: string;
  readonly sessionId?: string;
  readonly generation?: TerminalExecutionRef["generation"];
  readonly lastHeartbeat?: Dispatch["lastHeartbeat"];
  readonly historyIssue?: string;
  readonly issue?: WorkerIssue;
  readonly result?: NodeResult;
}

export interface WorkflowCatalog {
  readonly drafts: readonly (Pick<
    WorkflowDraft,
    "draftId" | "definitionId" | "revision" | "updatedAt"
  > & {
    readonly name: string | null;
  })[];
  readonly versions: readonly {
    readonly workflowVersionId: string;
    readonly definitionId: string;
    readonly version: number;
    readonly name: string;
    readonly contentHash: string;
    readonly publishedAt: string;
  }[];
}

export interface WorkflowTemplateSummary {
  readonly templateId: string;
  readonly name: string;
  readonly description: string;
}

export interface WorkflowDraftValidation {
  readonly canonical: ValidationResult<WorkflowDefinitionV1>;
  readonly editor: ValidationResult<WorkflowDefinitionV1>;
  readonly semanticallyEquivalent: boolean;
  readonly publishable: boolean;
}

export interface OrchestrationMailboxCheck {
  readonly run: OrchestrationRunSummary;
  readonly timedOut: boolean;
  readonly delivery: {
    readonly deliveryId: string;
    readonly consumer: MailboxConsumer;
    readonly cursorStart: number;
    readonly cursorEnd: number;
    readonly replayed: boolean;
    readonly events: readonly (Pick<
      MailboxEvent,
      "eventId" | "sequence" | "type" | "target"
    > & {
      readonly message?: OrchestrationMessage;
      readonly result?: NodeResult;
      readonly callerTask?: {
        readonly runId: string;
        readonly attemptId: string;
        readonly requestId: string;
        readonly state: "waiting" | "completed";
        readonly nodeId: string;
        readonly title: string;
        readonly prompt: string;
        readonly inputs: Readonly<Record<string, JsonValue>>;
        readonly resultSchema?: RunNode["definition"]["resultSchema"];
        readonly coding: boolean;
      };
    })[];
  } | null;
}

interface QueuedMessage {
  readonly status: "queued";
  readonly runId: string;
  readonly messageId: string;
  readonly dispatchId?: string;
}

interface InitialWorkflowDocument {
  readonly canonicalDraft: WorkflowDefinitionV1;
  readonly editorDocument: FlowEditorDocumentV1;
}

export interface OrchestrationResponses {
  "orchestration.run.create": { readonly run: OrchestrationRunSummary };
  "orchestration.run.use": { readonly run: OrchestrationRunSummary };
  "orchestration.run.current": { readonly run: OrchestrationRunSummary };
  "orchestration.task.create": OrchestrationTaskView;
  "orchestration.task.list": {
    readonly runId: string;
    readonly tasks: readonly OrchestrationTaskView[];
  };
  "orchestration.worker.start": OrchestrationTaskView & {
    readonly reachedStage: string;
    readonly timedOut?: boolean;
    readonly failedStage?: string;
  };
  "orchestration.worker.list": {
    readonly runId: string;
    readonly workers: readonly OrchestrationWorkerView[];
  };
  "orchestration.worker.show": OrchestrationWorkerView;
  "orchestration.worker.read": JsonValue;
  "orchestration.worker.done": ResultSubmissionReceipt;
  "orchestration.worker.heartbeat": QueuedMessage;
  "orchestration.inbox.check": OrchestrationMailboxCheck;
  "orchestration.status": OrchestrationRunSummary;
  "orchestration.run.list": readonly OrchestrationRunSummary[];
  "orchestration.run.get": WorkflowRun;
  "orchestration.gate.create": OrchestrationTaskView;
  "orchestration.gate.list": {
    readonly runId: string;
    readonly gates: readonly HumanGate[];
  };
  "orchestration.gate.resolve": OrchestrationRunSummary;
  "orchestration.message.post": QueuedMessage;
  "orchestration.message.send": QueuedMessage;
  "orchestration.message.ask": QueuedMessage;
  "orchestration.message.escalate": QueuedMessage;
  "orchestration.attempt.cancel": {
    readonly outcome: "uncertain" | "requested" | "confirmed";
    readonly operationId: string;
    readonly message?: string;
    readonly run: OrchestrationRunSummary;
  };
  "orchestration.attempt.recover": OrchestrationRunSummary;
  "orchestration.attempt.retry": OrchestrationRunSummary;
  "orchestration.input.disposition": OrchestrationRunSummary;
  "workflow.list": WorkflowCatalog;
  "workflow.version.get": WorkflowVersion;
  "workflow.template.list": readonly WorkflowTemplateSummary[];
  "workflow.template.get": InitialWorkflowDocument;
  "workflow.draft.initialize": InitialWorkflowDocument;
  "workflow.draft.create_from_template": WorkflowDraft;
  "workflow.draft.create": WorkflowDraft;
  "workflow.draft.get": WorkflowDraft;
  "workflow.draft.create_from_run": WorkflowDraft;
  "workflow.draft.update": WorkflowDraft;
  "workflow.draft.delete": { readonly deleted: true };
  "workflow.draft.validate": WorkflowDraftValidation;
  "workflow.publish": {
    readonly version: WorkflowVersion;
    readonly draft: WorkflowDraft;
  };
  "workflow.caller.done": ResultSubmissionReceipt;
  "workflow.run": OrchestrationRunSummary;
}
