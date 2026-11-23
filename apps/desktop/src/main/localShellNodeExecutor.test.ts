import type {
  NodeAttempt,
  ShellNodeDefinition,
  TerminalExecutionRef,
  WorkflowRun
} from "@kmux/orchestration";
import { vi } from "vitest";

import {
  resolveShellCommand,
  LocalShellNodeExecutor,
  type LocalShellExecutorMutationPort
} from "./localShellNodeExecutor";
import type { PtyHostManager } from "./ptyHost";

const execution: TerminalExecutionRef = {
  targetId: "local",
  targetAuthority: "desktop:test",
  surfaceId: "surface:shell",
  sessionId: "session:shell",
  generation: { kind: "local", runtimeEpoch: "epoch:test" },
  inputAuthorityRef: "input:shell"
};

function shellRun(
  executable = "/usr/bin/printf",
  config: Partial<ShellNodeDefinition["config"]> = {}
): WorkflowRun {
  const definition: ShellNodeDefinition = {
    id: "shell",
    kind: "shell",
    title: "Fixture Shell",
    config: {
      version: 1,
      command: {
        kind: "structured",
        executable,
        args: [
          { kind: "literal", value: "%s" },
          { kind: "input", input: "value" }
        ]
      },
      targetPolicy: "local",
      surfacePolicy: "create",
      cwdPolicy: "workspace",
      resultMode: "json-stdout",
      maxOutputBytes: 1024,
      ...config
    }
  };
  const attempt: NodeAttempt = {
    attemptId: "attempt:shell",
    nodeId: "shell",
    ordinal: 1,
    status: "preparing",
    resolvedInputs: { value: "hello" },
    startedAt: "2026-08-29T00:00:00.000Z"
  } as unknown as NodeAttempt;
  return {
    attempts: { [attempt.attemptId]: attempt },
    graph: { nodes: { shell: { nodeId: "shell", definition } } }
  } as unknown as WorkflowRun;
}

function harness(output: string, exitCode = 0) {
  const mutations: LocalShellExecutorMutationPort = {
    recordIntent: vi.fn(async () => undefined),
    bindExecution: vi.fn(async () => undefined),
    settle: vi.fn(async () => undefined),
    markPreparationFailed: vi.fn(async () => undefined),
    markOutcomeUnknown: vi.fn(async () => undefined)
  };
  const waitForCommandExit = vi.fn(async () => ({
    type: "orchestration.command.exit" as const,
    operationId: "shell-operation:1",
    session: {
      sessionId: execution.sessionId,
      surfaceId: execution.surfaceId,
      runtimeEpoch: "epoch:test"
    },
    exitCode,
    output,
    outputBytes: Buffer.byteLength(output),
    truncated: false
  }));
  const closeSessionGeneration = vi.fn(async () => "terminated" as const);
  const bindSurface = vi.fn(async () => ({ execution, processId: 8123 }));
  const prepareSurface = vi.fn(async () => bindSurface);
  const executor = new LocalShellNodeExecutor({
    ptyHost: {
      waitForCommandExit,
      closeSessionGeneration
    } as unknown as PtyHostManager,
    prepareSurface,
    mutations,
    id: () => "shell-operation:1"
  });
  return {
    executor,
    mutations,
    bindSurface,
    prepareSurface,
    waitForCommandExit,
    closeSessionGeneration
  };
}

