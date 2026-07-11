import type { TerminalDataPortLike } from "./terminalSessionStream";

export interface UtilityProcessMessageEventLike {
  data: unknown;
  ports?: TerminalDataPortLike[];
}

export interface UtilityParentPortLike {
  postMessage(message: unknown): void;
  on(
    event: "message",
    listener: (messageEvent: UtilityProcessMessageEventLike) => void
  ): unknown;
  off?(
    event: "message",
    listener: (messageEvent: UtilityProcessMessageEventLike) => void
  ): unknown;
}

interface UtilityProcessLike {
  parentPort?: UtilityParentPortLike | null;
}

export interface UtilityProcessControlTransport {
  readonly available: boolean;
  postMessage(message: unknown): void;
  onMessage(
    listener: (message: unknown, ports: TerminalDataPortLike[]) => void
  ): { dispose(): void };
}

export function createUtilityProcessControlTransport(
  processLike: UtilityProcessLike = process as UtilityProcessLike
): UtilityProcessControlTransport {
  const parentPort = processLike.parentPort ?? null;

  return {
    available: parentPort !== null,
    postMessage(message) {
      parentPort?.postMessage(message);
    },
    onMessage(listener) {
      if (!parentPort) {
        return { dispose() {} };
      }
      const handleMessage = (
        messageEvent: UtilityProcessMessageEventLike
      ): void => {
        listener(messageEvent.data, messageEvent.ports ?? []);
      };
      parentPort.on("message", handleMessage);
      return {
        dispose() {
          parentPort.off?.("message", handleMessage);
        }
      };
    }
  };
}
