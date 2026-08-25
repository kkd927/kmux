import type { AgentModule } from "../../contracts";
import { join } from "node:path";
import {
  createFileUsageAdapter,
  normalizeSessionInventoryRoots,
  resolveAgentSessionRoots,
  resolveAgentStorageRoots
} from "@kmux/metadata";
import {
  booleanField,
  absoluteUsageOverrideRoots,
  commonHookResult,
  firstString,
  needsInputFallback,
  recordField,
  stringField,
  usageWatchIsRecursive
} from "../shared";
import {
  createAntigravityExternalSessionProjection,
  createAntigravityHistorySourceProjection
} from "./externalSessions";
import { classifyAntigravityMetadataPath } from "./inventory";
import { antigravitySessionIndexPath } from "./sessionIndex";
import {
  antigravityUsageProjectionProbeRevision,
  createAntigravityUsageSourceProjection,
  prepareAntigravityUsageProjection
} from "./usage";
import { queryAntigravityConversationSteps } from "./storage";

const ALLOW = Object.freeze({ decision: "allow" });

export const antigravityAgent = Object.freeze({
  descriptor: {
    id: "antigravity",
    displayName: "Antigravity",
    aliases: ["agy", "antigravity-cli"],
    presentation: { shortLabel: "AGY" }
  },
  definitionRevision: "antigravity-v1",
  command: { executable: "agy" },
  resume: {
    build: (commonArgs, sessionId) => [
      ...commonArgs,
      "--conversation",
      sessionId
    ]
  },
  hooks: {
    resolveLocalConfigPath: ({ agentStorageRoots }) =>
      agentStorageRoots.antigravity.hooksPath,
    portable: {
      format: "namespaced-hooks",
      relativePath: ".gemini/config/hooks.json",
      namespace: "kmux-antigravity",
      marker: "KMUX_MANAGED_ANTIGRAVITY_HOOK=1",
      managed: [
        { event: "PreInvocation" },
        { event: "PreToolUse", matcher: ".*" },
        { event: "Stop" }
      ],
      deprecated: ["PostToolUse", "PostInvocation"],
      outputMode: "json",
      successResponse: ALLOW,
      fallbackResponse: ALLOW,
      fallbackByEvent: {
        PreInvocation: {},
        PreToolUse: ALLOW,
        Stop: ALLOW
      },
      sessionClaim: {
        startEvents: ["PreInvocation"],
        sessionIdFields: ["conversationId", "conversation_id"]
      }
    },
    normalize(rawEvent, payload) {
      const normalized = rawEvent
        .trim()
        .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
        .replace(/_/gu, "-")
        .toLowerCase();
      const toolName = antigravityToolName(payload);
      const event =
        normalized === "pre-invocation"
          ? "session_start"
          : normalized === "pre-tool-use" &&
              (toolName === "ask_permission" || toolName === "ask_question")
            ? "needs_input"
            : normalized === "stop" &&
                booleanField(payload, "fullyIdle") !== false
              ? "turn_complete"
              : null;
      if (!event) return null;
      return commonHookResult({
        payload,
        result: {
          event,
          vendorSessionId: firstString(
            stringField(payload, "conversationId"),
            stringField(payload, "conversation_id")
          ),
          title:
            event === "needs_input" ? "Antigravity needs input" : undefined,
          message:
            event === "needs_input"
              ? antigravityNeedsInputMessage(payload, toolName)
              : undefined
        }
      });
    }
  },
  metadataSources: {
    revision: "antigravity-metadata-v1",
    defaultRoot: ".gemini/antigravity-cli",
    localQueryPlans: {
      "antigravity.conversation.steps.v1": {
        execute: queryAntigravityConversationSteps
      }
    },
    resolveLocalRoots(options) {
      const storage =
        options.agentStorageRoots ??
        resolveAgentStorageRoots({
          homeDir: options.homeDir,
          env: options.env
        });
      return resolveAgentSessionRoots({
        agentStorageRoots: storage,
        agentSettings: options.agentSettings
      }).antigravity;
    },
    sources: [
      {
        role: "antigravity-history",
        format: "jsonl",
        pattern: "history.jsonl",
        purposes: ["externalSessions", "history"],
        claimScope: "agent"
      },
      {
        role: "antigravity-transcript",
        format: "jsonl",
        pattern: "brain/*/.system_generated/logs/transcript.jsonl",
        purposes: ["externalSessions", "history", "usage"]
      },
      {
        role: "antigravity-conversation",
        format: "sqlite",
        pattern: "conversations/*.db",
        purposes: ["externalSessions", "history"],
        queryPlanIds: ["antigravity.conversation.steps.v1"]
      }
    ]
  },
  externalSessions: {
    createMetadataProjection(options) {
      return createAntigravityExternalSessionProjection({
        ...options,
        indexPath:
          options.agentSettings?.antigravity?.sessionRoot === undefined
            ? (options.indexPath ??
              antigravitySessionIndexPath(options.homeDir, options.env))
            : undefined
      });
    }
  },
  history: {
    createMetadataProjection(options) {
      return createAntigravityExternalSessionProjection({
        ...options,
        indexPath:
          options.agentSettings?.antigravity?.sessionRoot === undefined
            ? (options.indexPath ??
              antigravitySessionIndexPath(options.homeDir, options.env))
            : undefined
      });
    },
    createSourceProjection: createAntigravityHistorySourceProjection
  },
  usage: {
    pricingVendorId: "gemini",
    createSourceProjection: createAntigravityUsageSourceProjection,
    createLocalAdapter(options) {
      const env = options.env ?? process.env;
      const storage =
        options.agentStorageRoots ??
        resolveAgentStorageRoots({ homeDir: options.homeDir, env });
      const sessionRoots = resolveAgentSessionRoots({
        agentStorageRoots: storage,
        agentSettings: options.agentSettings
      }).antigravity;
      const overrideRoots =
        options.agentSettings?.antigravity?.sessionRoot === undefined
          ? absoluteUsageOverrideRoots(env.KMUX_ANTIGRAVITY_USAGE_DIR)
          : [];
      const roots =
        overrideRoots.length > 0
          ? overrideRoots
          : sessionRoots.map((root) => join(root, "brain"));
      const topologyRoots = normalizeSessionInventoryRoots([
        ...roots,
        ...sessionRoots
      ]);
      return createFileUsageAdapter({
        agentId: "antigravity",
        roots,
        topologyRoots,
        sourceProjection: createAntigravityUsageSourceProjection(),
        classifySource(candidate) {
          const role = classifyAntigravityMetadataPath(
            topologyRoots,
            candidate.path
          );
          return role === "antigravity-transcript"
            ? { role, format: "jsonl" }
            : null;
        },
        prepareProjection: prepareAntigravityUsageProjection,
        probeProjectionRevision: () =>
          antigravityUsageProjectionProbeRevision(topologyRoots),
        metadataInventory: options.metadataInventory,
        watchRecursive: usageWatchIsRecursive(
          options.platform ?? process.platform
        )
      });
    }
  },
  subscription: {
    createFetcher: (options) => async () => {
      const { fetchAntigravitySubscriptionUsage } =
        await import("./subscription");
      return fetchAntigravitySubscriptionUsage(options);
    },
    createAuthDetector: (options) => async () => {
      const { detectAntigravitySubscriptionAuth } =
        await import("./subscription");
      return detectAntigravitySubscriptionAuth(options);
    }
  },
  processDetection: {
    executableBasenames: ["agy", "antigravity", "antigravity-cli"]
  }
} satisfies AgentModule);

function antigravityToolName(
  payload: Record<string, unknown>
): string | undefined {
  return firstString(
    stringField(recordField(payload, "toolCall"), "name"),
    stringField(recordField(payload, "toolCall"), "toolName"),
    stringField(payload, "tool_name"),
    stringField(payload, "toolName"),
    stringField(payload, "name"),
    stringField(recordField(payload, "tool"), "name"),
    stringField(recordField(payload, "tool"), "toolName")
  )?.toLowerCase();
}

function antigravityNeedsInputMessage(
  payload: Record<string, unknown>,
  toolName: string | undefined
): string {
  if (toolName === "ask_question") {
    return firstString(
      stringField(payload, "message"),
      stringField(payload, "question"),
      stringField(recordField(payload, "toolInput"), "question"),
      "Question requested"
    )!;
  }
  if (toolName === "ask_permission") {
    return firstString(
      stringField(payload, "message"),
      stringField(payload, "reason"),
      "Tool permission requested"
    )!;
  }
  return needsInputFallback(payload);
}
