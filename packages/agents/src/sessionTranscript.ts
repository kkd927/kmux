import type { AgentId } from "@kmux/proto";
import type { AgentMetadataInventoryService } from "@kmux/metadata";
import type {
  AgentSessionTranscriptCapability,
  AgentSessionTranscriptMessage,
  AgentSessionTranscriptReadResult
} from "./contracts";

const MAX_TRANSCRIPT_BYTES = 256 * 1024;

/** Read only the attested provider session, with bounded I/O through the shared inventory. */
export async function readAgentSessionTranscript(input: {
  readonly agentId: AgentId;
  readonly sessionId: string;
  readonly roots: readonly string[];
  readonly capability: AgentSessionTranscriptCapability;
  readonly metadataInventory: AgentMetadataInventoryService;
  readonly dispatchMarker?: string;
  readonly maxBytes?: number;
}): Promise<AgentSessionTranscriptReadResult> {
  if (!input.sessionId || /[/\\\0]/u.test(input.sessionId)) {
    return {
      status: "missing",
      text: "",
      truncated: false,
      reason: "invalid provider session identity"
    };
  }
  const lease = input.metadataInventory.acquire(input.agentId, input.roots);
  try {
    // Completion may arrive before the metadata watcher's debounce flushes.
    lease.invalidate();
    const inventory = await lease.inventory();
    const candidate = inventory.candidates
      .filter((entry) =>
        input.capability.matchesPath({ ...input, path: entry.path })
      )
      .sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))[0];
    if (!candidate) {
      const failed = inventory.diagnostics.find(
        (entry) =>
          entry.kind === "directory-unreadable" ||
          entry.kind === "entry-unreadable" ||
          (entry.kind === "root-unavailable" &&
            entry.message &&
            !entry.message.includes("ENOENT"))
      );
      if (failed)
        return {
          status: "unreadable",
          text: "",
          truncated: inventory.truncated,
          reason:
            failed.message ?? "provider transcript inventory could not be read"
        };
      return {
        status: "missing",
        text: "",
        truncated: inventory.truncated,
        reason: "provider session transcript was not found"
      };
    }
    const budget = Math.max(
      1,
      Math.min(MAX_TRANSCRIPT_BYTES, input.maxBytes ?? MAX_TRANSCRIPT_BYTES)
    );
    const offset = Math.max(0, candidate.size - budget);
    let text = await lease.readText({
      path: candidate.path,
      offset,
      maxBytes: budget
    });
    if (offset > 0) {
      const preceding = await lease.readText({
        path: candidate.path,
        offset: offset - 1,
        maxBytes: 1
      });
      if (preceding !== "\n") {
        const newline = text.indexOf("\n");
        text = newline < 0 ? "" : text.slice(newline + 1);
      }
    }
    const messages: AgentSessionTranscriptMessage[] = [];
    let malformed = false;
    for (const line of text.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      try {
        const message = input.capability.decodeRecord(JSON.parse(line));
        if (message) messages.push(message);
      } catch {
        malformed = true;
      }
    }
    const truncated = offset > 0 || malformed || inventory.truncated;
    // A session can outlive several Tasks. Never substitute its current tail for
    // a requested Dispatch whose boundary has already fallen out of the budget.
    const dispatchMarkers = messages.map((entry) =>
      entry.role === "user"
        ? entry.text.match(/(?:^|\n)(\[kmux-dispatch:[^\]\s]+\])\s*$/u)?.[1]
        : undefined
    );
    const boundary = input.dispatchMarker
      ? dispatchMarkers.lastIndexOf(input.dispatchMarker)
      : -1;
    if (input.dispatchMarker && boundary < 0) {
      return {
        status: "missing",
        text: "",
        truncated,
        reason:
          "Requested Dispatch boundary is not retained in provider transcript"
      };
    }
    const nextBoundary =
      boundary >= 0
        ? dispatchMarkers.findIndex(
            (marker, index) => index > boundary && marker !== undefined
          )
        : -1;
    const selected =
      boundary >= 0
        ? messages.slice(boundary, nextBoundary < 0 ? undefined : nextBoundary)
        : messages;
    const transcript = selected
      .map((entry) => `[${entry.role}]\n${entry.text}`)
      .join("\n\n");
    return {
      status: transcript ? "available" : "empty",
      text: transcript,
      truncated,
      ...(malformed
        ? { reason: "incomplete or malformed JSONL records were skipped" }
        : {})
    };
  } catch (error) {
    return {
      status: "unreadable",
      text: "",
      truncated: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await lease.release();
  }
}
