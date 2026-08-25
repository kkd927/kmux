import {
  AGENT_CAPABILITY_KEYS,
  decodeAgentId,
  type AgentCapabilityKey,
  type AgentDescriptorDto,
  type AgentId
} from "@kmux/proto";

import { createAgentCatalog } from "./catalog";
import type {
  AgentCapabilityBinding,
  AgentCapabilityFor,
  AgentCatalog,
  AgentCommandDefinition,
  AgentMetadataSourcesCapability,
  AgentModule,
  CapabilityResolver
} from "./contracts";
import { builtinAgentModules } from "./builtins";

export interface InternalAgentModuleRegistry {
  readonly catalog: AgentCatalog;
  resolver<K extends AgentCapabilityKey>(key: K): CapabilityResolver<K>;
  materialize<K extends AgentCapabilityKey>(
    key: K
  ): readonly AgentCapabilityBinding<K>[];
  commands(): ReadonlyMap<AgentId, AgentCommandDefinition>;
  definitionRevisions(): ReadonlyMap<AgentId, string>;
  metadataSourceRevisions(): ReadonlyMap<AgentId, string>;
  metadataSources(): ReadonlyMap<AgentId, AgentMetadataSourcesCapability>;
}

export function createInternalAgentModuleRegistry(
  modules: readonly AgentModule[]
): InternalAgentModuleRegistry {
  validateModules(modules);
  const byId = new Map(modules.map((module) => [module.descriptor.id, module]));
  const descriptors = modules.map(toDescriptorDto);
  const catalog = createAgentCatalog(descriptors);
  return Object.freeze({
    catalog,
    resolver<K extends AgentCapabilityKey>(key: K): CapabilityResolver<K> {
      return Object.freeze({
        resolve(id: AgentId): AgentCapabilityFor<K> | undefined {
          return capabilityFor(byId.get(id), key);
        }
      });
    },
    materialize<K extends AgentCapabilityKey>(
      key: K
    ): readonly AgentCapabilityBinding<K>[] {
      return modules.flatMap((module) => {
        const capability = capabilityFor(module, key);
        return capability === undefined
          ? []
          : [{ agentId: module.descriptor.id, capability }];
      });
    },
    commands(): ReadonlyMap<AgentId, AgentCommandDefinition> {
      return new Map(
        modules.flatMap((module) =>
          module.command
            ? [[module.descriptor.id, module.command] as const]
            : []
        )
      );
    },
    definitionRevisions(): ReadonlyMap<AgentId, string> {
      return new Map(
        modules.map((module) => [
          module.descriptor.id,
          module.definitionRevision
        ])
      );
    },
    metadataSourceRevisions(): ReadonlyMap<AgentId, string> {
      return new Map(
        modules.flatMap((module) =>
          module.metadataSources
            ? [[module.descriptor.id, module.metadataSources.revision] as const]
            : []
        )
      );
    },
    metadataSources(): ReadonlyMap<AgentId, AgentMetadataSourcesCapability> {
      return new Map(
        modules.flatMap((module) =>
          module.metadataSources
            ? [[module.descriptor.id, module.metadataSources] as const]
            : []
        )
      );
    }
  });
}

export function createBuiltinAgentComposition(): InternalAgentModuleRegistry {
  return createInternalAgentModuleRegistry(builtinAgentModules);
}

export { builtinAgentModules } from "./builtins";
export { createPortableAgentManifest } from "./manifest";

function validateModules(modules: readonly AgentModule[]): void {
  const identities = new Map<
    AgentId,
    { owner: AgentId; kind: "id" | "alias" }
  >();
  for (const module of modules) {
    const id = decodeAgentId(module.descriptor.id);
    if (id === "ssh") {
      throw new TypeError("agent id ssh is reserved for the settings scope");
    }
    registerIdentity(identities, id, id, "id");
    if (!module.definitionRevision.trim()) {
      throw new TypeError(`agent ${id} has no definition revision`);
    }
    for (const alias of module.descriptor.aliases) {
      registerIdentity(identities, decodeAgentId(alias), id, "alias");
    }
    if (module.resume && !module.command) {
      throw new TypeError(`agent ${id} resume requires a command`);
    }
    if (module.commandWrapper && (!module.command || !module.hooks)) {
      throw new TypeError(
        `agent ${id} command wrapper requires command and hook definitions`
      );
    }
    if (module.commandWrapper)
      validateCommandWrapper(id, module.commandWrapper);
    validateHookDefinition(module);
    validateMetadataReferences(module);
  }
}

