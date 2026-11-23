import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileOrchestrationStore } from "./node";
import {
  createAdaptiveRun,
  createEmptyOrchestrationSnapshot,
  LOCAL_V1_DEFAULT_RUN_LIMITS
} from "./runtime";

function legacySnapshot() {
  const run = createAdaptiveRun({
    runId: "run:archive",
    objective: "Restore saved output",
    limits: LOCAL_V1_DEFAULT_RUN_LIMITS,
    context: {
      now: () => "2026-10-09T00:00:00.000Z",
      id: (kind) => `${kind}:archive`
    }
  });
  const history = {
    source: "transcript",
    status: "available",
    vt: "saved review\n".repeat(4096),
    truncated: true
  };
  return {
    history,
    snapshot: {
      ...createEmptyOrchestrationSnapshot(),
      runs: {
        [run.runId]: {
          ...run,
          dispatches: {
            "dispatch:archive": {
              dispatchId: "dispatch:archive",
              terminalState: "released",
              terminalHistory: history
            }
          }
        }
      }
    }
  };
}

describe("saved Worker output archives", () => {
  it("preserves existing inline output as an Artifact and restores it after reopening a compact snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-output-archive-"));
    const filePath = join(root, "orchestration.json");
    try {
      const { history, snapshot } = legacySnapshot();
      writeFileSync(filePath, JSON.stringify(snapshot));
      const store = await FileOrchestrationStore.open({ filePath });
      const state = await store.read();
      const archive =
        state.runs["run:archive"]!.dispatches["dispatch:archive"]!
          .terminalHistory!;
      expect(archive).toMatchObject({
        source: "transcript",
        status: "available",
        truncated: true,
        artifact: { kind: "worker-output" }
      });
      expect(readFileSync(filePath).byteLength).toBeLessThan(
        Buffer.byteLength(history.vt)
      );
      const reopened = await FileOrchestrationStore.open({ filePath });
      await expect(
        reopened.workerOutputArchives.read(archive)
      ).resolves.toEqual(history);
      const empty = await reopened.workerOutputArchives.capture({
        source: "terminal",
        status: "empty",
        vt: ""
      });
      expect(empty.status).toBe("empty");
      await expect(
        reopened.workerOutputArchives.read(empty)
      ).resolves.toMatchObject({ status: "empty", vt: "" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves the original snapshot intact when existing output cannot be stored", async () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-output-archive-failure-"));
    const filePath = join(root, "orchestration.json");
    try {
      const original = JSON.stringify(legacySnapshot().snapshot);
      writeFileSync(filePath, original);
      const artifactRoot = join(root, "blocked-artifacts");
      writeFileSync(artifactRoot, "not a directory");
      await expect(
        FileOrchestrationStore.open({ filePath, artifactRoot })
      ).rejects.toThrow();
      expect(readFileSync(filePath, "utf8")).toBe(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
