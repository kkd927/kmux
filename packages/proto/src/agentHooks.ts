import type { AgentEventName, Id, NotificationItem } from "./index";

export interface AgentHookEnvironment {
  KMUX_WORKSPACE_ID?: string;
  KMUX_PANE_ID?: string;
  KMUX_SURFACE_ID?: string;
  KMUX_SESSION_ID?: string;
}

export interface NormalizedAgentEvent {
  workspaceId?: Id;
  paneId?: Id;
  surfaceId?: Id;
  sessionId?: Id;
  agent: string;
  event: AgentEventName;
  title?: string;
  message?: string;
  details?: Record<string, unknown>;
}

export interface NormalizedHookNotification {
  workspaceId?: Id;
  paneId?: Id;
  surfaceId?: Id;
  sessionId?: Id;
  agent: string;
  source: NotificationItem["source"];
  title: string;
  message: string;
}

type HookPayload = Record<string, unknown>;

export function normalizeAgentHookInvocation(
  agentInput: string,
  hookEventInput: string,
  payload: HookPayload = {},
  environment: AgentHookEnvironment = {}
): NormalizedAgentEvent | null {
  const agent = normalizeAgentName(agentInput);
  const hookEvent = normalizeHookEventName(
    hookEventInput || stringField(payload, "hook_event_name") || ""
  );
  const event = mapAgentHookEvent(agent, hookEvent, payload);
  if (!event) {
    return null;
  }

  const target = resolveHookTarget(payload, environment);
  const message = extractHookMessage(agent, event, payload);
  const displayName = agentDisplayName(agent);

  const details = compactDetails(payload);
  const hookEventArg = hookEventInput.trim();
  if (hookEventArg) {
    details.kmux_hook_event_arg = hookEventArg.slice(0, 160);
  }

  return {
    workspaceId: target.workspaceId,
    paneId: target.paneId,
    surfaceId: target.surfaceId,
    sessionId: target.sessionId,
    agent,
    event,
    title: event === "needs_input" ? `${displayName} needs input` : undefined,
    message,
    details
  };
}

export function normalizeHookNotificationInvocation(
  agentInput: string,
  hookEventInput: string,
  payload: HookPayload = {},
  environment: AgentHookEnvironment = {}
): NormalizedHookNotification | null {
  const agent = normalizeAgentName(agentInput);
  const hookEvent = normalizeHookEventName(
    hookEventInput || stringField(payload, "hook_event_name") || ""
  );
  if (!isClaudeNotificationHook(agent, hookEvent)) {
    return null;
  }

  const target = resolveHookTarget(payload, environment);
  const title =
    firstString(stringField(payload, "title"), agentDisplayName(agent)) ??
    agentDisplayName(agent);
  const message =
    firstString(
      stringField(payload, "message"),
      stringField(payload, "body"),
      stringField(payload, "text"),
      stringField(payload, "prompt"),
      stringField(payload, "reason"),
      title,
      "Notification"
    ) ?? title;

  return {
    workspaceId: target.workspaceId,
    paneId: target.paneId,
    surfaceId: target.surfaceId,
    sessionId: target.sessionId,
    agent,
    source: "agent",
    title,
    message
  };
}

function normalizeAgentName(agent: string): string {
  return agent
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]/g, "_");
}

