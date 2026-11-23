// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createAdaptiveRun,
  LOCAL_V1_DEFAULT_RUN_LIMITS,
  type WorkflowRun
} from "@kmux/orchestration";
import { useWorkflowRun } from "./useWorkflowRun";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function run(
  runId: string,
  status: WorkflowRun["status"] = "running"
): WorkflowRun {
  return {
    ...createAdaptiveRun({
      runId,
      objective: "Query fixture",
      limits: LOCAL_V1_DEFAULT_RUN_LIMITS,
      context: {
        now: () => "2026-10-09T00:00:00.000Z",
        id: (kind) => `${kind}:query`
      }
    }),
    status
  };
}

describe("Workflow Run queries", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useWorkflowRun>;
  let original: Window["kmux"];
  const rpc = vi.fn<() => Promise<WorkflowRun>>();
  function Probe({ id }: { id: string }) {
    current = useWorkflowRun(id);
    return (
      <output>
        {current.run
          ? `${current.run.runId}:${current.run.status}`
          : (current.error ?? "loading")}
      </output>
    );
  }
  beforeEach(() => {
    vi.useFakeTimers();
    rpc.mockReset();
    original = window.kmux;
    window.kmux = { orchestration: rpc } as unknown as Window["kmux"];
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.kmux = original;
    vi.useRealTimers();
  });

  it("coalesces manual refresh with polling and stops polling a settled Run", async () => {
    const first = deferred<WorkflowRun>();
    const second = deferred<WorkflowRun>();
    rpc.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await act(async () => root.render(<Probe id="run:one" />));
    await act(async () => {
      void current.refresh();
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve(run("run:one")));
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    await act(async () => {
      void current.refresh();
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    await act(async () => second.resolve(run("run:one", "succeeded")));
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(container.textContent).toBe("run:one:succeeded");
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("keeps the selected Run when an older selection responds later", async () => {
    const old = deferred<WorkflowRun>();
    const next = deferred<WorkflowRun>();
    rpc.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    await act(async () => root.render(<Probe id="run:old" />));
    await act(async () => root.render(<Probe id="run:new" />));
    await act(async () => next.resolve(run("run:new", "failed")));
    await act(async () => old.resolve(run("run:old", "succeeded")));
    expect(container.textContent).toBe("run:new:failed");
  });

  it("reports a read failure and recovers on the next poll", async () => {
    rpc
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(run("run:one", "succeeded"));
    await act(async () => root.render(<Probe id="run:one" />));
    expect(container.textContent).toBe("offline");
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(container.textContent).toBe("run:one:succeeded");
    expect(current.error).toBeNull();
  });
});
