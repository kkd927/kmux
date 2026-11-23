import type { AgentModule } from "../../contracts";
import {
  createFileUsageAdapter,
  resolveAgentSessionRoots,
  resolveAgentStorageRoots
} from "@kmux/metadata";
import {
  arrayField,
  absoluteUsageOverrideRoots,
  commonHookResult,
  firstString,
  needsInputFallback,
  recordField,
  stringField,
  summarizeTurnMessage,
  usageWatchIsRecursive
} from "../shared";
import {
  claudeSessionTranscript,
  createClaudeExternalSessionProjection,
  createClaudeSessionSourceProjection
} from "./externalSessions";
import { classifyClaudeMetadataPath } from "./inventory";
import { createClaudeUsageSourceProjection } from "./usage";
import { createGlobalAgentSkillPlacement } from "../../skillPlacement";
import { listClaudeModels } from "./models";
import { classifyClaudeTerminalReadiness } from "./terminalReadiness";

export const claudeAgent = Object.freeze({
  descriptor: {
    id: "claude",
    displayName: "Claude",
    aliases: [],
    presentation: { shortLabel: "CLAUDE" }
  },
  definitionRevision: "claude-v5",
  command: { executable: "claude" },
  terminalReadiness: { classify: classifyClaudeTerminalReadiness },
  launchPreferences: {
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    listModels: listClaudeModels,
    buildArgs: (preferences) => [
      ...(preferences.model ? ["--model", preferences.model] : []),
      ...(preferences.effort ? ["--effort", preferences.effort] : [])
    ]
  },
  skillPlacement: createGlobalAgentSkillPlacement({
    defaultHomeRelativePath: ".claude"
  }),
  resume: {
    build: (commonArgs, sessionId, options) => [
      ...commonArgs,
      options?.fork ? "--fork-session" : "--resume",
      sessionId
    ],
    supportsFork: true
  },
  hooks: {
    resolveLocalConfigPath: ({ agentStorageRoots }) =>
      agentStorageRoots.claude.settingsPath,
    portable: {
      relativePath: ".claude/settings.json",
      document: { eventsPath: ["hooks"] },
      entry: {
        commandField: "command",
        wrapper: { field: "hooks", when: "always" }
      },
      marker: "KMUX_MANAGED_CLAUDE_HOOK=1",
      managed: [
        { event: "PermissionRequest" },
        { event: "PreToolUse", matcher: "AskUserQuestion|ExitPlanMode" },
        { event: "SessionStart" },
        { event: "Stop" }
      ],
      deprecated: [
        "Notification",
        "PostToolUse",
        "SessionEnd",
        "UserPromptSubmit"
      ],
      outputMode: "silent",
      successResponse: {},
      fallbackResponse: {},
      sessionClaim: {
        startEvents: ["SessionStart"],
        sessionIdFields: ["session_id", "sessionId"]
      }
    },
    normalize(rawEvent, payload) {
      const event = normalizeClaudeEvent(rawEvent, payload);
      if (!event) return null;
      return commonHookResult({
        payload,
        result: {
          event,
          vendorSessionId: firstString(
            stringField(payload, "session_id"),
            stringField(payload, "sessionId")
          ),
          title: event === "needs_input" ? "Claude needs input" : undefined,
          message:
            event === "turn_complete"
              ? summarizeTurnMessage(
                  stringField(payload, "last_assistant_message")
                )
              : event === "needs_input"
                ? claudeQuestion(payload)
                : undefined
        }
      });
    },
    normalizeNotification(rawEvent, payload) {
      const event = rawEvent.trim().replace(/_/gu, "-").toLowerCase();
      if (event !== "notification" && event !== "notify") return null;
      const title =
        firstString(stringField(payload, "title"), "Claude") ?? "Claude";
      return {
        title,
        message:
          firstString(
            stringField(payload, "message"),
            stringField(payload, "body"),
            stringField(payload, "text"),
            stringField(payload, "prompt"),
            stringField(payload, "reason"),
            title
          ) ?? title
      };
    }
  },
  metadataSources: {
    revision: "claude-metadata-v2",
    defaultRoot: ".claude/projects",
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
      }).claude;
    },
    sources: [
      {
        role: "claude-session",
        format: "jsonl",
        pattern: "**/*.jsonl",
        purposes: ["sessions", "usage"]
      },
      {
        role: "claude-subagent",
        format: "jsonl",
        pattern: "**/subagents/*.jsonl",
        purposes: ["usage"]
      }
    ]
  },
  sessions: {
    transcript: claudeSessionTranscript,
    createMetadataProjection: createClaudeExternalSessionProjection,
    createSourceProjection: createClaudeSessionSourceProjection
  },
  usage: {
    pricingVendorId: "claude",
    createSourceProjection: createClaudeUsageSourceProjection,
    createLocalAdapter(options) {
      const env = options.env ?? process.env;
      const storage =
        options.agentStorageRoots ??
        resolveAgentStorageRoots({ homeDir: options.homeDir, env });
      const configuredRoots = resolveAgentSessionRoots({
        agentStorageRoots: storage,
        agentSettings: options.agentSettings
      }).claude;
      const overrideRoots =
        options.agentSettings?.claude?.sessionRoot === undefined
          ? absoluteUsageOverrideRoots(env.KMUX_CLAUDE_USAGE_DIR)
          : [];
      const roots = overrideRoots.length > 0 ? overrideRoots : configuredRoots;
      return createFileUsageAdapter({
        agentId: "claude",
        roots,
        topologyRoots: roots,
        sourceProjection: createClaudeUsageSourceProjection(),
        classifySource(candidate) {
          const role = classifyClaudeMetadataPath(candidate.path);
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
      const { fetchClaudeSubscriptionUsage } = await import("./subscription");
      return fetchClaudeSubscriptionUsage(options);
    },
    createAuthDetector: (options) => async () => {
      const { detectClaudeSubscriptionAuth } = await import("./subscription");
      return detectClaudeSubscriptionAuth(options);
    }
  },
  processDetection: {
    executableBasenames: ["claude", "claude-code"],
    packageNames: ["@anthropic-ai/claude-code"]
  }
} satisfies AgentModule);

function normalizeClaudeEvent(
  rawEvent: string,
  payload: Record<string, unknown>
) {
  const event = rawEvent
    .trim()
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/_/gu, "-")
    .toLowerCase();
  if (event === "permission-request") return "needs_input" as const;
  if (
    event === "pre-tool-use" &&
    ["AskUserQuestion", "ExitPlanMode"].includes(
      stringField(payload, "tool_name") ?? ""
    )
  )
    return "needs_input" as const;
  if (event === "stop" || event === "idle") return "turn_complete" as const;
  if (event === "session-end") return "session_end" as const;
  if (event === "session-start") return "session_start" as const;
  return null;
}

function claudeQuestion(payload: Record<string, unknown>): string {
  if (stringField(payload, "tool_name") === "ExitPlanMode") {
    return firstString(
      stringField(payload, "message"),
      "Plan ready for approval"
    )!;
  }
  const firstQuestion = arrayField(
    recordField(payload, "tool_input"),
    "questions"
  )[0];
  const record =
    firstQuestion &&
    typeof firstQuestion === "object" &&
    !Array.isArray(firstQuestion)
      ? (firstQuestion as Record<string, unknown>)
      : undefined;
  const question =
    firstString(
      stringField(record, "question"),
      stringField(record, "header"),
      stringField(record, "prompt")
    ) ?? needsInputFallback(payload);
  const options = arrayField(record, "options")
    .map((option) => {
      if (typeof option === "string") return option.trim();
      const optionRecord =
        option && typeof option === "object" && !Array.isArray(option)
          ? (option as Record<string, unknown>)
          : undefined;
      return firstString(
        stringField(optionRecord, "label"),
        stringField(optionRecord, "value")
      );
    })
    .filter((option): option is string => Boolean(option))
    .slice(0, 3);
  return options.length === 0
    ? question
    : `${question} (${options.join(", ")})`;
}
