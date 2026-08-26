import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  watch,
  type FSWatcher
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import type { AgentId } from "@kmux/proto";

import { METADATA_SOURCE_CONTRACT } from "./core/sourceContract";
import { createMetadataSourceCoordinator } from "./sourceCoordinator";
import {
  collectSessionInventory,
  normalizeSessionInventoryRoots,
  type SessionInventory,
  type SessionInventoryLimits
} from "./sessionInventory";

const INVENTORY_RESYNC_MS = 60_000;
const INVENTORY_WATCH_DEBOUNCE_MS = 180;
const MAX_SHARED_READ_BYTES = 256 * 1024;

export interface AgentMetadataTextReadRequest {
  path: string;
  offset: number;
  maxBytes: number;
}

export interface AgentMetadataQueryRequest {
  path: string;
  queryPlanId: string;
  maxRows: number;
}

export interface AgentMetadataQueryRow {
  index: number;
  stepType: number;
  payloadBase64: string;
}

export interface AgentMetadataQueryResult {
  queryPlanId: string;
  rows: AgentMetadataQueryRow[];
}

export interface AgentMetadataLocalQueryPlan {
  execute(path: string, maxRows: number): readonly AgentMetadataQueryRow[];
}

type AgentMetadataReadRequest =
  | ({ kind: "text" } & AgentMetadataTextReadRequest)
  | ({ kind: "query" } & AgentMetadataQueryRequest);

type AgentMetadataReadResult =
  | { kind: "text"; text: string }
  | { kind: "query"; result: AgentMetadataQueryResult };

export interface AgentMetadataTopologyLease {
  inventory(): Promise<SessionInventory>;
  readText(request: AgentMetadataTextReadRequest): Promise<string>;
  query(request: AgentMetadataQueryRequest): Promise<AgentMetadataQueryResult>;
  watch(onChange: (sourcePath?: string) => void): () => void;
  invalidate(): void;
  release(): Promise<void>;
}

export interface AgentMetadataInventoryService {
  acquire(
    agentId: AgentId,
    roots: readonly string[],
    limits?: Partial<SessionInventoryLimits>
  ): AgentMetadataTopologyLease;
  invalidate(agentId?: AgentId): void;
  close(): Promise<void>;
}

