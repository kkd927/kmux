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
import {
  classifyCopilotMetadataPath,
  copilotSessionIdFromPath
} from "./inventory";

export const copilotSessionTranscript: AgentSessionTranscriptCapability = {
  matchesPath({ roots, path, sessionId }) {
    return (
      classifyCopilotMetadataPath(roots, path) === "copilot-session" &&
      copilotSessionIdFromPath(path) === sessionId
    );
  },
  decodeRecord(record) {
    const event = asCoreHistoryObject(record);
    if (
      !event ||
      event.agentId !== undefined ||
      (event.type !== "user.message" && event.type !== "assistant.message")
    )
      return undefined;
    const data = asCoreHistoryObject(event.data);
    const text = typeof data?.content === "string" ? data.content : undefined;
    return text
      ? { role: event.type === "user.message" ? "user" : "assistant", text }
      : undefined;
  }
};

export function createCopilotExternalSessionProjection(): AgentExternalSessionMetadataProjection {
  const cache = createExternalSessionProjectionCache();
  return Object.freeze({
    async project(input: AgentExternalSessionProjectionInput) {
      const selected = projectionCandidates(
        input,
        (candidate) =>
          classifyCopilotMetadataPath(input.roots, candidate.path) ===
          "copilot-session"
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
            projectCopilotHistorySource({
              role: "copilot-session",
              format: "jsonl",
              logicalName: candidate.path,
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

export function createCopilotSessionSourceProjection(): AgentSessionSourceProjection {
  return Object.freeze({ projectSource: projectCopilotHistorySource });
}

function projectCopilotHistorySource(
  input: AgentSessionSourceProjectionInput
): readonly AgentExternalSessionRecordProjection[] {
  if (input.format !== "jsonl" || input.role !== "copilot-session") return [];
  const record = parseCopilotHistory(input);
  return record ? [record] : [];
}

function parseCopilotHistory(
  input: AgentSessionSourceProjectionInput
): AgentExternalSessionRecordProjection | null {
  let sessionId = copilotSessionIdFromPath(input.logicalName);
  let cwd: string | undefined;
  let createdAt: string | undefined;
  let updatedAt: string | undefined;
  let title: string | undefined;
  let promptTitle: string | undefined;
  let recentConversation: string | undefined;
  let model: string | undefined;
  for (const value of input.records ?? []) {
    const event = asCoreHistoryObject(value);
    const data = asCoreHistoryObject(event?.data);
    if (!event || !data || typeof event.type !== "string") continue;
    const timestamp = pickCoreHistoryString(event, ["timestamp"]);
    if (timestamp) {
      createdAt ??= timestamp;
      updatedAt = maxCoreHistoryIsoTimestamp(updatedAt, timestamp);
    }
    if (event.type === "session.start") {
      const context = asCoreHistoryObject(data.context);
      sessionId =
        pickCoreHistoryString(data, ["sessionId", "session_id"]) ?? sessionId;
      cwd =
        pickCoreHistoryString(context, ["cwd"]) ??
        pickCoreHistoryString(data, ["cwd"]) ??
        cwd;
      model =
        pickCoreHistoryString(data, [
          "selectedModel",
          "model",
          "currentModel"
        ]) ?? model;
    } else if (event.type === "session.resume") {
      const context = asCoreHistoryObject(data.context);
      cwd =
        pickCoreHistoryString(context, ["cwd"]) ??
        pickCoreHistoryString(data, ["cwd"]) ??
        cwd;
      model =
        pickCoreHistoryString(data, [
          "selectedModel",
          "model",
          "currentModel"
        ]) ?? model;
    } else if (event.type === "session.context_changed") {
      cwd = pickCoreHistoryString(data, ["cwd"]) ?? cwd;
    } else if (event.type === "session.title_changed") {
      title =
        sanitizeCoreHistoryTitle(pickCoreHistoryString(data, ["title"])) ??
        title;
    } else if (event.type === "session.task_complete") {
      title ??= sanitizeCoreHistoryTitle(
        pickCoreHistoryString(data, ["summary"])
      );
    } else if (event.type === "session.shutdown") {
      model = pickCoreHistoryString(data, ["currentModel", "model"]) ?? model;
    } else if (
      event.type === "session.model_change" &&
      event.agentId === undefined
    ) {
      model = pickCoreHistoryString(data, ["newModel"]) ?? model;
    } else if (
      event.type === "assistant.message" &&
      event.agentId === undefined
    ) {
      model = pickCoreHistoryString(data, ["model"]) ?? model;
    }
    if (event.agentId !== undefined) continue;
    if (event.type === "user.message") {
      const content = pickCoreHistoryString(data, [
        "content",
        "transformedContent"
      ]);
      promptTitle ??= sanitizeCoreHistoryTitle(content);
      recentConversation =
        sanitizeCoreHistoryPreview(content) ?? recentConversation;
    } else if (event.type === "assistant.message") {
      recentConversation =
        sanitizeCoreHistoryPreview(pickCoreHistoryString(data, ["content"])) ??
        recentConversation;
    }
  }
  sessionId ??= input.claim?.sessionId;
  if (!sessionId || (input.claim && input.claim.sessionId !== sessionId)) {
    return null;
  }
  return buildCoreHistoryRecord({
    vendor: "copilot",
    sessionId,
    cwd: cwd ?? coreHistoryClaimCwd(input.claim),
    createdAt,
    updatedAt: recentCoreHistoryActivityTimestamp(updatedAt, input.mtimeMs),
    title: firstMeaningfulCoreHistoryTitle(
      [title, promptTitle, input.claim?.launchTitle],
      sessionId
    ),
    recentConversation,
    model,
    updatedAtMs: Math.max(input.mtimeMs, input.claim?.lastSeenAtUnixMs ?? 0)
  });
}
