import type { MetadataVendor } from "./sourceContract";

const MAX_TITLE_LENGTH = 96;
const MAX_PREVIEW_LENGTH = 220;
const textEncoder = new TextEncoder();

export interface CoreHistoryClaim {
  sessionId: string;
  claimedAtUnixMs?: number;
  lastSeenAtUnixMs?: number;
  cwd?: string;
  workspacePaths?: string[];
  launchTitle?: string;
}

export interface CoreHistoryRecord {
  key: string;
  vendor: MetadataVendor;
  sessionId: string;
  title: string;
  recentConversation?: string;
  model?: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  updatedAtMs: number;
}

export class IncrementalCoreHistoryJsonlParser {
  private pending = "";
  private readonly prefix: unknown[] = [];
  private readonly suffix: unknown[] = [];
  private suffixStart = 0;
  private readonly maximumPendingBytes: number;
  truncated = false;

  constructor(
    private readonly maximumEdgeRecords = 512,
    options: { maximumPendingBytes?: number } = {}
  ) {
    if (!Number.isSafeInteger(maximumEdgeRecords) || maximumEdgeRecords < 1) {
      throw new TypeError("history parser edge bound is invalid");
    }
    this.maximumPendingBytes =
      options.maximumPendingBytes ?? Number.MAX_SAFE_INTEGER;
    if (
      !Number.isSafeInteger(this.maximumPendingBytes) ||
      this.maximumPendingBytes < 1
    ) {
      throw new TypeError("history parser pending byte bound is invalid");
    }
  }

  append(content: string, options: { eof?: boolean } = {}): void {
    const combined = this.pending + content;
    const lines = combined.split("\n");
    const trailingLine = lines.pop() ?? "";
    this.pending = "";
    if (trailingLine) {
      if (options.eof && isCompleteJsonValue(trailingLine)) {
        lines.push(trailingLine);
      } else {
        this.pending = trailingLine;
        if (
          textEncoder.encode(this.pending).byteLength > this.maximumPendingBytes
        ) {
          throw new RangeError("history JSONL record exceeds its byte bound");
        }
      }
    }
    for (const line of lines) {
      if (textEncoder.encode(line).byteLength > this.maximumPendingBytes) {
        throw new RangeError("history JSONL record exceeds its byte bound");
      }
      this.consume(line);
    }
  }

  records(): unknown[] {
    if (this.suffixStart === 0) {
      return [...this.prefix, ...this.suffix];
    }
    return [
      ...this.prefix,
      ...this.suffix.slice(this.suffixStart),
      ...this.suffix.slice(0, this.suffixStart)
    ];
  }

  reset(): void {
    this.pending = "";
    this.prefix.length = 0;
    this.suffix.length = 0;
    this.suffixStart = 0;
    this.truncated = false;
  }

  clone(): IncrementalCoreHistoryJsonlParser {
    const parser = new IncrementalCoreHistoryJsonlParser(
      this.maximumEdgeRecords,
      { maximumPendingBytes: this.maximumPendingBytes }
    );
    parser.pending = this.pending;
    parser.prefix.push(...this.prefix);
    parser.suffix.push(...this.suffix);
    parser.suffixStart = this.suffixStart;
    parser.truncated = this.truncated;
    return parser;
  }

  private consume(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let value: unknown;
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch {
      return;
    }
    if (this.prefix.length < this.maximumEdgeRecords) {
      this.prefix.push(value);
      return;
    }
    if (this.suffix.length < this.maximumEdgeRecords) {
      this.suffix.push(value);
      return;
    }
    this.suffix[this.suffixStart] = value;
    this.suffixStart = (this.suffixStart + 1) % this.maximumEdgeRecords;
    this.truncated = true;
  }
}

function isCompleteJsonValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

