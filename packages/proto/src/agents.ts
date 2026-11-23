export type AgentId = string;
export type MetadataSourceRoleId = string;

export const AGENT_ID_MAX_BYTES = 64;
export const AGENT_DESCRIPTOR_MAX_COUNT = 128;
export const AGENT_DESCRIPTOR_MAX_ALIASES = 16;

export type AgentCapabilityKey =
  | "resume"
  | "hooks"
  | "sessions"
  | "usage"
  | "subscription"
  | "launchPreferences"
  | "orchestrationLaunch"
  | "terminalReadiness"
  | "skillPlacement"
  | "workspaceTrust"
  | "processDetection"
  | "terminalNotifications";

export type AgentSkillPlacementScope = "global" | "workspace";

export const AGENT_CAPABILITY_KEYS = Object.freeze([
  "resume",
  "hooks",
  "sessions",
  "usage",
  "subscription",
  "launchPreferences",
  "orchestrationLaunch",
  "terminalReadiness",
  "skillPlacement",
  "workspaceTrust",
  "processDetection",
  "terminalNotifications"
] satisfies readonly AgentCapabilityKey[]);

export interface AgentPresentationDto {
  shortLabel?: string;
}

export interface AgentDescriptorDto {
  id: AgentId;
  displayName: string;
  aliases: string[];
  capabilities: AgentCapabilityKey[];
  launchPreferences?: {
    model: "opaque-provider-id";
    efforts: string[];
    effortRequiresModel: true;
  };
  skillPlacement?: {
    scopes: AgentSkillPlacementScope[];
  };
  presentation?: AgentPresentationDto;
}

/** Metadata from an installed CLI's model picker, without starting a turn. */
export interface AgentModelOptionDto {
  id: string;
  displayName: string;
  efforts: string[];
  defaultEffort?: string;
  effortRequired?: boolean;
  variants?: Array<{ model: string; effort: string }>;
}

export function decodeAgentModelOptions(value: unknown): AgentModelOptionDto[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new TypeError("agent model catalog is invalid");
  }
  const models = value.map((entry): AgentModelOptionDto => {
    if (!isRecord(entry)) throw new TypeError("agent model must be an object");
    requireExactKeys(entry, [
      "id",
      "displayName",
      "efforts",
      "defaultEffort",
      "effortRequired",
      "variants"
    ]);
    if (!Array.isArray(entry.efforts) || entry.efforts.length > 32) {
      throw new TypeError("agent model efforts are invalid");
    }
    const efforts = entry.efforts.map((effort) =>
      boundedText(effort, 64, "model effort")
    );
    if (new Set(efforts).size !== efforts.length)
      throw new TypeError("duplicate model efforts");
    const defaultEffort =
      entry.defaultEffort === undefined
        ? undefined
        : boundedText(entry.defaultEffort, 64, "default effort");
    if (defaultEffort !== undefined && !efforts.includes(defaultEffort))
      throw new TypeError("default effort must be supported");
    if (
      entry.effortRequired !== undefined &&
      typeof entry.effortRequired !== "boolean"
    )
      throw new TypeError("invalid effort requirement");
    if (entry.effortRequired === true && defaultEffort === undefined)
      throw new TypeError("required effort needs a default");
    let variants: AgentModelOptionDto["variants"];
    if (entry.variants !== undefined) {
      if (!Array.isArray(entry.variants) || entry.variants.length > 32)
        throw new TypeError("invalid model variants");
      variants = entry.variants.map((value) => {
        if (!isRecord(value)) throw new TypeError("invalid model variant");
        requireExactKeys(value, ["model", "effort"]);
        const effort = boundedText(value.effort, 64, "variant effort");
        if (!efforts.includes(effort))
          throw new TypeError("variant effort must be supported");
        return {
          model: boundedText(value.model, 256, "variant model"),
          effort
        };
      });
      if (
        new Set(variants.map((variant) => variant.model)).size !==
        variants.length
      )
        throw new TypeError("duplicate model variants");
    }
    return {
      id: boundedText(entry.id, 256, "model id"),
      displayName: boundedText(entry.displayName, 256, "model name"),
      efforts,
      ...(defaultEffort === undefined ? {} : { defaultEffort }),
      ...(entry.effortRequired === undefined
        ? {}
        : { effortRequired: entry.effortRequired }),
      ...(variants === undefined ? {} : { variants })
    };
  });
  if (new Set(models.map((model) => model.id)).size !== models.length)
    throw new TypeError("duplicate model ids");
  return models;
}

const textEncoder = new TextEncoder();
const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
const SOURCE_ROLE_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/u;

export function isAgentId(value: unknown): value is AgentId {
  return (
    typeof value === "string" &&
    value !== "unknown" &&
    textEncoder.encode(value).byteLength <= AGENT_ID_MAX_BYTES &&
    AGENT_ID_PATTERN.test(value)
  );
}

export function decodeAgentId(value: unknown): AgentId {
  if (!isAgentId(value)) {
    throw new TypeError("agent id is invalid");
  }
  return value;
}

export function normalizeAgentIdInput(value: string): string {
  return value.trim().toLowerCase();
}

