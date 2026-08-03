import { isCodexSubagentSessionMetadata } from "../codexSession";
import type { MetadataSourceRole, MetadataVendor } from "./sourceContract";

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

export interface CoreHistorySourceInput {
  vendor: MetadataVendor;
  role: MetadataSourceRole;
  logicalName: string;
  mtimeMs: number;
  records: readonly unknown[];
  claim?: CoreHistoryClaim;
}

export interface AntigravityConversationStepRow {
  index: number;
  stepType: number;
  payloadBase64: string;
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

export function parseCoreHistorySource(
  input: CoreHistorySourceInput
): CoreHistoryRecord[] {
  switch (input.role) {
    case "codex-session": {
      const record = parseCodexHistory(input);
      return record ? [record] : [];
    }
    case "claude-session": {
      const record = parseClaudeHistory(input);
      return record ? [record] : [];
    }
    case "claude-subagent":
      return [];
    case "antigravity-history":
      return parseAntigravityHistory(input);
    case "antigravity-transcript": {
      const record = parseAntigravityTranscript(input);
      return record ? [record] : [];
    }
    case "antigravity-conversation":
      return [];
  }
}

export function parseAntigravityConversationRows(options: {
  logicalName: string;
  mtimeMs: number;
  rows: readonly AntigravityConversationStepRow[];
  claim?: CoreHistoryClaim;
}): CoreHistoryRecord | null {
  const sessionId =
    options.claim?.sessionId ??
    options.logicalName.replace(/\\/g, "/").match(/\/([^/]+)\.db$/u)?.[1] ??
    options.logicalName.replace(/\.db$/u, "").split("/").at(-1);
  if (!sessionId) return null;
  const promptRows = options.rows
    .filter((row) => row.stepType === 14)
    .sort((left, right) => left.index - right.index);
  const firstPrompt = promptFromConversationRow(
    promptRows.find((row) => row.index === 0)
  );
  const latestPrompt = promptFromConversationRow(promptRows.at(-1));
  if (!firstPrompt && !latestPrompt) return null;
  return buildCoreHistoryRecord({
    vendor: "antigravity",
    sessionId,
    cwd: claimCwd(options.claim),
    title: firstPrompt,
    recentConversation: latestPrompt,
    updatedAtMs: Math.max(options.mtimeMs, options.claim?.lastSeenAtUnixMs ?? 0)
  });
}

function promptFromConversationRow(
  row: AntigravityConversationStepRow | undefined
): string | undefined {
  if (!row) return undefined;
  const payload = decodeBase64(row.payloadBase64);
  return payload ? extractPromptFromPayload(payload, 0) : undefined;
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
      title: meaningfulTitle(newer.title, newer.sessionId)
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
    cwd: claimCwd(options.claim),
    title: options.claim.launchTitle,
    updatedAtMs:
      options.claim.lastSeenAtUnixMs ?? options.claim.claimedAtUnixMs ?? 0
  });
}

export function applyCoreHistoryClaim(
  record: CoreHistoryRecord,
  claim: CoreHistoryClaim
): CoreHistoryRecord {
  const launchTitle = sanitizeTitle(claim.launchTitle);
  return {
    ...record,
    cwd: record.cwd ?? claimCwd(claim),
    title:
      record.title === `${vendorLabel(record.vendor)} session` &&
      launchTitle &&
      meaningfulTitle(launchTitle, record.sessionId)
        ? launchTitle
        : record.title,
    updatedAtMs: Math.max(
      record.updatedAtMs,
      claim.lastSeenAtUnixMs ?? claim.claimedAtUnixMs ?? 0
    )
  };
}