export function createLocalMetadataInventoryService(options: {
  targetAuthority?: string;
  principal: string;
  platform?: NodeJS.Platform;
  sourceDefinitionRevisions: Readonly<Record<AgentId, string>>;
  queryPlans?: Readonly<Record<string, AgentMetadataLocalQueryPlan>>;
}): AgentMetadataInventoryService {
  const coordinator = createMetadataSourceCoordinator<
    SessionInventory,
    AgentMetadataReadResult
  >();
  const activeLeases = new Set<{
    agentId: AgentId;
    invalidate(): void;
    release(): Promise<void>;
  }>();
  let closed = false;

  const acquire = (
    agentId: AgentId,
    roots: readonly string[],
    limits: Partial<SessionInventoryLimits> = {}
  ): AgentMetadataTopologyLease => {
    if (closed) {
      throw new Error("local metadata inventory is closed");
    }
    const normalizedRoots = Object.freeze(
      normalizeSessionInventoryRoots(roots)
    );
    const normalizedLimits = normalizeInventoryLimits(limits);
    const rootSettingsRevision = JSON.stringify({
      roots: normalizedRoots,
      limits: normalizedLimits
    });
    const projectionLease = coordinator.acquire(
      {
        targetAuthority: options.targetAuthority ?? "local",
        principal: options.principal,
        agentId,
        sourceDefinitionRevision:
          (Object.hasOwn(options.sourceDefinitionRevisions, agentId)
            ? options.sourceDefinitionRevisions[agentId]
            : undefined) ?? "unregistered",
        rootSettingsRevision
      },
      () =>
        createInventoryResource(
          normalizedRoots,
          normalizedLimits,
          options.platform ?? process.platform,
          options.queryPlans ?? {}
        )
    );
    const watchCleanups = new Set<() => void>();
    let released = false;
    let releasePromise: Promise<void> | undefined;
    const requireOpen = () => {
      if (released || closed) {
        throw new Error("local metadata topology lease is closed");
      }
    };
    const record = {
      agentId,
      invalidate() {
        void projectionLease
          .then((lease) => lease.invalidate())
          .catch(() => undefined);
      },
      async release() {
        if (releasePromise) return releasePromise;
        released = true;
        for (const cleanup of watchCleanups) cleanup();
        watchCleanups.clear();
        releasePromise = projectionLease
          .then(
            (lease) => lease.release(),
            () => undefined
          )
          .finally(() => activeLeases.delete(record));
        return releasePromise;
      }
    };
    activeLeases.add(record);
    return Object.freeze({
      async inventory(): Promise<SessionInventory> {
        requireOpen();
        return (await projectionLease).inventory();
      },
      async readText(request: AgentMetadataTextReadRequest): Promise<string> {
        requireOpen();
        validateTextReadRequest(request);
        const result = await (
          await projectionLease
        ).read(JSON.stringify({ kind: "text", ...request }));
        if (result.kind !== "text") {
          throw new TypeError("local metadata read returned the wrong result");
        }
        return result.text;
      },
      async query(
        request: AgentMetadataQueryRequest
      ): Promise<AgentMetadataQueryResult> {
        requireOpen();
        validateQueryRequest(request);
        const result = await (
          await projectionLease
        ).read(JSON.stringify({ kind: "query", ...request }));
        if (result.kind !== "query") {
          throw new TypeError("local metadata query returned the wrong result");
        }
        return {
          queryPlanId: result.result.queryPlanId,
          rows: result.result.rows.map((row) => ({ ...row }))
        };
      },
      watch(onChange: (sourcePath?: string) => void): () => void {
        requireOpen();
        let active = true;
        let stop: (() => void) | undefined;
        const cleanup = () => {
          if (!active) return;
          active = false;
          stop?.();
          watchCleanups.delete(cleanup);
        };
        watchCleanups.add(cleanup);
        void projectionLease
          .then((lease) => {
            if (!active || released) return;
            stop = lease.watch((sourcePath) => onChange(sourcePath));
          })
          .catch(() => undefined);
        return cleanup;
      },
      invalidate(): void {
        requireOpen();
        record.invalidate();
      },
      release: () => record.release()
    });
  };

  const service: AgentMetadataInventoryService = {
    acquire,
    invalidate(agentId) {
      for (const lease of activeLeases) {
        if (agentId && lease.agentId !== agentId) continue;
        lease.invalidate();
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([...activeLeases].map((lease) => lease.release()));
      await coordinator.close();
    }
  };
  return Object.freeze(service);
}

function normalizeInventoryLimits(
  limits: Partial<SessionInventoryLimits>
): Partial<SessionInventoryLimits> {
  return Object.freeze({
    ...(limits.maxDepth === undefined ? {} : { maxDepth: limits.maxDepth }),
    ...(limits.maxDirectories === undefined
      ? {}
      : { maxDirectories: limits.maxDirectories }),
    ...(limits.maxEntries === undefined
      ? {}
      : { maxEntries: limits.maxEntries })
  });
}

function createInventoryResource(
  roots: readonly string[],
  limits: Partial<SessionInventoryLimits>,
  platform: NodeJS.Platform,
  queryPlans: Readonly<Record<string, AgentMetadataLocalQueryPlan>>
) {
  const watchers = new Set<FSWatcher>();
  let resyncTimer: ReturnType<typeof setInterval> | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  const changedPaths = new Set<string>();
  let hasUnknownChange = false;
  let notifyChange: ((sourcePath?: string) => void) | undefined;

  const flushChanges = () => {
    debounceTimer = undefined;
    const sourcePath =
      !hasUnknownChange && changedPaths.size === 1
        ? changedPaths.values().next().value
        : undefined;
    changedPaths.clear();
    hasUnknownChange = false;
    notifyChange?.(sourcePath);
  };
  const scheduleChange = (
    watchRoot: string,
    filename: string | Buffer | null
  ) => {
    if (!filename) {
      hasUnknownChange = true;
    } else {
      changedPaths.add(
        canonicalMetadataSourcePath(resolve(watchRoot, filename.toString()))
      );
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushChanges, INVENTORY_WATCH_DEBOUNCE_MS);
  };

  return {
    async inventory(): Promise<SessionInventory> {
      return collectSessionInventory(roots, limits);
    },
    async read(sourceId: string): Promise<AgentMetadataReadResult> {
      const request = decodeReadRequest(sourceId);
      if (request.kind === "text") {
        return { kind: "text", text: readBoundedText(roots, request) };
      }
      const path = resolveAuthorizedMetadataFile(roots, request.path);
      const plan = Object.hasOwn(queryPlans, request.queryPlanId)
        ? queryPlans[request.queryPlanId]
        : undefined;
      if (!plan) {
        throw new TypeError("local metadata query plan is unsupported");
      }
      return {
        kind: "query",
        result: {
          queryPlanId: request.queryPlanId,
          rows: [...plan.execute(path, request.maxRows)]
        }
      };
    },
    watch(onChange: (sourcePath?: string) => void) {
      notifyChange = onChange;
      for (const root of roots) {
        const watchRoot = resolveExistingWatchRoot(root);
        if (!watchRoot) continue;
        try {
          const watcher = watch(
            watchRoot,
            { recursive: platform === "darwin" || platform === "win32" },
            (_eventType, filename) => scheduleChange(watchRoot, filename)
          );
          watcher.on("error", () => undefined);
          watchers.add(watcher);
        } catch {
          // The periodic resync below remains the bounded fallback.
        }
      }
      resyncTimer = setInterval(() => onChange(undefined), INVENTORY_RESYNC_MS);
      resyncTimer.unref?.();
      return () => {
        if (resyncTimer) clearInterval(resyncTimer);
        resyncTimer = undefined;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = undefined;
        changedPaths.clear();
        hasUnknownChange = false;
        notifyChange = undefined;
        for (const watcher of watchers) watcher.close();
        watchers.clear();
      };
    },
    close() {
      if (resyncTimer) clearInterval(resyncTimer);
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = undefined;
      changedPaths.clear();
      notifyChange = undefined;
      for (const watcher of watchers) watcher.close();
      watchers.clear();
    }
  };
}

function validateTextReadRequest(request: AgentMetadataTextReadRequest): void {
  if (
    !isAbsolute(request.path) ||
    !Number.isSafeInteger(request.offset) ||
    request.offset < 0 ||
    !Number.isSafeInteger(request.maxBytes) ||
    request.maxBytes < 1 ||
    request.maxBytes > MAX_SHARED_READ_BYTES
  ) {
    throw new TypeError("local metadata read is outside its hard bounds");
  }
}

function validateQueryRequest(request: AgentMetadataQueryRequest): void {
  if (
    !isAbsolute(request.path) ||
    !request.queryPlanId.trim() ||
    !Number.isSafeInteger(request.maxRows) ||
    request.maxRows < 1 ||
    request.maxRows > METADATA_SOURCE_CONTRACT.limits.queryRows
  ) {
    throw new TypeError("local metadata query is outside its hard bounds");
  }
}

function decodeReadRequest(sourceId: string): AgentMetadataReadRequest {
  const value = JSON.parse(sourceId) as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("local metadata read request is invalid");
  }
  if (value.kind === "text") {
    if (
      Object.keys(value).some(
        (key) =>
          key !== "kind" &&
          key !== "path" &&
          key !== "offset" &&
          key !== "maxBytes"
      )
    ) {
      throw new TypeError("local metadata read request is invalid");
    }
    const request: Extract<AgentMetadataReadRequest, { kind: "text" }> = {
      kind: "text" as const,
      path: value.path,
      offset: value.offset,
      maxBytes: value.maxBytes
    } as Extract<AgentMetadataReadRequest, { kind: "text" }>;
    validateTextReadRequest(request);
    return request;
  }
  if (value.kind === "query") {
    if (
      Object.keys(value).some(
        (key) =>
          key !== "kind" &&
          key !== "path" &&
          key !== "queryPlanId" &&
          key !== "maxRows"
      )
    ) {
      throw new TypeError("local metadata query request is invalid");
    }
    const request: Extract<AgentMetadataReadRequest, { kind: "query" }> = {
      kind: "query" as const,
      path: value.path,
      queryPlanId: value.queryPlanId,
      maxRows: value.maxRows
    } as Extract<AgentMetadataReadRequest, { kind: "query" }>;
    validateQueryRequest(request);
    return request;
  }
  throw new TypeError("local metadata read request is invalid");
}

