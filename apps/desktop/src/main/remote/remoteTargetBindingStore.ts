import {
  validateRemoteTargetBinding,
  type RemoteTargetBinding
} from "@kmux/core";
import type { Id } from "@kmux/proto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";

import { durableAtomicReplace } from "./durableAtomicWrite";

const STORE_VERSION = 1;
const MAX_BINDINGS = 256;
const MAX_STORE_BYTES = 1024 * 1024;

interface RemoteTargetBindingEnvelope {
  version: typeof STORE_VERSION;
  bindings: RemoteTargetBinding[];
}

export interface RemoteTargetBindingStore {
  get(targetId: Id): RemoteTargetBinding | undefined;
  list(): RemoteTargetBinding[];
  replace(binding: RemoteTargetBinding): void;
  remove(targetId: Id): void;
}

/** Main-owned durable authority registry; locator changes never rewrite IDs. */
export function createRemoteTargetBindingStore(
  path: string
): RemoteTargetBindingStore {
  let bindings = new Map<Id, RemoteTargetBinding>(
    loadEnvelope(path).bindings.map((binding) => [binding.id, binding])
  );

  const persist = (next: Map<Id, RemoteTargetBinding>): void => {
    const envelope: RemoteTargetBindingEnvelope = {
      version: STORE_VERSION,
      bindings: [...next.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((binding) => structuredClone(binding))
    };
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));
    if (bytes.byteLength > MAX_STORE_BYTES) {
      throw new RangeError(
        "remote target binding store exceeds its size limit"
      );
    }
    durableAtomicReplace(dirname(path), basename(path), bytes);
    bindings = next;
  };

  return Object.freeze({
    get(targetId: Id): RemoteTargetBinding | undefined {
      const binding = bindings.get(targetId);
      return binding ? structuredClone(binding) : undefined;
    },

    list(): RemoteTargetBinding[] {
      return [...bindings.values()].map((binding) => structuredClone(binding));
    },

    replace(value: RemoteTargetBinding): void {
      const binding = validateRemoteTargetBinding(value);
      const existing = bindings.get(binding.id);
      if (existing && !sameAuthority(existing, binding)) {
        throw new Error(
          "remote target authority cannot be replaced under an existing target ID"
        );
      }
      const duplicateAuthority = [...bindings.values()].find(
        (candidate) =>
          candidate.id !== binding.id && sameAuthority(candidate, binding)
      );
      if (duplicateAuthority) {
        throw new Error(
          "remote target authority is already bound to another target ID"
        );
      }
      const next = new Map(bindings);
      next.set(binding.id, binding);
      if (next.size > MAX_BINDINGS) {
        throw new RangeError("remote target binding store is full");
      }
      persist(next);
    },

    remove(targetId: Id): void {
      if (!bindings.has(targetId)) return;
      const next = new Map(bindings);
      next.delete(targetId);
      persist(next);
    }
  });
}

function loadEnvelope(path: string): RemoteTargetBindingEnvelope {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { version: STORE_VERSION, bindings: [] };
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("remote target binding store must be a regular file");
  }
  if (
    (typeof process.getuid === "function" && stats.uid !== process.getuid()) ||
    (stats.mode & 0o077) !== 0
  ) {
    throw new Error("remote target binding store is not private");
  }
  if (stats.size > MAX_STORE_BYTES) {
    throw new RangeError("remote target binding store exceeds its size limit");
  }
  const bytes = readFileSync(path);
  if (bytes.byteLength > MAX_STORE_BYTES) {
    throw new RangeError("remote target binding store exceeds its size limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("remote target binding store is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("remote target binding store must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "bindings" ||
    keys[1] !== "version" ||
    record.version !== STORE_VERSION ||
    !Array.isArray(record.bindings) ||
    record.bindings.length > MAX_BINDINGS
  ) {
    throw new Error("remote target binding store record is invalid");
  }
  const parsed = record.bindings.map((binding) =>
    validateRemoteTargetBinding(binding)
  );
  if (new Set(parsed.map((binding) => binding.id)).size !== parsed.length) {
    throw new Error("remote target binding store contains duplicate targets");
  }
  return { version: STORE_VERSION, bindings: parsed };
}

function sameAuthority(
  left: RemoteTargetBinding,
  right: RemoteTargetBinding
): boolean {
  return (
    left.authority.remoteInstallationId ===
      right.authority.remoteInstallationId &&
    left.authority.executionNodeId === right.authority.executionNodeId &&
    left.authority.authenticatedPrincipal.uid ===
      right.authority.authenticatedPrincipal.uid &&
    left.authority.authenticatedPrincipal.accountName ===
      right.authority.authenticatedPrincipal.accountName
  );
}