function parseCodexHistory(
  input: CoreHistorySourceInput
): CoreHistoryRecord | null {
  let sawSessionMeta = false;
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let createdAt: string | undefined;
  let updatedAt: string | undefined;
  let metadataTitle: string | undefined;
  let messageTitle: string | undefined;
  let recentConversation: string | undefined;
  let model: string | undefined;
  for (const value of input.records) {
    const object = asObject(value);
    const payload = asObject(object?.payload);
    const timestamp = pickFirstString(object, ["timestamp"]);
    if (timestamp) updatedAt = maxIsoTimestamp(updatedAt, timestamp);
    if (object?.type === "session_meta" && payload && !sawSessionMeta) {
      sawSessionMeta = true;
      if (isCodexSubagentSessionMetadata(payload)) return null;
      sessionId = pickFirstString(payload, ["id", "session_id", "sessionId"]);
      cwd = pickFirstString(payload, ["cwd"]);
      createdAt =
        pickFirstString(payload, ["timestamp", "createdAt", "startTime"]) ??
        timestamp;
      updatedAt =
        pickFirstString(payload, ["timestamp", "updatedAt", "lastUpdated"]) ??
        updatedAt;
    }
    if (payload?.type === "thread_name_updated") {
      metadataTitle =
        sanitizeTitle(
          pickFirstString(payload, ["thread_name", "threadName", "name"])
        ) ?? metadataTitle;
    }
    if (payload?.type === "user_message") {
      messageTitle ??= sanitizeTitle(extractCodexPromptText(payload.message));
    }
    if (
      object?.type === "response_item" &&
      payload?.type === "message" &&
      payload.role === "user"
    ) {
      messageTitle ??= sanitizeTitle(extractCodexPromptText(payload.content));
    }
    recentConversation =
      codexConversationPreview(object, payload) ?? recentConversation;
    model = codexModelFromRecord(object, payload) ?? model;
  }
  sessionId ??= input.claim?.sessionId;
  if (!sessionId || (input.claim && input.claim.sessionId !== sessionId)) {
    return null;
  }
  return buildCoreHistoryRecord({
    vendor: "codex",
    sessionId,
    cwd: cwd ?? claimCwd(input.claim),
    createdAt,
    updatedAt: recentActivityTimestamp(updatedAt, input.mtimeMs),
    title: firstMeaningfulTitle(
      [metadataTitle, messageTitle, input.claim?.launchTitle],
      sessionId
    ),
    recentConversation,
    model,
    updatedAtMs: Math.max(input.mtimeMs, input.claim?.lastSeenAtUnixMs ?? 0)
  });
}

function parseClaudeHistory(
  input: CoreHistorySourceInput
): CoreHistoryRecord | null {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let createdAt: string | undefined;
  let updatedAt: string | undefined;
  let metadataTitle: string | undefined;
  let promptTitle: string | undefined;
  let recentConversation: string | undefined;
  let model: string | undefined;
  for (const value of input.records) {
    const object = asObject(value);
    if (!object) continue;
    sessionId ??= pickFirstString(object, ["sessionId", "session_id", "id"]);
    cwd ??= pickFirstString(object, ["cwd", "projectRoot"]);
    const timestamp = pickFirstString(object, [
      "timestamp",
      "createdAt",
      "updatedAt"
    ]);
    if (timestamp) {
      createdAt ??= timestamp;
      updatedAt = maxIsoTimestamp(updatedAt, timestamp);
    }
    metadataTitle = claudeMetadataTitle(object) ?? metadataTitle;
    const type = pickFirstString(object, ["type", "role"]);
    if ((type === "user" || type === "human") && object.isMeta !== true) {
      const message = asObject(object.message);
      promptTitle ??= sanitizeTitle(
        extractClaudePromptText(
          message?.content ?? object.content ?? object.message
        )
      );
    }
    recentConversation =
      claudeConversationPreview(object) ?? recentConversation;
    model = claudeModelFromRecord(object) ?? model;
  }
  sessionId ??=
    input.claim?.sessionId ??
    input.logicalName
      .replace(/\.jsonl$/u, "")
      .split("/")
      .at(-1);
  if (!sessionId || (input.claim && input.claim.sessionId !== sessionId)) {
    return null;
  }
  return buildCoreHistoryRecord({
    vendor: "claude",
    sessionId,
    cwd: cwd ?? claimCwd(input.claim),
    createdAt,
    updatedAt: recentActivityTimestamp(updatedAt, input.mtimeMs),
    title: firstMeaningfulTitle(
      [metadataTitle, promptTitle, input.claim?.launchTitle],
      sessionId
    ),
    recentConversation,
    model,
    updatedAtMs: Math.max(input.mtimeMs, input.claim?.lastSeenAtUnixMs ?? 0)
  });
}

