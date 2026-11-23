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
  AgentSessionTranscriptCapability,
  AgentSessionSourceProjection,
  AgentSessionSourceProjectionInput
} from "../../contracts";
import {
  createExternalSessionProjectionCache,
  dedupeProjectedRecords,
  projectionCandidates,
  readJsonlEdges
} from "../externalSessionShared";
import { classifyClaudeMetadataPath } from "./inventory";

export const claudeSessionTranscript: AgentSessionTranscriptCapability = {
  matchesPath({ path, sessionId }) {
    return (
      classifyClaudeMetadataPath(path) === "claude-session" &&
      (basename(path) === `${sessionId}.jsonl` ||
        basename(path) === `${sessionId}.ndjson`)
    );
  },
  decodeRecord(record) {
    const event = asCoreHistoryObject(record);
    if (
      !event ||
      event.isMeta ||
      event.isSidechain ||
      (event.type !== "user" && event.type !== "assistant")
    )
      return undefined;
    const message = asCoreHistoryObject(event.message);
    const text = extractClaudePromptText(message?.content);
    return text ? { role: event.type, text } : undefined;
  }
};

export function createClaudeExternalSessionProjection(): AgentExternalSessionMetadataProjection {
  const cache = createExternalSessionProjectionCache();
  return Object.freeze({
    async project(input: AgentExternalSessionProjectionInput) {
      const selected = projectionCandidates(
        input,
        (candidate) =>
          classifyClaudeMetadataPath(candidate.path) === "claude-session"
      );
      const records = new Map<string, AgentExternalSessionRecordProjection>();
      let visitedCandidates = 0;
      for (const candidate of selected.candidates) {
        visitedCandidates += 1;
        const cached = cache.get(candidate);
        if (cached !== undefined) {
          if (cached) upsert(records, cached);
        } else {
          const edges = await readJsonlEdges(input, candidate);
          const record =
            projectClaudeHistorySource({
              role: "claude-session",
              format: "jsonl",
              logicalName: basename(candidate.path),
              mtimeMs: candidate.mtimeMs,
              records: edges.records
            })[0] ?? null;
          cache.set(candidate, record);
          if (record) upsert(records, record);
        }
        if (records.size >= input.maxRecords) break;
      }
      const projected = dedupeProjectedRecords([...records.values()]);
      return {
        records: projected.slice(0, input.maxRecords),
        truncated:
          selected.truncated ||
          visitedCandidates < selected.candidates.length ||
          projected.length > input.maxRecords
      };
    }
  });
}

function upsert(
  records: Map<string, AgentExternalSessionRecordProjection>,
  record: AgentExternalSessionRecordProjection
): void {
  const previous = records.get(record.sessionId);
  if (!previous || record.updatedAtMs > previous.updatedAtMs) {
    records.set(record.sessionId, record);
  }
}

export function createClaudeSessionSourceProjection(): AgentSessionSourceProjection {
  return Object.freeze({ projectSource: projectClaudeHistorySource });
}

function projectClaudeHistorySource(
  input: AgentSessionSourceProjectionInput
): readonly AgentExternalSessionRecordProjection[] {
  if (input.format !== "jsonl" || input.role !== "claude-session") return [];
  const record = parseClaudeHistory(input);
  return record ? [record] : [];
}

function parseClaudeHistory(
  input: AgentSessionSourceProjectionInput
): AgentExternalSessionRecordProjection | null {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let createdAt: string | undefined;
  let updatedAt: string | undefined;
  let metadataTitle: string | undefined;
  let promptTitle: string | undefined;
  let recentConversation: string | undefined;
  let model: string | undefined;
  for (const value of input.records ?? []) {
    const object = asCoreHistoryObject(value);
    if (!object) continue;
    sessionId ??= pickCoreHistoryString(object, [
      "sessionId",
      "session_id",
      "id"
    ]);
    cwd ??= pickCoreHistoryString(object, ["cwd", "projectRoot"]);
    const timestamp = pickCoreHistoryString(object, [
      "timestamp",
      "createdAt",
      "updatedAt"
    ]);
    if (timestamp) {
      createdAt ??= timestamp;
      updatedAt = maxCoreHistoryIsoTimestamp(updatedAt, timestamp);
    }
    metadataTitle = claudeMetadataTitle(object) ?? metadataTitle;
    const type = pickCoreHistoryString(object, ["type", "role"]);
    if ((type === "user" || type === "human") && object.isMeta !== true) {
      const message = asCoreHistoryObject(object.message);
      promptTitle ??= sanitizeCoreHistoryTitle(
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
  const claim = input.claim
    ? {
        ...input.claim,
        workspacePaths: input.claim.workspacePaths
          ? [...input.claim.workspacePaths]
          : undefined
      }
    : undefined;
  return buildCoreHistoryRecord({
    vendor: "claude",
    sessionId,
    cwd: cwd ?? coreHistoryClaimCwd(claim),
    createdAt,
    updatedAt: recentCoreHistoryActivityTimestamp(updatedAt, input.mtimeMs),
    title: firstMeaningfulCoreHistoryTitle(
      [metadataTitle, promptTitle, input.claim?.launchTitle],
      sessionId
    ),
    recentConversation,
    model,
    updatedAtMs: Math.max(input.mtimeMs, input.claim?.lastSeenAtUnixMs ?? 0)
  });
}

function claudeMetadataTitle(
  object: Record<string, unknown>
): string | undefined {
  const type = pickCoreHistoryString(object, ["type", "role"]);
  if (type === "custom-title") {
    return sanitizeCoreHistoryTitle(
      pickCoreHistoryString(object, ["customTitle", "custom_title", "title"])
    );
  }
  if (
    type === "summary" ||
    type === "session-summary" ||
    type === "session_summary" ||
    type === "title" ||
    (type !== "user" && type !== "human" && type !== "assistant")
  ) {
    return sanitizeCoreHistoryTitle(
      pickCoreHistoryString(object, [
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
  const type = pickCoreHistoryString(object, ["type", "role"]);
  if (type !== "user" && type !== "human" && type !== "assistant") {
    return undefined;
  }
  if ((type === "user" || type === "human") && object.isMeta === true) {
    return undefined;
  }
  const message = asCoreHistoryObject(object.message);
  return sanitizeCoreHistoryPreview(
    extractClaudePromptText(
      message?.content ?? object.content ?? object.message
    )
  );
}

function claudeModelFromRecord(
  object: Record<string, unknown>
): string | undefined {
  return pickCoreHistoryString(object, ["type", "role"]) === "assistant"
    ? (pickCoreHistoryString(asCoreHistoryObject(object.message), ["model"]) ??
        pickCoreHistoryString(object, ["model"]))
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
  const object = asCoreHistoryObject(value);
  if (!object || object.type === "tool_result" || "tool_use_id" in object) {
    return undefined;
  }
  return extractClaudePromptText(
    object.content ?? object.text ?? object.message
  );
}
