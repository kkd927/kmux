import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  createUtilityProcessControlTransport,
  type UtilityParentPortLike
} from "./utilityProcessTransport";

describe("utility process control transport", () => {
  it("uses parentPort messages instead of Node child-process IPC", () => {
    const parentPort = new EventEmitter() as EventEmitter &
      UtilityParentPortLike;
    parentPort.postMessage = vi.fn();
    const transport = createUtilityProcessControlTransport({ parentPort });
    const onMessage = vi.fn();
    const subscription = transport.onMessage(onMessage);

    transport.postMessage({ type: "ready" });
    parentPort.emit("message", {
      data: { type: "shutdown", requestId: "request_1" }
    });

    expect(parentPort.postMessage).toHaveBeenCalledWith({ type: "ready" });
    expect(onMessage).toHaveBeenCalledWith(
      {
        type: "shutdown",
        requestId: "request_1"
      },
      []
    );

    subscription.dispose();
    parentPort.emit("message", { data: { type: "close" } });
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("is inert outside an Electron utility process", () => {
    const transport = createUtilityProcessControlTransport({});
    const onMessage = vi.fn();

    expect(transport.available).toBe(false);
    expect(() => transport.postMessage({ type: "ready" })).not.toThrow();
    expect(() => transport.onMessage(onMessage).dispose()).not.toThrow();
    expect(onMessage).not.toHaveBeenCalled();
  });
});
