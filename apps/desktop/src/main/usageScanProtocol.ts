import type { ExternalSessionResumeSpec } from "@kmux/agents";
import type {
  AgentStorageRoots,
  UsageAdapterScanFailure,
  UsageAdapterDirtyOptions,
  UsageAdapterReadResult,
  UsageVendor
} from "@kmux/metadata";
import type { AgentScopeSettings } from "@kmux/proto";
import type { ExternalAgentSessionsSnapshot } from "@kmux/proto";

export interface UsageScanWorkerConfig {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  agentStorageRoots?: AgentStorageRoots;
  agentSettings?: AgentScopeSettings;
  platform: NodeJS.Platform;
  antigravitySessionIndexPath?: string;
}

export type UsageScanWorkerRequest =
  | {
      type: "init";
      requestId: string;
      config: UsageScanWorkerConfig;
    }
  | {
      type: "scan";
      requestId: string;
      startOfDayMs: number;
      initial: boolean;
    }
  | {
      type: "external-sessions-scan";
      requestId: string;
    }
  | {
      type: "reconfigure";
      requestId: string;
      agentSettings?: AgentScopeSettings;
    }
  | {
      type: "mark-dirty";
      vendor: Exclude<UsageVendor, "unknown">;
      options?: UsageAdapterDirtyOptions;
    }
  | { type: "shutdown" };

export type UsageScanWorkerResponse =
  | { type: "ready"; requestId: string }
  | {
      type: "scan-result";
      requestId: string;
      reads: UsageAdapterReadResult[];
      failures: UsageAdapterScanFailure[];
    }
  | {
      type: "external-sessions-scan-result";
      requestId: string;
      snapshot: ExternalAgentSessionsSnapshot;
      resumeSpecs: ExternalSessionResumeSpec[];
    }
  | { type: "changed"; vendor: UsageVendor }
  | {
      type: "error";
      requestId: string;
      message: string;
      stack?: string;
      context?: string;
    };
