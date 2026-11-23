import {
  createLocalMetadataInventoryService,
  scanUsageAdapters,
  scanUsageAdaptersAtStartup,
  type AgentMetadataInventoryService,
  type UsageAdapter
} from "@kmux/metadata";
import {
  builtinAgentMetadataDirectoryFilters,
  builtinAgentMetadataQueryPlans,
  builtinAgentMetadataSourceRevisions,
  createBuiltinLocalExternalSessionIndexer,
  readBuiltinAgentSessionTranscript,
  listBuiltinLocalUsageAdapters
} from "@kmux/agents/builtin-runtime";
import type { ExternalSessionIndexer } from "@kmux/agents";

import type {
  UsageScanWorkerConfig,
  UsageScanWorkerRequest,
  UsageScanWorkerResponse
} from "./usageScanProtocol";

let adapters: UsageAdapter[] = [];
let externalSessionIndexer: ExternalSessionIndexer | null = null;
let metadataInventory: AgentMetadataInventoryService | null = null;
let activeConfig: UsageScanWorkerConfig | null = null;
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

function sendError(requestId: string, error: unknown, context: string): void {
  send({
    type: "error",
    requestId,
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    context
  });
}

async function disposeAdapters(): Promise<void> {
  for (const cleanup of watcherCleanups) {
    cleanup();
  }
  watcherCleanups = [];
  for (const adapter of adapters) {
    adapter.close();
  }
  adapters = [];
  externalSessionIndexer?.close?.();
  externalSessionIndexer = null;
  await metadataInventory?.close();
  metadataInventory = null;
  initialized = false;
  scanInitialized = false;
}

async function initialize(config: UsageScanWorkerConfig): Promise<void> {
  await disposeAdapters();
  metadataInventory = createLocalMetadataInventoryService({
    principal: process.getuid ? `uid:${process.getuid()}` : "desktop-user",
    platform: config.platform,
    sourceDefinitionRevisions: builtinAgentMetadataSourceRevisions(),
    queryPlans: builtinAgentMetadataQueryPlans(),
    directoryFilters: builtinAgentMetadataDirectoryFilters()
  });
  const runtimeOptions = { ...config, metadataInventory };
  adapters = [...listBuiltinLocalUsageAdapters(runtimeOptions)];
  externalSessionIndexer =
    createBuiltinLocalExternalSessionIndexer(runtimeOptions);
  watcherCleanups = adapters.map((adapter) =>
    adapter.watch(() => {
      send({ type: "changed", vendor: adapter.vendor });
    })
  );
  initialized = true;
  activeConfig = config;
}

async function handleRequest(request: UsageScanWorkerRequest): Promise<void> {
  if (request.type === "init") {
    await initialize(request.config);
    send({ type: "ready", requestId: request.requestId });
    return;
  }

  if (request.type === "shutdown") {
    await disposeAdapters();
    activeConfig = null;
    process.disconnect?.();
    return;
  }

  if (!initialized) {
    if (
      request.type === "scan" ||
      request.type === "external-sessions-scan" ||
      request.type === "session-transcript"
    ) {
      sendError(
        request.requestId,
        new Error("usage scan worker is not initialized"),
        "scan before init"
      );
    }
    return;
  }

  if (request.type === "reconfigure") {
    if (!activeConfig) {
      sendError(
        request.requestId,
        new Error("agent metadata scan worker has no active configuration"),
        "reconfigure before init"
      );
      return;
    }
    const nextConfig = { ...activeConfig };
    if (request.agentSettings === undefined) {
      delete nextConfig.agentSettings;
    } else {
      nextConfig.agentSettings = request.agentSettings;
    }
    await initialize(nextConfig);
    send({ type: "ready", requestId: request.requestId });
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

  if (request.type === "session-transcript") {
    try {
      const result = await readBuiltinAgentSessionTranscript({
        ...activeConfig!,
        ...request,
        metadataInventory: metadataInventory!
      });
      send({
        type: "session-transcript-result",
        requestId: request.requestId,
        result
      });
    } catch (error) {
      sendError(request.requestId, error, "session transcript");
    }
    return;
  }

  if (request.type === "external-sessions-scan") {
    if (!externalSessionIndexer) {
      sendError(
        request.requestId,
        new Error("external session indexer is not initialized"),
        "external session scan before init"
      );
      return;
    }
    try {
      const snapshot = await externalSessionIndexer.listExternalAgentSessions();
      const resumeSpecs = snapshot.sessions.flatMap((session) => {
        const spec = externalSessionIndexer?.resolveExternalAgentSession(
          session.key
        );
        return spec ? [spec] : [];
      });
      send({
        type: "external-sessions-scan-result",
        requestId: request.requestId,
        snapshot,
        resumeSpecs
      });
    } catch (error) {
      sendError(request.requestId, error, "external session scan");
    }
    return;
  }

  try {
    if (request.initial || !scanInitialized) {
      const result = await scanUsageAdaptersAtStartup(adapters, {
        startOfDayMs: request.startOfDayMs
      });
      scanInitialized = result.failures.length === 0;
      send({
        type: "scan-result",
        requestId: request.requestId,
        reads: result.reads,
        failures: result.failures
      });
      return;
    }

    const result = await scanUsageAdapters(adapters, {
      startOfDayMs: request.startOfDayMs,
      initial: false
    });
    send({
      type: "scan-result",
      requestId: request.requestId,
      reads: result.reads,
      failures: result.failures
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
  void disposeAdapters().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void disposeAdapters().finally(() => process.exit(0));
});

process.on("exit", () => {
  for (const cleanup of watcherCleanups) cleanup();
  for (const adapter of adapters) adapter.close();
});
