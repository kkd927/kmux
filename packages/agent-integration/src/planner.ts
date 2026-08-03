import rawContract from "../contract.json";

export type AgentIntegrationPlannerVendor = "claude" | "codex" | "antigravity";

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

export interface AgentIntegrationPlannerContract {
  contractVersion: number;
  commandTemplate: string;
  codexWrapper: {
    contractMarker: string;
    legacyHooksFeature: string;
    currentHooksFeature: string;
    currentHooksFeatureMinor: number;
    notificationMethod: string;
  };
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
  const definition = AGENT_INTEGRATION_PLANNER_CONTRACT.vendors[vendor];
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
  const definition = AGENT_INTEGRATION_PLANNER_CONTRACT.vendors[vendor];
  return definition.format === "namespaced-hooks"
    ? mergeNamespacedHooks(vendor, definition, input)
    : mergeGroupedHooks(vendor, definition, input);
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

function mergeGroupedHooks(
  vendor: AgentIntegrationPlannerVendor,
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
    if (Array.isArray(pruned) && pruned.length === 0) delete nextHooks[event];
    else nextHooks[event] = pruned;
  }
  for (const hook of definition.managed) {
    const current = Array.isArray(nextHooks[hook.event])
      ? (nextHooks[hook.event] as unknown[])
      : [];
    nextHooks[hook.event] = [
      ...current,
      {
        ...(hook.matcher ? { matcher: hook.matcher } : {}),
        hooks: [managedCommand(vendor, hook.event)]
      }
    ];
  }
  return { ...input, hooks: nextHooks };
}

function mergeNamespacedHooks(
  vendor: AgentIntegrationPlannerVendor,
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
  vendor: AgentIntegrationPlannerVendor,
  event: string
): JsonObject {
  return {
    type: "command",
    command: buildPlannedAgentHookCommand(vendor, event)
  };
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

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
