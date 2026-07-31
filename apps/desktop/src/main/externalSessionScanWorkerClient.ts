import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as osConstants, setPriority } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentStorageRoots } from "@kmux/metadata";
import type {
  AgentScopeSettings,
  ExternalAgentSessionsSnapshot
} from "@kmux/proto";

import type {
  ExternalSessionIndexer,
  ExternalSessionResumeSpec
} from "./externalSessions";
import type {
  ExternalSessionScanWorkerConfig,
  ExternalSessionScanWorkerRequest,
  ExternalSessionScanWorkerResponse
} from "./externalSessionScanProtocol";

const EXTERNAL_SESSION_SCAN_TIMEOUT_MS = 10_000;

export interface ExternalSessionScanWorkerLaunchOptions {
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
  resolve: (message: ExternalSessionScanWorkerResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface CreateExternalSessionScanWorkerClientOptions {
  homeDir: string;
  env?: NodeJS.ProcessEnv;
  agentStorageRoots?: AgentStorageRoots;
  agentSettings?: AgentScopeSettings;
  antigravitySessionIndexPath?: string;
  currentDir?: string;
  nodeEnv?: string;
  resourcesPath?: string;
  forkWorker?: ForkWorker;
  requestTimeoutMs?: number;
}

export function resolveExternalSessionScanWorkerLaunchOptions(
  currentDir: string,
  nodeEnv: string | undefined = process.env.NODE_ENV,
  resourcesPath: string | undefined = process.resourcesPath
): ExternalSessionScanWorkerLaunchOptions {
  const asarSegment = `${sep}app.asar${sep}`;
  if (currentDir.includes(asarSegment)) {
    const packagedResourcesPath =
      resourcesPath ?? resolve(currentDir, "../../../..");
    return {
      entry: join(currentDir, "externalSessionScanWorker.js"),
      cwd: join(packagedResourcesPath, "app.asar.unpacked"),
      execArgv: []
    };
  }

  const repoRoot = resolve(currentDir, "../../../..");
  if (nodeEnv === "production") {
    return {
      entry: resolve(currentDir, "externalSessionScanWorker.js"),
      cwd: repoRoot,
      execArgv: []
    };
  }

  return {
    entry: resolve(
      repoRoot,
      "apps/desktop/src/main/externalSessionScanWorker.ts"
    ),
    cwd: repoRoot,
    execArgv: ["--import", "tsx"]
  };
}

export function createExternalSessionScanWorkerClient(
  options: CreateExternalSessionScanWorkerClientOptions
): ExternalSessionIndexer {
  const currentDir =
    options.currentDir ?? dirname(fileURLToPath(import.meta.url));
  const launchOptions = resolveExternalSessionScanWorkerLaunchOptions(
    currentDir,
    options.nodeEnv,
    options.resourcesPath
  );
  const config: ExternalSessionScanWorkerConfig = {
    homeDir: options.homeDir,
    env: normalizeEnv(options.env ?? process.env),
    ...(options.agentStorageRoots
      ? { agentStorageRoots: options.agentStorageRoots }
      : {}),
    ...(options.agentSettings ? { agentSettings: options.agentSettings } : {}),
    ...(options.antigravitySessionIndexPath
      ? { antigravitySessionIndexPath: options.antigravitySessionIndexPath }
      : {})
  };
  const requestTimeoutMs =
    options.requestTimeoutMs ?? EXTERNAL_SESSION_SCAN_TIMEOUT_MS;
  const forkWorker = options.forkWorker ?? fork;
  const pending = new Map<string, PendingRequest>();
  const resumeSpecs = new Map<string, ExternalSessionResumeSpec>();
  let child: ChildProcess | null = null;
  let startPromise: Promise<void> | null = null;
  let scanPromise: Promise<ExternalAgentSessionsSnapshot> | null = null;
  let closed = false;

  function rejectPending(error: Error): void {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
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
    scanPromise = null;
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

  function handleMessage(message: ExternalSessionScanWorkerResponse): void {
    if (!message || typeof message !== "object" || !("requestId" in message)) {
      return;
    }
    const request = pending.get(message.requestId);
    if (!request) {
      return;
    }
    pending.delete(message.requestId);
    clearTimeout(request.timeout);
    if (message.type === "error") {
      const error = new Error(message.message);
      error.name = "ExternalSessionScanWorkerError";
      if (message.stack) {
        error.stack = message.stack;
      }
      request.reject(error);
      return;
    }
    request.resolve(message);
  }

  function sendRequest(
    target: ChildProcess,
    request: Extract<ExternalSessionScanWorkerRequest, { requestId: string }>
  ): Promise<ExternalSessionScanWorkerResponse> {
    return new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        if (!pending.delete(request.requestId)) {
          return;
        }
        const error = new Error(
          `external session scan worker timed out after ${requestTimeoutMs}ms`
        );
        error.name = "ExternalSessionScanTimeoutError";
        rejectPromise(error);
        terminateChild(target, error);
      }, requestTimeoutMs);
      pending.set(request.requestId, {
        resolve: resolvePromise,
        reject: rejectPromise,
        timeout
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
          clearTimeout(pendingRequest.timeout);
          pendingRequest.reject(error);
        });
      } catch (error) {
        pending.delete(request.requestId);
        clearTimeout(timeout);
        rejectPromise(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    });
  }

  function ensureWorker(): Promise<void> {
    if (closed) {
      return Promise.reject(
        new Error("external session scan worker is closed")
      );
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
          `external session scan worker exited (code ${code ?? "null"}, signal ${signal ?? "none"})`
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
            "external session scan worker returned an invalid init response"
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

  const indexer: ExternalSessionIndexer = {
    listExternalAgentSessions() {
      scanPromise ??= (async () => {
        await ensureWorker();
        const target = child;
        if (!target) {
          throw new Error("external session scan worker is unavailable");
        }
        const requestId = randomUUID();
        const message = await sendRequest(target, {
          type: "scan",
          requestId
        });
        if (message.type !== "scan-result") {
          throw new Error(
            "external session scan worker returned an invalid scan response"
          );
        }
        resumeSpecs.clear();
        for (const spec of message.resumeSpecs) {
          resumeSpecs.set(spec.key, spec);
        }
        return message.snapshot;
      })().finally(() => {
        scanPromise = null;
      });
      return scanPromise;
    },
    resolveExternalAgentSession(key) {
      return resumeSpecs.get(key) ?? null;
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      resumeSpecs.clear();
      const target = child;
      child = null;
      startPromise = null;
      scanPromise = null;
      rejectPending(new Error("external session scan worker closed"));
      if (!target) {
        return;
      }
      try {
        target.send({
          type: "shutdown"
        } satisfies ExternalSessionScanWorkerRequest);
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

  return Object.freeze(indexer);
}

function normalizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
}