function normalizeHookEventName(eventName: string): string {
  return eventName
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

function mapAgentHookEvent(
  agent: string,
  hookEvent: string,
  payload: HookPayload
): AgentEventName | null {
  if (agent === "claude") {
    if (hookEvent === "permission-request") {
      return "needs_input";
    }
    if (
      hookEvent === "pre-tool-use" &&
      stringField(payload, "tool_name") === "AskUserQuestion"
    ) {
      return "needs_input";
    }
    if (
      hookEvent === "pre-tool-use" ||
      hookEvent === "post-tool-use" ||
      hookEvent === "prompt-submit" ||
      hookEvent === "user-prompt-submit"
    ) {
      return "running";
    }
    if (hookEvent === "stop" || hookEvent === "idle") {
      return "turn_complete";
    }
    if (hookEvent === "session-end") {
      return "session_end";
    }
    if (hookEvent === "session-start") {
      return "session_start";
    }
  }

  if (agent === "gemini") {
    if (
      hookEvent === "notification" &&
      stringField(payload, "notification_type") === "ToolPermission"
    ) {
      return "needs_input";
    }
    if (
      hookEvent === "before-agent" ||
      hookEvent === "before-tool" ||
      hookEvent === "after-tool"
    ) {
      return "running";
    }
    if (hookEvent === "after-agent" || hookEvent === "idle") {
      return "turn_complete";
    }
    if (hookEvent === "session-end") {
      return "session_end";
    }
    if (hookEvent === "session-start") {
      return "session_start";
    }
  }

  if (agent === "codex") {
    if (
      hookEvent === "user-prompt-submit" ||
      hookEvent === "prompt-submit" ||
      hookEvent === "pre-tool-use"
    ) {
      return "running";
    }
    if (hookEvent === "stop" || hookEvent === "idle") {
      return "turn_complete";
    }
    if (hookEvent === "session-end") {
      return "session_end";
    }
    if (hookEvent === "session-start") {
      return "session_start";
    }
  }

  return null;
}

function isClaudeNotificationHook(agent: string, hookEvent: string): boolean {
  return (
    agent === "claude" &&
    (hookEvent === "notification" || hookEvent === "notify")
  );
}

function resolveHookTarget(
  payload: HookPayload,
  environment: AgentHookEnvironment
): {
  workspaceId?: Id;
  paneId?: Id;
  surfaceId?: Id;
  sessionId?: Id;
} {
  const surfaceId = firstString(
    stringField(payload, "surface_id"),
    stringField(payload, "surfaceId"),
    environment.KMUX_SURFACE_ID
  );
  const sessionId = firstString(
    stringField(payload, "session_id"),
    stringField(payload, "sessionId"),
    environment.KMUX_SESSION_ID,
    surfaceId
  );

  return {
    workspaceId: firstString(
      stringField(payload, "workspace_id"),
      stringField(payload, "workspaceId"),
      environment.KMUX_WORKSPACE_ID
    ),
    paneId: firstString(
      stringField(payload, "pane_id"),
      stringField(payload, "paneId"),
      environment.KMUX_PANE_ID
    ),
    surfaceId,
    sessionId
  };
}

function extractHookMessage(
  agent: string,
  event: AgentEventName,
  payload: HookPayload
): string | undefined {
  if (event === "running") {
    return "Running";
  }
  if (event !== "needs_input") {
    return undefined;
  }

  if (agent === "claude") {
    const question = extractClaudeQuestion(payload);
    if (question) {
      return question;
    }
  }

  if (agent === "gemini") {
    const details = recordField(payload, "details");
    const toolName = firstString(
      stringField(payload, "tool_name"),
      stringField(details, "tool_name"),
      stringField(details, "toolName")
    );
    if (toolName) {
      return `Tool permission requested: ${toolName}`;
    }
    return firstString(
      stringField(payload, "message"),
      "Tool permission requested"
    );
  }

  return firstString(
    stringField(payload, "message"),
    stringField(payload, "body"),
    stringField(payload, "text"),
    stringField(payload, "prompt"),
    stringField(payload, "reason"),
    "Needs input"
  );
}

function extractClaudeQuestion(payload: HookPayload): string | undefined {
  const toolInput = recordField(payload, "tool_input");
  const questions = arrayField(toolInput, "questions");
  const firstQuestion = recordValue(questions[0]);
  const questionText = firstString(
    stringField(firstQuestion, "question"),
    stringField(firstQuestion, "header"),
    stringField(firstQuestion, "prompt"),
    stringField(payload, "message")
  );
  if (!questionText) {
    return undefined;
  }

  const options = arrayField(firstQuestion, "options")
    .map((option) => {
      if (typeof option === "string") {
        return option.trim();
      }
      const optionRecord = recordValue(option);
      return firstString(
        stringField(optionRecord, "label"),
        stringField(optionRecord, "value")
      );
    })
    .filter((option): option is string => Boolean(option))
    .slice(0, 3);

  if (options.length === 0) {
    return questionText;
  }
  return `${questionText} (${options.join(", ")})`;
}

function compactDetails(payload: HookPayload): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  for (const key of [
    "hook_event_name",
    "notification_type",
    "tool_name",
    "session_id",
    "surface_id"
  ]) {
    const value = stringField(payload, key);
    if (value) {
      details[key] = value.slice(0, 160);
    }
  }
  return details;
}

function agentDisplayName(agent: string): string {
  switch (agent) {
    case "claude":
      return "Claude";
    case "gemini":
      return "Gemini";
    case "codex":
      return "Codex";
    default:
      return agent
        .replace(/[_-]+/g, " ")
        .replace(/\b\w/g, (character) => character.toUpperCase());
  }
}

function firstString(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function stringField(
  record: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function recordField(
  record: Record<string, unknown> | undefined,
  key: string
): Record<string, unknown> | undefined {
  return recordValue(record?.[key]);
}

function arrayField(
  record: Record<string, unknown> | undefined,
  key: string
): unknown[] {
  const value = record?.[key];
  return Array.isArray(value) ? value : [];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
