import rawSourceContract from "../../source-contract.json";
import type { AgentId, MetadataSourceRoleId } from "@kmux/proto";

export type MetadataPurpose = "usage" | "history";
export type MetadataVendor = AgentId;
export type MetadataSourceFormat = "jsonl" | "json" | "sqlite";
export type MetadataSourceRole = MetadataSourceRoleId;

export interface MetadataSourceContract {
  version: 2;
  capability: "agent-metadata-sources-v2";
  limits: {
    sourceReadBytes: number;
    responseBytes: number;
    queryRows: number;
    queryExecutionMs: number;
  };
  sources: Array<{
    vendor: MetadataVendor;
    role: MetadataSourceRole;
    format: MetadataSourceFormat;
    purposes: MetadataPurpose[];
    claimScope?: "session" | "agent";
    pattern: string;
  }>;
  queries: Record<string, { id: string; sourceRole: MetadataSourceRole }>;
}

export const METADATA_SOURCE_CONTRACT = Object.freeze(
  rawSourceContract as MetadataSourceContract
);

if (METADATA_SOURCE_CONTRACT.version !== 2) {
  throw new Error("unsupported metadata source contract version");
}
