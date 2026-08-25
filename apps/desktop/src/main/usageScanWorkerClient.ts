import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as osConstants, homedir, setPriority } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AgentHistorySessionIndexer,
  ExternalSessionIndexer,
  ExternalSessionResumeSpec,
  ExternalSessionScanPurpose
} from "@kmux/agents";
import type {
  AgentStorageRoots,
  UsageAdapterScanFailure,
  UsageAdapterDirtyOptions,
  UsageAdapterReadResult,
  UsageVendor
} from "@kmux/metadata";
import type {
  AgentScopeSettings,
  ExternalAgentSessionsSnapshot
} from "@kmux/proto";
import type {
  UsageScanWorkerConfig,
  UsageScanWorkerRequest,
  UsageScanWorkerResponse
} from "./usageScanProtocol";

const AGENT_METADATA_CONTROL_TIMEOUT_MS = 10_000;

export interface UsageScanResult {
  reads: UsageAdapterReadResult[];
  failures: UsageAdapterScanFailure[];
}

export interface UsageScanService {
  watch(onChange: (vendor: UsageVendor) => void): () => void;
  scan(options: {
    startOfDayMs: number;
    initial: boolean;
  }): Promise<UsageScanResult>;
  markDirty(
    vendor: Exclude<UsageVendor, "unknown">,
    options?: UsageAdapterDirtyOptions
  ): void;
  close(): void;
}

export interface AgentMetadataScanService extends UsageScanService {
  readonly externalSessions: ExternalSessionIndexer &
    AgentHistorySessionIndexer;
  updateAgentSettings(agentSettings?: AgentScopeSettings): Promise<void>;
}

export interface UsageScanWorkerLaunchOptions {
  entry: string;
  cwd: string;
  execArgv: string[];
}

type ForkWorker = (
  modulePath: string,
  args: readonly string[],
  options: ForkOptions
) => ChildProcess;

interface PendingRequest {
  resolve: (message: UsageScanWorkerResponse) => void;
  reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
}

interface ExternalScanInFlight {
  readonly generation: number;
  readonly promise: Promise<ExternalAgentSessionsSnapshot>;
}

export interface UsageScanWorkerError extends Error {
  workerStack?: string;
  workerContext?: string;
}

interface CreateUsageScanWorkerClientOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  agentStorageRoots?: AgentStorageRoots;
  agentSettings?: AgentScopeSettings;
  platform?: NodeJS.Platform;
  antigravitySessionIndexPath?: string;
  currentDir?: string;
  nodeEnv?: string;
  resourcesPath?: string;
  forkWorker?: ForkWorker;
  requestTimeoutMs?: number;
}

export function resolveUsageScanWorkerLaunchOptions(
  currentDir: string,
  nodeEnv: string | undefined = process.env.NODE_ENV,
  resourcesPath: string | undefined = process.resourcesPath
): UsageScanWorkerLaunchOptions {
  const asarSegment = `${sep}app.asar${sep}`;
  if (currentDir.includes(asarSegment)) {
    const packagedResourcesPath =
      resourcesPath ?? resolve(currentDir, "../../../..");
    return {
      entry: join(currentDir, "usageScanWorker.js"),
      cwd: join(packagedResourcesPath, "app.asar.unpacked"),
      execArgv: []
    };
  }

  const repoRoot = resolve(currentDir, "../../../..");
  if (nodeEnv === "production") {
    return {
      entry: resolve(currentDir, "usageScanWorker.js"),
      cwd: repoRoot,
      execArgv: []
    };
  }

  return {
    entry: resolve(repoRoot, "apps/desktop/src/main/usageScanWorker.ts"),
    cwd: repoRoot,
    execArgv: ["--import", "tsx"]
  };
}

