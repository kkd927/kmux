import { basename } from "node:path";

import {
  asCoreHistoryObject,
  buildCoreHistoryRecord,
  coreHistoryClaimCwd,
  firstMeaningfulCoreHistoryTitle,
  maxCoreHistoryIsoTimestamp,
  pickCoreHistoryString,
  recentCoreHistoryActivityTimestamp,
  sanitizeCoreHistoryPreview,
  sanitizeCoreHistoryTitle
} from "@kmux/metadata";

import type {
  AgentExternalSessionMetadataProjection,
  AgentExternalSessionProjectionInput,
  AgentExternalSessionRecordProjection,
  AgentHistorySourceProjection,
  AgentHistorySourceProjectionInput
} from "../../contracts";
import {
  createExternalSessionProjectionCache,
  dedupeProjectedRecords,
  projectionCandidates,
  readJsonlEdges
} from "../externalSessionShared";
import { classifyCodexMetadataPath } from "./inventory";
import { isCodexSubagentSessionMetadata } from "./sessionMetadata";

export function createCodexExternalSessionProjection(): AgentExternalSessionMetadataProjection {
  const cache = createExternalSessionProjectionCache();
  return Object.freeze({
    async project(input: AgentExternalSessionProjectionInput) {
      const selected = projectionCandidates(
        input,
        (candidate) =>
          classifyCodexMetadataPath(candidate.path) === "codex-session"
      );
      const records: AgentExternalSessionRecordProjection[] = [];
      for (const candidate of selected.candidates) {
        const cached = cache.get(candidate);
        if (cached !== undefined) {
          if (cached) records.push(cached);
          continue;
        }
        const edges = await readJsonlEdges(input, candidate);
        const record =
          projectCodexHistorySource({
            role: "codex-session",
            format: "jsonl",
            logicalName: basename(candidate.path),
            mtimeMs: candidate.mtimeMs,
            records: edges.records
          })[0] ?? null;
        cache.set(candidate, record);
        if (record) records.push(record);
      }
      const projected = dedupeProjectedRecords(records);
      return {
        records: projected.slice(0, input.maxRecords),
        truncated: selected.truncated || projected.length > input.maxRecords
      };
    }
  });
}

export function createCodexHistorySourceProjection(): AgentHistorySourceProjection {
  return Object.freeze({ projectSource: projectCodexHistorySource });
}

function projectCodexHistorySource(
  input: AgentHistorySourceProjectionInput
): readonly AgentExternalSessionRecordProjection[] {
  if (input.format !== "jsonl" || input.role !== "codex-session") return [];
  const records = input.records ?? [];
  const identity = firstSessionMetadata(records);
  if (identity && isCodexSubagentSessionMetadata(identity)) return [];
  const record = parseCodexHistory(input);
  return record ? [record] : [];
}

function parseCodexHistory(
  input: AgentHistorySourceProjectionInput
): AgentExternalSessionRecordProjection | null {
  let sawSessionMeta = false;
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let createdAt: string | undefined;
  let updatedAt: string | undefined;
  let metadataTitle: string | undefined;
  let messageTitle: string | undefined;
  let recentConversation: string | undefined;
  let model: string | undefined;
  for (const value of input.records ?? []) {
    const object = asCoreHistoryObject(value);
    const payload = asCoreHistoryObject(object?.payload);
    const timestamp = pickCoreHistoryString(object, ["timestamp"]);
    if (timestamp) {
      updatedAt = maxCoreHistoryIsoTimestamp(updatedAt, timestamp);
    }
    if (object?.type === "session_meta" && payload && !sawSessionMeta) {
      sawSessionMeta = true;
      if (isCodexSubagentSessionMetadata(payload)) return null;
      sessionId = pickCoreHistoryString(payload, [
        "id",
        "session_id",
        "sessionId"
      ]);
      cwd = pickCoreHistoryString(payload, ["cwd"]);
      createdAt =
        pickCoreHistoryString(payload, [
          "timestamp",
          "createdAt",
          "startTime"
        ]) ?? timestamp;
      updatedAt =
        pickCoreHistoryString(payload, [
          "timestamp",
          "updatedAt",
          "lastUpdated"
        ]) ?? updatedAt;
    }
    if (payload?.type === "thread_name_updated") {
      metadataTitle =
        sanitizeCoreHistoryTitle(
          pickCoreHistoryString(payload, ["thread_name", "threadName", "name"])
        ) ?? metadataTitle;
    }
    if (payload?.type === "user_message") {
      messageTitle ??= sanitizeCoreHistoryTitle(
        extractCodexPromptText(payload.message)
      );
    }
    if (
      object?.type === "response_item" &&
      payload?.type === "message" &&
      payload.role === "user"
    ) {
      messageTitle ??= sanitizeCoreHistoryTitle(
        extractCodexPromptText(payload.content)
      );
    }
    recentConversation =
      codexConversationPreview(object, payload) ?? recentConversation;
    model = codexModelFromRecord(object, payload) ?? model;
  }
  sessionId ??= input.claim?.sessionId;
  if (!sessionId || (input.claim && input.claim.sessionId !== sessionId)) {
    return null;
  }
  const claim = input.claim
    ? {
        ...input.claim,
        workspacePaths: input.claim.workspacePaths
          ? [...input.claim.workspacePaths]
          : undefined
      }
    : undefined;
  return buildCoreHistoryRecord({
    vendor: "codex",
    sessionId,
    cwd: cwd ?? coreHistoryClaimCwd(claim),
    createdAt,
    updatedAt: recentCoreHistoryActivityTimestamp(updatedAt, input.mtimeMs),
    title: firstMeaningfulCoreHistoryTitle(
      [metadataTitle, messageTitle, input.claim?.launchTitle],
      sessionId
    ),
    recentConversation,
    model,
    updatedAtMs: Math.max(input.mtimeMs, input.claim?.lastSeenAtUnixMs ?? 0)
  });
}

function codexConversationPreview(
  object: Record<string, unknown> | null,
  payload: Record<string, unknown> | null
): string | undefined {
  if (object?.type === "event_msg") {
    return payload?.type === "user_message" || payload?.type === "agent_message"
      ? sanitizeCoreHistoryPreview(extractCodexPromptText(payload.message))
      : undefined;
  }
  return object?.type === "response_item" &&
    payload?.type === "message" &&
    (payload.role === "user" || payload.role === "assistant")
    ? sanitizeCoreHistoryPreview(extractCodexPromptText(payload.content))
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
    pickCoreHistoryString(payload, ["model", "model_name", "modelName"]) ??
    pickCoreHistoryString(asCoreHistoryObject(payload?.metadata), ["model"]) ??
    pickCoreHistoryString(asCoreHistoryObject(payload?.info), ["model"])
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
  const object = asCoreHistoryObject(value);
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

function firstSessionMetadata(
  records: readonly unknown[]
): Record<string, unknown> | null {
  for (const record of records) {
    const object = asObject(record);
    if (object?.type === "session_meta") {
      return asObject(object.payload);
    }
  }
  return null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
