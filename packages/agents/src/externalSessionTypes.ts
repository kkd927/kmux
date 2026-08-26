import type { WorkspaceTarget } from "@kmux/core";
import type {
  ExternalAgentSessionRef,
  ExternalAgentSessionVendor,
  ExternalAgentSessionsSnapshot,
  SessionLaunchConfig
} from "@kmux/proto";

export interface ExternalSessionIndexer {
  listExternalAgentSessions():
    | ExternalAgentSessionsSnapshot
    | Promise<ExternalAgentSessionsSnapshot>;
  resolveExternalAgentSession(key: string): ExternalSessionResumeSpec | null;
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
