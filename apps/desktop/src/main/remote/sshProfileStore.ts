import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, basename, dirname } from "node:path";

import {
  makeId,
  type Id,
  type SshProfileDraftDto,
  type SshProfileDto
} from "@kmux/proto";

import { durableAtomicReplace } from "./durableAtomicWrite";

const STORE_VERSION = 1;
const MAX_PROFILES = 128;
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_BYTES = 32 * 1024;
const MAX_ENVIRONMENT_ENTRIES = 128;

interface StoredProfileError {
  profileId: Id;
  at: string;
  message: string;
}

interface SshProfileEnvelope {
  version: typeof STORE_VERSION;
  profiles: SshProfileDto[];
  errors: StoredProfileError[];
}

export interface SshProfileStore {
  list(): SshProfileDto[];
  get(profileId: Id): SshProfileDto | undefined;
  save(profileId: Id | undefined, draft: SshProfileDraftDto): SshProfileDto;
  duplicate(profileId: Id): SshProfileDto;
  remove(profileId: Id): void;
  getError(profileId: Id): { at: string; message: string } | undefined;
  recordError(profileId: Id, error: Error): void;
  clearError(profileId: Id): void;
}

export function createSshProfileStore(
  path: string,
  options: { now?: () => string; makeProfileId?: () => Id } = {}
): SshProfileStore {
  const now = options.now ?? (() => new Date().toISOString());
  const makeProfileId =
    options.makeProfileId ?? (() => makeId("ssh-profile"));
  let envelope = loadEnvelope(path);

  const persist = (next: SshProfileEnvelope): void => {
    const canonical: SshProfileEnvelope = {
      version: STORE_VERSION,
      profiles: [...next.profiles]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((profile) => structuredClone(profile)),
      errors: [...next.errors]
        .sort((left, right) => left.profileId.localeCompare(right.profileId))
        .map((error) => structuredClone(error))
    };
    const bytes = new TextEncoder().encode(JSON.stringify(canonical));
    if (bytes.byteLength > MAX_STORE_BYTES) {
      throw new RangeError("SSH profile store exceeds its size limit");
    }
    durableAtomicReplace(dirname(path), basename(path), bytes);
    envelope = canonical;
  };

  return Object.freeze({
    list(): SshProfileDto[] {
      return envelope.profiles.map((profile) => structuredClone(profile));
    },

    get(profileId: Id): SshProfileDto | undefined {
      const profile = envelope.profiles.find((entry) => entry.id === profileId);
      return profile ? structuredClone(profile) : undefined;
    },

    save(
      profileId: Id | undefined,
      draft: SshProfileDraftDto
    ): SshProfileDto {
      const normalized = decodeSshProfileDraft(draft);
      const existing = profileId
        ? envelope.profiles.find((entry) => entry.id === profileId)
        : undefined;
      if (profileId !== undefined && !existing) {
        throw new Error("SSH profile does not exist");
      }
      const timestamp = requireIsoTimestamp(now(), "profile timestamp");
      const profile = decodeSshProfile({
        ...normalized,
        id: existing?.id ?? makeProfileId(),
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp
      });
      const profiles = existing
        ? envelope.profiles.map((entry) =>
            entry.id === existing.id ? profile : entry
          )
        : [...envelope.profiles, profile];
      if (profiles.length > MAX_PROFILES) {
        throw new RangeError("SSH profile store is full");
      }
      persist({
        ...envelope,
        profiles,
        errors: envelope.errors.filter(
          (entry) => entry.profileId !== profile.id
        )
      });
      return structuredClone(profile);
    },

    duplicate(profileId: Id): SshProfileDto {
      const source = envelope.profiles.find((entry) => entry.id === profileId);
      if (!source) throw new Error("SSH profile does not exist");
      const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...draft } =
        source;
      return this.save(undefined, {
        ...draft,
        name: boundedCopyName(source.name, envelope.profiles)
      });
    },

    remove(profileId: Id): void {
      if (!envelope.profiles.some((entry) => entry.id === profileId)) return;
      persist({
        ...envelope,
        profiles: envelope.profiles.filter((entry) => entry.id !== profileId),
        errors: envelope.errors.filter((entry) => entry.profileId !== profileId)
      });
    },

    getError(profileId: Id): { at: string; message: string } | undefined {
      const error = envelope.errors.find(
        (entry) => entry.profileId === profileId
      );
      return error ? { at: error.at, message: error.message } : undefined;
    },

    recordError(profileId: Id, error: Error): void {
      if (!envelope.profiles.some((entry) => entry.id === profileId)) {
        throw new Error("SSH profile does not exist");
      }
      const record: StoredProfileError = {
        profileId,
        at: requireIsoTimestamp(now(), "profile error timestamp"),
        message: requireText(error.message, "profile error", 4 * 1024)
      };
      persist({
        ...envelope,
        errors: [
          ...envelope.errors.filter((entry) => entry.profileId !== profileId),
          record
        ]
      });
    },

    clearError(profileId: Id): void {
      if (!envelope.errors.some((entry) => entry.profileId === profileId)) {
        return;
      }
      persist({
        ...envelope,
        errors: envelope.errors.filter((entry) => entry.profileId !== profileId)
      });
    }
  });
}