function readBoundedText(
  roots: readonly string[],
  request: AgentMetadataTextReadRequest
): string {
  const canonicalPath = resolveAuthorizedMetadataFile(roots, request.path);
  const fd = openSync(
    canonicalPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  );
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) {
      throw new TypeError("opened metadata source is not a regular file");
    }
    const remaining = Math.max(0, Number(opened.size) - request.offset);
    const byteLength = Math.min(request.maxBytes, remaining);
    if (byteLength === 0) return "";
    const buffer = Buffer.allocUnsafe(byteLength);
    const bytesRead = readSync(fd, buffer, 0, byteLength, request.offset);
    return decodeBoundedUtf8(buffer.subarray(0, bytesRead));
  } finally {
    closeSync(fd);
  }
}

function decodeBoundedUtf8(bytes: Buffer): string {
  if (bytes.includes(0)) return decodeBoundedBinary(bytes);
  let start = 0;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  for (let trim = 0; trim <= 3 && start <= bytes.length - trim; trim += 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(start, bytes.length - trim)
      );
    } catch {
      // A bounded read may end in the middle of one UTF-8 code point.
    }
  }
  // Preserve one output byte per input byte for bounded binary scans so the
  // caller can advance its offset without skipping data.
  return decodeBoundedBinary(bytes);
}

