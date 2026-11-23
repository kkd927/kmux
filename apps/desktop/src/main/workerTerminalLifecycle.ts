import {
  markWorkerTerminalReleaseUnknown,
  recordWorkerTerminalHistory,
  retainWorkerTerminalAfterTakeover,
  settleAttemptInputDisposition,
  type OrchestrationStore,
  type RuntimeContext,
  type WorkerOutputArchive
} from "@kmux/orchestration";
import { OrchestrationError } from "@kmux/orchestration";
import type { FileWorkerOutputArchives } from "@kmux/orchestration/node";
import type { LocalAgentExecutionDriver } from "./orchestrationContracts";
import { requireAttempt } from "./orchestrationQueries";
export class WorkerTerminalLifecycle {
  constructor(
    private readonly store: OrchestrationStore,
    private readonly context: RuntimeContext,
    private readonly archives: FileWorkerOutputArchives,
    private readonly getDriver: () => LocalAgentExecutionDriver | undefined
  ) {}
  async preserve(attemptId: string): Promise<WorkerOutputArchive> {
    const located = requireAttempt(await this.store.read(), attemptId);
    const dispatch = located.attempt.dispatchId
      ? located.run.dispatches[located.attempt.dispatchId]
      : undefined;
    if (!dispatch) {
      throw new OrchestrationError(
        "not-found",
        "Worker Dispatch was not found"
      );
    }
    try {
      let history = dispatch.terminalHistory;
      if (history === undefined) {
        const driver = this.getDriver();
        if (!driver?.readWorker)
          throw new Error("Worker history reader is unavailable");
        history = await this.archives.capture(
          await driver.readWorker({
            run: located.run,
            dispatchId: dispatch.dispatchId,
            lines: 10_000,
            maxBytes: 4 * 1024 * 1024
          })
        );
      } else {
        await this.archives.read(history);
      }
      return await this.store.transact(
        {
          type: "orchestration.worker.history-preserved",
          principal: "host:electron-main",
          runId: located.run.runId,
          payload: { attemptId, dispatchId: dispatch.dispatchId }
        },
        (current) => {
          const currentLocated = requireAttempt(current, attemptId);
          const existing =
            currentLocated.run.dispatches[dispatch.dispatchId]?.terminalHistory;
          const preserved = existing ?? history!;
          const run = recordWorkerTerminalHistory({
            run: currentLocated.run,
            dispatchId: dispatch.dispatchId,
            history: preserved
          });
          return {
            snapshot: {
              ...current,
              runs: { ...current.runs, [run.runId]: run }
            },
            value: preserved
          };
        }
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.store
        .transact(
          {
            type: "orchestration.worker.history-failed",
            principal: "host:electron-main",
            runId: located.run.runId,
            payload: { attemptId, dispatchId: dispatch.dispatchId, reason }
          },
          (current) => {
            const currentLocated = requireAttempt(current, attemptId);
            const run = currentLocated.run;
            return {
              snapshot: {
                ...current,
                runs: {
                  ...current.runs,
                  [run.runId]: {
                    ...run,
                    dispatches: {
                      ...run.dispatches,
                      [dispatch.dispatchId]: {
                        ...run.dispatches[dispatch.dispatchId]!,
                        historyIssue: reason
                      }
                    }
                  }
                }
              },
              value: undefined
            };
          }
        )
        .catch(() => undefined); // Store failure cannot authorize closing or reusing the terminal.
      throw new OrchestrationError(
        "conflict",
        `Worker history could not be preserved; terminal kept open: ${reason}`
      );
    }
  }

  async settle(attemptId: string): Promise<void> {
    const driver = this.getDriver();
    const snapshot = await this.store.read();
    const located = requireAttempt(snapshot, attemptId);
    const control = located.run.inputControls[attemptId];
    const dispatch = located.attempt.dispatchId
      ? located.run.dispatches[located.attempt.dispatchId]
      : undefined;
    if (
      !control ||
      !dispatch ||
      !["succeeded", "failed", "canceled"].includes(located.attempt.status)
    ) {
      return;
    }
    if (
      dispatch.terminalState === "retained" ||
      dispatch.terminalState === "released"
    ) {
      return;
    }
    const disposition = control.requestedDisposition;
    if (!disposition) return;
    if (control.disposition === disposition) return;
    if (disposition === "release") {
      if (!driver?.releaseWorkerTerminal) {
        throw new OrchestrationError(
          "unsupported",
          "the Agent executor cannot clean up its Worker terminal"
        );
      }
      let history: WorkerOutputArchive;
      try {
        history = await this.preserve(attemptId);
      } catch (error) {
        // Never close a terminal unless its archive was durably saved.
        await this.store
          .transact(
            {
              type: "orchestration.worker.history-retained",
              principal: "host:electron-main",
              runId: located.run.runId,
              payload: { attemptId, dispatchId: dispatch.dispatchId }
            },
            (current) => {
              const currentLocated = requireAttempt(current, attemptId);
              const currentControl =
                currentLocated.run.inputControls[attemptId]!;
              const run = settleAttemptInputDisposition({
                run: currentLocated.run,
                attemptId,
                expectedRevision: currentControl.revision,
                disposition: "retain",
                context: this.context
              });
              return {
                snapshot: {
                  ...current,
                  runs: {
                    ...current.runs,
                    [run.runId]: run
                  }
                },
                value: undefined
              };
            }
          )
          .catch(() => undefined); // A failed store still cannot authorize closing the terminal.
        throw error;
      }
      let outcome: "released" | "retained" | "unknown" = "unknown";
      try {
        const releaseSnapshot = await this.store.read();
        const releaseRun = requireAttempt(releaseSnapshot, attemptId).run;
        outcome = await driver.releaseWorkerTerminal({
          run: releaseRun,
          attemptId
        });
      } catch {
        outcome = "unknown";
      }
      await this.store.transact(
        {
          type: `orchestration.input.release-${outcome}`,
          principal: "host:electron-main",
          runId: located.run.runId,
          payload: { attemptId, dispatchId: dispatch.dispatchId }
        },
        (current) => {
          const currentLocated = requireAttempt(current, attemptId);
          let run = currentLocated.run;
          if (
            history !== undefined &&
            run.dispatches[dispatch.dispatchId]?.terminalHistory === undefined
          ) {
            run = recordWorkerTerminalHistory({
              run,
              dispatchId: dispatch.dispatchId,
              history
            });
          }
          if (outcome === "retained") {
            if (
              run.dispatches[dispatch.dispatchId]?.terminalState !== "retained"
            ) {
              run = retainWorkerTerminalAfterTakeover({
                run,
                dispatchId: dispatch.dispatchId,
                context: this.context
              });
            }
          } else if (outcome === "unknown") {
            run = markWorkerTerminalReleaseUnknown({
              run,
              dispatchId: dispatch.dispatchId,
              context: this.context
            });
          } else {
            const currentControl = run.inputControls[attemptId];
            if (!currentControl) {
              throw new OrchestrationError(
                "conflict",
                "Worker input ownership disappeared during release"
              );
            }
            run = settleAttemptInputDisposition({
              run,
              attemptId,
              expectedRevision: currentControl.revision,
              disposition: "release",
              context: this.context
            });
          }
          return {
            snapshot: {
              ...current,
              runs: { ...current.runs, [run.runId]: run }
            },
            value: undefined
          };
        }
      );
      return;
    }
    await this.store.transact(
      {
        type: `orchestration.input.${disposition}`,
        principal: "host:electron-main",
        runId: located.run.runId,
        payload: { attemptId, expectedRevision: control.revision }
      },
      (current) => {
        const currentLocated = requireAttempt(current, attemptId);
        const currentControl = currentLocated.run.inputControls[attemptId];
        if (!currentControl || currentControl.disposition) {
          return { snapshot: current, value: undefined };
        }
        const run = settleAttemptInputDisposition({
          run: currentLocated.run,
          attemptId,
          expectedRevision: currentControl.revision,
          disposition,
          context: this.context
        });
        return {
          snapshot: {
            ...current,
            runs: { ...current.runs, [run.runId]: run }
          },
          value: undefined
        };
      }
    );
  }
}
