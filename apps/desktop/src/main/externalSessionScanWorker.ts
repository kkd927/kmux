import {
  createExternalSessionIndexer,
  type SynchronousExternalSessionIndexer
} from "./externalSessions";
import type {
  ExternalSessionScanWorkerConfig,
  ExternalSessionScanWorkerRequest,
  ExternalSessionScanWorkerResponse
} from "./externalSessionScanProtocol";

let indexer: SynchronousExternalSessionIndexer | null = null;
let jobQueue = Promise.resolve();

function send(message: ExternalSessionScanWorkerResponse): void {
  if (!process.send || !process.connected) {
    return;
  }
  try {
    process.send(message, () => {
      // The parent owns retries and worker lifecycle.
    });
  } catch {
    // Parent shutdown may race with a completed scan.
  }
}

function sendError(requestId: string, error: unknown, context: string): void {
  send({
    type: "error",
    requestId,
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    context
  });
}

function initialize(config: ExternalSessionScanWorkerConfig): void {
  indexer = createExternalSessionIndexer(config);
}

function handleRequest(request: ExternalSessionScanWorkerRequest): void {
  if (request.type === "init") {
    initialize(request.config);
    send({ type: "ready", requestId: request.requestId });
    return;
  }
  if (request.type === "shutdown") {
    indexer = null;
    process.disconnect?.();
    return;
  }
  if (!indexer) {
    sendError(
      request.requestId,
      new Error("external session scan worker is not initialized"),
      "scan before init"
    );
    return;
  }

  try {
    const snapshot = indexer.listExternalAgentSessions();
    const resumeSpecs = snapshot.sessions.flatMap((session) => {
      const spec = indexer?.resolveExternalAgentSession(session.key);
      return spec ? [spec] : [];
    });
    send({
      type: "scan-result",
      requestId: request.requestId,
      snapshot,
      resumeSpecs
    });
  } catch (error) {
    sendError(request.requestId, error, "external session scan");
  }
}

process.on("message", (message: ExternalSessionScanWorkerRequest) => {
  if (!message || typeof message !== "object" || !("type" in message)) {
    return;
  }
  jobQueue = jobQueue
    .then(() => handleRequest(message))
    .catch((error) => {
      if ("requestId" in message) {
        sendError(message.requestId, error, `queued ${message.type} request`);
      }
    });
});

process.on("disconnect", () => {
  indexer = null;
  process.exit(0);
});

process.on("SIGTERM", () => {
  indexer = null;
  process.exit(0);
});
