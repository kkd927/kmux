// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import type { TerminalCheckpoint } from "@kmux/proto";
import type { Terminal } from "@xterm/xterm";

import { SurfaceTerminalCheckpointController } from "./terminalCheckpointController";
import type { TerminalBundle } from "./terminalBundle";

function checkpoint(data = "new output"): TerminalCheckpoint {
  return {
    format: "xterm-vt/1",
    session: {
      surfaceId: "surface_1",
      sessionId: "session_1",
      epoch: "epoch_1"
    },
    sequence: 7,
    data,
    cols: 100,
    rows: 30
  };
}

function fakeBundle(options: {
  text: string;
  deferWrite?: boolean;
  failWrite?: boolean;
}): TerminalBundle & {
  text: string;
  finishWrite(): void;
  dispose: ReturnType<typeof vi.fn>;
} {
  const host = document.createElement("div");
  host.textContent = options.text;
  let pendingWrite: (() => void) | null = null;
  const dispose = vi.fn();
  const bundle = {
    host,
    text: options.text,
    finishWrite() {
      pendingWrite?.();
      pendingWrite = null;
    },
    dispose,
    terminal: {
      cols: 80,
      rows: 24,
      resize: vi.fn((cols: number, rows: number) => {
        Object.assign(bundle.terminal, { cols, rows });
      }),
      write: vi.fn((data: string, callback?: () => void) => {
        if (options.failWrite) {
          throw new Error("parser failed");
        }
        bundle.text += data;
        host.textContent = bundle.text;
        if (options.deferWrite) {
          pendingWrite = callback ?? null;
        } else {
          callback?.();
        }
      }),
      dispose
    } as unknown as Terminal,
    fit: {} as TerminalBundle["fit"],
    search: {} as TerminalBundle["search"],
    unicode11: {} as TerminalBundle["unicode11"],
    webLinks: {} as TerminalBundle["webLinks"],
    fileLinks: { dispose: vi.fn() },
    lineCwdTrimListener: { dispose: vi.fn() },
    lineCwds: {
      getTrimmedLineCount: vi.fn(() => 0),
      handleTrim: vi.fn(),
      importSnapshotRanges: vi.fn(),
      recordWrite: vi.fn(),
      getCwdForLine: vi.fn(),
      clear: vi.fn()
    }
  } satisfies TerminalBundle & {
    text: string;
    finishWrite(): void;
    dispose: ReturnType<typeof vi.fn>;
  };
  return bundle;
}

