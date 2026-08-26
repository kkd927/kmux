import type { AgentModule } from "../../contracts";
import {
  createFileUsageAdapter,
  resolveAgentMetadataRoots,
  resolveAgentStorageRoots
} from "@kmux/metadata";

import {
  commonHookResult,
  firstString,
  needsInputFallback,
  normalizeHookEventName,
  stringField,
  summarizeTurnMessage,
  usageWatchIsRecursive
} from "../shared";
import {
  createCopilotExternalSessionProjection,
  createCopilotSessionSourceProjection
} from "./externalSessions";
import { classifyCopilotMetadataPath } from "./inventory";
import { buildCopilotResumeArgs } from "./resume";
import { createCopilotUsageSourceProjection } from "./usage";
import type {
  CopilotSubscriptionRuntime,
  CopilotSubscriptionUsageOptions
} from "./subscription";

const COPILOT_PATH_ROOT = {
  defaultHomeRelativePath: ".copilot",
  environmentVariable: "COPILOT_HOME"
} as const;

const copilotSubscriptionRuntimes = new WeakMap<
  CopilotSubscriptionUsageOptions,
  Promise<CopilotSubscriptionRuntime>
>();

function loadCopilotSubscriptionRuntime(
  options: CopilotSubscriptionUsageOptions
): Promise<CopilotSubscriptionRuntime> {
  const existing = copilotSubscriptionRuntimes.get(options);
  if (existing) return existing;
  const runtime = import("./subscription").then(
    ({ createCopilotSubscriptionRuntime }) =>
      createCopilotSubscriptionRuntime(options)
  );
  copilotSubscriptionRuntimes.set(options, runtime);
  return runtime;
}

export const copilotAgent = Object.freeze({
  descriptor: {
    id: "copilot",
    displayName: "GitHub Copilot",
    aliases: [],
    presentation: { shortLabel: "COPILOT" }
  },
  definitionRevision: "copilot-v1",
  command: { executable: "copilot" },
  resume: { build: buildCopilotResumeArgs },
  hooks: {
    portable: {
      pathRoot: COPILOT_PATH_ROOT,
      relativePath: "hooks/kmux.json",
      document: {
        eventsPath: ["hooks"],
        version: { field: "version", value: 1 }
      },
      entry: { commandField: "bash" },
      marker: "KMUX_MANAGED_COPILOT_HOOK=1",
      managed: [
        { event: "sessionStart" },
        { event: "notification" },
        { event: "agentStop" },
        { event: "sessionEnd" }
      ],
      deprecated: [],
      outputMode: "silent",
      successResponse: {},
      fallbackResponse: {},
      sessionClaim: {
        startEvents: ["sessionStart"],
        sessionIdFields: ["sessionId", "session_id"]
      }
    },
    normalize(rawEvent, payload) {
      const normalized = normalizeHookEventName(rawEvent);
      const notificationType = firstString(
        stringField(payload, "notification_type"),
        stringField(payload, "notificationType")
      );
      const event =
        normalized === "session-start"
          ? "session_start"
          : normalized === "notification" &&
              ["permission_prompt", "elicitation_dialog"].includes(
                notificationType ?? ""
              )
            ? "needs_input"
            : normalized === "agent-stop"
              ? "turn_complete"
              : normalized === "session-end"
                ? "session_end"
                : null;
      if (!event) return null;
      return commonHookResult({
        payload,
        result: {
          event,
          vendorSessionId: firstString(
            stringField(payload, "sessionId"),
            stringField(payload, "session_id")
          ),
          title: event === "needs_input" ? "Copilot needs input" : undefined,
          message:
            event === "needs_input"
              ? copilotNeedsInputMessage(payload)
              : event === "turn_complete"
                ? summarizeTurnMessage(
                    firstString(
                      stringField(payload, "summary"),
                      stringField(payload, "message"),
                      stringField(payload, "lastAssistantMessage")
                    )
                  )
                : undefined
        }
      });
    },
    normalizeNotification(rawEvent, payload) {
      if (normalizeHookEventName(rawEvent) !== "notification") return null;
      const title = firstString(stringField(payload, "title"), "Copilot")!;
      return {
        title,
        message:
          firstString(
            stringField(payload, "message"),
            stringField(payload, "body"),
            title
          ) ?? title
      };
    }
  },
  metadataSources: {
    revision: "copilot-metadata-v1",
    pathRoot: COPILOT_PATH_ROOT,
    defaultRoot: "session-state",
    sources: [
      {
        role: "copilot-session",
        format: "jsonl",
        pattern: "*/events.jsonl",
        purposes: ["sessions", "usage"]
      }
    ]
  },
  sessions: {
    createMetadataProjection: createCopilotExternalSessionProjection,
    createSourceProjection: createCopilotSessionSourceProjection
  },
  usage: {
    createSourceProjection: createCopilotUsageSourceProjection,
    createLocalAdapter(options) {
      const env = options.env ?? process.env;
      const storage =
        options.agentStorageRoots ??
        resolveAgentStorageRoots({ homeDir: options.homeDir, env });
      const roots = resolveAgentMetadataRoots({
        agentId: "copilot",
        homeDir: storage.homeDir,
        env,
        pathRoot: COPILOT_PATH_ROOT,
        defaultRoot: "session-state",
        agentSettings: options.agentSettings
      });
      return createFileUsageAdapter({
        agentId: "copilot",
        roots,
        topologyRoots: roots,
        sourceProjection: createCopilotUsageSourceProjection(),
        classifySource(candidate) {
          const role = classifyCopilotMetadataPath(roots, candidate.path);
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
    createFetcher: (options) => async () =>
      (await loadCopilotSubscriptionRuntime(options)).fetch(),
    createAuthDetector: (options) => async () =>
      (await loadCopilotSubscriptionRuntime(options)).detectAuth()
  },
  processDetection: {
    executableBasenames: ["copilot"],
    wrapperAliases: ["npm-loader.js"],
    packageNames: ["@github/copilot"]
  }
} satisfies AgentModule);

function copilotNeedsInputMessage(payload: Record<string, unknown>): string {
  return (
    firstString(
      stringField(payload, "message"),
      stringField(payload, "body")
    ) ?? needsInputFallback(payload)
  );
}
