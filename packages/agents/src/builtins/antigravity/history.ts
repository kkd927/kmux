import {
  asCoreHistoryObject,
  buildCoreHistoryRecord,
  coreHistoryClaimCwd,
  decodeCoreHistoryBase64,
  extractCoreHistoryText,
  maxCoreHistoryIsoTimestamp,
  pickCoreHistoryNumber,
  pickCoreHistoryString,
  pickNestedCoreHistoryString,
  type CoreHistoryRecord
} from "@kmux/metadata";

export interface AntigravityHistoryClaim {
  readonly sessionId: string;
  readonly lastSeenAtUnixMs?: number;
  readonly cwd?: string;
  readonly workspacePaths?: readonly string[];
  readonly launchTitle?: string;
}

export interface AntigravityConversationStepRow {
  readonly index: number;
  readonly stepType: number;
  readonly payloadBase64: string;
}

interface AntigravityHistoryInput {
  readonly logicalName: string;
  readonly mtimeMs: number;
  readonly records: readonly unknown[];
  readonly claim?: AntigravityHistoryClaim;
}

export function parseAntigravityHistoryRecords(
  input: AntigravityHistoryInput
): readonly CoreHistoryRecord[] {
  return input.records.flatMap((value) => {
    const object = asCoreHistoryObject(value);
    if (!object) return [];
    const sessionId = pickCoreHistoryString(object, [
      "conversationId",
      "conversation_id",
      "sessionId",
      "session_id"
    ]);
    if (!sessionId || (input.claim && input.claim.sessionId !== sessionId)) {
      return [];
    }
    const updatedAtValue = pickCoreHistoryString(object, [
      "updatedAt",
      "updated_at",
      "timestamp"
    ]);
    const numericTimestamp = pickCoreHistoryNumber(object, [
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
    const display = pickCoreHistoryString(object, [
      "display",
      "title",
      "summary"
    ]);
    return [
      buildCoreHistoryRecord({
        vendor: "antigravity",
        sessionId,
        cwd:
          pickCoreHistoryString(object, ["workspace", "cwd"]) ??
          claimCwd(input.claim),
        title: display ?? input.claim?.launchTitle,
        recentConversation: display,
        model: pickCoreHistoryString(object, ["model"]),
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

export function parseAntigravityTranscriptRecord(
  input: AntigravityHistoryInput
): CoreHistoryRecord | null {
  const logicalSessionId = input.logicalName
    .replace(/\\/gu, "/")
    .match(/\/([^/]+)\/\.system_generated\/logs\/transcript\.jsonl$/u)?.[1];
  let recordedSessionId: string | undefined;
  for (const value of input.records) {
    const object = asCoreHistoryObject(value);
    recordedSessionId ??= pickCoreHistoryString(object, [
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
    const object = asCoreHistoryObject(value);
    if (!object) continue;
    const content = extractCoreHistoryText(object.content, 0);
    const source = String(object.source ?? "").toUpperCase();
    const type = String(object.type ?? "").toUpperCase();
    if ((source.includes("USER") || type.includes("USER")) && !title) {
      title = content;
    }
    recentConversation = content ?? recentConversation;
    model =
      pickNestedCoreHistoryString(
        value,
        ["model", "model_name", "modelName"],
        0
      ) ??
      content?.match(/gemini-[A-Za-z0-9._-]+/iu)?.[0] ??
      model;
    const timestamp = pickCoreHistoryString(object, [
      "timestamp",
      "createdAt",
      "updatedAt"
    ]);
    if (timestamp) {
      updatedAt = maxCoreHistoryIsoTimestamp(updatedAt, timestamp);
    }
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

export function parseAntigravityConversationRows(options: {
  readonly logicalName: string;
  readonly mtimeMs: number;
  readonly rows: readonly AntigravityConversationStepRow[];
  readonly claim?: AntigravityHistoryClaim;
}): CoreHistoryRecord | null {
  const sessionId =
    options.claim?.sessionId ??
    options.logicalName.replace(/\\/gu, "/").match(/\/([^/]+)\.db$/u)?.[1] ??
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
  const payload = decodeCoreHistoryBase64(row.payloadBase64);
  return payload ? extractAntigravityPromptFromPayload(payload, 0) : undefined;
}

function extractAntigravityPromptFromPayload(
  payload: Uint8Array,
  depth: number
): string | undefined {
  if (payload.byteLength > 1024 * 1024 || depth > 8) return undefined;
  let offset = 0;
  while (offset < payload.byteLength) {
    const tag = readAntigravityVarint(payload, offset);
    if (!tag || tag.value === 0) break;
    offset = tag.offset;
    const wireType = tag.value & 7;
    const fieldNumber = Math.floor(tag.value / 8);
    if (wireType === 2) {
      const length = readAntigravityVarint(payload, offset);
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
            // This field may contain another protobuf message instead of text.
          }
        }
        const nested = extractAntigravityPromptFromPayload(field, depth + 1);
        if (nested) return nested;
      }
      offset = end;
    } else if (wireType === 0) {
      const value = readAntigravityVarint(payload, offset);
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

function readAntigravityVarint(
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

function claimCwd(
  claim: AntigravityHistoryClaim | undefined
): string | undefined {
  return coreHistoryClaimCwd(
    claim
      ? {
          ...claim,
          workspacePaths: claim.workspacePaths
            ? [...claim.workspacePaths]
            : undefined
        }
      : undefined
  );
}
