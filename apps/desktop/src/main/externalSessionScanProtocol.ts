import type { AgentStorageRoots } from "@kmux/metadata";
import type { ExternalAgentSessionsSnapshot, KmuxSettings } from "@kmux/proto";

import type { ExternalSessionResumeSpec } from "./externalSessions";

export interface ExternalSessionScanWorkerConfig {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  agentStorageRoots?: AgentStorageRoots;
  settings?: Pick<KmuxSettings, "agents">;
  antigravitySessionIndexPath?: string;
}

export type ExternalSessionScanWorkerRequest =
  | {
      type: "init";
      requestId: string;
      config: ExternalSessionScanWorkerConfig;
    }
  | {
      type: "scan";
      requestId: string;
    }
  | {
      type: "shutdown";
    };

export type ExternalSessionScanWorkerResponse =
  | {
      type: "ready";
      requestId: string;
    }
  | {
      type: "scan-result";
      requestId: string;
      snapshot: ExternalAgentSessionsSnapshot;
      resumeSpecs: ExternalSessionResumeSpec[];
    }
  | {
      type: "error";
      requestId: string;
      message: string;
      stack?: string;
      context: string;
    };
