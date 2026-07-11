import {
  createUsageAdapters,
  scanUsageAdaptersAtStartup,
  type UsageAdapter
} from "@kmux/metadata";

import type {
  UsageScanWorkerConfig,
  UsageScanWorkerRequest,
  UsageScanWorkerResponse
} from "./usageScanProtocol";

let adapters: UsageAdapter[] = [];
let watcherCleanups: Array<() => void> = [];
let initialized = false;
let scanInitialized = false;
let jobQueue = Promise.resolve();

function send(message: UsageScanWorkerResponse): void {
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

function sendError(
  requestId: string,
  error: unknown,
  context: string
): void {
  send({
    type: "error",
    requestId,
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    context
  });
}

function disposeAdapters(): void {
  for (const cleanup of watcherCleanups) {
    cleanup();
  }
  watcherCleanups = [];
  for (const adapter of adapters) {
    adapter.close();
  }
  adapters = [];
  initialized = false;
  scanInitialized = false;
}

function initialize(config: UsageScanWorkerConfig): void {
  disposeAdapters();
  adapters = createUsageAdapters(config);
  watcherCleanups = adapters.map((adapter) =>
    adapter.watch(() => {
      send({ type: "changed", vendor: adapter.vendor });
    })
  );
  initialized = true;
}

async function handleRequest(request: UsageScanWorkerRequest): Promise<void> {
  if (request.type === "init") {
    initialize(request.config);
    send({ type: "ready", requestId: request.requestId });
    return;
  }

  if (request.type === "shutdown") {
    disposeAdapters();
    process.disconnect?.();
    return;
  }

  if (!initialized) {
    if (request.type === "scan") {
      sendError(
        request.requestId,
        new Error("usage scan worker is not initialized"),
        "scan before init"
      );
    }
    return;
  }

  if (request.type === "mark-dirty") {
    for (const adapter of adapters) {
      if (adapter.vendor === request.vendor) {
        adapter.markDirty?.(request.options);
      }
    }
    return;
  }

  try {
    if (request.initial || !scanInitialized) {
      const result = await scanUsageAdaptersAtStartup(adapters, {
        startOfDayMs: request.startOfDayMs,
        ...(request.historyRange ? { historyRange: request.historyRange } : {})
      });
      scanInitialized = true;
      send({
        type: "scan-result",
        requestId: request.requestId,
        reads: result.reads,
        ...(result.historyDays ? { historyDays: result.historyDays } : {})
      });
      return;
    }

    const reads = await Promise.all(
      adapters.map((adapter) => adapter.readIncremental(request.startOfDayMs))
    );
    send({
      type: "scan-result",
      requestId: request.requestId,
      reads
    });
  } catch (error) {
    sendError(
      request.requestId,
      error,
      request.initial ? "initial usage scan" : "incremental usage scan"
    );
  }
}

process.on("message", (message: UsageScanWorkerRequest) => {
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
  disposeAdapters();
  process.exit(0);
});

process.on("SIGTERM", () => {
  disposeAdapters();
  process.exit(0);
});

process.on("exit", disposeAdapters);
