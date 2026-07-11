import type {
  AgentStorageRoots,
  UsageAdapterDirtyOptions,
  UsageAdapterReadResult,
  UsageHistoryDay,
  UsageVendor
} from "@kmux/metadata";

export interface UsageScanWorkerConfig {
  env: NodeJS.ProcessEnv;
  homeDir?: string;
  agentStorageRoots?: AgentStorageRoots;
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
      historyRange?: { fromMs: number; toMs: number };
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
      historyDays?: UsageHistoryDay[];
    }
  | { type: "changed"; vendor: UsageVendor }
  | {
      type: "error";
      requestId: string;
      message: string;
      stack?: string;
      context?: string;
    };
