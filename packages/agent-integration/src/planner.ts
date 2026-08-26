import rawContract from "../contract.json";
import type { AgentId } from "@kmux/proto";

export type AgentIntegrationPlannerVendor = AgentId;

type JsonObject = Record<string, unknown>;

interface HookSpec {
  event: string;
  matcher?: string;
}

interface VendorContract {
  pathRoot?: {
    defaultHomeRelativePath: string;
    environmentVariable: string;
  };
  relativePath: string;
  document: {
    eventsPath: string[];
    version?: {
      field: string;
      value: number;
    };
  };
  entry: {
    commandField: "command" | "bash";
    wrapper?: {
      field: string;
      when: "always" | "matcher";
    };
  };
  marker: string;
  managed: HookSpec[];
  deprecated: string[];
  outputMode: "silent" | "json";
  fallback?: string;
  fallbackByEvent?: Record<string, string>;
}

export interface AgentIntegrationPlannerContract {
  contractVersion: number;
  commandTemplate: string;
  commandWrappers: Array<{
    agentId: AgentId;
    executable: string;
    homeEnvironmentVariable: string;
    defaultHomeRelativePath: string;
    integrationRelativePath: string;
    integrationContractMarker: string;
    integrationManagedMarker: string;
    legacyHooksFeature: string;
    currentHooksFeature: string;
    currentHooksFeatureMinor: number;
    notificationMethod: string;
  }>;
  vendors: Record<AgentIntegrationPlannerVendor, VendorContract>;
}

export interface AgentIntegrationSnapshot {
  vendor: AgentIntegrationPlannerVendor;
  path: string;
  state: "absent" | "present";
  sha256?: string;
  content?: string;
}

export interface AgentIntegrationPlan {
  vendor: AgentIntegrationPlannerVendor;
  path: string;
  contractVersion: number;
  changed: boolean;
  desiredContent: string;
  expected: { state: "absent" } | { state: "present"; sha256?: string };
}

export const AGENT_INTEGRATION_PLANNER_CONTRACT = Object.freeze(
  rawContract as AgentIntegrationPlannerContract
);

const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;
const textEncoder = new TextEncoder();

export function planAgentIntegrationSnapshot(
  snapshot: AgentIntegrationSnapshot
): AgentIntegrationPlan {
  requireSnapshot(snapshot);
  const existing =
    snapshot.state === "absent"
      ? {}
      : parseSettings(snapshot.vendor, snapshot.content ?? "");
  const desired = mergePlannedAgentIntegrationConfig(snapshot.vendor, existing);
  const changed = JSON.stringify(existing) !== JSON.stringify(desired);
  return {
    vendor: snapshot.vendor,
    path: snapshot.path,
    contractVersion: AGENT_INTEGRATION_PLANNER_CONTRACT.contractVersion,
    changed,
    desiredContent: `${JSON.stringify(desired, null, 2)}\n`,
    expected:
      snapshot.state === "absent"
        ? { state: "absent" }
        : {
            state: "present",
            ...(snapshot.sha256 === undefined
              ? {}
              : { sha256: snapshot.sha256 })
          }
  };
}

export function buildPlannedAgentHookCommand(
  vendor: AgentIntegrationPlannerVendor,
  event: string
): string {
  const definition = vendorDefinition(vendor);
  if (!definition) throw new TypeError(`unknown agent integration ${vendor}`);
  const fallback =
    definition.fallbackByEvent?.[event] ?? definition.fallback ?? "true";
  return AGENT_INTEGRATION_PLANNER_CONTRACT.commandTemplate
    .replace("{marker}", definition.marker)
    .replace("{outputMode}", definition.outputMode)
    .replace("{agent}", vendor)
    .replace("{event}", event)
    .replaceAll("{fallback}", fallback);
}

export function mergePlannedAgentIntegrationConfig(
  vendor: AgentIntegrationPlannerVendor,
  input: unknown
): JsonObject {
  if (!isPlainObject(input)) {
    throw new TypeError(`${vendor} agent integration config must be an object`);
  }
  const definition = vendorDefinition(vendor);
  if (!definition) throw new TypeError(`unknown agent integration ${vendor}`);
  return mergeDocumentHooks(vendor, definition, input);
}

function vendorDefinition(
  vendor: AgentIntegrationPlannerVendor
): VendorContract | undefined {
  return Object.hasOwn(AGENT_INTEGRATION_PLANNER_CONTRACT.vendors, vendor)
    ? AGENT_INTEGRATION_PLANNER_CONTRACT.vendors[vendor]
    : undefined;
}

