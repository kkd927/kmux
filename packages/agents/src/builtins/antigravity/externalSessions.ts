import type {
  AgentExternalSessionMetadataProjection,
  AgentExternalSessionProjectionInput,
  AgentExternalSessionProjectionOptions,
  AgentExternalSessionRecordProjection,
  AgentHistorySourceProjection,
  AgentHistorySourceProjectionInput
} from "../../contracts";
import {
  dedupeProjectedRecords,
  projectionCandidates
} from "../externalSessionShared";
import { readAntigravitySessionIndex } from "./sessionIndex";
import { classifyAntigravityMetadataPath } from "./inventory";
import { readAntigravityConversationMetadataFromSharedInventory } from "./storage";
import {
  parseAntigravityConversationRows,
  parseAntigravityHistoryRecords,
  parseAntigravityTranscriptRecord
} from "./history";

export function createAntigravityExternalSessionProjection(
  options: AgentExternalSessionProjectionOptions
): AgentExternalSessionMetadataProjection {
  return Object.freeze({
    async project(input: AgentExternalSessionProjectionInput) {
      const selected = projectionCandidates(input, (candidate) =>
        [
          "antigravity-history",
          "antigravity-conversation",
          "antigravity-project-index"
        ].includes(
          classifyAntigravityMetadataPath(input.roots, candidate.path) ?? ""
        )
      );
      const records = new Map<string, AgentExternalSessionRecordProjection>();
      const upsert = (record: AgentExternalSessionRecordProjection) => {
        const previous = records.get(record.sessionId);
        records.set(
          record.sessionId,
          previous ? mergeRecord(previous, record) : record
        );
      };

      for (const root of input.roots) {
        for (const session of await readAntigravityConversationMetadataFromSharedInventory(
          root,
          selected.candidates,
          {
            readText: input.readText,
            query: input.query
          },
          { maxConversationFiles: input.maxRecords }
        )) {
          upsert({
            sessionId: session.conversationId,
            ...(session.title ? { title: session.title } : {}),
            ...(session.recentConversation
              ? { recentConversation: session.recentConversation }
              : {}),
            ...(session.workspace ? { cwd: session.workspace } : {}),
            ...(session.createdAt ? { createdAt: session.createdAt } : {}),
            ...(session.updatedAt ? { updatedAt: session.updatedAt } : {}),
            updatedAtMs: session.mtimeMs
          });
        }
      }
      for (const session of options.indexPath
        ? readAntigravitySessionIndex(options.indexPath).sessions
        : []) {
        const updatedAtMs = Date.parse(session.updatedAt);
        upsert({
          sessionId: session.conversationId,
          cwd: session.cwd ?? session.workspacePaths?.[0],
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0
        });
      }

      const projected = dedupeProjectedRecords([...records.values()]);
      return {
        records: projected.slice(0, input.maxRecords),
        truncated: selected.truncated || projected.length > input.maxRecords
      };
    }
  });
}

export function createAntigravityHistorySourceProjection(): AgentHistorySourceProjection {
  return Object.freeze({ projectSource: projectAntigravityHistorySource });
}

function projectAntigravityHistorySource(
  input: AgentHistorySourceProjectionInput
): readonly AgentExternalSessionRecordProjection[] {
  if (input.format === "jsonl") {
    if (
      input.role !== "antigravity-history" &&
      input.role !== "antigravity-transcript"
    ) {
      return [];
    }
    if (input.role === "antigravity-history") {
      return parseAntigravityHistoryRecords({
        logicalName: input.logicalName,
        mtimeMs: input.mtimeMs,
        records: input.records ?? []
      });
    }
    const record = parseAntigravityTranscriptRecord({
      logicalName: input.logicalName,
      mtimeMs: input.mtimeMs,
      records: input.records ?? [],
      ...(input.claim ? { claim: input.claim } : {})
    });
    return record ? [record] : [];
  }
  if (
    input.format !== "sqlite" ||
    input.role !== "antigravity-conversation" ||
    input.query?.queryPlanId !== "antigravity.conversation.steps.v1"
  ) {
    return [];
  }
  const record = parseAntigravityConversationRows({
    logicalName: input.logicalName,
    mtimeMs: input.mtimeMs,
    rows: input.query.rows,
    ...(input.claim ? { claim: input.claim } : {})
  });
  return record ? [record] : [];
}

function mergeRecord(
  left: AgentExternalSessionRecordProjection,
  right: AgentExternalSessionRecordProjection
): AgentExternalSessionRecordProjection {
  const newer = right.updatedAtMs >= left.updatedAtMs ? right : left;
  const older = newer === right ? left : right;
  return {
    ...older,
    ...newer,
    title: newer.title ?? older.title,
    recentConversation: newer.recentConversation ?? older.recentConversation,
    cwd: newer.cwd ?? older.cwd,
    createdAt: earliestTimestamp(left.createdAt, right.createdAt),
    updatedAt: latestTimestamp(left.updatedAt, right.updatedAt),
    updatedAtMs: Math.max(left.updatedAtMs, right.updatedAtMs)
  };
}

function earliestTimestamp(
  left: string | undefined,
  right: string | undefined
): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(right) < Date.parse(left) ? right : left;
}

function latestTimestamp(
  left: string | undefined,
  right: string | undefined
): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}
