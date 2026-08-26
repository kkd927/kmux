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
  | "processDetection"
  | "terminalNotifications";

export const AGENT_CAPABILITY_KEYS = Object.freeze([
  "resume",
  "hooks",
  "sessions",
  "usage",
  "subscription",
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
  presentation?: AgentPresentationDto;
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
  return {
    id: decodeAgentId(value.id),
    displayName,
    aliases,
    capabilities,
    ...(value.presentation === undefined
      ? {}
      : { presentation: decodePresentation(value.presentation) })
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