export function mergeCoreHistoryRecords(
  records: Iterable<CoreHistoryRecord>,
  options: { maxRecords: number; cutoffMs?: number }
): { records: CoreHistoryRecord[]; truncated: boolean } {
  const latest = new Map<string, CoreHistoryRecord>();
  for (const record of records) {
    if (
      options.cutoffMs !== undefined &&
      record.updatedAtMs < options.cutoffMs
    ) {
      continue;
    }
    const previous = latest.get(record.key);
    if (!previous) {
      latest.set(record.key, record);
      continue;
    }
    const newer =
      record.updatedAtMs >= previous.updatedAtMs ? record : previous;
    const older = newer === record ? previous : record;
    latest.set(record.key, {
      ...older,
      ...newer,
      cwd: newer.cwd ?? older.cwd,
      title: meaningfulCoreHistoryTitle(newer.title, newer.sessionId)
        ? newer.title
        : older.title,
      recentConversation: newer.recentConversation ?? older.recentConversation,
      model: newer.model ?? older.model,
      createdAt: earliestIsoTimestamp(previous.createdAt, record.createdAt),
      updatedAt: latestIsoTimestamp(previous.updatedAt, record.updatedAt),
      updatedAtMs: Math.max(previous.updatedAtMs, record.updatedAtMs)
    });
  }
  const sorted = [...latest.values()].sort(
    (left, right) =>
      right.updatedAtMs - left.updatedAtMs || left.key.localeCompare(right.key)
  );
  const truncated = sorted.length > options.maxRecords;
  sorted.length = Math.min(sorted.length, options.maxRecords);
  return { records: sorted, truncated };
}

export function fallbackCoreHistoryRecord(options: {
  vendor: MetadataVendor;
  claim: CoreHistoryClaim;
}): CoreHistoryRecord {
  return buildCoreHistoryRecord({
    vendor: options.vendor,
    sessionId: options.claim.sessionId,
    cwd: coreHistoryClaimCwd(options.claim),
    title: options.claim.launchTitle,
    updatedAtMs:
      options.claim.lastSeenAtUnixMs ?? options.claim.claimedAtUnixMs ?? 0
  });
}

export function applyCoreHistoryClaim(
  record: CoreHistoryRecord,
  claim: CoreHistoryClaim
): CoreHistoryRecord {
  const launchTitle = sanitizeCoreHistoryTitle(claim.launchTitle);
  return {
    ...record,
    cwd: coreHistoryClaimCwd(claim) ?? record.cwd,
    title:
      record.title === `${vendorLabel(record.vendor)} session` &&
      launchTitle &&
      meaningfulCoreHistoryTitle(launchTitle, record.sessionId)
        ? launchTitle
        : record.title,
    updatedAtMs: Math.max(
      record.updatedAtMs,
      claim.lastSeenAtUnixMs ?? claim.claimedAtUnixMs ?? 0
    )
  };
}

export function buildCoreHistoryRecord(input: {
  vendor: MetadataVendor;
  sessionId: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  title?: string;
  recentConversation?: string;
  model?: string;
  updatedAtMs: number;
}): CoreHistoryRecord {
  const parsedUpdatedAt = input.updatedAt
    ? Date.parse(input.updatedAt)
    : Number.NaN;
  const updatedAtMs = Number.isFinite(parsedUpdatedAt)
    ? Math.max(parsedUpdatedAt, input.updatedAtMs)
    : input.updatedAtMs;
  const title = sanitizeCoreHistoryTitle(input.title);
  return {
    key: `${input.vendor}:${input.sessionId}`,
    vendor: input.vendor,
    sessionId: input.sessionId,
    title:
      title && meaningfulCoreHistoryTitle(title, input.sessionId)
        ? title
        : `${vendorLabel(input.vendor)} session`,
    ...(sanitizeCoreHistoryPreview(input.recentConversation) === undefined
      ? {}
      : {
          recentConversation: sanitizeCoreHistoryPreview(
            input.recentConversation
          )
        }),
    ...(sanitizeModel(input.model) === undefined
      ? {}
      : { model: sanitizeModel(input.model) }),
    ...(sanitizeAbsolutePath(input.cwd) === undefined
      ? {}
      : { cwd: sanitizeAbsolutePath(input.cwd) }),
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    updatedAt: input.updatedAt ?? new Date(updatedAtMs).toISOString(),
    updatedAtMs
  };
}