export function decodeMetadataSourceRoleId(
  value: unknown
): MetadataSourceRoleId {
  if (
    typeof value !== "string" ||
    textEncoder.encode(value).byteLength > 128 ||
    !SOURCE_ROLE_PATTERN.test(value)
  ) {
    throw new TypeError("metadata source role id is invalid");
  }
  return value;
}

export function decodeAgentDescriptorDto(value: unknown): AgentDescriptorDto {
  if (!isRecord(value)) {
    throw new TypeError("agent descriptor must be an object");
  }
  requireExactKeys(value, [
    "id",
    "displayName",
    "aliases",
    "capabilities",
    "launchPreferences",
    "skillPlacement",
    "presentation"
  ]);
  const displayName = boundedText(value.displayName, 128, "display name");
  if (
    !Array.isArray(value.aliases) ||
    value.aliases.length > AGENT_DESCRIPTOR_MAX_ALIASES
  ) {
    throw new TypeError("agent aliases are invalid");
  }
  const aliases = value.aliases.map((alias) => decodeAgentId(alias));
  if (!Array.isArray(value.capabilities)) {
    throw new TypeError("agent capabilities are invalid");
  }
  const capabilities = value.capabilities.map((capability) => {
    if (!AGENT_CAPABILITY_KEYS.includes(capability as AgentCapabilityKey)) {
      throw new TypeError("agent capability is invalid");
    }
    return capability as AgentCapabilityKey;
  });
  if (new Set(capabilities).size !== capabilities.length) {
    throw new TypeError("agent capabilities contain duplicates");
  }
  const declaresLaunchPreferences = capabilities.includes("launchPreferences");
  if (declaresLaunchPreferences !== (value.launchPreferences !== undefined)) {
    throw new TypeError(
      "agent launch preference capability and metadata must be declared together"
    );
  }
  const declaresSkillPlacement = capabilities.includes("skillPlacement");
  if (declaresSkillPlacement !== (value.skillPlacement !== undefined)) {
    throw new TypeError(
      "agent skill placement capability and metadata must be declared together"
    );
  }
  return {
    id: decodeAgentId(value.id),
    displayName,
    aliases,
    capabilities,
    ...(value.launchPreferences === undefined
      ? {}
      : {
          launchPreferences: decodeLaunchPreferences(value.launchPreferences)
        }),
    ...(value.skillPlacement === undefined
      ? {}
      : { skillPlacement: decodeSkillPlacement(value.skillPlacement) }),
    ...(value.presentation === undefined
      ? {}
      : { presentation: decodePresentation(value.presentation) })
  };
}

function decodeSkillPlacement(
  value: unknown
): NonNullable<AgentDescriptorDto["skillPlacement"]> {
  if (!isRecord(value)) {
    throw new TypeError("agent skill placement must be an object");
  }
  requireExactKeys(value, ["scopes"]);
  if (!Array.isArray(value.scopes) || value.scopes.length === 0) {
    throw new TypeError("agent skill placement scopes are invalid");
  }
  const scopes = value.scopes.map((scope) => {
    if (scope !== "global" && scope !== "workspace") {
      throw new TypeError("agent skill placement scope is invalid");
    }
    return scope;
  });
  if (new Set(scopes).size !== scopes.length) {
    throw new TypeError("agent skill placement scopes contain duplicates");
  }
  return { scopes };
}

function decodeLaunchPreferences(
  value: unknown
): NonNullable<AgentDescriptorDto["launchPreferences"]> {
  if (!isRecord(value)) {
    throw new TypeError("agent launch preferences must be an object");
  }
  requireExactKeys(value, ["model", "efforts", "effortRequiresModel"]);
  if (
    value.model !== "opaque-provider-id" ||
    value.effortRequiresModel !== true ||
    !Array.isArray(value.efforts) ||
    value.efforts.length > 32
  ) {
    throw new TypeError("agent launch preferences are invalid");
  }
  const efforts = value.efforts.map((effort) =>
    boundedText(effort, 64, "launch effort")
  );
  if (new Set(efforts).size !== efforts.length) {
    throw new TypeError("agent launch efforts contain duplicates");
  }
  return {
    model: "opaque-provider-id",
    efforts,
    effortRequiresModel: true
  };
}

export function decodeAgentDescriptorCatalogDto(
  value: unknown
): AgentDescriptorDto[] {
  if (!Array.isArray(value) || value.length > AGENT_DESCRIPTOR_MAX_COUNT) {
    throw new TypeError("agent descriptor catalog is invalid");
  }
  const descriptors = value.map(decodeAgentDescriptorDto);
  if (new Set(descriptors.map(({ id }) => id)).size !== descriptors.length) {
    throw new TypeError("agent descriptor catalog contains duplicate ids");
  }
  return descriptors;
}

function decodePresentation(value: unknown): AgentPresentationDto {
  if (!isRecord(value)) {
    throw new TypeError("agent presentation must be an object");
  }
  requireExactKeys(value, ["shortLabel"]);
  const shortLabel =
    value.shortLabel === undefined
      ? undefined
      : boundedText(value.shortLabel, 32, "presentation short label");
  return {
    ...(shortLabel === undefined ? {} : { shortLabel })
  };
}

function boundedText(value: unknown, maxBytes: number, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    /\p{Cc}/u.test(value) ||
    textEncoder.encode(value).byteLength > maxBytes
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new TypeError("agent descriptor contains an unknown field");
  }
}
