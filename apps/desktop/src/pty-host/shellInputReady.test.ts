import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SHELL_READY_FALLBACK_MS,
  armShellReadyFallback,
  disposeShellReadyFallback,
  isShellReadyOscPayload,
  markShellInputReady,
  type ShellInputReadyRecord
} from "./shellInputReady";

function createRecord(
  pendingInitialInput?: string
): ShellInputReadyRecord & { writes: string[] } {
  const writes: string[] = [];
  return {
    sessionId: "session_1",
    surfaceId: "surface_1",
    shellInputReady: false,
    pendingInitialInput,
    shellReadyFallbackTimer: null,
    pty: {
      write: (text: string) => {
        writes.push(text);
      }
    },
    writes
  };
}

describe("pty-host shell input readiness", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("recognizes only the kmux shell-ready OSC payload", () => {
    expect(isShellReadyOscPayload("shell.ready")).toBe(true);
    expect(isShellReadyOscPayload("file://localhost/Users/test")).toBe(false);
    expect(isShellReadyOscPayload("shell.ready\n")).toBe(false);
  });

  it("flushes pending initial input only when the shell becomes ready", () => {
    const record = createRecord("codex\r");
    const events: unknown[] = [];

    expect(markShellInputReady(record, (event) => events.push(event))).toBe(
      true
    );
    expect(record.shellInputReady).toBe(true);
    expect(record.pendingInitialInput).toBeUndefined();
    expect(record.writes).toEqual(["codex\r"]);
    expect(events).toEqual([
      {
        type: "shell.ready",
        sessionId: "session_1",
        surfaceId: "surface_1"
      }
    ]);

    expect(markShellInputReady(record, (event) => events.push(event))).toBe(
      false
    );
    expect(record.writes).toEqual(["codex\r"]);
    expect(events).toHaveLength(1);
  });

  it("flushes pending output before emitting ready or writing queued input", () => {
    const record = createRecord("codex\r");
    const calls: string[] = [];
    record.pty.write = (text: string) => {
      record.writes.push(text);
      calls.push(`write:${text}`);
    };

    markShellInputReady(
      record,
      (event) => calls.push(`event:${event.type}`),
      () => calls.push("flush")
    );

    expect(record.writes).toEqual(["codex\r"]);
    expect(calls).toEqual(["flush", "write:codex\r", "event:shell.ready"]);
  });

  it("uses a fallback timer so integrated shells cannot stay blocked forever", () => {
    vi.useFakeTimers();
    const record = createRecord("echo ready\r");
    const events: unknown[] = [];

    armShellReadyFallback(record, (event) => events.push(event));
    vi.advanceTimersByTime(SHELL_READY_FALLBACK_MS - 1);
    expect(record.shellInputReady).toBe(false);
    expect(record.writes).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(record.shellInputReady).toBe(true);
    expect(record.writes).toEqual(["echo ready\r"]);
    expect(events).toHaveLength(1);

    disposeShellReadyFallback(record);
    expect(record.shellReadyFallbackTimer).toBeNull();
  });
});
