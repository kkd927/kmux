import type {
  AgentStorageRoots,
  UsageAdapterDirtyOptions,
  UsageAdapterReadResult,
  UsageVendor
} from "@kmux/metadata";
import type { AgentScopeSettings } from "@kmux/proto";

export interface UsageScanWorkerConfig {
  env: NodeJS.ProcessEnv;
  homeDir?: string;
  agentStorageRoots?: AgentStorageRoots;
  agentSettings?: AgentScopeSettings;
  platform: NodeJS.Platform;
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
    }
  | { type: "changed"; vendor: UsageVendor }
  | {
      type: "error";
      requestId: string;
      message: string;
      stack?: string;
      context?: string;
    };
