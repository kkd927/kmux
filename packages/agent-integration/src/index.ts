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
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  AGENT_INTEGRATION_PLANNER_CONTRACT,
  buildPlannedAgentHookCommand,
  mergePlannedAgentIntegrationConfig,
  planAgentIntegrationSnapshot,
  type AgentIntegrationPlannerContract,
  type AgentIntegrationPlannerVendor
} from "./planner";

export {
  AGENT_INTEGRATION_PLANNER_CONTRACT,
  buildPlannedAgentHookCommand,
  mergePlannedAgentIntegrationConfig,
  planAgentIntegrationSnapshot
} from "./planner";
export type {
  AgentIntegrationPlan,
  AgentIntegrationPlannerContract,
  AgentIntegrationPlannerVendor,
  AgentIntegrationSnapshot
} from "./planner";

export type AgentIntegrationVendor = AgentIntegrationPlannerVendor;

type JsonObject = Record<string, unknown>;

export type AgentIntegrationContract = AgentIntegrationPlannerContract;

export type AgentIntegrationPaths = Record<AgentIntegrationVendor, string>;

export interface AgentIntegrationVendorResult {
  vendor: AgentIntegrationVendor;
  path: string;
  status: "changed" | "current" | "degraded";
  contractVersion: number;
  warning?: string;
}

export interface EnsureAgentIntegrationsOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  paths?: Partial<AgentIntegrationPaths>;
}

export const AGENT_INTEGRATION_CONTRACT = AGENT_INTEGRATION_PLANNER_CONTRACT;

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

export function defaultAgentIntegrationPaths(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env
): AgentIntegrationPaths {
  return Object.fromEntries(
    Object.entries(AGENT_INTEGRATION_CONTRACT.vendors).map(
      ([agentId, definition]) => [
        agentId,
        join(
          integrationPathRoot(homeDir, env, definition.pathRoot),
          definition.relativePath
        )
      ]
    )
  );
}

export function buildAgentHookCommand(
  vendor: AgentIntegrationVendor,
  event: string
): string {
  return buildPlannedAgentHookCommand(vendor, event);
}

export function mergeAgentIntegrationConfig(
  vendor: AgentIntegrationVendor,
  input: unknown
): JsonObject {
  return mergePlannedAgentIntegrationConfig(vendor, input);
}

export function ensureAgentIntegrations(
  options: EnsureAgentIntegrationsOptions
): AgentIntegrationVendorResult[] {
  const homeDir = options.homeDir?.trim();
  const defaults = homeDir
    ? defaultAgentIntegrationPaths(homeDir, options.env)
    : undefined;
  return Object.keys(AGENT_INTEGRATION_CONTRACT.vendors).map((vendor) => {
    const configuredPath =
      options.paths && Object.hasOwn(options.paths, vendor)
        ? options.paths[vendor]
        : undefined;
    const defaultPath =
      defaults && Object.hasOwn(defaults, vendor)
        ? defaults[vendor]
        : undefined;
    const path = configuredPath ?? defaultPath ?? "";
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

function integrationPathRoot(
  homeDir: string,
  env: NodeJS.ProcessEnv,
  root:
    | {
        defaultHomeRelativePath: string;
        environmentVariable: string;
      }
    | undefined
): string {
  if (!root) return homeDir;
  const override = env[root.environmentVariable]?.trim();
  return override && isAbsolute(override)
    ? resolve(override)
    : join(homeDir, root.defaultHomeRelativePath);
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
      const plan = planAgentIntegrationSnapshot({
        vendor,
        path,
        state: fileDescriptor === undefined ? "absent" : "present",
        ...(fileDescriptor === undefined
          ? {}
          : { content: JSON.stringify(existing) })
      });
      if (!plan.changed) {
        return current(vendor, path);
      }
      if (existingMode !== undefined && (existingMode & 0o200) === 0) {
        return degraded(vendor, path, `${path} is not user-writable`);
      }
      atomicWrite(path, plan.desiredContent);
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
