import type {
  SessionInventoryCandidate,
  AgentMetadataTextReadRequest
} from "@kmux/metadata";

import type {
  AgentExternalSessionProjectionInput,
  AgentExternalSessionRecordProjection
} from "../contracts";

const MAX_JSONL_SCAN_BYTES = 256 * 1024;
const MAX_CACHE_ENTRIES = 512;

export interface JsonlEdges {
  readonly prefix: string;
  readonly suffix: string;
  readonly records: readonly unknown[];
}

export function createExternalSessionProjectionCache() {
  const entries = new Map<
    string,
    {
      signature: string;
      record: AgentExternalSessionRecordProjection | null;
    }
  >();
  return Object.freeze({
    get(candidate: SessionInventoryCandidate) {
      const cached = entries.get(candidate.path);
      if (!cached || cached.signature !== signature(candidate))
        return undefined;
      entries.delete(candidate.path);
      entries.set(candidate.path, cached);
      return cached.record;
    },
    set(
      candidate: SessionInventoryCandidate,
      record: AgentExternalSessionRecordProjection | null
    ) {
      entries.delete(candidate.path);
      entries.set(candidate.path, { signature: signature(candidate), record });
      while (entries.size > MAX_CACHE_ENTRIES) {
        const oldest = entries.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    }
  });
}

export async function readJsonlEdges(
  input: AgentExternalSessionProjectionInput,
  candidate: SessionInventoryCandidate
): Promise<JsonlEdges> {
  try {
    const prefix = await input.readText(
      readRequest(candidate.path, 0, MAX_JSONL_SCAN_BYTES)
    );
    const suffixOffset = Math.max(0, candidate.size - MAX_JSONL_SCAN_BYTES);
    const suffix = await input.readText(
      readRequest(candidate.path, suffixOffset, MAX_JSONL_SCAN_BYTES)
    );
    return {
      prefix,
      suffix,
      records: parseJsonlLines(
        prefix === suffix ? prefix : `${prefix}\n${suffix}`
      )
    };
  } catch {
    return { prefix: "", suffix: "", records: [] };
  }
}

export function projectionCandidates(
  input: AgentExternalSessionProjectionInput,
  predicate: (candidate: SessionInventoryCandidate) => boolean,
  multiplier = 4
): { candidates: SessionInventoryCandidate[]; truncated: boolean } {
  const candidates = input.inventory.candidates
    .filter(predicate)
    .sort(
      (left, right) =>
        right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path)
    );
  const maximum = input.maxRecords * multiplier;
  const truncated = input.inventory.truncated || candidates.length > maximum;
  return { candidates: candidates.slice(0, maximum), truncated };
}

export function dedupeProjectedRecords(
  records: readonly AgentExternalSessionRecordProjection[]
): AgentExternalSessionRecordProjection[] {
  const latest = new Map<string, AgentExternalSessionRecordProjection>();
  for (const record of records) {
    const previous = latest.get(record.sessionId);
    if (!previous || record.updatedAtMs > previous.updatedAtMs) {
      latest.set(record.sessionId, record);
    }
  }
  return [...latest.values()].sort(
    (left, right) =>
      right.updatedAtMs - left.updatedAtMs ||
      left.sessionId.localeCompare(right.sessionId)
  );
}

function readRequest(
  path: string,
  offset: number,
  maxBytes: number
): AgentMetadataTextReadRequest {
  return { path, offset, maxBytes };
}

function parseJsonlLines(contents: string): unknown[] {
  return contents.split(/\r?\n/u).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    try {
      return [JSON.parse(trimmed) as unknown];
    } catch {
      return [];
    }
  });
}

function signature(candidate: SessionInventoryCandidate): string {
  return `${candidate.mtimeMs}:${candidate.size}`;
}
