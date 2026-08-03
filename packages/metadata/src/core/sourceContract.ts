import rawSourceContract from "../../source-contract.json";

export type MetadataPurpose = "usage" | "history";
export type MetadataVendor = "claude" | "codex" | "antigravity";
export type MetadataSourceFormat = "jsonl" | "json" | "sqlite";
export type MetadataSourceRole =
  | "codex-session"
  | "claude-session"
  | "claude-subagent"
  | "antigravity-history"
  | "antigravity-transcript"
  | "antigravity-conversation";

export interface MetadataSourceContract {
  version: 1;
  capability: "agent-metadata-sources-v1";
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
    pattern: string;
  }>;
  queries: {
    antigravityConversationSteps: {
      id: "antigravity.conversation.steps.v1";
      sourceRole: "antigravity-conversation";
    };
  };
}

export const METADATA_SOURCE_CONTRACT = Object.freeze(
  rawSourceContract as MetadataSourceContract
);

if (METADATA_SOURCE_CONTRACT.version !== 1) {
  throw new Error("unsupported metadata source contract version");
}
