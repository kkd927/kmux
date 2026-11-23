import type { FileOrchestrationArtifactStore } from "./artifacts";
import type { JsonValue, WorkerOutputArchive } from "./types";
import { workerOutputCanBeArchived } from "./workerOutput";

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const ARCHIVE_KIND = "worker-output";

/** The snapshot contains an immutable reference; only worker-read loads its body. */
export class FileWorkerOutputArchives {
  constructor(private readonly artifacts: FileOrchestrationArtifactStore) {}

  async capture(history: JsonValue): Promise<WorkerOutputArchive> {
    if (!workerOutputCanBeArchived(history)) {
      throw new Error("Worker history is missing or unreadable");
    }
    const value = history as Record<string, JsonValue>;
    const artifact = await this.artifacts.put({
      kind: ARCHIVE_KIND,
      bytes: Buffer.from(JSON.stringify(history), "utf8"),
      maxBytes: MAX_ARCHIVE_BYTES
    });
    const hasText = [value.vt, value.rawOutputTail].some(
      (text) => typeof text === "string" && text.length > 0
    );
    return {
      artifact,
      source: value.source === "transcript" ? "transcript" : "terminal",
      status: hasText ? "available" : "empty",
      truncated: value.truncated === true
    };
  }

  async read(archive: WorkerOutputArchive): Promise<JsonValue> {
    const bytes = await this.artifacts.get({
      artifact: archive.artifact,
      expectedKind: ARCHIVE_KIND,
      maxBytes: MAX_ARCHIVE_BYTES
    });
    const history = JSON.parse(
      Buffer.from(bytes).toString("utf8")
    ) as JsonValue;
    if (!workerOutputCanBeArchived(history)) {
      throw new Error("Archived Worker history is missing or unreadable");
    }
    return history;
  }
}