export function decodeSshProfileDraft(value: unknown): SshProfileDraftDto {
  const record = requireRecord(value, "SSH profile draft");
  assertExactKeys(record, [
    "name",
    "sshConfigHost",
    "host",
    "user",
    "port",
    "identityFile",
    "defaultRemoteCwd",
    "shellOverride",
    "bootstrapShellOverride",
    "installPathOverride",
    "authorityPathOverride",
    "statePathOverride",
    "runtimePathOverride",
    "sessionRetentionQuotaMiB",
    "targetRetentionQuotaMiB",
    "env",
    "forwardAgent"
  ]);
  const sshConfigHost = optionalText(record.sshConfigHost, "sshConfigHost", 512);
  const host = optionalText(record.host, "host", 512);
  if ((sshConfigHost === undefined) === (host === undefined)) {
    throw new TypeError(
      "SSH profile requires exactly one OpenSSH config alias or explicit host"
    );
  }
  const port = optionalInteger(record.port, "port", 1, 65_535);
  const identityFile = optionalLocalPath(record.identityFile, "identityFile");
  const defaultRemoteCwd = optionalRemotePath(
    record.defaultRemoteCwd,
    "defaultRemoteCwd"
  );
  const shellOverride = optionalRemotePath(
    record.shellOverride,
    "shellOverride"
  );
  const bootstrapShellOverride = optionalRemotePath(
    record.bootstrapShellOverride,
    "bootstrapShellOverride"
  );
  const installPathOverride = optionalRemotePath(
    record.installPathOverride,
    "installPathOverride"
  );
  const authorityPathOverride = optionalRemotePath(
    record.authorityPathOverride,
    "authorityPathOverride"
  );
  const statePathOverride = optionalRemotePath(
    record.statePathOverride,
    "statePathOverride"
  );
  const runtimePathOverride = optionalRemotePath(
    record.runtimePathOverride,
    "runtimePathOverride"
  );
  const sessionRetentionQuotaMiB = optionalInteger(
    record.sessionRetentionQuotaMiB,
    "sessionRetentionQuotaMiB",
    64,
    4 * 1024
  );
  const targetRetentionQuotaMiB = optionalInteger(
    record.targetRetentionQuotaMiB,
    "targetRetentionQuotaMiB",
    256,
    32 * 1024
  );
  if (
    sessionRetentionQuotaMiB !== undefined &&
    targetRetentionQuotaMiB !== undefined &&
    targetRetentionQuotaMiB < sessionRetentionQuotaMiB
  ) {
    throw new TypeError("target retention quota must cover one session quota");
  }
  const env = decodeEnvironment(record.env);
  if (record.forwardAgent !== undefined && typeof record.forwardAgent !== "boolean") {
    throw new TypeError("forwardAgent must be a boolean");
  }
  return {
    name: requireText(record.name, "name", 256),
    ...(sshConfigHost === undefined ? {} : { sshConfigHost }),
    ...(host === undefined ? {} : { host }),
    ...(optionalText(record.user, "user", 256) === undefined
      ? {}
      : { user: optionalText(record.user, "user", 256) }),
    ...(port === undefined ? {} : { port }),
    ...(identityFile === undefined ? {} : { identityFile }),
    ...(defaultRemoteCwd === undefined ? {} : { defaultRemoteCwd }),
    ...(shellOverride === undefined ? {} : { shellOverride }),
    ...(bootstrapShellOverride === undefined
      ? {}
      : { bootstrapShellOverride }),
    ...(installPathOverride === undefined ? {} : { installPathOverride }),
    ...(authorityPathOverride === undefined ? {} : { authorityPathOverride }),
    ...(statePathOverride === undefined ? {} : { statePathOverride }),
    ...(runtimePathOverride === undefined ? {} : { runtimePathOverride }),
    ...(sessionRetentionQuotaMiB === undefined
      ? {}
      : { sessionRetentionQuotaMiB }),
    ...(targetRetentionQuotaMiB === undefined
      ? {}
      : { targetRetentionQuotaMiB }),
    ...(env === undefined ? {} : { env }),
    ...(record.forwardAgent === undefined
      ? {}
      : { forwardAgent: record.forwardAgent })
  };
}

