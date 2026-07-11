import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as osConstants, setPriority } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AgentStorageRoots,
  UsageAdapterDirtyOptions,
  UsageAdapterReadResult,
  UsageHistoryDay,
  UsageVendor
} from "@kmux/metadata";

import type {
  UsageScanWorkerConfig,
  UsageScanWorkerRequest,
  UsageScanWorkerResponse
} from "./usageScanProtocol";

export interface UsageScanResult {
  reads: UsageAdapterReadResult[];
  historyDays?: UsageHistoryDay[];
}

export interface UsageScanService {
  watch(onChange: (vendor: UsageVendor) => void): () => void;
  scan(options: {
    startOfDayMs: number;
    initial: boolean;
    historyRange?: { fromMs: number; toMs: number };
  }): Promise<UsageScanResult>;
  markDirty(
    vendor: Exclude<UsageVendor, "unknown">,
    options?: UsageAdapterDirtyOptions
  ): void;
  close(): void;
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
}

export interface UsageScanWorkerError extends Error {
  workerStack?: string;
  workerContext?: string;
}

interface CreateUsageScanWorkerClientOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  agentStorageRoots?: AgentStorageRoots;
  platform?: NodeJS.Platform;
  currentDir?: string;
  nodeEnv?: string;
  resourcesPath?: string;
  forkWorker?: ForkWorker;
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
  options: CreateUsageScanWorkerClientOptions = {}
): UsageScanService {
  const currentDir =
    options.currentDir ?? dirname(fileURLToPath(import.meta.url));
  const launchOptions = resolveUsageScanWorkerLaunchOptions(
    currentDir,
    options.nodeEnv,
    options.resourcesPath
  );
  const config: UsageScanWorkerConfig = {
    env: normalizeEnv(options.env ?? process.env),
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.agentStorageRoots
      ? { agentStorageRoots: options.agentStorageRoots }
      : {}),
    platform: options.platform ?? process.platform
  };
  const forkWorker = options.forkWorker ?? fork;
  const listeners = new Set<(vendor: UsageVendor) => void>();
  const pending = new Map<string, PendingRequest>();
  let child: ChildProcess | null = null;
  let startPromise: Promise<void> | null = null;
  let closed = false;

  function rejectPending(error: Error): void {
    for (const request of pending.values()) {
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
    rejectPending(error);
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
    request: Extract<UsageScanWorkerRequest, { requestId: string }>
  ): Promise<UsageScanWorkerResponse> {
    return new Promise((resolvePromise, rejectPromise) => {
      pending.set(request.requestId, {
        resolve: resolvePromise,
        reject: rejectPromise
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
          pendingRequest.reject(error);
        });
      } catch (error) {
        pending.delete(request.requestId);
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
    startPromise = sendRequest(nextChild, {
      type: "init",
      requestId,
      config
    })
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
        disposeChild(
          nextChild,
          error instanceof Error ? error : new Error(String(error))
        );
        try {
          nextChild.kill("SIGTERM");
        } catch {
          // Ignore a worker that already exited.
        }
        throw error;
      });
    return startPromise;
  }

  return {
    watch(onChange) {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    async scan(scanOptions) {
      await ensureWorker();
      const target = child;
      if (!target) {
        throw new Error("usage scan worker is unavailable");
      }
      const requestId = randomUUID();
      const message = await sendRequest(target, {
        type: "scan",
        requestId,
        startOfDayMs: scanOptions.startOfDayMs,
        initial: scanOptions.initial,
        ...(scanOptions.historyRange
          ? { historyRange: scanOptions.historyRange }
          : {})
      });
      if (message.type !== "scan-result") {
        throw new Error("usage scan worker returned an invalid scan response");
      }
      return {
        reads: message.reads,
        ...(message.historyDays ? { historyDays: message.historyDays } : {})
      };
    },
    markDirty(vendor, dirtyOptions) {
      void ensureWorker()
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
    close() {
      if (closed) {
        return;
      }
      closed = true;
      listeners.clear();
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
}

function normalizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
}