export function extractCoreHistoryText(
  value: unknown,
  depth: number
): string | undefined {
  if (depth > 6) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) {
    const parts = value.flatMap((item) => {
      const part = extractCoreHistoryText(item, depth + 1);
      return part ? [part] : [];
    });
    return parts.length ? parts.join(" ") : undefined;
  }
  const object = asCoreHistoryObject(value);
  if (!object) return undefined;
  return extractCoreHistoryText(
    object.text ?? object.content ?? object.message ?? object.value,
    depth + 1
  );
}

export function pickNestedCoreHistoryString(
  value: unknown,
  keys: string[],
  depth: number
): string | undefined {
  if (depth > 6) return undefined;
  const object = asCoreHistoryObject(value);
  if (!object) return undefined;
  const direct = pickCoreHistoryString(object, keys);
  if (direct) return direct;
  for (const nested of Object.values(object)) {
    if (Array.isArray(nested)) {
      for (const item of nested.slice(0, 16)) {
        const found = pickNestedCoreHistoryString(item, keys, depth + 1);
        if (found) return found;
      }
    } else {
      const found = pickNestedCoreHistoryString(nested, keys, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

export function decodeCoreHistoryBase64(value: string): Uint8Array | undefined {
  if (
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(value) ||
    value.length > 2 * 1024 * 1024
  ) {
    return undefined;
  }
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

export function coreHistoryClaimCwd(
  claim: CoreHistoryClaim | undefined
): string | undefined {
  return (
    claim?.cwd ?? claim?.workspacePaths?.find((path) => path.startsWith("/"))
  );
}

export function sanitizeCoreHistoryTitle(
  value: string | undefined
): string | undefined {
  const firstLine = value
    ?.split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  const normalized = firstLine?.replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > MAX_TITLE_LENGTH
    ? `${normalized.slice(0, MAX_TITLE_LENGTH - 1)}…`
    : normalized;
}

export function sanitizeCoreHistoryPreview(
  value: string | undefined
): string | undefined {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > MAX_PREVIEW_LENGTH
    ? `${normalized.slice(0, MAX_PREVIEW_LENGTH - 1)}…`
    : normalized;
}

function sanitizeModel(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? [...normalized].slice(0, 128).join("") : undefined;
}

function sanitizeAbsolutePath(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized?.startsWith("/") ? normalized : undefined;
}

export function meaningfulCoreHistoryTitle(
  title: string,
  sessionId: string
): boolean {
  const trimmed = title.trim();
  return Boolean(
    trimmed &&
    !trimmed.includes(sessionId) &&
    !trimmed.startsWith("<local-command-") &&
    !trimmed.startsWith("<system-reminder") &&
    !(/^[0-9a-f_-]+$/iu.test(trimmed) && trimmed.length >= 24)
  );
}

export function firstMeaningfulCoreHistoryTitle(
  values: Array<string | undefined>,
  sessionId: string
): string | undefined {
  return values.find(
    (value): value is string =>
      value !== undefined && meaningfulCoreHistoryTitle(value, sessionId)
  );
}

function vendorLabel(vendor: MetadataVendor): string {
  return vendor
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

export function recentCoreHistoryActivityTimestamp(
  updatedAt: string | undefined,
  mtimeMs: number
): string {
  const parsed = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  return new Date(
    Number.isFinite(parsed) ? Math.max(parsed, mtimeMs) : mtimeMs
  ).toISOString();
}

export function maxCoreHistoryIsoTimestamp(
  current: string | undefined,
  candidate: string
): string {
  if (!current) return candidate;
  const currentMs = Date.parse(current);
  const candidateMs = Date.parse(candidate);
  if (!Number.isFinite(candidateMs)) return current;
  return !Number.isFinite(currentMs) || candidateMs > currentMs
    ? candidate
    : current;
}

function earliestIsoTimestamp(
  left: string | undefined,
  right: string | undefined
): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function latestIsoTimestamp(
  left: string | undefined,
  right: string | undefined
): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

export function pickCoreHistoryString(
  value: Record<string, unknown> | null,
  keys: string[]
): string | undefined {
  if (!value) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

export function pickCoreHistoryNumber(
  object: Record<string, unknown>,
  keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function asCoreHistoryObject(
  value: unknown
): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
