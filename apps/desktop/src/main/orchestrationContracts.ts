import {
  type AgentResultSubmission,
  type CoordinatorAttachment,
  type JsonValue,
  type NodeAttempt,
  type NodeResult,
  type WorkflowRun,
  type ParsedOrchestrationRequest,
  type ParsedOrchestrationParams
} from "@kmux/orchestration";

export type LocalOrchestrationRequest =
  | Exclude<
      ParsedOrchestrationRequest,
      {
        method:
          | "orchestration.run.create"
          | "workflow.run"
          | "orchestration.message.post";
      }
    >
  | { readonly method: "orchestration.run.create"; readonly params: unknown }
  | {
      readonly method: "workflow.run";
      readonly params: ParsedOrchestrationParams<"workflow.run"> & {
        readonly callerAttachment?: CoordinatorAttachment;
      };
    }
  | {
      readonly method: "orchestration.message.post";
      readonly params: Omit<
        ParsedOrchestrationParams<"orchestration.message.post">,
        "kind"
      > & {
        readonly kind:
          | ParsedOrchestrationParams<"orchestration.message.post">["kind"]
          | "heartbeat";
      };
    };

export interface LocalAgentExecutionDriver {
  execute(input: {
    readonly run: WorkflowRun;
    readonly attemptId: string;
  }): Promise<void>;
  cancel?(input: {
    readonly run: WorkflowRun;
    readonly attemptId: string;
  }): Promise<{ readonly executorReceiptId: string }>;
  releaseWorkerTerminal?(input: {
    readonly run: WorkflowRun;
    readonly attemptId: string;
  }): Promise<"released" | "retained" | "unknown">;
  nudgeWorker?(input: {
    readonly run: WorkflowRun;
    readonly dispatchId: string;
    readonly messageCount: number;
    readonly operationId: string;
    readonly isStillPending: () => Promise<boolean>;
  }): Promise<{
    readonly outcome: "written" | "uncertain" | "fenced" | "failed";
  }>;
  readWorker?(input: {
    readonly run: WorkflowRun;
    readonly dispatchId: string;
    readonly lines: number;
    readonly maxBytes: number;
  }): Promise<JsonValue>;
}

export interface LocalShellExecutionDriver {
  execute(input: {
    readonly run: WorkflowRun;
    readonly attemptId: string;
  }): Promise<void>;
  cancel?(input: {
    readonly run: WorkflowRun;
    readonly attemptId: string;
  }): Promise<{ readonly executorReceiptId: string }>;
}

export interface TrustedResultAssembler {
  assemble(input: {
    readonly run: WorkflowRun;
    readonly attempt: NodeAttempt;
    readonly submission: AgentResultSubmission;
  }): Promise<
    Omit<NodeResult, keyof AgentResultSubmission | "nodeId" | "attemptId">
  >;
}