function parseAntigravityHistory(
  input: CoreHistorySourceInput
): CoreHistoryRecord[] {
  return input.records.flatMap((value) => {
    const object = asObject(value);
    if (!object) return [];
    const sessionId = pickFirstString(object, [
      "conversationId",
      "conversation_id",
      "sessionId",
      "session_id"
    ]);
    if (!sessionId || (input.claim && input.claim.sessionId !== sessionId)) {
      return [];
    }
    const updatedAtValue = pickFirstString(object, [
      "updatedAt",
      "updated_at",
      "timestamp"
    ]);
    const numericTimestamp = pickFirstNumber(object, [
      "updatedAt",
      "updated_at",
      "timestamp"
    ]);
    const numericUpdatedAt =
      numericTimestamp !== undefined && numericTimestamp >= 0
        ? new Date(numericTimestamp).toISOString()
        : undefined;
    const updatedAt = updatedAtValue ?? numericUpdatedAt;
    const timestamp = updatedAt ? Date.parse(updatedAt) : Number.NaN;
    const display = pickFirstString(object, ["display", "title", "summary"]);
    return [
      buildCoreHistoryRecord({
        vendor: "antigravity",
        sessionId,
        cwd:
          pickFirstString(object, ["workspace", "cwd"]) ??
          claimCwd(input.claim),
        title: display ?? input.claim?.launchTitle,
        recentConversation: sanitizePreview(display),
        model: pickFirstString(object, ["model"]),
        createdAt: updatedAt,
        updatedAt,
        updatedAtMs: Math.max(
          Number.isFinite(timestamp) ? timestamp : input.mtimeMs,
          input.claim?.lastSeenAtUnixMs ?? 0
        )
      })
    ];
  });
}

function parseAntigravityTranscript(
  input: CoreHistorySourceInput
): CoreHistoryRecord | null {
  const logicalSessionId = input.logicalName
    .replace(/\\/g, "/")
    .match(/\/([^/]+)\/\.system_generated\/logs\/transcript\.jsonl$/u)?.[1];
  let recordedSessionId: string | undefined;
  for (const value of input.records) {
    const object = asObject(value);
    recordedSessionId ??= pickFirstString(object, [
      "conversationId",
      "conversation_id",
      "sessionId",
      "session_id"
    ]);
  }
  const observedSessionId = logicalSessionId ?? recordedSessionId;
  if (
    input.claim &&
    observedSessionId &&
    input.claim.sessionId !== observedSessionId
  ) {
    return null;
  }
  const sessionId = input.claim?.sessionId ?? observedSessionId;
  if (!sessionId) return null;
  let title: string | undefined;
  let recentConversation: string | undefined;
  let model: string | undefined;
  let updatedAt: string | undefined;
  for (const value of input.records) {
    const object = asObject(value);
    if (!object) continue;
    const content = extractText(object.content, 0);
    const source = String(object.source ?? "").toUpperCase();
    const type = String(object.type ?? "").toUpperCase();
    if ((source.includes("USER") || type.includes("USER")) && !title) {
      title = sanitizeTitle(content);
    }
    recentConversation = sanitizePreview(content) ?? recentConversation;
    model =
      pickNestedString(value, ["model", "model_name", "modelName"], 0) ??
      content?.match(/gemini-[A-Za-z0-9._-]+/iu)?.[0] ??
      model;
    const timestamp = pickFirstString(object, [
      "timestamp",
      "createdAt",
      "updatedAt"
    ]);
    if (timestamp) updatedAt = maxIsoTimestamp(updatedAt, timestamp);
  }
  return buildCoreHistoryRecord({
    vendor: "antigravity",
    sessionId,
    cwd: claimCwd(input.claim),
    title: title ?? input.claim?.launchTitle,
    recentConversation,
    model,
    updatedAt,
    updatedAtMs: Math.max(input.mtimeMs, input.claim?.lastSeenAtUnixMs ?? 0)
  });
}