function validateHookDefinition(module: AgentModule): void {
  const hook = module.hooks?.portable;
  if (!hook) return;
  const token = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
  if (
    hook.managed.length > 64 ||
    hook.managed.some(({ event }) => !token.test(event)) ||
    hook.deprecated.length > 64 ||
    hook.deprecated.some((event) => !token.test(event))
  ) {
    throw new TypeError(
      `agent ${module.descriptor.id} has an invalid hook definition`
    );
  }
  const claim = hook.sessionClaim;
  if (
    claim &&
    (claim.startEvents.length < 1 ||
      claim.startEvents.length > 16 ||
      claim.sessionIdFields.length < 1 ||
      claim.sessionIdFields.length > 16 ||
      claim.startEvents.some(
        (event) =>
          !token.test(event) ||
          !hook.managed.some(
            (managed) =>
              managed.event.localeCompare(event, undefined, {
                sensitivity: "accent"
              }) === 0
          )
      ) ||
      claim.sessionIdFields.some((field) => !token.test(field)))
  ) {
    throw new TypeError(
      `agent ${module.descriptor.id} has an invalid hook session claim`
    );
  }
}

function validateCommandWrapper(
  agentId: AgentId,
  wrapper: NonNullable<AgentModule["commandWrapper"]>
): void {
  const safeToken = /^[A-Za-z0-9._-]{1,128}$/u;
  const safeRelativePath = /^[A-Za-z0-9._/-]{1,256}$/u;
  if (
    !/^[A-Z][A-Z0-9_]{0,63}$/u.test(wrapper.homeEnvironmentVariable) ||
    !safeRelativePath.test(wrapper.defaultHomeRelativePath) ||
    wrapper.defaultHomeRelativePath.startsWith("/") ||
    wrapper.defaultHomeRelativePath.split("/").includes("..") ||
    !safeRelativePath.test(wrapper.integrationRelativePath) ||
    wrapper.integrationRelativePath.startsWith("/") ||
    wrapper.integrationRelativePath.split("/").includes("..") ||
    !wrapper.integrationContractMarker.trim() ||
    !safeToken.test(wrapper.legacyHooksFeature) ||
    !safeToken.test(wrapper.currentHooksFeature) ||
    !Number.isSafeInteger(wrapper.currentHooksFeatureMinor) ||
    wrapper.currentHooksFeatureMinor < 0 ||
    wrapper.currentHooksFeatureMinor > 10_000 ||
    !safeToken.test(wrapper.notificationMethod)
  ) {
    throw new TypeError(`agent ${agentId} has an invalid command wrapper`);
  }
}

function registerIdentity(
  identities: Map<AgentId, { owner: AgentId; kind: "id" | "alias" }>,
  value: AgentId,
  owner: AgentId,
  kind: "id" | "alias"
): void {
  const collision = identities.get(value);
  if (collision) {
    throw new TypeError(
      `agent identity ${value} collides between ${collision.owner} ${collision.kind} and ${owner} ${kind}`
    );
  }
  identities.set(value, { owner, kind });
}

function validateMetadataReferences(module: AgentModule): void {
  const roles = module.metadataSources?.sources.map(({ role }) => role) ?? [];
  if (new Set(roles).size !== roles.length) {
    throw new TypeError(
      `agent ${module.descriptor.id} metadata sources contain duplicate roles`
    );
  }
  for (const [purpose, capability] of [
    ["externalSessions", module.externalSessions],
    ["history", module.history],
    ["usage", module.usage]
  ] as const) {
    if (!capability) continue;
    if (!module.metadataSources) {
      throw new TypeError(
        `agent ${module.descriptor.id} metadata capability has no metadata sources`
      );
    }
    if (
      !module.metadataSources.sources.some((source) =>
        source.purposes.includes(purpose)
      )
    ) {
      throw new TypeError(
        `agent ${module.descriptor.id} has no metadata source for ${purpose}`
      );
    }
    if (
      (purpose === "externalSessions" || purpose === "history") &&
      !capability.createMetadataProjection
    ) {
      throw new TypeError(
        `agent ${module.descriptor.id} metadata ${purpose} has no projection factory`
      );
    }
    if (purpose === "history" && !module.history?.createSourceProjection) {
      throw new TypeError(
        `agent ${module.descriptor.id} metadata history has no target-neutral source projection`
      );
    }
    if (purpose === "usage" && !module.usage?.createSourceProjection) {
      throw new TypeError(
        `agent ${module.descriptor.id} metadata usage has no target-neutral source projection`
      );
    }
  }
}

function toDescriptorDto(module: AgentModule): AgentDescriptorDto {
  return {
    id: module.descriptor.id,
    displayName: module.descriptor.displayName,
    aliases: [...module.descriptor.aliases],
    capabilities: AGENT_CAPABILITY_KEYS.filter(
      (key) => capabilityFor(module, key) !== undefined
    ),
    ...(module.descriptor.presentation
      ? { presentation: { ...module.descriptor.presentation } }
      : {})
  };
}

function capabilityFor<K extends AgentCapabilityKey>(
  module: AgentModule | undefined,
  key: K
): AgentCapabilityFor<K> | undefined {
  return module?.[key] as AgentCapabilityFor<K> | undefined;
}
