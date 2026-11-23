import {
  canonicalJson,
  contentHash,
  type ContentHash,
  type JsonValue,
  type NodeAttempt,
  type ShellArgument,
  type ShellNodeDefinition,
  type TerminalExecutionRef,
  type WorkflowRun
} from "@kmux/orchestration";

import type { PtyHostManager } from "./ptyHost";

export interface ResolvedShellCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/** Resolve user-authored commands without an application-specific allowlist. */
export function resolveShellCommand(
  node: ShellNodeDefinition,
  attempt: NodeAttempt
): ResolvedShellCommand {
  const command = node.config.command;
  const args = command.args.map((argument) =>
    resolveShellArgument(argument, attempt)
  );
  if (args.some((arg) => arg.includes("\0"))) {
    throw new Error("Shell arguments cannot contain NUL");
  }
  if (command.kind === "script") {
    if (!command.script.trim() || command.script.includes("\0")) {
      throw new Error("Shell script must be nonempty and cannot contain NUL");
    }
    // Mapped values are positional arguments, never interpolated into script text.
    return {
      executable: "/bin/sh",
      args: ["-c", command.script, "workflow", ...args]
    };
  }
  if (!command.executable.trim() || command.executable.includes("\0")) {
    throw new Error("Shell executable must be nonempty and cannot contain NUL");
  }
  return { executable: command.executable, args };
}

export interface LocalShellSurfaceBinding {
  readonly execution: TerminalExecutionRef;
  readonly processId: number;
}

export interface LocalShellExecutorMutationPort {
  recordIntent(input: {
    readonly attemptId: string;
    readonly operationId: string;
    readonly commandHash: ContentHash;
  }): Promise<void>;
  bindExecution(input: {
    readonly operationId: string;
    readonly execution: TerminalExecutionRef;
    readonly processId: number;
  }): Promise<void>;
  settle(input: {
    readonly operationId: string;
    readonly exitCode: number;
    readonly outputHash: ContentHash;
    readonly outputBytes: number;
    readonly outcome: "succeeded" | "failed";
    readonly summary: string;
    readonly data?: JsonValue;
  }): Promise<void>;
  markPreparationFailed(input: {
    readonly attemptId: string;
    readonly reason: string;
  }): Promise<void>;
  markOutcomeUnknown(input: {
    readonly operationId: string;
    readonly reason: string;
  }): Promise<void>;
}

export class LocalShellNodeExecutor {
  private readonly cancellationRequested = new Set<string>();

  constructor(
    private readonly options: {
      readonly ptyHost: PtyHostManager;
      readonly prepareSurface: (input: {
        readonly run: WorkflowRun;
        readonly attempt: NodeAttempt;
        readonly command: ResolvedShellCommand;
      }) => Promise<(operationId: string) => Promise<LocalShellSurfaceBinding>>;
      readonly mutations: LocalShellExecutorMutationPort;
      readonly id: (kind: string) => string;
      readonly timeoutMs?: number;
    }
  ) {}