function decodeBoundedBinary(bytes: Buffer): string {
  const sanitized = Buffer.allocUnsafe(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index]!;
    sanitized[index] =
      byte === 0x09 ||
      byte === 0x0a ||
      byte === 0x0d ||
      (byte >= 0x20 && byte < 0x7f)
        ? byte
        : 0x20;
  }
  return sanitized.toString("ascii");
}

function resolveAuthorizedMetadataFile(
  roots: readonly string[],
  sourcePath: string
): string {
  const pathStats = lstatSync(sourcePath);
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
    throw new TypeError("local metadata source must be a regular file");
  }
  const canonicalPath = realpathSync(sourcePath);
  const allowed = roots.some((root) => {
    try {
      const canonicalRoot = realpathSync(resolve(root));
      const relativePath = relative(canonicalRoot, canonicalPath);
      return (
        relativePath === "" ||
        (!relativePath.startsWith("..") && !isAbsolute(relativePath))
      );
    } catch {
      return false;
    }
  });
  if (!allowed) {
    throw new TypeError(
      "local metadata source is outside its authorized roots"
    );
  }
  return canonicalPath;
}

function canonicalMetadataSourcePath(sourcePath: string): string {
  try {
    return realpathSync.native(sourcePath);
  } catch {
    try {
      return resolve(
        realpathSync.native(dirname(sourcePath)),
        basename(sourcePath)
      );
    } catch {
      return resolve(sourcePath);
    }
  }
}

function resolveExistingWatchRoot(root: string): string | null {
  let candidate = root;
  const watchFloor = dirname(root);
  while (!existsSync(candidate)) {
    if (candidate === watchFloor) return null;
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
  return candidate;
}
