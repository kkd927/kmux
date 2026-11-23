import { FileOrchestrationArtifactStore } from "./artifacts";
import { FileWorkerOutputArchives } from "./workerOutputArchives";
import { writePrivateFileAtomic } from "./nodePersistence";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { createEmptyOrchestrationSnapshot } from "./runtime";
import { InMemoryOrchestrationStore } from "./store";
import {
  OrchestrationError,
  type OrchestrationSnapshot,
  type JsonValue
} from "./types";

export class FileOrchestrationStore extends InMemoryOrchestrationStore {
  private constructor(
    private readonly filePath: string,
    snapshot: OrchestrationSnapshot,
    readonly workerOutputArchives: FileWorkerOutputArchives,
    now?: () => string,
    id?: (kind: string) => string
  ) {
    super(snapshot, now, id);
  }

  static async open(options: {
    filePath: string;
    artifactRoot?: string;
    now?: () => string;
    id?: (kind: string) => string;
  }): Promise<FileOrchestrationStore> {
    const loaded = await loadSnapshot(options.filePath);
    const archives = new FileWorkerOutputArchives(
      new FileOrchestrationArtifactStore({
        root:
          options.artifactRoot ??
          join(dirname(options.filePath), "orchestration-artifacts"),
        now: options.now,
        id: options.id
      })
    );
    const snapshot = await externalizeInlineWorkerHistories(loaded, archives);
    const store = new FileOrchestrationStore(
      options.filePath,
      snapshot,
      archives,
      options.now,
      options.id
    );
    // Preserve existing saved histories before publishing the smaller snapshot.
    if (snapshot !== loaded) await store.persist(snapshot);
    return store;
  }

  protected override async persist(
    snapshot: OrchestrationSnapshot
  ): Promise<void> {
    await writePrivateFileAtomic(
      this.filePath,
      `${JSON.stringify(snapshot)}\n`
    );
  }
}

async function loadSnapshot(filePath: string): Promise<OrchestrationSnapshot> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return createEmptyOrchestrationSnapshot();
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new OrchestrationError(
      "invalid",
      "orchestration store contains invalid JSON",
      {
        cause: error instanceof Error ? error.message : String(error)
      }
    );
  }
  if (!isSnapshotV1(value)) {
    const version =
      value !== null && typeof value === "object" && "storeVersion" in value
        ? String(value.storeVersion)
        : "missing";
    throw new OrchestrationError(
      version === "1" ? "invalid" : "unsupported",
      `orchestration store version '${version}' is not readable`
    );
  }
  return normalizeSnapshotV1(value);
}

function normalizeSnapshotV1(
  snapshot: OrchestrationSnapshot
): OrchestrationSnapshot {
  return {
    ...snapshot,
    workflowDrafts: snapshot.workflowDrafts ?? {},
    currentRunByPrincipal: snapshot.currentRunByPrincipal ?? {},
    runs: Object.fromEntries(
      Object.entries(snapshot.runs).map(([runId, run]) => [
        runId,
        {
          ...run,
          readinessReceipts: run.readinessReceipts ?? {},
          attemptResults: run.attemptResults ?? {},
          cancellations: run.cancellations ?? {},
          manualRetries: run.manualRetries ?? {},
          inputControls: run.inputControls ?? {},
          inputInterventions: run.inputInterventions ?? [],
          tasks: run.tasks ?? {}
        }
      ])
    )
  };
}

function isSnapshotV1(value: unknown): value is OrchestrationSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.storeVersion === 1 &&
    typeof record.revision === "number" &&
    isRecord(record.workflowVersions) &&
    (record.workflowDrafts === undefined || isRecord(record.workflowDrafts)) &&
    isRecord(record.runs) &&
    Array.isArray(record.auditEvents) &&
    isRecord(record.capabilities) &&
    (record.currentRunByPrincipal === undefined ||
      isRecord(record.currentRunByPrincipal)) &&
    isRecord(record.idempotency)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

export { FileOrchestrationArtifactStore } from "./artifacts";
export { FileWorkerOutputArchives } from "./workerOutputArchives";
export { writePrivateFileAtomic } from "./nodePersistence";
export * from "./workerOutput";

async function externalizeInlineWorkerHistories(
  snapshot: OrchestrationSnapshot,
  archives: FileWorkerOutputArchives
): Promise<OrchestrationSnapshot> {
  let changed = false;
  const runs = { ...snapshot.runs };
  for (const run of Object.values(runs)) {
    const dispatches = { ...run.dispatches };
    let runChanged = false;
    for (const dispatch of Object.values(dispatches)) {
      const history = dispatch.terminalHistory as unknown as
        | JsonValue
        | undefined;
      if (
        history === undefined ||
        (history &&
          typeof history === "object" &&
          !Array.isArray(history) &&
          "artifact" in history)
      )
        continue;
      const archive = await archives.capture(history);
      dispatches[dispatch.dispatchId] = {
        ...dispatch,
        terminalHistory: archive
      };
      runChanged = true;
    }
    if (runChanged) {
      runs[run.runId] = { ...run, dispatches };
      changed = true;
    }
  }
  return changed ? { ...snapshot, runs } : snapshot;
}