  async execute(input: {
    readonly run: WorkflowRun;
    readonly attemptId: string;
  }): Promise<void> {
    const attempt = input.run.attempts[input.attemptId];
    const runtimeNode = attempt
      ? input.run.graph.nodes[attempt.nodeId]
      : undefined;
    if (!attempt || runtimeNode?.definition.kind !== "shell") {
      throw new Error("Shell executor received a non-Shell attempt");
    }
    const node = runtimeNode.definition;
    let operationId: string | undefined;
    try {
      // Reject unsupported contracts before recording process intent.
      if (node.config.targetPolicy !== "local") {
        throw new Error(
          "local Shell execution supports only the local target policy"
        );
      }
      if (node.config.resultMode === "result-file") {
        throw new Error("local result-file Shell mode is not enabled");
      }
      const command = resolveShellCommand(node, attempt);
      const commandHash = contentHash(
        JSON.parse(
          canonicalJson({
            executable: command.executable,
            args: command.args,
            env: command.env ?? {}
          } as unknown as JsonValue)
        ) as JsonValue
      );
      // Resolve placement before intent. Only invoking the returned launcher
      // may create a process; failures after that boundary remain uncertain.
      const launch = await this.options.prepareSurface({
        run: input.run,
        attempt,
        command
      });
      operationId = this.options.id("shell-operation");
      await this.options.mutations.recordIntent({
        attemptId: attempt.attemptId,
        operationId,
        commandHash
      });
      const binding = await launch(operationId);
      await this.options.mutations.bindExecution({
        operationId,
        execution: binding.execution,
        processId: binding.processId
      });
      const exit = await this.options.ptyHost.waitForCommandExit({
        operationId,
        session: {
          sessionId: binding.execution.sessionId,
          surfaceId: binding.execution.surfaceId,
          runtimeEpoch:
            binding.execution.generation.kind === "local"
              ? binding.execution.generation.runtimeEpoch
              : ""
        },
        // Runtime owns workflow deadlines and cancellation. A transport wait
        // must survive a checkpoint/attention timeout and observe the real exit.
        ...(this.options.timeoutMs === undefined
          ? {}
          : { timeoutMs: this.options.timeoutMs })
      });
      if (this.cancellationRequested.delete(attempt.attemptId)) return;
      const outputHash = contentHash(exit.output);
      if (exit.truncated || exit.outputBytes > node.config.maxOutputBytes) {
        await this.options.mutations.settle({
          operationId,
          exitCode: exit.exitCode,
          outputHash,
          outputBytes: exit.outputBytes,
          outcome: "failed",
          summary: "managed Shell output exceeded its declared byte bound"
        });
        return;
      }
      if (exit.exitCode !== 0) {
        await this.options.mutations.settle({
          operationId,
          exitCode: exit.exitCode,
          outputHash,
          outputBytes: exit.outputBytes,
          outcome: "failed",
          summary: `Shell command '${command.executable}' exited ${exit.exitCode}`
        });
        return;
      }
      let decoded: JsonValue | undefined;
      try {
        decoded = decodeShellResult(node, exit.exitCode, exit.output);
      } catch (error) {
        await this.options.mutations.settle({
          operationId,
          exitCode: exit.exitCode,
          outputHash,
          outputBytes: exit.outputBytes,
          outcome: "failed",
          summary: error instanceof Error ? error.message : String(error)
        });
        return;
      }
      await this.options.mutations.settle({
        operationId,
        exitCode: exit.exitCode,
        outputHash,
        outputBytes: exit.outputBytes,
        outcome: "succeeded",
        summary: `Shell command '${command.executable}' completed`,
        ...(decoded === undefined ? {} : { data: decoded })
      });
    } catch (error) {
      // Exact cancellation rejects the exit waiter when the PTY closes. Its
      // confirmation/uncertainty belongs to the cancellation operation.
      if (this.cancellationRequested.delete(attempt.attemptId)) return;
      const reason = error instanceof Error ? error.message : String(error);
      if (operationId) {
        await this.options.mutations
          .markOutcomeUnknown({ operationId, reason })
          .catch(() => undefined);
      } else {
        await this.options.mutations.markPreparationFailed({
          attemptId: attempt.attemptId,
          reason
        });
      }
    }
  }

  async cancel(input: {
    readonly run: WorkflowRun;
    readonly attemptId: string;
  }): Promise<{ readonly executorReceiptId: string }> {
    const attempt = input.run.attempts[input.attemptId];
    const operation = Object.values(input.run.shellOperations).find(
      (candidate) => candidate.attemptId === input.attemptId
    );
    const execution = operation?.execution;
    if (
      !attempt ||
      !operation ||
      operation.state !== "executing" ||
      !execution
    ) {
      throw new Error("Shell cancellation has no exact executing process");
    }
    if (execution.generation.kind !== "local") {
      throw new Error("remote Shell cancellation is not enabled in local v1");
    }
    this.cancellationRequested.add(attempt.attemptId);
    try {
      const outcome = await this.options.ptyHost.closeSessionGeneration({
        surfaceId: execution.surfaceId,
        sessionId: execution.sessionId,
        epoch: execution.generation.runtimeEpoch
      });
      return {
        executorReceiptId: `${this.options.id("executor-cancel")}:${outcome}`
      };
    } catch (error) {
      this.cancellationRequested.delete(attempt.attemptId);
      throw error;
    }
  }
}

function resolveShellArgument(
  argument: ShellArgument,
  attempt: NodeAttempt
): string {
  if (argument.kind === "literal") return argument.value;
  if (argument.kind === "secret") {
    throw new Error(
      `Shell secret '${argument.secretRef}' has no registered secret resolver`
    );
  }
  const value = attempt.resolvedInputs[argument.input];
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    throw new Error(
      `Shell input '${argument.input}' is not a scalar argv value`
    );
  }
  return String(value);
}

function decodeShellResult(
  node: ShellNodeDefinition,
  exitCode: number,
  output: string
): JsonValue | undefined {
  if (node.config.resultMode === "exit-code") return { exitCode };
  if (node.config.resultMode === "result-file") {
    throw new Error("local result-file Shell mode is not enabled");
  }
  const framed = output.trim();
  if (!framed) throw new Error("Shell json-stdout result is empty");
  try {
    return JSON.parse(framed) as JsonValue;
  } catch {
    throw new Error("Shell json-stdout must contain exactly one JSON value");
  }
}
