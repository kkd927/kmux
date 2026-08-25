import { statSync } from "node:fs";
import { resolve } from "node:path";

import {
  estimateModelCost,
  type CoreUsageEventSample,
  type UsageProjectionPreparationInput,
  type UsageProjectionPreparationResult
} from "@kmux/metadata";

import type { AgentUsageSourceProjection } from "../../contracts";
import {
  createJsonlUsageSourceProjection,
  extractGenericUsageSample,
  isUsageTimestampInRange,
  normalizeUsageTimestamp,
  pickFirstString,
  toFiniteNumber,
  type UsageProjectionPolicy,
  type UsageProjectionRecordInput
} from "../usageParsingShared";
import { readAntigravityConversationMetadataFromSharedInventory } from "./storage";

interface AntigravitySessionContext {
  model?: string;
}

interface AntigravityUsageState {
  contexts: Map<string, AntigravitySessionContext>;
  workspaceByConversation: Map<string, string>;
}

const antigravityUsagePolicy: UsageProjectionPolicy<AntigravityUsageState> = {
  createState: () => ({
    contexts: new Map(),
    workspaceByConversation: new Map()
  }),
  cloneState: (state) => ({
    contexts: new Map(
      [...state.contexts].map(([path, context]) => [path, { ...context }])
    ),
    workspaceByConversation: new Map(state.workspaceByConversation)
  }),
  resetSource(state, sourcePath) {
    state.contexts.delete(sourcePath);
  },
  beginInventory(state, options) {
    if (!options.truncated) state.workspaceByConversation.clear();
  },
  applySourceClaim(state, { role, claim }) {
    if (role !== "antigravity-transcript" || !claim.cwd) return;
    state.workspaceByConversation.set(claim.sessionId, claim.cwd);
  },
  parseRecord: (state, input) => parseAntigravityUsageRecord(state, input)
};

export function createAntigravityUsageSourceProjection(): AgentUsageSourceProjection {
  return createJsonlUsageSourceProjection(
    "antigravity",
    antigravityUsagePolicy
  );
}

export async function prepareAntigravityUsageProjection(
  input: UsageProjectionPreparationInput
): Promise<UsageProjectionPreparationResult> {
  const conversations = new Map<
    string,
    { workspace: string; mtimeMs: number }
  >();
  for (const root of input.roots) {
    const records =
      await readAntigravityConversationMetadataFromSharedInventory(
        root,
        input.inventory.candidates,
        {
          readText: input.readText,
          ...(input.query ? { query: input.query } : {})
        },
        {
          maxConversationFiles: 32_768,
          includeConversationDetails: false
        }
      );
    for (const record of records) {
      if (!record.workspace) continue;
      const previous = conversations.get(record.conversationId);
      if (!previous || record.mtimeMs >= previous.mtimeMs) {
        conversations.set(record.conversationId, {
          workspace: record.workspace,
          mtimeMs: record.mtimeMs
        });
      }
    }
  }
  const sorted = [...conversations].sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return {
    claims: sorted.map(([sessionId, record]) => ({
      role: "antigravity-transcript",
      claim: {
        sessionId,
        cwd: record.workspace,
        workspacePaths: [record.workspace],
        lastSeenAtUnixMs: record.mtimeMs
      }
    })),
    revision: sorted
      .map(
        ([sessionId, record]) =>
          `${sessionId}\0${record.workspace}\0${record.mtimeMs}`
      )
      .join("\n"),
    truncated: input.inventory.truncated
  };
}

export function antigravityUsageProjectionProbeRevision(
  roots: readonly string[]
): string {
  return roots
    .flatMap((root) => [
      resolve(root, "history.jsonl"),
      resolve(root, "cache", "projects.json"),
      resolve(root, "conversations")
    ])
    .sort()
    .map((path) => {
      try {
        const stats = statSync(path);
        return `${path}\0${stats.size}\0${stats.mtimeMs}`;
      } catch {
        return `${path}\0missing`;
      }
    })
    .join("\n");
}