function buildCoreHistoryRecord(input: {
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
  const title = sanitizeTitle(input.title);
  return {
    key: `${input.vendor}:${input.sessionId}`,
    vendor: input.vendor,
    sessionId: input.sessionId,
    title:
      title && meaningfulTitle(title, input.sessionId)
        ? title
        : `${vendorLabel(input.vendor)} session`,
    ...(sanitizePreview(input.recentConversation) === undefined
      ? {}
      : { recentConversation: sanitizePreview(input.recentConversation) }),
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

function codexConversationPreview(
  object: Record<string, unknown> | null,
  payload: Record<string, unknown> | null
): string | undefined {
  if (object?.type === "event_msg") {
    return payload?.type === "user_message" || payload?.type === "agent_message"
      ? sanitizePreview(extractCodexPromptText(payload.message))
      : undefined;
  }
  return object?.type === "response_item" &&
    payload?.type === "message" &&
    (payload.role === "user" || payload.role === "assistant")
    ? sanitizePreview(extractCodexPromptText(payload.content))
    : undefined;
}

function codexModelFromRecord(
  object: Record<string, unknown> | null,
  payload: Record<string, unknown> | null
): string | undefined {
  if (object?.type !== "turn_context" && payload?.type !== "token_count") {
    return undefined;
  }
  return (
    pickFirstString(payload, ["model", "model_name", "modelName"]) ??
    pickFirstString(asObject(payload?.metadata), ["model"]) ??
    pickFirstString(asObject(payload?.info), ["model"])
  );
}

function extractCodexPromptText(value: unknown): string | undefined {
  if (typeof value === "string") {
    if (isCodexInjectedInstructions(value)) return undefined;
    const cleaned = value
      .replace(
        /<permissions instructions>[\s\S]*?<\/permissions instructions>/giu,
        "\n"
      )
      .replace(/<environment_context>[\s\S]*?<\/environment_context>/giu, "\n")
      .replace(/<turn_aborted>[\s\S]*?<\/turn_aborted>/giu, "\n")
      .replace(/<skill>[\s\S]*?<\/skill>/giu, "\n")
      .replace(
        /<recommended_plugins(?:\s[^>]*)?>[\s\S]*?<\/recommended_plugins>/giu,
        "\n"
      )
      .replace(
        /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/giu,
        "\n"
      )
      .trim();
    return cleaned && !isCodexInjectedInstructions(cleaned)
      ? cleaned
      : undefined;
  }
  if (Array.isArray(value)) {
    const parts = value.flatMap((item) => {
      const part = extractCodexPromptText(item);
      return part ? [part] : [];
    });
    return parts.length ? parts.join(" ") : undefined;
  }
  const object = asObject(value);
  if (!object) return undefined;
  return extractCodexPromptText(
    object.content ?? object.text ?? object.message
  );
}

function isCodexInjectedInstructions(value: string): boolean {
  return /^# [^\r\n]+ instructions for [^\r\n]+\r?\n\r?\n<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>\s*$/iu.test(
    value.trim()
  );
}

function claudeMetadataTitle(
  object: Record<string, unknown>
): string | undefined {
  const type = pickFirstString(object, ["type", "role"]);
  if (type === "custom-title") {
    return sanitizeTitle(
      pickFirstString(object, ["customTitle", "custom_title", "title"])
    );
  }
  if (
    type === "summary" ||
    type === "session-summary" ||
    type === "session_summary" ||
    type === "title" ||
    (type !== "user" && type !== "human" && type !== "assistant")
  ) {
    return sanitizeTitle(
      pickFirstString(object, [
        "customTitle",
        "custom_title",
        "summary",
        "title"
      ])
    );
  }
  return undefined;
}

function claudeConversationPreview(
  object: Record<string, unknown>
): string | undefined {
  const type = pickFirstString(object, ["type", "role"]);
  if (type !== "user" && type !== "human" && type !== "assistant") {
    return undefined;
  }
  if ((type === "user" || type === "human") && object.isMeta === true) {
    return undefined;
  }
  const message = asObject(object.message);
  return sanitizePreview(
    extractClaudePromptText(
      message?.content ?? object.content ?? object.message
    )
  );
}

function claudeModelFromRecord(
  object: Record<string, unknown>
): string | undefined {
  return pickFirstString(object, ["type", "role"]) === "assistant"
    ? (pickFirstString(asObject(object.message), ["model"]) ??
        pickFirstString(object, ["model"]))
    : undefined;
}

function extractClaudePromptText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return (
      value
        .replace(
          /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/giu,
          "\n"
        )
        .replace(
          /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/giu,
          "\n"
        )
        .replace(
          /<local-command-stderr>[\s\S]*?<\/local-command-stderr>/giu,
          "\n"
        )
        .replace(/<command-message>[\s\S]*?<\/command-message>/giu, "\n")
        .replace(/<command-name>[\s\S]*?<\/command-name>/giu, "\n")
        .replace(/<command-args>[\s\S]*?<\/command-args>/giu, "\n")
        .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/giu, "\n")
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/giu, "\n")
        .replace(/<system_reminder>[\s\S]*?<\/system_reminder>/giu, "\n")
        .trim() || undefined
    );
  }
  if (Array.isArray(value)) {
    const parts = value.flatMap((item) => {
      const part = extractClaudePromptText(item);
      return part ? [part] : [];
    });
    return parts.length ? parts.join(" ") : undefined;
  }
  const object = asObject(value);
  if (
    !object ||
    object.type === "tool_result" ||
    "tool_use_id" in (object ?? {})
  ) {
    return undefined;
  }
  return extractClaudePromptText(
    object.content ?? object.text ?? object.message
  );
}

