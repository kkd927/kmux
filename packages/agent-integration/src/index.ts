import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import rawContract from "../contract.json";

export type AgentIntegrationVendor = "claude" | "codex" | "antigravity";

type JsonObject = Record<string, unknown>;

interface HookSpec {
  event: string;
  matcher?: string;
}

interface VendorContract {
  format: "grouped-hooks" | "namespaced-hooks";
  relativePath: string;
  namespace?: string;
  marker: string;
  managed: HookSpec[];
  deprecated: string[];
  outputMode: "silent" | "json";
  fallback?: string;
  fallbackByEvent?: Record<string, string>;
}

export interface AgentIntegrationContract {
  contractVersion: number;
  commandTemplate: string;
  codexWrapper: {
    contractMarker: string;
    legacyHooksFeature: string;
    currentHooksFeature: string;
    currentHooksFeatureMinor: number;
    notificationMethod: string;
  };
  vendors: Record<AgentIntegrationVendor, VendorContract>;
}

export interface AgentIntegrationPaths {
  claude: string;
  codex: string;
  antigravity: string;
}

export interface AgentIntegrationVendorResult {
  vendor: AgentIntegrationVendor;
  path: string;
  status: "changed" | "current" | "degraded";
  contractVersion: number;
  warning?: string;
}

export interface EnsureAgentIntegrationsOptions {
  homeDir?: string;
  paths?: Partial<AgentIntegrationPaths>;
}

export const AGENT_INTEGRATION_CONTRACT = Object.freeze(
  rawContract as AgentIntegrationContract
);

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

export function defaultAgentIntegrationPaths(
  homeDir: string
): AgentIntegrationPaths {
  return {
    claude: join(
      homeDir,
      AGENT_INTEGRATION_CONTRACT.vendors.claude.relativePath
    ),
    codex: join(homeDir, AGENT_INTEGRATION_CONTRACT.vendors.codex.relativePath),
    antigravity: join(
      homeDir,
      AGENT_INTEGRATION_CONTRACT.vendors.antigravity.relativePath
    )
  };
}

export function buildAgentHookCommand(
  vendor: AgentIntegrationVendor,
  event: string
): string {
  const definition = AGENT_INTEGRATION_CONTRACT.vendors[vendor];
  const fallback =
    definition.fallbackByEvent?.[event] ?? definition.fallback ?? "true";
  return AGENT_INTEGRATION_CONTRACT.commandTemplate
    .replace("{marker}", definition.marker)
    .replace("{outputMode}", definition.outputMode)
    .replace("{agent}", vendor)
    .replace("{event}", event)
    .replaceAll("{fallback}", fallback);
}

export function mergeAgentIntegrationConfig(
  vendor: AgentIntegrationVendor,
  input: unknown
): JsonObject {
  if (!isPlainObject(input)) {
    throw new TypeError(`${vendor} agent integration config must be an object`);
  }
  const definition = AGENT_INTEGRATION_CONTRACT.vendors[vendor];
  return definition.format === "namespaced-hooks"
    ? mergeNamespacedHooks(vendor, definition, input)
    : mergeGroupedHooks(vendor, definition, input);
}

export function ensureAgentIntegrations(
  options: EnsureAgentIntegrationsOptions
): AgentIntegrationVendorResult[] {
  const homeDir = options.homeDir?.trim();
  const defaults = homeDir ? defaultAgentIntegrationPaths(homeDir) : undefined;
  return (["claude", "codex", "antigravity"] as const).map((vendor) => {
    const path = options.paths?.[vendor] ?? defaults?.[vendor] ?? "";
    if (!path || !isAbsolute(path)) {
      return degraded(
        vendor,
        path,
        "HOME or an absolute settings path is required"
      );
    }
    return ensureVendorFile(vendor, path);
  });
}

export function ensureAgentIntegrationVendor(
  vendor: AgentIntegrationVendor,
  path: string
): AgentIntegrationVendorResult {
  if (!isAbsolute(path)) {
    return degraded(vendor, path, "an absolute settings path is required");
  }
  return ensureVendorFile(vendor, path);
}

