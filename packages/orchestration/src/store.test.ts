import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileOrchestrationStore } from "./node";
import {
  claimMailboxDelivery,
  coordinatorMailboxConsumer,
  createAdaptiveRun,
  LOCAL_V1_DEFAULT_RUN_LIMITS,
  postOrchestrationMessage,
  type RuntimeContext
} from "./runtime";

describe("transactional local orchestration store", () => {
  it("atomically commits current state and its audit event, then restores both", async () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-orchestration-store-"));
    const filePath = join(root, "orchestration.json");
    let sequence = 0;
    try {
      const store = await FileOrchestrationStore.open({
        filePath,
        now: () => "2026-08-26T00:00:00.000Z",
        id: (kind) => `${kind}:${++sequence}`
      });
      const observed: Array<{ revision: number; durableRevision: number }> = [];
      const unsubscribe = store.subscribe((snapshot) => {
        observed.push({
          revision: snapshot.revision,
          durableRevision: JSON.parse(readFileSync(filePath, "utf8")).revision
        });
      });
      await store.transact(
        {
          type: "run.created",
          principal: "user:local",
          runId: "run:1",
          expectedStoreRevision: 0,
          payload: { source: "test" }
        },
        (snapshot) => ({
          snapshot: {
            ...snapshot,
            runs: {
              ...snapshot.runs,
              "run:1": { marker: true } as never
            }
          },
          value: undefined
        })
      );

      const onDisk = JSON.parse(readFileSync(filePath, "utf8"));
      expect(observed).toEqual([{ revision: 1, durableRevision: 1 }]);
      unsubscribe();
      expect(onDisk.revision).toBe(1);
      expect(onDisk.runs["run:1"]).toEqual({ marker: true });
      expect(onDisk.auditEvents).toEqual([
        {
          eventId: "event:1",
          sequence: 1,
          occurredAt: "2026-08-26T00:00:00.000Z",
          runId: "run:1",
          type: "run.created",
          principal: "user:local",
          payload: { source: "test" }
        }
      ]);

      const restored = await FileOrchestrationStore.open({ filePath });
      expect(await restored.read()).toMatchObject({
        revision: 1,
        runs: { "run:1": { marker: true } },
        auditEvents: [{ sequence: 1, type: "run.created" }]
      });

      await expect(
        restored.transact(
          {
            type: "stale.write",
            principal: "user:local",
            expectedStoreRevision: 0
          },
          (snapshot) => ({ snapshot, value: undefined })
        )
      ).rejects.toMatchObject({ code: "stale-revision" });
      expect((await restored.read()).revision).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses unknown durable store versions instead of guessing a migration", async () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-orchestration-store-"));
    const filePath = join(root, "orchestration.json");
    try {
      writeFileSync(filePath, '{"storeVersion":99}\n', "utf8");
      await expect(
        FileOrchestrationStore.open({ filePath })
      ).rejects.toMatchObject({ code: "unsupported" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores the same active mailbox Delivery after a process restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-mailbox-store-"));
    const filePath = join(root, "orchestration.json");
    let sequence = 0;
    const context: RuntimeContext = {
      now: () => "2026-09-20T00:00:00.000Z",
      id: (kind) => `${kind}:${++sequence}`
    };
    try {
      const execution = {
        targetId: "local",
        targetAuthority: "desktop:test",
        surfaceId: "surface:coordinator",
        sessionId: "session:coordinator",
        generation: { kind: "local" as const, runtimeEpoch: "epoch:1" },
        inputAuthorityRef: "authority:coordinator"
      };
      let run = createAdaptiveRun({
        runId: "run:mailbox-restore",
        objective: "Restore an active Delivery",
        limits: LOCAL_V1_DEFAULT_RUN_LIMITS,
        coordinatorAttachment: {
          transport: "terminal",
          surfaceId: execution.surfaceId,
          sessionId: execution.sessionId,
          execution,
          process: { pid: 1, startedAt: context.now() }
        },
        context
      });
      run = postOrchestrationMessage({
        run,
        kind: "question",
        principal: "session:worker",
        body: { text: "durable?" },
        context
      }).run;
      const consumer = coordinatorMailboxConsumer(run);
      const claimed = claimMailboxDelivery({ run, consumer, context });
      const delivery = claimed.delivery!;
      const store = await FileOrchestrationStore.open({ filePath });
      await store.transact(
        {
          type: "mailbox.claimed",
          principal: "session:coordinator",
          runId: run.runId
        },
        (snapshot) => ({
          snapshot: {
            ...snapshot,
            runs: { ...snapshot.runs, [run.runId]: claimed.run }
          },
          value: undefined
        })
      );

      const restored = await FileOrchestrationStore.open({ filePath });
      const restoredRun = (await restored.read()).runs[run.runId]!;
      const replay = claimMailboxDelivery({
        run: restoredRun,
        consumer: coordinatorMailboxConsumer(restoredRun),
        context
      });
      expect(replay.replayed).toBe(true);
      expect(replay.delivery).toEqual(delivery);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