describe("local managed Shell node executor", () => {
  it("settles placement validation as preparation failure without process intent", async () => {
    const { executor, prepareSurface, bindSurface, mutations } = harness("{}");
    prepareSurface.mockRejectedValueOnce(
      new Error("untrusted worktree receipt")
    );
    await executor.execute({ run: shellRun(), attemptId: "attempt:shell" });
    expect(mutations.markPreparationFailed).toHaveBeenCalledWith({
      attemptId: "attempt:shell",
      reason: "untrusted worktree receipt"
    });
    expect(mutations.recordIntent).not.toHaveBeenCalled();
    expect(bindSurface).not.toHaveBeenCalled();
    expect(mutations.markOutcomeUnknown).not.toHaveBeenCalled();
  });

  it("preserves diagnostic uncertainty after process creation may have started", async () => {
    const { executor, bindSurface, mutations } = harness("{}");
    bindSurface.mockRejectedValueOnce(new Error("creation transport lost"));
    await executor.execute({ run: shellRun(), attemptId: "attempt:shell" });
    expect(mutations.recordIntent).toHaveBeenCalledOnce();
    expect(mutations.markOutcomeUnknown).toHaveBeenCalledWith({
      operationId: "shell-operation:1",
      reason: "creation transport lost"
    });
    expect(mutations.markPreparationFailed).not.toHaveBeenCalled();
  });
  it("passes mapped script inputs as literal positional arguments", () => {
    const script = 'printf "%s" "$1"';
    const run = shellRun("/bin/sh", {
      command: {
        kind: "script",
        script,
        args: [{ kind: "input", input: "value" }]
      }
    });
    const node = run.graph.nodes.shell!.definition as ShellNodeDefinition;
    const value = 'line one\n$(touch /tmp/not-executed); "quoted"';
    const attempt = {
      ...run.attempts["attempt:shell"]!,
      resolvedInputs: { value }
    };
    expect(resolveShellCommand(node, attempt)).toEqual({
      executable: "/bin/sh",
      args: ["-c", script, "workflow", value]
    });
    expect(() =>
      resolveShellCommand(node, {
        ...attempt,
        resolvedInputs: { value: "invalid\0argument" }
      })
    ).toThrow("NUL");
  });

  it.each([
    {
      config: { resultMode: "result-file", resultFileInput: "resultPath" },
      reason: "result-file"
    },
    {
      config: { targetPolicy: "selected", targetRef: "remote:explicit" },
      reason: "local target"
    }
  ] as const)(
    "rejects unsupported execution requirements before any process intent: $reason",
    async ({ config, reason }) => {
      const { executor, mutations, bindSurface, waitForCommandExit } =
        harness("{}");
      await executor.execute({
        run: shellRun("fixture.json.v1", config),
        attemptId: "attempt:shell"
      });
      expect(mutations.markPreparationFailed).toHaveBeenCalledWith({
        attemptId: "attempt:shell",
        reason: expect.stringContaining(reason)
      });
      expect(mutations.recordIntent).not.toHaveBeenCalled();
      expect(bindSurface).not.toHaveBeenCalled();
      expect(waitForCommandExit).not.toHaveBeenCalled();
      expect(mutations.markOutcomeUnknown).not.toHaveBeenCalled();
    }
  );

  it("binds the exact managed process receipt and settles bounded JSON", async () => {
    const { executor, mutations, bindSurface, waitForCommandExit } =
      harness('{"ok":true}');
    await executor.execute({ run: shellRun(), attemptId: "attempt:shell" });
    expect(mutations.recordIntent).toHaveBeenCalledTimes(1);
    expect(bindSurface).toHaveBeenCalledTimes(1);
    expect(mutations.bindExecution).toHaveBeenCalledWith({
      operationId: "shell-operation:1",
      execution,
      processId: 8123
    });
    expect(waitForCommandExit).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "shell-operation:1",
        session: {
          sessionId: "session:shell",
          surfaceId: "surface:shell",
          runtimeEpoch: "epoch:test"
        }
      })
    );
    expect(mutations.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "shell-operation:1",
        exitCode: 0,
        outcome: "succeeded",
        data: { ok: true }
      })
    );
    expect(mutations.markOutcomeUnknown).not.toHaveBeenCalled();
  });

  it("records malformed JSON as a known failed outcome after trusted exit", async () => {
    const { executor, mutations } = harness("not-json");
    await executor.execute({ run: shellRun(), attemptId: "attempt:shell" });
    expect(mutations.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        exitCode: 0,
        outcome: "failed",
        summary: expect.stringContaining("exactly one JSON value")
      })
    );
    expect(mutations.markOutcomeUnknown).not.toHaveBeenCalled();
  });

  it("cancels only the exact managed Shell terminal generation", async () => {
    const { executor, closeSessionGeneration, waitForCommandExit, mutations } =
      harness("{}");
    const run = shellRun() as unknown as {
      attempts: Record<string, NodeAttempt>;
      shellOperations: WorkflowRun["shellOperations"];
    };
    run.shellOperations = {
      "shell-operation:1": {
        operationId: "shell-operation:1",
        runId: "run:shell",
        nodeId: "shell",
        attemptId: "attempt:shell",
        commandHash: "sha256:fixture",
        state: "executing",
        execution,
        processId: 8123,
        createdAt: "2026-08-29T00:00:00.000Z"
      }
    };
    let rejectExit!: (reason: Error) => void;
    waitForCommandExit.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectExit = reject;
        })
    );
    closeSessionGeneration.mockImplementation(async () => {
      rejectExit(
        new Error("managed command session ended before an exit receipt")
      );
      return "terminated";
    });
    const executing = executor.execute({
      run: run as unknown as WorkflowRun,
      attemptId: "attempt:shell"
    });
    await vi.waitFor(() => expect(waitForCommandExit).toHaveBeenCalled());

    await expect(
      executor.cancel({
        run: run as unknown as WorkflowRun,
        attemptId: "attempt:shell"
      })
    ).resolves.toMatchObject({
      executorReceiptId: expect.stringContaining(":terminated")
    });
    await executing;
    expect(mutations.markOutcomeUnknown).not.toHaveBeenCalled();
    expect(mutations.settle).not.toHaveBeenCalled();
    expect(closeSessionGeneration).toHaveBeenCalledWith({
      surfaceId: execution.surfaceId,
      sessionId: execution.sessionId,
      epoch: "epoch:test"
    });
  });
});
