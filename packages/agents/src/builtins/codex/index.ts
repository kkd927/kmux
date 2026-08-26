import type { AgentModule } from "../../contracts";
import {
  createFileUsageAdapter,
  resolveAgentSessionRoots,
  resolveAgentStorageRoots
} from "@kmux/metadata";
import {
  commonHookResult,
  absoluteUsageOverrideRoots,
  firstString,
  needsInputFallback,
  recordField,
  stringField,
  summarizeTurnMessage,
  usageWatchIsRecursive
} from "../shared";
import {
  createCodexExternalSessionProjection,
  createCodexSessionSourceProjection
} from "./externalSessions";
import { classifyCodexMetadataPath } from "./inventory";
import { createCodexUsageSourceProjection } from "./usage";

export const codexAgent = Object.freeze({
  descriptor: {
    id: "codex",
    displayName: "Codex",
    aliases: [],
    presentation: { shortLabel: "CODEX" }
  },
  definitionRevision: "codex-v3",
  command: { executable: "codex" },
  commandWrapper: {
    homeEnvironmentVariable: "CODEX_HOME",
    defaultHomeRelativePath: ".codex",
    integrationRelativePath: "hooks.json",
    integrationContractMarker: "KMUX_AGENT_INTEGRATION_CONTRACT_VERSION=3",
    legacyHooksFeature: "codex_hooks",
    currentHooksFeature: "hooks",
    currentHooksFeatureMinor: 129,
    notificationMethod: "osc9"
  },
  resume: {
    build: (commonArgs, sessionId, options) => [
      ...commonArgs,
      "resume",
      ...(options?.fork ? ["--fork"] : []),
      sessionId
    ]
  },
  hooks: {
    resolveLocalConfigPath: ({ agentStorageRoots }) =>
      agentStorageRoots.codex.hooksPath,
    portable: {
      pathRoot: {
        defaultHomeRelativePath: ".codex",
        environmentVariable: "CODEX_HOME"
      },
      relativePath: "hooks.json",
      document: { eventsPath: ["hooks"] },
      entry: {
        commandField: "command",
        wrapper: { field: "hooks", when: "always" }
      },
      marker: "KMUX_MANAGED_CODEX_HOOK=1",
      managed: [
        { event: "SessionStart" },
        { event: "PermissionRequest" },
        { event: "Stop" }
      ],
      deprecated: ["UserPromptSubmit"],
      outputMode: "silent",
      successResponse: {},
      fallbackResponse: {},
      sessionClaim: {
        startEvents: ["SessionStart"],
        sessionIdFields: ["session_id", "sessionId"]
      }
    },
    normalize(rawEvent, payload) {
      const normalized = rawEvent
        .trim()
        .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
        .replace(/_/gu, "-")
        .toLowerCase();
      const event =
        normalized === "permission-request"
          ? "needs_input"
          : normalized === "stop" || normalized === "idle"
            ? "turn_complete"
            : normalized === "session-end"
              ? "session_end"
              : normalized === "session-start"
                ? "session_start"
                : null;
      if (!event) return null;
      return commonHookResult({
        payload,
        result: {
          event,
          vendorSessionId: firstString(
            stringField(payload, "session_id"),
            stringField(payload, "sessionId")
          ),
          title: event === "needs_input" ? "Codex needs input" : undefined,
          message:
            event === "turn_complete"
              ? summarizeTurnMessage(
                  stringField(payload, "last_assistant_message")
                )
              : event === "needs_input"
                ? firstString(
                    stringField(
                      recordField(payload, "tool_input"),
                      "description"
                    ),
                    needsInputFallback(payload)
                  )
                : undefined
        }
      });
    }
  },
  metadataSources: {
    revision: "codex-metadata-v3",
    pathRoot: {
      defaultHomeRelativePath: ".codex",
      environmentVariable: "CODEX_HOME"
    },
    defaultRoot: "sessions",
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
      }).codex;
    },
    sources: [
      {
        role: "codex-session",
        format: "jsonl",
        pattern: "**/*.jsonl",
        purposes: ["sessions", "usage"]
      }
    ]
  },
  sessions: {
    createMetadataProjection: createCodexExternalSessionProjection,
    createSourceProjection: createCodexSessionSourceProjection
  },
  usage: {
    pricingVendorId: "codex",
    createSourceProjection: createCodexUsageSourceProjection,
    createLocalAdapter(options) {
      const env = options.env ?? process.env;
      const storage =
        options.agentStorageRoots ??
        resolveAgentStorageRoots({ homeDir: options.homeDir, env });
      const configuredRoots = resolveAgentSessionRoots({
        agentStorageRoots: storage,
        agentSettings: options.agentSettings
      }).codex;
      const overrideRoots =
        options.agentSettings?.codex?.sessionRoot === undefined
          ? absoluteUsageOverrideRoots(env.KMUX_CODEX_USAGE_DIR)
          : [];
      const roots = overrideRoots.length > 0 ? overrideRoots : configuredRoots;
      return createFileUsageAdapter({
        agentId: "codex",
        roots,
        topologyRoots: roots,
        sourceProjection: createCodexUsageSourceProjection(),
        classifySource(candidate) {
          const role = classifyCodexMetadataPath(candidate.path);
          return role ? { role, format: "jsonl" } : null;
        },
        metadataInventory: options.metadataInventory,
        watchRecursive: usageWatchIsRecursive(
          options.platform ?? process.platform
        )
      });
    }
  },
  subscription: {
    createFetcher: (options) => async () => {
      const { fetchCodexSubscriptionUsage } = await import("./subscription");
      return fetchCodexSubscriptionUsage(options);
    },
    createAuthDetector: (options) => async () => {
      const { detectCodexSubscriptionAuth } = await import("./subscription");
      return detectCodexSubscriptionAuth(options);
    }
  },
  processDetection: {
    executableBasenames: ["codex"],
    wrapperAliases: ["codex.js"],
    packageNames: ["@openai/codex"]
  },
  terminalNotifications: { classify: classifyCodexTerminalNotification }
} satisfies AgentModule);

function classifyCodexTerminalNotification(title: string, message: string) {
  const normalized = `${title}\n${message}`.trim();
  const question = /\bquestion \d+\/\d+\b/iu.test(normalized);
  const submit = /\benter to submit answer\b/iu.test(normalized);
  if (question && /\bunanswered\b/iu.test(normalized)) {
    return {
      disposition: "needs_input" as const,
      reason: "question-unanswered"
    };
  }
  if (question && submit) {
    return { disposition: "needs_input" as const, reason: "question-submit" };
  }
  if (/\bplan mode prompt:/iu.test(normalized)) {
    return { disposition: "needs_input" as const, reason: "plan-mode-prompt" };
  }
  if (submit) {
    return {
      disposition: "needs_input" as const,
      reason: "enter-to-submit-answer"
    };
  }
  if (/\bneeds input\b/iu.test(normalized)) {
    return { disposition: "needs_input" as const, reason: "needs-input" };
  }
  if (/\bwaiting for input\b/iu.test(normalized)) {
    return { disposition: "needs_input" as const, reason: "waiting-for-input" };
  }
  return {
    disposition: "suppressed" as const,
    reason: "codex-terminal-chatter"
  };
}
