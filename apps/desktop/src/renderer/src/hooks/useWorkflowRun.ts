import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkflowRun } from "@kmux/orchestration";

import { orchestration } from "../orchestrationClient";
import { isTerminalWorkflowRun } from "../workflowRunProjection";

interface RunQuery {
  readonly runId: string;
  active: boolean;
  run: WorkflowRun | null;
  pending: Promise<void> | null;
  timer?: number;
}

/** One query owns polling, manual refresh, and the lifetime of its Run selection. */
export function useWorkflowRun(runId: string | null) {
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectedId = useRef(runId);
  selectedId.current = runId;
  const queryRef = useRef<RunQuery | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const query = queryRef.current;
    if (!query?.active || selectedId.current !== query.runId) return;
    if (query.pending) return query.pending;
    const current = () => query.active && selectedId.current === query.runId;
    query.pending = (async () => {
      try {
        const next = await Promise.resolve().then(() =>
          orchestration("orchestration.run.get", { runId: query.runId })
        );
        if (!current()) return;
        query.run = next;
        setRun(next);
        setError(null);
      } catch (cause) {
        if (current())
          setError(cause instanceof Error ? cause.message : String(cause));
        throw cause;
      } finally {
        query.pending = null;
        if (current()) {
          if (query.run && isTerminalWorkflowRun(query.run.status)) {
            window.clearTimeout(query.timer);
            query.timer = undefined;
          } else if (query.timer === undefined) {
            query.timer = window.setTimeout(() => {
              query.timer = undefined;
              void refresh().catch(() => undefined);
            }, 1500);
          }
        }
      }
    })();
    return query.pending;
  }, []);

  useEffect(() => {
    setRun(null);
    setError(null);
    if (!runId) {
      queryRef.current = null;
      return;
    }
    const query: RunQuery = { runId, active: true, run: null, pending: null };
    queryRef.current = query;
    void refresh().catch(() => undefined);
    return () => {
      query.active = false;
      window.clearTimeout(query.timer);
    };
  }, [runId, refresh]);

  return {
    run: run?.runId === runId ? run : null,
    error: queryRef.current?.runId === runId ? error : null,
    refresh
  };
}