function extractText(value: unknown, depth: number): string | undefined {
  if (depth > 6) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) {
    const parts = value.flatMap((item) => {
      const part = extractText(item, depth + 1);
      return part ? [part] : [];
    });
    return parts.length ? parts.join(" ") : undefined;
  }
  const object = asObject(value);
  if (!object) return undefined;
  return extractText(
    object.text ?? object.content ?? object.message ?? object.value,
    depth + 1
  );
}

function pickNestedString(
  value: unknown,
  keys: string[],
  depth: number
): string | undefined {
  if (depth > 6) return undefined;
  const object = asObject(value);
  if (!object) return undefined;
  const direct = pickFirstString(object, keys);
  if (direct) return direct;
  for (const nested of Object.values(object)) {
    if (Array.isArray(nested)) {
      for (const item of nested.slice(0, 16)) {
        const found = pickNestedString(item, keys, depth + 1);
        if (found) return found;
      }
    } else {
      const found = pickNestedString(nested, keys, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function extractPromptFromPayload(
  payload: Uint8Array,
  depth: number
): string | undefined {
  if (payload.byteLength > 1024 * 1024 || depth > 8) return undefined;
  let offset = 0;
  while (offset < payload.byteLength) {
    const tag = readVarint(payload, offset);
    if (!tag || tag.value === 0) break;
    offset = tag.offset;
    const wireType = tag.value & 7;
    const fieldNumber = Math.floor(tag.value / 8);
    if (wireType === 2) {
      const length = readVarint(payload, offset);
      if (!length) break;
      offset = length.offset;
      const end = offset + length.value;
      if (end > payload.byteLength) break;
      if (length.value <= 128 * 1024) {
        const field = payload.subarray(offset, end);
        if (fieldNumber === 2) {
          try {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(
              field
            );
            if (
              text.trim().length >= 2 &&
              [...text].every(
                (character) =>
                  character >= " " ||
                  character === "\n" ||
                  character === "\r" ||
                  character === "\t"
              )
            ) {
              return text.trim();
            }
          } catch {
            // A protobuf field can contain another message instead of UTF-8.
          }
        }
        const nested = extractPromptFromPayload(field, depth + 1);
        if (nested) return nested;
      }
      offset = end;
    } else if (wireType === 0) {
      const value = readVarint(payload, offset);
      if (!value) break;
      offset = value.offset;
    } else if (wireType === 1) {
      offset += 8;
    } else if (wireType === 5) {
      offset += 4;
    } else {
      break;
    }
  }
  return undefined;
}

function readVarint(
  payload: Uint8Array,
  start: number
): { value: number; offset: number } | undefined {
  let value = 0;
  let factor = 1;
  let offset = start;
  for (let index = 0; index < 10; index += 1) {
    const byte = payload[offset];
    if (byte === undefined) return undefined;
    offset += 1;
    value += (byte & 0x7f) * factor;
    if ((byte & 0x80) === 0) return { value, offset };
    factor *= 128;
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(factor)) {
      return undefined;
    }
  }
  return undefined;
}

function decodeBase64(value: string): Uint8Array | undefined {
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

function claimCwd(claim: CoreHistoryClaim | undefined): string | undefined {
  return (
    claim?.cwd ?? claim?.workspacePaths?.find((path) => path.startsWith("/"))
  );
}

function sanitizeTitle(value: string | undefined): string | undefined {
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

function sanitizePreview(value: string | undefined): string | undefined {
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

function meaningfulTitle(title: string, sessionId: string): boolean {
  const trimmed = title.trim();
  return Boolean(
    trimmed &&
    !trimmed.includes(sessionId) &&
    !trimmed.startsWith("<local-command-") &&
    !trimmed.startsWith("<system-reminder") &&
    !(/^[0-9a-f_-]+$/iu.test(trimmed) && trimmed.length >= 24)
  );
}

function firstMeaningfulTitle(
  values: Array<string | undefined>,
  sessionId: string
): string | undefined {
  return values.find(
    (value): value is string =>
      value !== undefined && meaningfulTitle(value, sessionId)
  );
}

function vendorLabel(vendor: MetadataVendor): string {
  return vendor === "codex"
    ? "Codex"
    : vendor === "claude"
      ? "Claude"
      : "Antigravity";
}

function recentActivityTimestamp(
  updatedAt: string | undefined,
  mtimeMs: number
): string {
  const parsed = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  return new Date(
    Number.isFinite(parsed) ? Math.max(parsed, mtimeMs) : mtimeMs
  ).toISOString();
}

function maxIsoTimestamp(
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

function pickFirstString(
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

function pickFirstNumber(
  object: Record<string, unknown>,
  keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
