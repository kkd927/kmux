import { accessSync, constants, statSync } from "node:fs";
import { delimiter } from "node:path";

import type {
  AgentModelOptionDto,
  AgentDescriptorDto,
  AgentId,
  AgentScopeSettings,
  AgentSettings
} from "@kmux/proto";
import type {
  AgentMetadataLocalQueryPlan,
  AgentMetadataInventoryService,
  AgentStorageRoots,
  AiCliProcessMatcher,
  PricingVendorId,
  SessionInventoryDirectoryFilter,
  SessionInventoryLimits,
  UsageAdapter
} from "@kmux/metadata";

import { createBuiltinAgentComposition } from "./composition";
import {
  resolveAgentLaunchPolicy,
  resolveAgentResumePolicy,
  type ResolvedAgentLaunchPolicy
} from "./command";
import type {
  AgentLaunchPreferences,
  AgentSkillPlacementCapability,
  AgentWorkspaceTrustPreparation,
  AgentSessionSourceProjection,
  AgentUsageSourceProjection,
  AgentUsageRuntimeOptions,
  AgentTerminalNotificationDecision
} from "./contracts";
import { resolveAgentPortablePath } from "./portablePath";
import { readAgentSessionTranscript } from "./sessionTranscript";
import type { AgentSessionTranscriptReadResult } from "./contracts";
import {
  createMaterializedExternalSessionIndexer,
  materializeAgentSessionSources,
  type AgentSessionProjectionBinding,
  type MaterializedExternalSessionIndexer
} from "./externalSessionRuntime";
import { createAgentProcessMatcher } from "./processDetection";
import { normalizeAgentScopeSettings } from "./settings";
import { classifyAgentTerminalSnapshot } from "./terminalReadiness";
import type { AgentTerminalReadiness } from "./contracts";
export { createAgentModelCatalog } from "./modelCatalog";

const composition = createBuiltinAgentComposition();

export function classifyBuiltinAgentTerminalReadiness(input: {
  readonly agentId: string;
  readonly visible: string;
  readonly agentProcessDetected: boolean;
}): AgentTerminalReadiness {
  const agentId = resolveBuiltinAgentId(input.agentId);
  return classifyAgentTerminalSnapshot({
    ...input,
    capability: agentId
      ? composition.resolver("terminalReadiness").resolve(agentId)
      : undefined
  });
}
const commands = composition.commands();
const definitionRevisions = new Map(composition.definitionRevisions());
const processMatchers = Object.freeze(
  composition.materialize("processDetection").map((binding) => ({
    agentId: binding.agentId,
    matches: createAgentProcessMatcher(binding.capability)
  }))
);

export async function readBuiltinAgentSessionTranscript(options: {
  readonly agentId: string;
  readonly sessionId: string;
  readonly metadataInventory: AgentMetadataInventoryService;
  readonly homeDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly agentStorageRoots?: AgentStorageRoots;
  readonly agentSettings?: AgentScopeSettings;
  readonly dispatchMarker?: string;
  readonly maxBytes?: number;
}): Promise<AgentSessionTranscriptReadResult> {
  const agentId = resolveBuiltinAgentId(options.agentId);
  const sessions = agentId
    ? composition.resolver("sessions").resolve(agentId)
    : undefined;
  if (!agentId || !sessions?.transcript) {
    return {
      status: "unsupported",
      text: "",
      truncated: false,
      reason: "provider has no transcript reader"
    };
  }
  const source = materializeAgentSessionSources({
    bindings: [{ agentId, capability: sessions }],
    metadataSources: composition.metadataSources(),
    runtime: options
  })[0]!;
  return readAgentSessionTranscript({
    ...options,
    agentId,
    roots: source.roots,
    capability: sessions.transcript
  });
}

export function listBuiltinAgentDescriptors(): readonly AgentDescriptorDto[] {
  return composition.catalog.listDescriptors();
}

export async function listBuiltinAgentModels(options: {
  agentId: AgentId;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  settings?: AgentSettings;
}): Promise<readonly AgentModelOptionDto[]> {
  const capability = composition
    .resolver("launchPreferences")
    .resolve(options.agentId);
  const command = commands.get(options.agentId);
  if (!capability?.listModels || !command) return [];
  return capability.listModels({
    homeDir: options.homeDir,
    env: options.env,
    command: options.settings?.command ?? command.executable
  });
}

