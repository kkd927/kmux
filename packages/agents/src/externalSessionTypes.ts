import type { WorkspaceTarget } from "@kmux/core";
import type {
  ExternalAgentSessionRef,
  ExternalAgentSessionVendor,
  ExternalAgentSessionsSnapshot,
  SessionLaunchConfig
} from "@kmux/proto";

export type ExternalSessionScanPurpose = "externalSessions" | "history";

export interface AgentHistorySessionIndexer {
  listAgentHistorySessions():
    | ExternalAgentSessionsSnapshot
    | Promise<ExternalAgentSessionsSnapshot>;
}

export interface ExternalSessionIndexer {
  listExternalAgentSessions():
    | ExternalAgentSessionsSnapshot
    | Promise<ExternalAgentSessionsSnapshot>;
  resolveExternalAgentSession(
    key: string,
    purpose?: ExternalSessionScanPurpose
  ): ExternalSessionResumeSpec | null;
  close?(): void;
}

export interface ExternalSessionResumeSpec {
  key: string;
  vendor: ExternalAgentSessionVendor;
  agentSessionRef: ExternalAgentSessionRef;
  title: string;
  target: WorkspaceTarget;
  cwd?: string;
  launch: SessionLaunchConfig;
}
