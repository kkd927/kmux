import { describe, expect, it, vi } from "vitest";

import { RendererTerminalWriteArbiter } from "./rendererTerminalWriteArbiter";

describe("RendererTerminalWriteArbiter", () => {
  it("round-robins lanes that re-admit themselves", () => {
    const turns: Array<() => void> = [];
    const order: string[] = [];
    const arbiter = new RendererTerminalWriteArbiter({
      scheduleTurn: (callback) => turns.push(callback),
      now: () => 0
    });
    let a = 0;
    let b = 0;
    const runA = (): void => {
      order.push(`a${++a}`);
      if (a < 2) arbiter.request("a", runA);
    };
    const runB = (): void => {
      order.push(`b${++b}`);
      if (b < 2) arbiter.request("b", runB);
    };

    arbiter.request("a", runA);
    arbiter.request("b", runB);
    turns.shift()?.();

    expect(order).toEqual(["a1", "b1", "a2", "b2"]);
    arbiter.dispose();
  });

  it("yields after the configured start budget", () => {
    const turns: Array<() => void> = [];
    const run = vi.fn();
    const arbiter = new RendererTerminalWriteArbiter({
      maxStartsPerTurn: 2,
      scheduleTurn: (callback) => turns.push(callback),
      now: () => 0
    });

    for (const lane of ["a", "b", "c"]) {
      arbiter.request(lane, run);
    }
    turns.shift()?.();
    expect(run).toHaveBeenCalledTimes(2);
    expect(turns).toHaveLength(1);
    turns.shift()?.();
    expect(run).toHaveBeenCalledTimes(3);
    arbiter.dispose();
  });

  it("yields after the configured time budget", () => {
    const turns: Array<() => void> = [];
    const run = vi.fn();
    const times = [0, 1, 9, 9];
    const arbiter = new RendererTerminalWriteArbiter({
      maxRunMs: 8,
      scheduleTurn: (callback) => turns.push(callback),
      now: () => times.shift() ?? 9
    });

    for (const lane of ["a", "b", "c"]) {
      arbiter.request(lane, run);
    }
    turns.shift()?.();
    expect(run).toHaveBeenCalledTimes(2);
    expect(turns).toHaveLength(1);
    turns.shift()?.();
    expect(run).toHaveBeenCalledTimes(3);
    arbiter.dispose();
  });

  it("gives an input-priority lane one next turn without starving peers", () => {
    const turns: Array<() => void> = [];
    const order: string[] = [];
    const arbiter = new RendererTerminalWriteArbiter({
      scheduleTurn: (callback) => turns.push(callback),
      now: () => 0
    });

    arbiter.request("peer", () => order.push("peer"));
    arbiter.prioritize("target");
    arbiter.request("target", () => order.push("target"));
    turns.shift()?.();

    expect(order).toEqual(["target", "peer"]);
    arbiter.dispose();
  });

  it("consumes combined reserved and explicit priority exactly once", () => {
    const turns: Array<() => void> = [];
    const order: string[] = [];
    const arbiter = new RendererTerminalWriteArbiter({
      scheduleTurn: (callback) => turns.push(callback),
      now: () => 0
    });
    let targetRuns = 0;
    const runTarget = (): void => {
      targetRuns += 1;
      order.push(`target-${targetRuns}`);
      if (targetRuns === 1) {
        arbiter.request("target", runTarget);
      }
    };

    arbiter.request("peer", () => order.push("peer"));
    arbiter.prioritize("target");
    arbiter.request("target", runTarget, true);
    turns.shift()?.();

    expect(order).toEqual(["target-1", "peer", "target-2"]);
    arbiter.dispose();
  });

  it("keeps peer lanes scheduled when lane error reporting throws", () => {
    const turns: Array<() => void> = [];
    const peer = vi.fn();
    const arbiter = new RendererTerminalWriteArbiter({
      maxStartsPerTurn: 1,
      scheduleTurn: (callback) => turns.push(callback),
      onError: () => {
        throw new Error("diagnostics failed");
      }
    });

    arbiter.request("failed", () => {
      throw new Error("parse failed");
    });
    arbiter.request("peer", peer);
    expect(() => turns.shift()?.()).not.toThrow();
    expect(turns).toHaveLength(1);
    turns.shift()?.();

    expect(peer).toHaveBeenCalledOnce();
    arbiter.dispose();
  });

  it("cancels queued lanes and ignores requests after dispose", () => {
    const turns: Array<() => void> = [];
    const run = vi.fn();
    const arbiter = new RendererTerminalWriteArbiter({
      scheduleTurn: (callback) => turns.push(callback)
    });

    arbiter.prioritize("a");
    arbiter.cancel("a");
    arbiter.request("a", run);
    turns.shift()?.();
    expect(run).toHaveBeenCalledOnce();
    arbiter.request("b", run);
    arbiter.dispose();
    turns.shift()?.();

    expect(run).toHaveBeenCalledOnce();
  });
});