export function builtinAgentDescriptor(
  agentId: AgentId
): AgentDescriptorDto | undefined {
  return composition.catalog.descriptor(agentId);
}

export function resolveBuiltinAgentSkillPlacement(
  agentId: AgentId
): AgentSkillPlacementCapability | undefined {
  return composition.resolver("skillPlacement").resolve(agentId);
}

export function prepareBuiltinAgentWorkspaceTrust(options: {
  readonly agentId: AgentId;
  readonly cwd: string;
  readonly homeDir: string;
  readonly env?: NodeJS.ProcessEnv;
}): AgentWorkspaceTrustPreparation {
  const capability = composition
    .resolver("workspaceTrust")
    .resolve(options.agentId);
  return capability ? capability.prepare(options) : "not-required";
}

export function resolveBuiltinAgentId(input: string): AgentId | undefined {
  return composition.catalog.resolveOperationalIngress(input);
}

export function resolveBuiltinAgentResumePolicy(options: {
  agentId: AgentId;
  sessionId: string;
  settings?: AgentSettings;
  fork?: boolean;
}): ResolvedAgentLaunchPolicy | undefined {
  const command = commands.get(options.agentId);
  const resume = composition.resolver("resume").resolve(options.agentId);
  if (!command || !resume) return undefined;
  return resolveAgentResumePolicy({ ...options, command, resume });
}

export function resolveBuiltinAgentLaunchPolicy(options: {
  agentId: AgentId;
  settings?: AgentSettings;
  preferences?: AgentLaunchPreferences;
}): ResolvedAgentLaunchPolicy | undefined {
  const command = commands.get(options.agentId);
  if (!command) return undefined;
  const resolved = resolveAgentLaunchPolicy({
    ...options,
    command,
    defaultArgs: composition
      .resolver("orchestrationLaunch")
      .resolve(options.agentId)?.defaultArgs,
    ...(options.preferences
      ? {
          preferencesCapability: composition
            .resolver("launchPreferences")
            .resolve(options.agentId)
        }
      : {})
  });
  return {
    ...resolved,
    agentDescriptorRevision:
      definitionRevisions.get(options.agentId) ?? "unknown"
  };
}

export function resolvedAgentCommandIsAvailable(
  command: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return commandExists(command, env.PATH);
}

export function classifyBuiltinTerminalNotification(
  agentId: AgentId,
  title: string,
  message: string
): AgentTerminalNotificationDecision | undefined {
  return composition
    .resolver("terminalNotifications")
    .resolve(agentId)
    ?.classify(title, message);
}

export function listBuiltinProcessMatchers(): readonly AiCliProcessMatcher[] {
  return processMatchers;
}

export function resolveBuiltinDetectedProcessAgent(
  commandLine: string
): AgentId | undefined {
  return processMatchers.find(({ matches }) => matches(commandLine))?.agentId;
}

export function builtinAgentPricingVendor(
  agentId: AgentId
): PricingVendorId | undefined {
  return composition.resolver("usage").resolve(agentId)?.pricingVendorId;
}

export function listBuiltinLocalUsageAdapters(
  options: AgentUsageRuntimeOptions
): readonly UsageAdapter[] {
  return composition
    .materialize("usage")
    .flatMap(({ capability }) =>
      capability.createLocalAdapter
        ? [capability.createLocalAdapter(options)]
        : []
    );
}