export function createUsageScanWorkerClient(
  options: CreateUsageScanWorkerClientOptions
): AgentMetadataScanService {
  const currentDir =
    options.currentDir ?? dirname(fileURLToPath(import.meta.url));
  const launchOptions = resolveUsageScanWorkerLaunchOptions(
    currentDir,
    options.nodeEnv,
    options.resourcesPath
  );
  let config: UsageScanWorkerConfig = {
    env: normalizeEnv(options.env ?? process.env),
    homeDir: options.homeDir ?? homedir(),
    ...(options.agentStorageRoots
      ? { agentStorageRoots: options.agentStorageRoots }
      : {}),
    ...(options.agentSettings ? { agentSettings: options.agentSettings } : {}),
    platform: options.platform ?? process.platform,
    ...(options.antigravitySessionIndexPath
      ? { antigravitySessionIndexPath: options.antigravitySessionIndexPath }
      : {})
  };
  const forkWorker = options.forkWorker ?? fork;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? AGENT_METADATA_CONTROL_TIMEOUT_MS;
  const listeners = new Set<(vendor: UsageVendor) => void>();
  const pending = new Map<string, PendingRequest>();
  let child: ChildProcess | null = null;
  let startPromise: Promise<void> | null = null;
  let operationQueue: Promise<void> = Promise.resolve();
  let closed = false;
  let agentSettingsGeneration = 0;
  let agentSettingsReady: Promise<void> = Promise.resolve();
  const externalScanPromises = new Map<
    ExternalSessionScanPurpose,
    ExternalScanInFlight
  >();
  const resumeSpecs = new Map<
    ExternalSessionScanPurpose,
    ReadonlyMap<string, ExternalSessionResumeSpec>
  >();

  function enqueueOperation<TResult>(
    operation: () => Promise<TResult>
  ): Promise<TResult> {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  function rejectPending(error: Error): void {
    for (const request of pending.values()) {
      if (request.timeout) clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  }

  function disposeChild(target: ChildProcess, error: Error): void {
    if (child !== target) {
      return;
    }
    child = null;
    startPromise = null;
    externalScanPromises.clear();
    resumeSpecs.clear();
    rejectPending(error);
  }

  function terminateChild(target: ChildProcess, error: Error): void {
    disposeChild(target, error);
    try {
      target.kill("SIGTERM");
    } catch {
      // Ignore a worker that already exited.
    }
  }

  function handleMessage(message: UsageScanWorkerResponse): void {
    if (!message || typeof message !== "object" || !("type" in message)) {
      return;
    }
    if (message.type === "changed") {
      for (const listener of listeners) {
        listener(message.vendor);
      }
      return;
    }
    const request = pending.get(message.requestId);
    if (!request) {
      return;
    }
    pending.delete(message.requestId);
    if (request.timeout) clearTimeout(request.timeout);
    if (message.type === "error") {
      const error = new Error(message.message) as UsageScanWorkerError;
      error.name = "UsageScanWorkerError";
      if (message.stack) {
        error.workerStack = message.stack;
      }
      if (message.context) {
        error.workerContext = message.context;
      }
      request.reject(error);
      return;
    }
    request.resolve(message);
  }

  function sendRequest(
    target: ChildProcess,
    request: Extract<UsageScanWorkerRequest, { requestId: string }>,
    timeoutMs?: number
  ): Promise<UsageScanWorkerResponse> {
    return new Promise((resolvePromise, rejectPromise) => {
      const timeout =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              if (!pending.delete(request.requestId)) return;
              const error = new Error(
                `agent metadata scan worker timed out after ${timeoutMs}ms`
              );
              error.name =
                request.type === "external-sessions-scan"
                  ? "ExternalSessionScanTimeoutError"
                  : "AgentMetadataScanTimeoutError";
              rejectPromise(error);
              terminateChild(target, error);
            }, timeoutMs);
      pending.set(request.requestId, {
        resolve: resolvePromise,
        reject: rejectPromise,
        ...(timeout === undefined ? {} : { timeout })
      });
      try {
        target.send(request, (error) => {
          if (!error) {
            return;
          }
          const pendingRequest = pending.get(request.requestId);
          if (!pendingRequest) {
            return;
          }
          pending.delete(request.requestId);
          if (pendingRequest.timeout) clearTimeout(pendingRequest.timeout);
          pendingRequest.reject(error);
        });
      } catch (error) {
        pending.delete(request.requestId);
        if (timeout) clearTimeout(timeout);
        rejectPromise(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    });
  }

  function ensureWorker(): Promise<void> {
    if (closed) {
      return Promise.reject(new Error("usage scan worker is closed"));
    }
    if (child && !startPromise) {
      return Promise.resolve();
    }
    if (startPromise) {
      return startPromise;
    }

    const nextChild = forkWorker(launchOptions.entry, [], {
      cwd: launchOptions.cwd,
      execArgv: launchOptions.execArgv,
      env: process.env,
      stdio: ["ignore", "ignore", "inherit", "ipc"]
    });
    if (nextChild.pid) {
      try {
        setPriority(nextChild.pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        // Priority changes are best effort on restricted hosts.
      }
    }
    child = nextChild;
    nextChild.on("message", handleMessage);
    nextChild.once("error", (error) => {
      disposeChild(nextChild, error);
    });
    nextChild.once("exit", (code, signal) => {
      disposeChild(
        nextChild,
        new Error(
          `usage scan worker exited (code ${code ?? "null"}, signal ${signal ?? "none"})`
        )
      );
    });

    const requestId = randomUUID();
    startPromise = sendRequest(
      nextChild,
      {
        type: "init",
        requestId,
        config
      },
      requestTimeoutMs
    )
      .then((message) => {
        if (message.type !== "ready") {
          throw new Error(
            "usage scan worker returned an invalid init response"
          );
        }
        if (child === nextChild) {
          startPromise = null;
        }
      })
      .catch((error) => {
        terminateChild(
          nextChild,
          error instanceof Error ? error : new Error(String(error))
        );
        throw error;
      });
    return startPromise;
  }

  async function reconfigureWorker(
    agentSettings: AgentScopeSettings | undefined
  ): Promise<void> {
    await enqueueOperation(async () => {
      await ensureWorker();
      const target = child;
      if (!target) {
        throw new Error("agent metadata scan worker is unavailable");
      }
      try {
        const message = await sendRequest(
          target,
          {
            type: "reconfigure",
            requestId: randomUUID(),
            ...(agentSettings === undefined ? {} : { agentSettings })
          },
          requestTimeoutMs
        );
        if (message.type !== "ready") {
          throw new Error(
            "agent metadata scan worker returned an invalid reconfigure response"
          );
        }
      } catch (error) {
        const failure =
          error instanceof Error ? error : new Error(String(error));
        terminateChild(target, failure);
        throw failure;
      }
    });
  }

  function scanExternalSessions(
    purpose: ExternalSessionScanPurpose
  ): Promise<ExternalAgentSessionsSnapshot> {
    const generation = agentSettingsGeneration;
    const current = externalScanPromises.get(purpose);
    if (current?.generation === generation) return current.promise;
    const request = (async () => {
      await agentSettingsReady;
      if (generation !== agentSettingsGeneration) {
        return scanExternalSessions(purpose);
      }
      let message: UsageScanWorkerResponse | null;
      try {
        message = await enqueueOperation(async () => {
          if (generation !== agentSettingsGeneration) return null;
          await ensureWorker();
          if (generation !== agentSettingsGeneration) return null;
          const target = child;
          if (!target) {
            throw new Error("agent metadata scan worker is unavailable");
          }
          return await sendRequest(
            target,
            {
              type: "external-sessions-scan",
              requestId: randomUUID(),
              purpose
            },
            requestTimeoutMs
          );
        });
      } catch (error) {
        if (generation !== agentSettingsGeneration) {
          return scanExternalSessions(purpose);
        }
        throw error;
      }
      if (message === null || generation !== agentSettingsGeneration) {
        return scanExternalSessions(purpose);
      }
      if (
        message.type !== "external-sessions-scan-result" ||
        message.purpose !== purpose
      ) {
        throw new Error(
          "agent metadata scan worker returned an invalid external-session response"
        );
      }
      resumeSpecs.set(
        purpose,
        new Map(message.resumeSpecs.map((spec) => [spec.key, spec]))
      );
      return message.snapshot;
    })().finally(() => {
      if (externalScanPromises.get(purpose)?.promise === request) {
        externalScanPromises.delete(purpose);
      }
    });
    externalScanPromises.set(purpose, { generation, promise: request });
    return request;
  }

  async function scanUsage(scanOptions: {
    startOfDayMs: number;
    initial: boolean;
  }): Promise<UsageScanResult> {
    const generation = agentSettingsGeneration;
    await agentSettingsReady;
    if (generation !== agentSettingsGeneration) return scanUsage(scanOptions);
    let message: UsageScanWorkerResponse | null;
    try {
      message = await enqueueOperation(async () => {
        if (generation !== agentSettingsGeneration) return null;
        await ensureWorker();
        if (generation !== agentSettingsGeneration) return null;
        const target = child;
        if (!target) {
          throw new Error("usage scan worker is unavailable");
        }
        return await sendRequest(target, {
          type: "scan",
          requestId: randomUUID(),
          startOfDayMs: scanOptions.startOfDayMs,
          initial: scanOptions.initial
        });
      });
    } catch (error) {
      if (generation !== agentSettingsGeneration) return scanUsage(scanOptions);
      throw error;
    }
    if (message === null || generation !== agentSettingsGeneration) {
      return scanUsage(scanOptions);
    }
    if (message.type !== "scan-result") {
      throw new Error("usage scan worker returned an invalid scan response");
    }
    for (const failure of message.failures) {
      console.warn(
        `[usage] ${failure.vendor} scan failed; keeping other provider results:`,
        failure.message
      );
    }
    return {
      reads: message.reads,
      failures: message.failures
    };
  }

  const service: AgentMetadataScanService = {
    watch(onChange) {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    scan: scanUsage,
    markDirty(vendor, dirtyOptions) {
      void agentSettingsReady
        .then(() => ensureWorker())
        .then(() => {
          child?.send({
            type: "mark-dirty",
            vendor,
            ...(dirtyOptions ? { options: dirtyOptions } : {})
          } satisfies UsageScanWorkerRequest);
        })
        .catch(() => {
          // A later scan restarts the worker and performs a full initial read.
        });
    },
    updateAgentSettings(agentSettings) {
      const nextAgentSettings =
        agentSettings === undefined
          ? undefined
          : structuredClone(agentSettings);
      config = {
        ...config,
        ...(nextAgentSettings === undefined
          ? {}
          : { agentSettings: nextAgentSettings })
      };
      if (nextAgentSettings === undefined) delete config.agentSettings;
      agentSettingsGeneration += 1;
      externalScanPromises.clear();
      resumeSpecs.clear();
      if (closed) {
        return Promise.reject(new Error("usage scan worker is closed"));
      }
      if (!child && !startPromise) {
        agentSettingsReady = Promise.resolve();
        return agentSettingsReady;
      }
      const reconfigure = agentSettingsReady.then(() =>
        reconfigureWorker(nextAgentSettings)
      );
      agentSettingsReady = reconfigure.catch(() => undefined);
      return reconfigure;
    },
    externalSessions: {
      listExternalAgentSessions() {
        return scanExternalSessions("externalSessions");
      },
      listAgentHistorySessions() {
        return scanExternalSessions("history");
      },
      resolveExternalAgentSession(key, purpose) {
        if (purpose) return resumeSpecs.get(purpose)?.get(key) ?? null;
        return (
          resumeSpecs.get("externalSessions")?.get(key) ??
          resumeSpecs.get("history")?.get(key) ??
          null
        );
      },
      close() {
        service.close();
      }
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      listeners.clear();
      resumeSpecs.clear();
      externalScanPromises.clear();
      const target = child;
      child = null;
      startPromise = null;
      rejectPending(new Error("usage scan worker closed"));
      if (!target) {
        return;
      }
      try {
        target.send({ type: "shutdown" } satisfies UsageScanWorkerRequest);
      } catch {
        // Fall through to termination.
      }
      try {
        target.kill("SIGTERM");
      } catch {
        // Ignore a worker that already exited.
      }
    }
  };
  return Object.freeze(service);
}

function normalizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
}
