import { accessSync, constants, statSync } from "node:fs";
import { delimiter } from "node:path";

import type {
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
  SessionInventoryLimits,
  UsageAdapter
} from "@kmux/metadata";

import { createBuiltinAgentComposition } from "./composition";
import {
  resolveAgentResumePolicy,
  type ResolvedAgentLaunchPolicy
} from "./command";
import type {
  AgentSessionSourceProjection,
  AgentUsageSourceProjection,
  AgentUsageRuntimeOptions,
  AgentTerminalNotificationDecision
} from "./contracts";
import { resolveAgentPortablePath } from "./portablePath";
import {
  createMaterializedExternalSessionIndexer,
  materializeAgentSessionSources,
  type AgentSessionProjectionBinding,
  type MaterializedExternalSessionIndexer
} from "./externalSessionRuntime";
import { createAgentProcessMatcher } from "./processDetection";
import { normalizeAgentScopeSettings } from "./settings";

const composition = createBuiltinAgentComposition();
const commands = composition.commands();
const processMatchers = Object.freeze(
  composition.materialize("processDetection").map((binding) => ({
    agentId: binding.agentId,
    matches: createAgentProcessMatcher(binding.capability)
  }))
);

export function listBuiltinAgentDescriptors(): readonly AgentDescriptorDto[] {
  return composition.catalog.listDescriptors();
}

export function builtinAgentDescriptor(
  agentId: AgentId
): AgentDescriptorDto | undefined {
  return composition.catalog.descriptor(agentId);
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
