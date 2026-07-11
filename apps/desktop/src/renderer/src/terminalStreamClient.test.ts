// @vitest-environment jsdom

import type {
  TerminalCheckpoint,
  TerminalDataPlaneHostMessage,
  TerminalSessionRef
} from "@kmux/proto";
import { TERMINAL_DATA_PLANE_PROTOCOL_VERSION } from "@kmux/proto";
import { describe, expect, it, vi } from "vitest";

import {
  KMUX_TERMINAL_PORT_WINDOW_MESSAGE,
  type TerminalStreamAttachResult,
  type TerminalStreamGrant
} from "../../shared/terminalPort";
import {
  TERMINAL_STREAM_PENDING_INPUT_MAX_BYTES,
  TerminalStreamClient,
  TerminalStreamPendingInputBuffer
} from "./terminalStreamClient";
import {
  TerminalStreamRouter,
  type TerminalStreamRegistration,
  type TerminalStreamSink
} from "./terminalStreamRouter";

class FakePort {
  readonly sent: unknown[] = [];
  readonly close = vi.fn();
  readonly start = vi.fn();
  private readonly listeners = new Map<
    string,
    Set<(event: MessageEvent<unknown>) => void>
  >();

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  addEventListener(
    type: "message" | "messageerror",
    listener: (event: MessageEvent<unknown>) => void
  ): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(
    type: "message" | "messageerror",
    listener: (event: MessageEvent<unknown>) => void
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  receive(message: TerminalDataPlaneHostMessage): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: message } as MessageEvent<unknown>);
    }
  }
}

class FakeWindow {
  readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
  requestGrant: (
    surfaceId: string,
    sessionId: string
  ) => Promise<TerminalStreamGrant | TerminalStreamAttachResult | null> =
    async () => null;
  readonly kmux = {
    attachTerminalStream: async (surfaceId: string, sessionId: string) => {
      const result = await this.requestGrant(surfaceId, sessionId);
      return result && "attachId" in result
        ? ({
            status: "granted",
            grant: result
          } satisfies TerminalStreamAttachResult)
        : result;
    }
  };

  addEventListener(type: string, listener: EventListener): void {
    if (type === "message") {
      this.listeners.add(listener as (event: MessageEvent<unknown>) => void);
    }
  }

  removeEventListener(type: string, listener: EventListener): void {
    if (type === "message") {
      this.listeners.delete(listener as (event: MessageEvent<unknown>) => void);
    }
  }