function frameHarness() {
  let nextId = 1;
  const frames = new Map<number, FrameRequestCallback>();
  return {
    request(callback: FrameRequestCallback): number {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancel(id: number): void {
      frames.delete(id);
    },
    runNext(): void {
      const entry = frames.entries().next().value;
      if (!entry) {
        throw new Error("no frame pending");
      }
      const [id, callback] = entry;
      frames.delete(id);
      callback(performance.now());
    }
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function beginTestCooperativeWrite(
  _laneId: string,
  data: string,
  write: (chunk: string, onParsed: () => void) => void
) {
  let settled = false;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    rejectCompletion = reject;
    if (!data) {
      settled = true;
      resolve();
      return;
    }
    try {
      write(data, () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
    } catch (error) {
      settled = true;
      reject(error);
    }
  });
  return {
    completion,
    cancel(reason = new Error("test write cancelled")) {
      if (!settled) {
        settled = true;
        rejectCompletion(reason);
      }
    }
  };
}

describe("SurfaceTerminalCheckpointController", () => {
  it("keeps the old terminal intact until the staged parser and paint commit", async () => {
    const oldBundle = fakeBundle({ text: "old output" });
    const stagedBundle = fakeBundle({ text: "", deferWrite: true });
    const wrapper = document.createElement("div");
    wrapper.appendChild(oldBundle.host);
    let current: TerminalBundle = oldBundle;
    const frames = frameHarness();
    const controller = new SurfaceTerminalCheckpointController({
      getCurrentBundle: () => current,
      beginCooperativeWrite: beginTestCooperativeWrite,
      disposeBundle: (bundle) => {
        bundle.terminal.dispose();
        bundle.host.remove();
      },
      requestAnimationFrame: frames.request,
      cancelAnimationFrame: frames.cancel
    });
    controller.bind({
      createBundle: () => stagedBundle,
      getWrapper: () => wrapper,
      commitBundle(expected, replacement) {
        expect(expected).toBe(oldBundle);
        wrapper.replaceChild(replacement.host, expected.host);
        current = replacement;
        return true;
      }
    });

    const hydration = controller.applyCheckpoint(checkpoint());
    expect(current).toBe(oldBundle);
    expect(oldBundle.text).toBe("old output");
    expect(oldBundle.dispose).not.toHaveBeenCalled();
    expect(stagedBundle.host.style.visibility).toBe("hidden");

    stagedBundle.finishWrite();
    await flushMicrotasks();
    frames.runNext();
    await flushMicrotasks();
    frames.runNext();
    await expect(hydration).resolves.toEqual({ swapGeneration: 1 });

    expect(current).toBe(stagedBundle);
    expect(stagedBundle.text).toBe("new output");
    expect(wrapper.firstChild).toBe(stagedBundle.host);
    expect(stagedBundle.host.style.visibility).toBe("");
    expect(oldBundle.dispose).toHaveBeenCalledOnce();
  });

  it("does not roll back a committed replacement when old-widget cleanup throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const oldBundle = fakeBundle({ text: "old output" });
    const stagedBundle = fakeBundle({ text: "" });
    oldBundle.dispose.mockImplementation(() => {
      throw new Error("old dispose failed");
    });
    const wrapper = document.createElement("div");
    wrapper.appendChild(oldBundle.host);
    let current: TerminalBundle = oldBundle;
    const frames = frameHarness();
    const controller = new SurfaceTerminalCheckpointController({
      getCurrentBundle: () => current,
      beginCooperativeWrite: beginTestCooperativeWrite,
      disposeBundle: (bundle) => bundle.terminal.dispose(),
      requestAnimationFrame: frames.request,
      cancelAnimationFrame: frames.cancel
    });
    controller.bind({
      createBundle: () => stagedBundle,
      getWrapper: () => wrapper,
      commitBundle(_expected, replacement) {
        wrapper.replaceChildren(replacement.host);
        current = replacement;
        return true;
      }
    });

    const hydration = controller.applyCheckpoint(checkpoint());
    await flushMicrotasks();
    frames.runNext();
    await flushMicrotasks();
    frames.runNext();

    await expect(hydration).resolves.toEqual({ swapGeneration: 1 });
    expect(current).toBe(stagedBundle);
    expect(stagedBundle.dispose).not.toHaveBeenCalled();
    expect(oldBundle.dispose).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "Failed to dispose replaced terminal bundle",
      expect.any(Error)
    );
    warn.mockRestore();
  });

  it("rolls back by disposing only the staged terminal when parsing fails", async () => {
    const oldBundle = fakeBundle({ text: "authoritative" });
    const failedStage = fakeBundle({ text: "", failWrite: true });
    const wrapper = document.createElement("div");
    wrapper.appendChild(oldBundle.host);
    let current: TerminalBundle = oldBundle;
    const controller = new SurfaceTerminalCheckpointController({
      getCurrentBundle: () => current,
      beginCooperativeWrite: beginTestCooperativeWrite,
      disposeBundle: (bundle) => {
        bundle.terminal.dispose();
        bundle.host.remove();
      }
    });
    controller.bind({
      createBundle: () => failedStage,
      getWrapper: () => wrapper,
      commitBundle(_expected, replacement) {
        current = replacement;
        return true;
      }
    });

    await expect(controller.applyCheckpoint(checkpoint())).rejects.toThrow(
      "parser failed"
    );
    expect(current).toBe(oldBundle);
    expect(oldBundle.text).toBe("authoritative");
    expect(oldBundle.dispose).not.toHaveBeenCalled();
    expect(failedStage.dispose).toHaveBeenCalledOnce();
    expect(wrapper.firstChild).toBe(oldBundle.host);
  });

  it("hands an in-flight stage to the pane that most recently bound the surface", async () => {
    const oldBundle = fakeBundle({ text: "old" });
    const stagedBundle = fakeBundle({ text: "", deferWrite: true });
    const sourceWrapper = document.createElement("div");
    const targetWrapper = document.createElement("div");
    sourceWrapper.appendChild(oldBundle.host);
    let current: TerminalBundle = oldBundle;
    const frames = frameHarness();
    const controller = new SurfaceTerminalCheckpointController({
      getCurrentBundle: () => current,
      beginCooperativeWrite: beginTestCooperativeWrite,
      requestAnimationFrame: frames.request,
      cancelAnimationFrame: frames.cancel
    });
    const sourceToken = controller.bind({
      createBundle: () => stagedBundle,
      getWrapper: () => sourceWrapper,
      commitBundle: vi.fn(() => false)
    });
    const hydration = controller.applyCheckpoint(checkpoint());
    controller.unbind(sourceToken);
    const targetCommit = vi.fn(
      (expected: TerminalBundle, replacement: TerminalBundle) => {
        targetWrapper.replaceChildren(replacement.host);
        current = replacement;
        return true;
      }
    );
    controller.bind({
      createBundle: () => stagedBundle,
      getWrapper: () => targetWrapper,
      commitBundle: targetCommit
    });

    expect(stagedBundle.host.parentNode).toBe(targetWrapper);
    stagedBundle.finishWrite();
    await flushMicrotasks();
    frames.runNext();
    await flushMicrotasks();
    frames.runNext();
    await hydration;

    expect(targetCommit).toHaveBeenCalledOnce();
    expect(current).toBe(stagedBundle);
    expect(targetWrapper.firstChild).toBe(stagedBundle.host);
  });

  it("cancels and disposes a stale stage after its visible owner detaches", async () => {
    const oldBundle = fakeBundle({ text: "old" });
    const stagedBundle = fakeBundle({ text: "", deferWrite: true });
    const wrapper = document.createElement("div");
    wrapper.appendChild(oldBundle.host);
    const controller = new SurfaceTerminalCheckpointController({
      getCurrentBundle: () => oldBundle,
      beginCooperativeWrite: beginTestCooperativeWrite,
      disposeBundle: (bundle) => {
        bundle.terminal.dispose();
        bundle.host.remove();
      }
    });
    const token = controller.bind({
      createBundle: () => stagedBundle,
      getWrapper: () => wrapper,
      commitBundle: vi.fn(() => true)
    });
    const hydration = controller.applyCheckpoint(checkpoint());

    controller.unbind(token);
    await expect(hydration).rejects.toThrow("lost its visible owner");
    expect(oldBundle.dispose).not.toHaveBeenCalled();
    expect(stagedBundle.dispose).toHaveBeenCalledOnce();
    expect(wrapper.firstChild).toBe(oldBundle.host);
  });

  it("preserves the cancellation error when staged-widget cleanup throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const oldBundle = fakeBundle({ text: "old" });
    const stagedBundle = fakeBundle({ text: "", deferWrite: true });
    stagedBundle.dispose.mockImplementation(() => {
      throw new Error("staged dispose failed");
    });
    const wrapper = document.createElement("div");
    wrapper.appendChild(oldBundle.host);
    const controller = new SurfaceTerminalCheckpointController({
      getCurrentBundle: () => oldBundle,
      beginCooperativeWrite: beginTestCooperativeWrite,
      disposeBundle: (bundle) => bundle.terminal.dispose()
    });
    const token = controller.bind({
      createBundle: () => stagedBundle,
      getWrapper: () => wrapper,
      commitBundle: vi.fn(() => true)
    });
    const hydration = controller.applyCheckpoint(checkpoint());

    controller.unbind(token);

    await expect(hydration).rejects.toThrow("lost its visible owner");
    expect(oldBundle.dispose).not.toHaveBeenCalled();
    expect(stagedBundle.dispose).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "Failed to dispose staged terminal bundle",
      expect.any(Error)
    );
    warn.mockRestore();
  });
});