function decodeSshProfile(value: unknown): SshProfileDto {
  const record = requireRecord(value, "SSH profile");
  const { id, createdAt, updatedAt, ...draft } = record;
  return {
    ...decodeSshProfileDraft(draft),
    id: requireText(id, "profile id", 512),
    createdAt: requireIsoTimestamp(createdAt, "createdAt"),
    updatedAt: requireIsoTimestamp(updatedAt, "updatedAt")
  };
}

function loadEnvelope(path: string): SshProfileEnvelope {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: STORE_VERSION, profiles: [], errors: [] };
    }
    throw error;
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > MAX_STORE_BYTES ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid()) ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error("SSH profile store must be a bounded private regular file");
  }
  const bytes = readFileSync(path);
  if (bytes.byteLength > MAX_STORE_BYTES) {
    throw new RangeError("SSH profile store exceeds its size limit");
  }
  const value = JSON.parse(bytes.toString("utf8")) as unknown;
  const record = requireRecord(value, "SSH profile store");
  assertExactKeys(record, ["version", "profiles", "errors"]);
  if (
    record.version !== STORE_VERSION ||
    !Array.isArray(record.profiles) ||
    record.profiles.length > MAX_PROFILES ||
    !Array.isArray(record.errors) ||
    record.errors.length > MAX_PROFILES
  ) {
    throw new Error("SSH profile store envelope is invalid");
  }
  const profiles = record.profiles.map(decodeSshProfile);
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
    throw new Error("SSH profile store contains duplicate profile IDs");
  }
  const profileIds = new Set(profiles.map((profile) => profile.id));
  const errors = record.errors.map((entry) => decodeStoredError(entry, profileIds));
  if (new Set(errors.map((error) => error.profileId)).size !== errors.length) {
    throw new Error("SSH profile store contains duplicate errors");
  }
  return { version: STORE_VERSION, profiles, errors };
}

function decodeStoredError(
  value: unknown,
  profileIds: ReadonlySet<Id>
): StoredProfileError {
  const record = requireRecord(value, "SSH profile error");
  assertExactKeys(record, ["profileId", "at", "message"]);
  const profileId = requireText(record.profileId, "profileId", 512);
  if (!profileIds.has(profileId)) {
    throw new Error("SSH profile error references a missing profile");
  }
  return {
    profileId,
    at: requireIsoTimestamp(record.at, "profile error timestamp"),
    message: requireText(record.message, "profile error", 4 * 1024)
  };
}

function decodeEnvironment(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, "SSH profile environment");
  if (Object.keys(record).length > MAX_ENVIRONMENT_ENTRIES) {
    throw new RangeError("SSH profile environment has too many entries");
  }
  const output: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(record).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || key.length > 256) {
      throw new TypeError("SSH profile environment key is invalid");
    }
    output[key] = requireText(rawValue, `environment ${key}`, 16 * 1024, true);
  }
  return output;
}

function optionalText(
  value: unknown,
  name: string,
  maxBytes: number
): string | undefined {
  return value === undefined ? undefined : requireText(value, name, maxBytes);
}

function requireText(
  value: unknown,
  name: string,
  maxBytes = MAX_TEXT_BYTES,
  allowEmpty = false
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.trim().length === 0) ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new TypeError(`${name} must be bounded text`);
  }
  return value;
}

function optionalLocalPath(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  const path = requireText(value, name);
  if (!isAbsolute(path)) throw new TypeError(`${name} must be absolute`);
  return path;
}

function optionalRemotePath(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  const path = requireText(value, name);
  if (!path.startsWith("/")) throw new TypeError(`${name} must be absolute`);
  return path;
}

function optionalInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(`${name} is outside its supported range`);
  }
  return value as number;
}

function requireIsoTimestamp(value: unknown, name: string): string {
  const timestamp = requireText(value, name, 128);
  if (new Date(timestamp).toISOString() !== timestamp) {
    throw new TypeError(`${name} must be a canonical ISO timestamp`);
  }
  return timestamp;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[]
): void {
  const allow = new Set(allowed);
  const unexpected = Object.keys(record).find((key) => !allow.has(key));
  if (unexpected) {
    throw new TypeError(`SSH profile data contains unexpected field ${unexpected}`);
  }
}

function boundedCopyName(
  sourceName: string,
  profiles: readonly SshProfileDto[]
): string {
  const names = new Set(profiles.map((profile) => profile.name));
  for (let index = 1; index <= MAX_PROFILES; index += 1) {
    const suffix = index === 1 ? " copy" : ` copy ${index}`;
    const maximumSourceBytes = 256 - Buffer.byteLength(suffix, "utf8");
    let prefix = sourceName;
    while (Buffer.byteLength(prefix, "utf8") > maximumSourceBytes) {
      prefix = prefix.slice(0, -1);
    }
    const candidate = `${prefix}${suffix}`;
    if (!names.has(candidate)) return candidate;
  }
  throw new RangeError("SSH profile copy name space is exhausted");
}