  transfer(grant: TerminalStreamGrant, port: FakePort): void {
    const event = {
      source: this,
      data: { type: KMUX_TERMINAL_PORT_WINDOW_MESSAGE, grant },
      ports: [port]
    } as unknown as MessageEvent<unknown>;
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

const session: TerminalSessionRef = {
  surfaceId: "surface_1",
  sessionId: "session_1",
  epoch: "epoch_1"
};

function grant(attachId: string, nextSession = session): TerminalStreamGrant {
  return { attachId, session: nextSession };
}

function checkpoint(
  sequence: number,
  checkpointSession = session
): TerminalCheckpoint {
  return {
    format: "xterm-vt/1",
    session: checkpointSession,
    sequence,
    data: "snapshot",
    cols: 80,
    rows: 24
  };
}

function attachedCheckpoint(
  attachId: string,
  checkpointSession = session,
  sequence = 0
): TerminalDataPlaneHostMessage {
  return {
    protocol: TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
    attachId,
    session: checkpointSession,
    type: "attached",
    mode: "checkpoint",
    checkpoint: checkpoint(sequence, checkpointSession)
  };
}

function output(
  attachId: string,
  fromSequence: number,
  data: string,
  outputSession = session
): TerminalDataPlaneHostMessage {
  return {
    protocol: TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
    attachId,
    session: outputSession,
    type: "delta",
    delta: {
      type: "output",
      fromSequence,
      sequence: fromSequence + 1,
      byteLength: data.length,
      segments: [
        {
          sequence: fromSequence + 1,
          data,
          byteLength: data.length
        }
      ]
    }
  };
}

function sink(): TerminalStreamSink {
  return {
    applyCheckpoint() {},
    applyResume() {},
    write(_data, parsed) {
      parsed();
    },
    resize() {},
    exit() {}
  };
}

describe("TerminalStreamClient", () => {
  it("pairs a transferred port that arrives before the invoke grant", async () => {
    const target = new FakeWindow();
    const port = new FakePort();
    const streamGrant = grant("attach_1");
    let resolveGrant!: (value: TerminalStreamGrant) => void;
    target.requestGrant = () =>
      new Promise((resolve) => {
        resolveGrant = resolve;
      });
    const client = new TerminalStreamClient(
      new TerminalStreamRouter(),
      target as unknown as Window
    );

    const attachedPromise = client.attach({
      surfaceId: session.surfaceId,
      expectedSessionId: session.sessionId,
      sink: sink()
    });
    target.transfer(streamGrant, port);
    resolveGrant(streamGrant);

    const attached = await attachedPromise;
    expect(attached?.grant).toEqual(streamGrant);
    expect(port.sent[0]).toMatchObject({
      protocol: TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
      type: "attach",
      attachId: "attach_1",
      session
    });
    client.dispose();
  });

  it("resumes only when the surface, session, and runtime epoch all match", async () => {
    const target = new FakeWindow();
    const client = new TerminalStreamClient(
      new TerminalStreamRouter(),
      target as unknown as Window
    );
    const grants = [
      grant("attach_1"),
      grant("attach_2"),
      grant("attach_3", { ...session, epoch: "epoch_2" })
    ];
    const ports = [new FakePort(), new FakePort(), new FakePort()];
    target.requestGrant = async () => {
      const nextGrant = grants.shift()!;
      const nextPort = ports[3 - grants.length - 1]!;
      target.transfer(nextGrant, nextPort);
      return nextGrant;
    };

    const first = await client.attach({
      surfaceId: session.surfaceId,
      expectedSessionId: session.sessionId,
      sink: sink()
    });
    ports[0]!.receive({
      protocol: TERMINAL_DATA_PLANE_PROTOCOL_VERSION,
      attachId: "attach_1",
      session,
      type: "attached",
      mode: "checkpoint",
      checkpoint: checkpoint(7)
    });
    await vi.waitFor(() => expect(first?.registration.sequence).toBe(7));
    client.detach(first!);
    await Promise.resolve();

    const resumed = await client.attach({
      surfaceId: session.surfaceId,
      expectedSessionId: session.sessionId,
      sink: sink(),
      resumeFromSequence: 7
    });
    expect(ports[1]!.sent[0]).toMatchObject({
      type: "attach",
      resumeFromSequence: 7
    });
    client.detach(resumed!);
    await Promise.resolve();

    await client.attach({
      surfaceId: session.surfaceId,
      expectedSessionId: session.sessionId,
      sink: sink(),
      resumeFromSequence: 7
    });
    expect(ports[2]!.sent[0]).not.toHaveProperty("resumeFromSequence");
    client.dispose();
  });

  it("invalidates an attachment hidden before its checkpoint commits", async () => {
    const target = new FakeWindow();
    const client = new TerminalStreamClient(
      new TerminalStreamRouter(),
      target as unknown as Window
    );
    const port = new FakePort();
    const streamGrant = grant("attach_pending");
    target.requestGrant = async () => {
      target.transfer(streamGrant, port);
      return streamGrant;
    };
    const invalidateResume = vi.fn();
    const attached = await client.attach({
      surfaceId: session.surfaceId,
      expectedSessionId: session.sessionId,
      sink: sink(),
      invalidateResume
    });

    await client.detach(attached!);
    expect(invalidateResume).toHaveBeenCalledOnce();
    expect(port.close).toHaveBeenCalledOnce();
  });

  it("closes an unsafe hidden port immediately and resumes after admitted output settles", async () => {
    const target = new FakeWindow();
    const client = new TerminalStreamClient(
      new TerminalStreamRouter(),
      target as unknown as Window
    );
    const grants = [grant("attach_settling"), grant("attach_resumed")];
    const ports = [new FakePort(), new FakePort()];
    const requestGrant = vi.fn(async () => {
      const nextGrant = grants.shift()!;
      const nextPort = ports[2 - grants.length - 1]!;
      target.transfer(nextGrant, nextPort);
      return nextGrant;
    });
    target.requestGrant = requestGrant;
    let completeWrite: (() => void) | null = null;
    let hydratedSequence = 0;
    const invalidateResume = vi.fn();
    const first = await client.attach({
      surfaceId: session.surfaceId,
      expectedSessionId: session.sessionId,
      sink: {
        ...sink(),
        write(_data, parsed) {
          completeWrite = () => {
            hydratedSequence = 1;
            parsed();
          };
        }
      },
      invalidateResume
    });
    ports[0]!.receive(attachedCheckpoint("attach_settling"));
    await vi.waitFor(() => expect(first?.registration.resumeSafe).toBe(true));
    ports[0]!.receive(output("attach_settling", 0, "pending"));
    await vi.waitFor(() => expect(completeWrite).not.toBeNull());

    const detachSettled = client.detach(first!, "hidden");
    await Promise.resolve();
    expect(ports[0]!.close).toHaveBeenCalledOnce();
    expect(invalidateResume).not.toHaveBeenCalled();

    const resumedPromise = client.attach({
      surfaceId: session.surfaceId,
      expectedSessionId: session.sessionId,
      sink: sink(),
      resumeFromSequence: () => hydratedSequence,
      invalidateResume
    });
    await Promise.resolve();
    expect(requestGrant).toHaveBeenCalledOnce();

    (completeWrite as (() => void) | null)?.();
    await detachSettled;
    const resumed = await resumedPromise;
    expect(requestGrant).toHaveBeenCalledTimes(2);
    expect(ports[1]!.sent[0]).toMatchObject({
      type: "attach",
      resumeFromSequence: 1
    });
    expect(invalidateResume).not.toHaveBeenCalled();
    client.dispose();
    expect(resumed?.registration.closed).toBe(true);
  });

  it("keeps a clean warm resume and does not invalidate it on detach", async () => {
    const target = new FakeWindow();
    const client = new TerminalStreamClient(
      new TerminalStreamRouter(),
      target as unknown as Window
    );
    const port = new FakePort();
    const streamGrant = grant("attach_clean");
    target.requestGrant = async () => {
      target.transfer(streamGrant, port);
      return streamGrant;
    };
    const invalidateResume = vi.fn();
    const attached = await client.attach({
      surfaceId: session.surfaceId,
      expectedSessionId: session.sessionId,
      sink: sink(),
      invalidateResume
    });
    port.receive(attachedCheckpoint(streamGrant.attachId, session, 4));
    await vi.waitFor(() =>
      expect(attached?.registration.resumeSafe).toBe(true)
    );

    client.detach(attached!);
    await Promise.resolve();
    expect(invalidateResume).not.toHaveBeenCalled();
    expect(port.close).toHaveBeenCalledOnce();
  });

  it("preserves an unsafe stream during the pane-move microtask handoff", async () => {
    const target = new FakeWindow();
    const client = new TerminalStreamClient(
      new TerminalStreamRouter(),
      target as unknown as Window
    );
    const port = new FakePort();
    const streamGrant = grant("attach_handoff");
    target.requestGrant = async () => {
      target.transfer(streamGrant, port);
      return streamGrant;
    };
    let completeWrite: (() => void) | null = null;
    const firstInvalidation = vi.fn();
    const secondInvalidation = vi.fn();
    const first = await client.attach({
      surfaceId: session.surfaceId,
      expectedSessionId: session.sessionId,
      sink: {
        ...sink(),
        write(_data, parsed) {
          completeWrite = parsed;
        }
      },
      invalidateResume: firstInvalidation
    });
    port.receive(attachedCheckpoint(streamGrant.attachId));
    await vi.waitFor(() => expect(first?.registration.sequence).toBe(0));
    port.receive(output(streamGrant.attachId, 0, "moving"));
    await vi.waitFor(() => expect(completeWrite).not.toBeNull());

    client.detach(first!);
    const second = await client.attach({
      surfaceId: session.surfaceId,
      expectedSessionId: session.sessionId,
      sink: sink(),
      invalidateResume: secondInvalidation
    });
    await Promise.resolve();
    expect(second).toBe(first);
    expect(firstInvalidation).not.toHaveBeenCalled();
    expect(secondInvalidation).not.toHaveBeenCalled();
    expect(port.close).not.toHaveBeenCalled();

    (completeWrite as (() => void) | null)?.();
    await vi.waitFor(() => expect(second?.registration.resumeSafe).toBe(true));
    client.detach(second!);
    await Promise.resolve();
  });

  it("retries a shared pending attach when only its first pane owner aborts", async () => {
    const target = new FakeWindow();
    const firstGrant = grant("attach_pending_owner");
    const nextGrant = grant("attach_handoff_owner");
    const firstPort = new FakePort();
    const nextPort = new FakePort();
    let resolveFirst!: (value: TerminalStreamGrant) => void;
    const requestGrant = vi.fn(async () => {
      if (requestGrant.mock.calls.length === 1) {
        return new Promise<TerminalStreamGrant>((resolve) => {
          resolveFirst = resolve;
        });
      }
      target.transfer(nextGrant, nextPort);
      return nextGrant;
    });
    target.requestGrant = requestGrant;
    const client = new TerminalStreamClient(
      new TerminalStreamRouter(),
      target as unknown as Window,
      { retryDelaysMs: [0] }
    );
    const firstOwner = new AbortController();

    const first = client.attachWithRetryOutcome({
      surfaceId: session.surfaceId,
      expectedSessionId: session.sessionId,
      sink: sink(),
      signal: firstOwner.signal
    });
    const handoff = client.attachWithRetryOutcome({
      surfaceId: session.surfaceId,
      expectedSessionId: session.sessionId,
      sink: sink()
    });
    firstOwner.abort();
    target.transfer(firstGrant, firstPort);
    resolveFirst(firstGrant);

    await expect(first).resolves.toEqual({ status: "cancelled" });
    await expect(handoff).resolves.toMatchObject({
      status: "attached",
      stream: { grant: nextGrant }
    });
    expect(requestGrant).toHaveBeenCalledTimes(2);
    client.dispose();
  });

  it("retries when the first owner aborts after the shared port is registered", async () => {
    const target = new FakeWindow();
    const firstGrant = grant("attach_registered_owner");
    const nextGrant = grant("attach_registered_handoff");
    const firstPort = new FakePort();
    const nextPort = new FakePort();
    const firstOwner = new AbortController();
    firstPort.start.mockImplementation(() => firstOwner.abort());
    const requestGrant = vi.fn(async () => {
      if (requestGrant.mock.calls.length === 1) {
        target.transfer(firstGrant, firstPort);
        return firstGrant;
      }
      target.transfer(nextGrant, nextPort);
      return nextGrant;
    });
    target.requestGrant = requestGrant;
    const client = new TerminalStreamClient(
      new TerminalStreamRouter(),
      target as unknown as Window,
      { retryDelaysMs: [0] }
    );

    const first = client.attachWithRetryOutcome({
      surfaceId: session.surfaceId,
      expectedSessionId: session.sessionId,
      sink: sink(),
      signal: firstOwner.signal
    });
    const handoff = client.attachWithRetryOutcome({
      surfaceId: session.surfaceId,
      expectedSessionId: session.sessionId,
      sink: sink()
    });

    await expect(first).resolves.toEqual({ status: "cancelled" });
    await expect(handoff).resolves.toMatchObject({
      status: "attached",
      stream: { grant: nextGrant }
    });
    expect(firstPort.close).toHaveBeenCalledOnce();
    expect(requestGrant).toHaveBeenCalledTimes(2);
    client.dispose();
  });

  it("supersedes a pending old session attach instead of returning its result", async () => {
    const target = new FakeWindow();
    const client = new TerminalStreamClient(
      new TerminalStreamRouter(),
      target as unknown as Window
    );
    const nextSession = {
      ...session,
      sessionId: "session_2",
      epoch: "epoch_2"
    };
    const oldGrant = grant("attach_old");
    const nextGrant = grant("attach_new", nextSession);
    const oldPort = new FakePort();
    const nextPort = new FakePort();
    let resolveOld!: (value: TerminalStreamGrant) => void;
    let resolveNext!: (value: TerminalStreamGrant) => void;
    target.requestGrant = (_surfaceId, expectedSessionId) =>
      new Promise((resolve) => {
        if (expectedSessionId === session.sessionId) {
          resolveOld = resolve;
        } else {
          resolveNext = resolve;
        }
      });

    const oldAttach = client.attach({
      surfaceId: session.surfaceId,
      expectedSessionId: session.sessionId,
      sink: sink()
    });
    const nextAttach = client.attach({
      surfaceId: nextSession.surfaceId,
      expectedSessionId: nextSession.sessionId,
      sink: sink()
    });
    target.transfer(nextGrant, nextPort);
    resolveNext(nextGrant);
    await expect(nextAttach).resolves.toMatchObject({ grant: nextGrant });

    target.transfer(oldGrant, oldPort);
    resolveOld(oldGrant);
    await expect(oldAttach).resolves.toBeNull();
    expect(oldPort.close).toHaveBeenCalledOnce();
    expect(nextPort.close).not.toHaveBeenCalled();
    client.dispose();
  });

  it("retries an initially not-ready runtime and attaches when it becomes ready", async () => {
    const target = new FakeWindow();
    const port = new FakePort();
    const streamGrant = grant("attach_after_ready");
    const requestGrant = vi.fn(async () => {
      if (requestGrant.mock.calls.length === 1) {
        return {
          status: "retryable-not-ready",
          reason: "runtime-not-ready"
        } satisfies TerminalStreamAttachResult;
      }
      target.transfer(streamGrant, port);
      return streamGrant;
    });
    target.requestGrant = requestGrant;
    const client = new TerminalStreamClient(
      new TerminalStreamRouter(),
      target as unknown as Window,
      { retryDelaysMs: [0] }
    );

    const attached = await client.attachWithRetry({
      surfaceId: session.surfaceId,
      expectedSessionId: session.sessionId,
      sink: sink()
    });

    expect(requestGrant).toHaveBeenCalledTimes(2);
    expect(attached?.grant).toEqual(streamGrant);
    client.dispose();
  });

  it("retries when a granted port misses its transfer deadline", async () => {
    const target = new FakeWindow();
    const firstGrant = grant("attach_timed_out");
    const retryGrant = grant("attach_after_timeout");
    const retryPort = new FakePort();
    const requestGrant = vi
      .fn()
      .mockResolvedValueOnce(firstGrant)
      .mockImplementationOnce(async () => {
        target.transfer(retryGrant, retryPort);
        return retryGrant;
      });
    target.requestGrant = requestGrant;
    const client = new TerminalStreamClient(
      new TerminalStreamRouter(),
      target as unknown as Window,
      { portTransferTimeoutMs: 5, retryDelaysMs: [0] }
    );

    const attached = await client.attachWithRetry({
      surfaceId: session.surfaceId,
      expectedSessionId: session.sessionId,
      sink: sink()
    });

    expect(requestGrant).toHaveBeenCalledTimes(2);
    expect(attached?.grant).toEqual(retryGrant);
    client.dispose();
  });

  it("does not retry a permanent authorization denial", async () => {
    const target = new FakeWindow();
    const requestGrant = vi.fn(
      async () =>
        ({
          status: "denied",
          reason: "not-current-surface"
        }) satisfies TerminalStreamAttachResult
    );
    target.requestGrant = requestGrant;
    const client = new TerminalStreamClient(
      new TerminalStreamRouter(),
      target as unknown as Window,
      { retryDelaysMs: [0, 0] }
    );

    await expect(
      client.attachWithRetry({
        surfaceId: session.surfaceId,
        expectedSessionId: session.sessionId,
        sink: sink()
      })
    ).resolves.toBeNull();
    expect(requestGrant).toHaveBeenCalledOnce();
    client.dispose();
  });

  it("reports retryable exhaustion separately from permanent denial", async () => {
    const target = new FakeWindow();
    target.requestGrant = async () => ({
      status: "retryable-not-ready",
      reason: "runtime-not-ready"
    });
    const client = new TerminalStreamClient(
      new TerminalStreamRouter(),
      target as unknown as Window,
      { retryDelaysMs: [] }
    );

    await expect(
      client.attachWithRetryOutcome({
        surfaceId: session.surfaceId,
        expectedSessionId: session.sessionId,
        sink: sink()
      })
    ).resolves.toEqual({ status: "retryable-not-ready" });
    client.dispose();
  });

  it("cancels a pending retry when its surface attachment is superseded", async () => {
    const target = new FakeWindow();
    const requestGrant = vi.fn(
      async () =>
        ({
          status: "retryable-not-ready",
          reason: "runtime-not-ready"
        }) satisfies TerminalStreamAttachResult
    );
    target.requestGrant = requestGrant;
    const client = new TerminalStreamClient(
      new TerminalStreamRouter(),
      target as unknown as Window,
      { retryDelaysMs: [1_000] }
    );
    const controller = new AbortController();

    const attached = client.attachWithRetry({
      surfaceId: session.surfaceId,
      expectedSessionId: session.sessionId,
      sink: sink(),
      signal: controller.signal
    });
    await Promise.resolve();
    controller.abort();

    await expect(attached).resolves.toBeNull();
    expect(requestGrant).toHaveBeenCalledOnce();
    client.dispose();
  });

  it("forgets a live surface capability permanently", async () => {
    const target = new FakeWindow();
    const client = new TerminalStreamClient(
      new TerminalStreamRouter(),
      target as unknown as Window
    );
    const port = new FakePort();
    const streamGrant = grant("attach_forget");
    target.requestGrant = async () => {
      target.transfer(streamGrant, port);
      return streamGrant;
    };
    const attached = await client.attach({
      surfaceId: session.surfaceId,
      expectedSessionId: session.sessionId,
      sink: sink()
    });
    port.receive(attachedCheckpoint(streamGrant.attachId));
    await vi.waitFor(() => expect(attached?.registration.sequence).toBe(0));

    client.forgetSurface(session.surfaceId);
    expect(port.sent.at(-1)).toMatchObject({
      type: "detach",
      reason: "surface-closed"
    });
    expect(port.close).toHaveBeenCalledOnce();
  });
});

describe("TerminalStreamPendingInputBuffer", () => {
  it("flushes text and binary in FIFO order through one registration", () => {
    const buffer = new TerminalStreamPendingInputBuffer();
    const calls: string[] = [];
    const sendText = vi.fn((data: string) => calls.push(`text:${data}`));
    const sendBinary = vi.fn((data: string) => calls.push(`binary:${data}`));
    expect(buffer.enqueueText(session.surfaceId, session.sessionId, "a")).toBe(
      true
    );
    expect(
      buffer.enqueueBinary(session.surfaceId, session.sessionId, "\u0001")
    ).toBe(true);
    expect(buffer.enqueueText(session.surfaceId, session.sessionId, "b")).toBe(
      true
    );

    buffer.flush({
      grant: grant("attach_buffer"),
      registration: {
        sendText,
        sendBinary
      } as unknown as TerminalStreamRegistration
    });

    expect(calls).toEqual(["text:a", "binary:\u0001", "text:b"]);
    expect(buffer.byteLength).toBe(0);
  });

  it("never exceeds its bounded attach-time input capacity", () => {
    const buffer = new TerminalStreamPendingInputBuffer();
    expect(
      buffer.enqueueBinary(
        session.surfaceId,
        session.sessionId,
        "x".repeat(TERMINAL_STREAM_PENDING_INPUT_MAX_BYTES)
      )
    ).toBe(true);
    expect(buffer.byteLength).toBe(TERMINAL_STREAM_PENDING_INPUT_MAX_BYTES);
    expect(
      buffer.enqueueText(session.surfaceId, session.sessionId, "overflow")
    ).toBe(false);
    expect(buffer.byteLength).toBe(TERMINAL_STREAM_PENDING_INPUT_MAX_BYTES);
  });

  it("discards attach-time input on failure or unmount", () => {
    const buffer = new TerminalStreamPendingInputBuffer();
    const sendText = vi.fn();
    buffer.enqueueText(session.surfaceId, session.sessionId, "stale-input");

    buffer.discard();
    buffer.flush({
      grant: grant("attach_after_unmount"),
      registration: { sendText } as unknown as TerminalStreamRegistration
    });

    expect(sendText).not.toHaveBeenCalled();
    expect(buffer.byteLength).toBe(0);
  });
});