function parseAntigravityUsageRecord(
  state: AntigravityUsageState,
  input: UsageProjectionRecordInput
): readonly CoreUsageEventSample[] {
  const { record, sourcePath, range } = input;
  const conversationId =
    conversationIdFromPath(sourcePath) ??
    pickFirstString(record, ["conversationId", "conversation_id"]);
  const cwd = conversationId
    ? state.workspaceByConversation.get(conversationId)
    : undefined;
  const inferredModel = inferModel(record);
  const previousContext = state.contexts.get(sourcePath);
  const model = inferredModel ?? previousContext?.model;
  if (inferredModel && previousContext?.model !== inferredModel) {
    state.contexts.set(sourcePath, { model: inferredModel });
  }
  const augmented: Record<string, unknown> = { ...record };
  if (conversationId && !pickFirstString(augmented, ["conversationId"])) {
    augmented.conversationId = conversationId;
  }
  if (cwd && !pickFirstString(augmented, ["cwd"])) augmented.cwd = cwd;
  if (cwd && !pickFirstString(augmented, ["projectPath"])) {
    augmented.projectPath = cwd;
  }
  if (model && !pickFirstString(augmented, ["model"])) augmented.model = model;

  const reported = extractGenericUsageSample({
    agentId: "antigravity",
    pricingVendorId: "gemini",
    record: augmented,
    sourcePath
  });
  if (reported && isUsageTimestampInRange(reported.timestampMs, range)) {
    const threadId =
      reported.threadId ??
      antigravityThreadId(conversationId, record, reported.timestampMs);
    return [
      {
        ...reported,
        sessionId: reported.sessionId ?? conversationId,
        threadId,
        ...(threadId
          ? {
              dedupeKey: [
                reported.sessionId ?? conversationId ?? "",
                reported.eventId ?? threadId
              ].join("\t")
            }
          : {}),
        model: reported.model ?? model,
        cwd: reported.cwd ?? cwd,
        projectPath: reported.projectPath ?? cwd,
        costSource: reported.costSource ?? "unavailable"
      }
    ];
  }

  const timestampMs = normalizeUsageTimestamp(
    record.created_at ??
      record.createdAt ??
      record.timestamp ??
      record.updated_at ??
      record.updatedAt,
    Date.now()
  );
  if (!isUsageTimestampInRange(timestampMs, range)) return [];
  const text = transcriptText(record);
  const inputTokens = estimateTranscriptTokens(text.inputText);
  const outputTokens = estimateTranscriptTokens(text.outputText);
  const totalTokens = inputTokens + outputTokens;
  if (totalTokens <= 0) return [];
  const estimatedCostUsd =
    estimateModelCost({
      vendor: "gemini",
      model,
      inputTokens,
      outputTokens,
      cacheTokens: 0,
      cacheCreateTokens: 0,
      cacheCreateTokensKnown: false,
      thinkingTokens: 0
    })?.estimatedCostUsd ?? 0;
  const threadId = antigravityThreadId(conversationId, record, timestampMs);
  return [
    {
      vendor: "antigravity",
      timestampMs,
      sourcePath,
      sourceType: "jsonl",
      sessionId: conversationId,
      threadId,
      ...(threadId
        ? {
            dedupeKey: [conversationId ?? "", threadId].join("\t")
          }
        : {}),
      model,
      cwd,
      projectPath: cwd,
      inputTokens,
      outputTokens,
      thinkingTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWriteTokensKnown: false,
      cacheTokens: 0,
      totalTokens,
      estimatedCostUsd,
      costSource: estimatedCostUsd > 0 ? "estimated" : "unavailable"
    }
  ];
}

function transcriptText(record: Record<string, unknown>): {
  inputText: string;
  outputText: string;
} {
  const type = typeof record.type === "string" ? record.type.toUpperCase() : "";
  const source =
    typeof record.source === "string" ? record.source.toUpperCase() : "";
  const content = stringifyTranscriptValue(record.content);
  const toolCalls = Array.isArray(record.tool_calls)
    ? stringifyTranscriptValue(record.tool_calls)
    : "";
  return source === "MODEL" &&
    (type.endsWith("_RESPONSE") || Boolean(toolCalls))
    ? {
        inputText: "",
        outputText: [content, toolCalls].filter(Boolean).join("\n")
      }
    : { inputText: content, outputText: "" };
}

function stringifyTranscriptValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function estimateTranscriptTokens(value: string): number {
  const normalized = value.trim();
  return normalized ? Math.max(1, Math.ceil(normalized.length / 4)) : 0;
}

function conversationIdFromPath(sourcePath: string): string | undefined {
  return sourcePath
    .replace(/\\/gu, "/")
    .match(/\/([^/]+)\/\.system_generated\/logs\/transcript\.jsonl$/u)?.[1];
}

function antigravityThreadId(
  conversationId: string | undefined,
  record: Record<string, unknown>,
  timestampMs: number
): string | undefined {
  const explicit = pickFirstString(record, [
    "thread_id",
    "threadId",
    "id",
    "messageId",
    "eventId"
  ]);
  if (explicit) return explicit;
  const stepIndex = toFiniteNumber(record.step_index ?? record.stepIndex);
  if (conversationId && stepIndex !== undefined) {
    return `${conversationId}:${stepIndex}`;
  }
  return conversationId ? `${conversationId}:${timestampMs}` : undefined;
}

function inferModel(record: Record<string, unknown>): string | undefined {
  const explicit = pickFirstString(record, [
    "model",
    "model_name",
    "modelName"
  ]);
  if (explicit) return explicit;
  const content = stringifyTranscriptValue(record.content);
  return (
    content.match(/gemini-[A-Za-z0-9._-]+/iu)?.[0] ??
    content
      .match(
        /Gemini\s+\d+(?:\.\d+)?\s+(?:Pro|Flash(?:[- ]Lite)?)(?:\s*\((?:Low|Medium|High)\))?/iu
      )?.[0]
      ?.trim()
      .replace(/[.。]+$/u, "")
  );
}
