import { makeId, type Id } from "@kmux/proto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";

import { durableAtomicReplace } from "./durableAtomicWrite";

const IDENTITY_VERSION = 1;
const MAX_IDENTITY_BYTES = 4 * 1024;

interface DesktopInstallationIdentityRecord {
  version: typeof IDENTITY_VERSION;
  desktopInstallationId: Id;
}

export interface LoadDesktopInstallationIdentityOptions {
  makeInstallationId?: () => Id;
  uid?: number;
}

/** Loads the one durable desktop identity, creating it before first use. */
export function loadOrCreateDesktopInstallationId(
  path: string,
  options: LoadDesktopInstallationIdentityOptions = {}
): Id {
  const existing = readIdentity(path, options.uid);
  if (existing) return existing.desktopInstallationId;

  const record: DesktopInstallationIdentityRecord = {
    version: IDENTITY_VERSION,
    desktopInstallationId: validateId(
      options.makeInstallationId?.() ?? makeId("desktop-installation")
    )
  };
  durableAtomicReplace(
    dirname(path),
    basename(path),
    new TextEncoder().encode(JSON.stringify(record)),
    { ...(options.uid === undefined ? {} : { uid: options.uid }) }
  );
  return requireIdentity(path, options.uid).desktopInstallationId;
}

function readIdentity(
  path: string,
  uid: number | undefined
): DesktopInstallationIdentityRecord | null {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("desktop installation identity must be a regular file");
  }
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error("desktop installation identity has the wrong owner");
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(
      "desktop installation identity has group or other permissions"
    );
  }
  if (stats.size > MAX_IDENTITY_BYTES) {
    throw new Error("desktop installation identity exceeds its size limit");
  }
  const bytes = readFileSync(path);
  if (bytes.byteLength > MAX_IDENTITY_BYTES) {
    throw new Error("desktop installation identity exceeds its size limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("desktop installation identity is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("desktop installation identity must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "desktopInstallationId" ||
    keys[1] !== "version" ||
    record.version !== IDENTITY_VERSION
  ) {
    throw new Error("desktop installation identity record is invalid");
  }
  return {
    version: IDENTITY_VERSION,
    desktopInstallationId: validateId(record.desktopInstallationId)
  };
}

function requireIdentity(
  path: string,
  uid: number | undefined
): DesktopInstallationIdentityRecord {
  const identity = readIdentity(path, uid);
  if (!identity) {
    throw new Error("desktop installation identity was not durably created");
  }
  return identity;
}

function validateId(value: unknown): Id {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 512 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error("desktop installation ID is invalid");
  }
  return value;
}