function requireSnapshot(snapshot: AgentIntegrationSnapshot): void {
  if (
    !Object.hasOwn(
      AGENT_INTEGRATION_PLANNER_CONTRACT.vendors,
      snapshot.vendor
    ) ||
    typeof snapshot.path !== "string" ||
    !snapshot.path.startsWith("/") ||
    /\p{Cc}/u.test(snapshot.path) ||
    textEncoder.encode(snapshot.path).byteLength > 32 * 1024 ||
    (snapshot.state !== "absent" && snapshot.state !== "present")
  ) {
    throw new TypeError("agent integration snapshot is invalid");
  }
  if (snapshot.state === "absent") {
    if (snapshot.content !== undefined || snapshot.sha256 !== undefined) {
      throw new TypeError("absent agent integration snapshot has file data");
    }
    return;
  }
  if (
    typeof snapshot.content !== "string" ||
    textEncoder.encode(snapshot.content).byteLength > MAX_SETTINGS_BYTES ||
    (snapshot.sha256 !== undefined && !/^[a-f0-9]{64}$/u.test(snapshot.sha256))
  ) {
    throw new TypeError("present agent integration snapshot is invalid");
  }
}

function parseSettings(
  vendor: AgentIntegrationPlannerVendor,
  content: string
): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new TypeError(`${vendor} agent integration config is not valid JSON`);
  }
  if (!isPlainObject(parsed)) {
    throw new TypeError(`${vendor} agent integration config must be an object`);
  }
  return parsed;
}

function mergeDocumentHooks(
  vendor: AgentIntegrationPlannerVendor,
  definition: VendorContract,
  input: JsonObject
): JsonObject {
  const pruned = pruneManagedEntries(
    input,
    definition.marker,
    definition.entry.wrapper?.field
  );
  const next = isPlainObject(pruned) ? pruned : {};
  requireDocumentVersion(vendor, definition, next);
  const events = objectAtPath(vendor, next, definition.document.eventsPath);
  const eventsLabel = definition.document.eventsPath.join(".");
  for (const [event, entries] of Object.entries(events)) {
    if (Array.isArray(entries) && entries.length === 0) delete events[event];
  }
  for (const hook of definition.managed) {
    const existing = events[hook.event];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new TypeError(
        `${vendor} ${eventsLabel}.${hook.event} must be an array`
      );
    }
  }
  for (const hook of definition.managed) {
    const current = Array.isArray(events[hook.event])
      ? (events[hook.event] as unknown[])
      : [];
    events[hook.event] = [...current, managedEntry(vendor, definition, hook)];
  }
  return next;
}

function requireDocumentVersion(
  vendor: AgentIntegrationPlannerVendor,
  definition: VendorContract,
  root: JsonObject
): void {
  const version = definition.document.version;
  if (!version) return;
  const existing = root[version.field];
  if (existing !== undefined && existing !== version.value) {
    throw new TypeError(`${vendor} ${version.field} must be ${version.value}`);
  }
  root[version.field] = version.value;
}

function objectAtPath(
  vendor: AgentIntegrationPlannerVendor,
  root: JsonObject,
  path: readonly string[]
): JsonObject {
  let current = root;
  const traversed: string[] = [];
  for (const component of path) {
    traversed.push(component);
    const existing = current[component];
    if (existing !== undefined && !isPlainObject(existing)) {
      throw new TypeError(`${vendor} ${traversed.join(".")} must be an object`);
    }
    const next = isPlainObject(existing) ? existing : {};
    current[component] = next;
    current = next;
  }
  return current;
}

function managedEntry(
  vendor: AgentIntegrationPlannerVendor,
  definition: VendorContract,
  hook: HookSpec
): JsonObject {
  const command = {
    type: "command",
    [definition.entry.commandField]: buildPlannedAgentHookCommand(
      vendor,
      hook.event
    )
  };
  const wrapper = definition.entry.wrapper;
  const shouldWrap =
    wrapper && (wrapper.when === "always" || hook.matcher !== undefined);
  return shouldWrap
    ? {
        ...(hook.matcher ? { matcher: hook.matcher } : {}),
        [wrapper.field]: [command]
      }
    : { ...(hook.matcher ? { matcher: hook.matcher } : {}), ...command };
}

function pruneManagedEntries(
  value: unknown,
  marker: string,
  wrapperField?: string
): unknown {
  if (Array.isArray(value)) {
    return value
      .map((item) => pruneManagedEntries(item, marker, wrapperField))
      .filter((item) => item !== undefined);
  }
  if (!isPlainObject(value)) return value;
  if (
    ["command", "bash", "powershell"].some(
      (field) =>
        typeof value[field] === "string" && value[field].includes(marker)
    )
  ) {
    return undefined;
  }
  const next: JsonObject = {};
  for (const [key, nested] of Object.entries(value)) {
    const pruned = pruneManagedEntries(nested, marker, wrapperField);
    if (pruned !== undefined) next[key] = pruned;
  }
  if (
    wrapperField &&
    Array.isArray(value[wrapperField]) &&
    Array.isArray(next[wrapperField]) &&
    next[wrapperField].length === 0
  ) {
    return undefined;
  }
  return next;
}

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