export function createBuiltinLocalExternalSessionIndexer(options: {
  readonly homeDir: string;
  readonly metadataInventory: AgentMetadataInventoryService;
  readonly env?: NodeJS.ProcessEnv;
  readonly agentStorageRoots?: AgentStorageRoots;
  readonly agentSettings?: AgentScopeSettings;
  readonly antigravitySessionIndexPath?: string;
  readonly now?: () => Date;
  readonly maxFilesPerVendor?: number;
  readonly commandAvailability?: (command: string) => boolean;
  readonly scanLimits?: Partial<SessionInventoryLimits>;
}): MaterializedExternalSessionIndexer {
  const runtimeOptions = {
    homeDir: options.homeDir,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.agentStorageRoots === undefined
      ? {}
      : { agentStorageRoots: options.agentStorageRoots }),
    ...(options.agentSettings === undefined
      ? {}
      : { agentSettings: options.agentSettings }),
    ...(options.antigravitySessionIndexPath === undefined
      ? {}
      : { indexPath: options.antigravitySessionIndexPath })
  };
  const bindings: AgentSessionProjectionBinding[] = composition
    .materialize("sessions")
    .map(({ agentId, capability }) => ({ agentId, capability }));
  const sources = materializeAgentSessionSources({
    bindings,
    metadataSources: composition.metadataSources(),
    runtime: runtimeOptions
  });
  return createMaterializedExternalSessionIndexer({
    sources,
    metadataInventory: options.metadataInventory,
    catalog: composition.catalog,
    resolveResume: resolveBuiltinAgentResumePolicy,
    ...(options.agentSettings === undefined
      ? {}
      : { agentSettings: options.agentSettings }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.maxFilesPerVendor === undefined
      ? {}
      : { maxRecords: options.maxFilesPerVendor }),
    commandAvailability:
      options.commandAvailability ??
      ((command) =>
        resolvedAgentCommandIsAvailable(command, options.env ?? process.env)),
    ...(options.scanLimits === undefined
      ? {}
      : { scanLimits: options.scanLimits })
  });
}

export function createBuiltinRemoteHistoryProjections(): ReadonlyMap<
  AgentId,
  AgentSessionSourceProjection
> {
  return new Map(
    composition.materialize("sessions").flatMap(({ agentId, capability }) => {
      const projection = capability.createSourceProjection?.();
      return projection ? [[agentId, projection] as const] : [];
    })
  );
}

export function createBuiltinRemoteUsageProjections(): ReadonlyMap<
  AgentId,
  AgentUsageSourceProjection
> {
  return new Map(
    composition.materialize("usage").flatMap(({ agentId, capability }) => {
      const projection = capability.createSourceProjection?.();
      return projection ? [[agentId, projection] as const] : [];
    })
  );
}

export function builtinLocalAgentIntegrationPaths(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir: string;
  readonly agentStorageRoots: AgentStorageRoots;
}): Readonly<Record<AgentId, string>> {
  return Object.freeze(
    Object.fromEntries(
      composition.materialize("hooks").map(({ agentId, capability }) => [
        agentId,
        capability.resolveLocalConfigPath?.(options) ??
          resolveAgentPortablePath({
            env: options.env,
            homeDir: options.homeDir,
            pathRoot: capability.portable.pathRoot,
            relativePath: capability.portable.relativePath
          })
      ])
    )
  );
}

export function builtinAgentDefinitionRevisions(): Readonly<
  Record<AgentId, string>
> {
  return Object.freeze(Object.fromEntries(composition.definitionRevisions()));
}

export function builtinAgentMetadataSourceRevisions(): Readonly<
  Record<AgentId, string>
> {
  return Object.freeze(
    Object.fromEntries(composition.metadataSourceRevisions())
  );
}

export function builtinAgentMetadataQueryPlans(): Readonly<
  Record<string, AgentMetadataLocalQueryPlan>
> {
  return Object.freeze(
    Object.fromEntries(
      [...composition.metadataSources().values()].flatMap((capability) =>
        Object.entries(capability.localQueryPlans ?? {})
      )
    )
  );
}

export function builtinAgentMetadataDirectoryFilters(): Readonly<
  Record<AgentId, SessionInventoryDirectoryFilter>
> {
  return Object.freeze(
    Object.fromEntries(
      [...composition.metadataSources().entries()].flatMap(
        ([agentId, capability]) =>
          capability.shouldDescendDirectory
            ? [[agentId, capability.shouldDescendDirectory] as const]
            : []
      )
    )
  );
}

export function normalizeBuiltinAgentScopeSettings(
  value: Readonly<Record<string, AgentSettings>> | undefined
): ReadonlyMap<AgentId, AgentSettings> {
  return normalizeAgentScopeSettings({
    value,
    catalog: composition.catalog
  });
}

function commandExists(
  command: string,
  pathValue: string | undefined
): boolean {
  if (command.includes("/")) return executableFile(command);
  if (!pathValue) return false;
  return pathValue
    .split(delimiter)
    .filter(Boolean)
    .some((directory) => executableFile(`${directory}/${command}`));
}

function executableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