function ensureVendorFile(
  vendor: AgentIntegrationVendor,
  path: string
): AgentIntegrationVendorResult {
  try {
    return withSettingsLock(path, () => {
      let existing: JsonObject = {};
      let existingMode: number | undefined;
      let fileDescriptor: number | undefined;
      try {
        fileDescriptor = openSync(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (fileDescriptor !== undefined) {
        const metadata = fstatSync(fileDescriptor);
        if (
          !metadata.isFile() ||
          metadata.size > 4 * 1024 * 1024 ||
          (process.getuid !== undefined && metadata.uid !== process.getuid())
        ) {
          closeSync(fileDescriptor);
          return degraded(
            vendor,
            path,
            `${path} is not a safe bounded regular file`
          );
        }
        existingMode = metadata.mode;
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(fileDescriptor, "utf8"));
        } catch {
          closeSync(fileDescriptor);
          return degraded(vendor, path, `${path} is not valid JSON`);
        }
        closeSync(fileDescriptor);
        if (!isPlainObject(parsed)) {
          return degraded(vendor, path, `${path} must contain a JSON object`);
        }
        existing = parsed;
      }
      const next = mergeAgentIntegrationConfig(vendor, existing);
      if (JSON.stringify(existing) === JSON.stringify(next)) {
        return current(vendor, path);
      }
      if (existingMode !== undefined && (existingMode & 0o200) === 0) {
        return degraded(vendor, path, `${path} is not user-writable`);
      }
      atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`);
      return changed(vendor, path);
    });
  } catch (error) {
    return degraded(
      vendor,
      path,
      error instanceof Error ? error.message : String(error)
    );
  }
}

function mergeGroupedHooks(
  vendor: AgentIntegrationVendor,
  definition: VendorContract,
  input: JsonObject
): JsonObject {
  if (input.hooks !== undefined && !isPlainObject(input.hooks)) {
    throw new TypeError(`${vendor} hooks must be an object`);
  }
  const existingHooks = isPlainObject(input.hooks) ? input.hooks : {};
  for (const hook of definition.managed) {
    const existing = existingHooks[hook.event];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new TypeError(`${vendor} hooks.${hook.event} must be an array`);
    }
  }
  const nextHooks: JsonObject = { ...existingHooks };
  for (const [event, groups] of Object.entries(existingHooks)) {
    const pruned = pruneManagedEntries(groups, definition.marker);
    if (Array.isArray(pruned) && pruned.length === 0) {
      delete nextHooks[event];
    } else {
      nextHooks[event] = pruned;
    }
  }
  for (const hook of definition.managed) {
    const currentGroups = Array.isArray(nextHooks[hook.event])
      ? (nextHooks[hook.event] as unknown[])
      : [];
    nextHooks[hook.event] = [
      ...currentGroups,
      {
        ...(hook.matcher ? { matcher: hook.matcher } : {}),
        hooks: [managedCommand(vendor, hook.event)]
      }
    ];
  }
  return { ...input, hooks: nextHooks };
}

function mergeNamespacedHooks(
  vendor: AgentIntegrationVendor,
  definition: VendorContract,
  input: JsonObject
): JsonObject {
  const namespace = definition.namespace;
  if (!namespace) throw new Error(`${vendor} namespace is missing`);
  if (input[namespace] !== undefined && !isPlainObject(input[namespace])) {
    throw new TypeError(`${vendor} ${namespace} must be an object`);
  }
  const existingNamespace = isPlainObject(input[namespace])
    ? input[namespace]
    : {};
  for (const hook of definition.managed) {
    const existing = existingNamespace[hook.event];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new TypeError(
        `${vendor} ${namespace}.${hook.event} must be an array`
      );
    }
  }
  const pruned = pruneManagedEntries(input, definition.marker);
  const next = isPlainObject(pruned) ? { ...pruned } : {};
  const managedNamespace = isPlainObject(next[namespace])
    ? { ...(next[namespace] as JsonObject) }
    : {};
  for (const hook of definition.managed) {
    const existing = Array.isArray(managedNamespace[hook.event])
      ? (managedNamespace[hook.event] as unknown[])
      : [];
    managedNamespace[hook.event] = [
      ...existing,
      ...(hook.matcher
        ? [
            {
              matcher: hook.matcher,
              hooks: [managedCommand(vendor, hook.event)]
            }
          ]
        : [managedCommand(vendor, hook.event)])
    ];
  }
  next[namespace] = managedNamespace;
  return next;
}

function managedCommand(
  vendor: AgentIntegrationVendor,
  event: string
): JsonObject {
  return { type: "command", command: buildAgentHookCommand(vendor, event) };
}

function pruneManagedEntries(value: unknown, marker: string): unknown {
  if (Array.isArray(value)) {
    return value
      .map((item) => pruneManagedEntries(item, marker))
      .filter((item) => item !== undefined);
  }
  if (!isPlainObject(value)) return value;
  if (typeof value.command === "string" && value.command.includes(marker)) {
    return undefined;
  }
  const next: JsonObject = {};
  for (const [key, nested] of Object.entries(value)) {
    const pruned = pruneManagedEntries(nested, marker);
    if (pruned !== undefined) next[key] = pruned;
  }
  if (
    Array.isArray(value.hooks) &&
    Array.isArray(next.hooks) &&
    next.hooks.length === 0
  ) {
    return undefined;
  }
  return next;
}

function withSettingsLock<T>(path: string, operation: () => T): T {
  const lockPath = `${path}.kmux-agent-integration.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out waiting for agent integration lock ${lockPath}`
        );
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return operation();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "EEXIST";
}

function changed(
  vendor: AgentIntegrationVendor,
  path: string
): AgentIntegrationVendorResult {
  return {
    vendor,
    path,
    status: "changed",
    contractVersion: AGENT_INTEGRATION_CONTRACT.contractVersion
  };
}

function current(
  vendor: AgentIntegrationVendor,
  path: string
): AgentIntegrationVendorResult {
  return {
    vendor,
    path,
    status: "current",
    contractVersion: AGENT_INTEGRATION_CONTRACT.contractVersion
  };
}

function degraded(
  vendor: AgentIntegrationVendor,
  path: string,
  warning: string
): AgentIntegrationVendorResult {
  return {
    vendor,
    path,
    status: "degraded",
    contractVersion: AGENT_INTEGRATION_CONTRACT.contractVersion,
    warning: `[agent-integration] ${vendor}: ${warning}`
  };
}
