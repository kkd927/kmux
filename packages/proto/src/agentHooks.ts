import type { AgentEventName, Id, NotificationItem } from "./index";

export interface AgentHookEnvironment {
  KMUX_WORKSPACE_ID?: string;
  KMUX_SURFACE_ID?: string;
  KMUX_SESSION_ID?: string;
}

export interface NormalizedAgentEvent {
  workspaceId?: Id;
  paneId?: Id;
  surfaceId?: Id;
  sessionId?: Id;
  vendorSessionId?: string;
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
