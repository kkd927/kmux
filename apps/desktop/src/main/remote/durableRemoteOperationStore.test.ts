import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalizeRemoteOperationPayload,
  createInitialState,
  type RemoteOperationIntent,
  type RemoteOperationPayloadDto
} from "@kmux/core";
import { createRemoteOperationPendingFact } from "@kmux/core/main";
import { uint64 } from "@kmux/proto";

import {
  DurableOperationConflictError,
  createDurableRemoteOperationStore
} from "./durableRemoteOperationStore";
import { durableAtomicReplace } from "./durableAtomicWrite";

describe("durable remote operation store", () => {
  let sandbox: string;
  let root: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "kmux-operation-store-"));
    root = join(sandbox, "operations");
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("atomically admits intent, payload, pending fact, and outbox as one record", () => {
    const store = createDurableRemoteOperationStore(root);
    const admission = createAdmission();

    expect(store.admit(admission)).toEqual(admission);
    expect(store.get(admission.intent.operationId)).toEqual(admission);
    expect(store.loadAll()).toEqual([admission]);
    expect(store.admit(admission)).toEqual(admission);

    const [fileName] = readdirSync(root);
    expect(fileName).toMatch(/^[a-f0-9]{64}\.json$/);
    expect(
      JSON.parse(readFileSync(join(root, fileName), "utf8"))
    ).toMatchObject({
      version: 1,
      record: {
        intent: {
          expectedRemoteResourceRevision: "4",
          nextRemoteResourceRevision: "5"
        },
        payload: { kind: "session.terminate" },
        pendingFact: { type: "remote-operation.pending" }
      },
      recordDigest: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
  });

  it("rejects operation-ID reuse with different canonical content", () => {
    const store = createDurableRemoteOperationStore(root);
    store.admit(createAdmission());

    expect(() =>
      store.admit(
        createAdmission({
          sessionId: "session_other",
          operationId: "operation_1"
        })
      )
    ).toThrow(DurableOperationConflictError);
  });

  it("persists an authoritative result with its exact product fact", () => {
    const store = createDurableRemoteOperationStore(root);
    const admission = createAdmission();
    store.admit(admission);
    const completedAt = "2026-07-17T00:00:01.000Z";
    const resultDigest = "d".repeat(64);
    const fact = {
      type: "remote-operation.succeeded" as const,
      operationId: admission.intent.operationId,
      remoteResourceRevision: uint64(5n),
      resultDigest,
      completedAt
    };

    const persisted = store.recordResult(
      admission.intent.operationId,
      {
        outcome: "succeeded",
        operationId: admission.intent.operationId,
        remoteResourceRevision: uint64(5n),
        resultDigest,
        completedAt
      },
      fact
    );

    expect(persisted.result).toEqual({
      authoritative: {
        outcome: "succeeded",
        operationId: admission.intent.operationId,
        remoteResourceRevision: uint64(5n),
        resultDigest,
        completedAt
      },
      fact
    });
    expect(store.loadAll()).toEqual([persisted]);
    expect(() =>
      store.recordResult(
        admission.intent.operationId,
        {
          outcome: "failed",
          operationId: admission.intent.operationId,
          resultDigest: "e".repeat(64),
          code: "denied",
          message: "different",
          completedAt
        },
        {
          type: "remote-operation.failed",
          operationId: admission.intent.operationId,
          resultDigest: "e".repeat(64),
          code: "denied",
          message: "different",
          completedAt
        }
      )
    ).toThrow(DurableOperationConflictError);
  });

  it("fails closed on corruption and unsafe record permissions", () => {
    const store = createDurableRemoteOperationStore(root);
    const admission = createAdmission();
    store.admit(admission);
    const [fileName] = readdirSync(root);
    const path = join(root, fileName);
    const envelope = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    (envelope.record as { payload: { sessionId: string } }).payload.sessionId =
      "session_tampered";
    writeFileSync(path, JSON.stringify(envelope), { mode: 0o600 });

    expect(() => store.loadAll()).toThrow(/digest mismatch/);

    chmodSync(path, 0o644);
    expect(() => store.loadAll()).toThrow(/group or other permissions/);
  });

  it("rejects record-name substitution and bounds new admissions", () => {
    const bounded = createDurableRemoteOperationStore(root, { maxRecords: 1 });
    const admission = createAdmission();
    bounded.admit(admission);

    expect(() =>
      bounded.admit(
        createAdmission({ operationId: "operation_2", sessionId: "session_2" })
      )
    ).toThrow(/too many records/);

    const [fileName] = readdirSync(root);
    renameSync(join(root, fileName), join(root, "0".repeat(64) + ".json"));
    expect(() => bounded.loadAll()).toThrow(/file name does not match/);
  });

  it("durably removes crash-left temporary records and rejects unknown files", () => {
    const store = createDurableRemoteOperationStore(root);
    const admission = createAdmission();
    store.admit(admission);
    const [recordName] = readdirSync(root);
    const temporaryName = `.${recordName}.tmp-crashed-writer`;
    const temporaryPath = join(root, temporaryName);
    writeFileSync(temporaryPath, "partial", { mode: 0o600 });

    expect(store.loadAll()).toEqual([admission]);
    expect(existsSync(temporaryPath)).toBe(false);

    writeFileSync(join(root, "unexpected"), "foreign", { mode: 0o600 });
    expect(() => store.loadAll()).toThrow(/file name is invalid/);
  });

  it("durably retains monotonic resource descriptor receipts beyond operation-ledger GC", () => {
    let writes = 0;
    const store = createDurableRemoteOperationStore(root, {
      write: (directory, fileName, bytes) => {
        writes += 1;
        durableAtomicReplace(directory, fileName, bytes);
      }
    });
    const receipt = createResourceReceipt();

    expect(store.recordResourceReceipt(receipt)).toEqual(receipt);
    expect(writes).toBe(1);
    expect(
      store.recordResourceReceipt({
        ...receipt,
        observedAt: "2026-07-17T00:00:01.000Z"
      })
    ).toEqual(receipt);
    expect(writes).toBe(1);
    expect(
      store.recordResourceReceipt({
        ...receipt,
        processState: "exited",
        observedAt: "2026-07-17T00:00:02.000Z"
      })
    ).toMatchObject({ processState: "exited" });
    expect(writes).toBe(2);
    expect(store.getResourceReceipt(receipt.resourceKey)).toMatchObject({
      ...receipt,
      processState: "exited",
      observedAt: "2026-07-17T00:00:02.000Z"
    });
    expect(store.listResourceReceipts()).toMatchObject([
      {
        ...receipt,
        processState: "exited",
        observedAt: "2026-07-17T00:00:02.000Z"
      }
    ]);
    expect(store.loadAll()).toEqual([]);

    expect(() =>
      store.recordResourceReceipt({
        ...receipt,
        processState: "running",
        observedAt: "2026-07-17T00:00:03.000Z"
      })
    ).toThrow(/conflicts at the same revision/u);

    expect(() =>
      store.recordResourceReceipt({
        ...receipt,
        remoteResourceRevision: uint64(3n)
      })
    ).toThrow(/regressed/u);
    expect(() =>
      store.recordResourceReceipt({
        ...receipt,
        createOperationId: "different-create"
      })
    ).toThrow(/permanent create identity/u);
  });

  it("compacts a terminal operation only after the durable product fact and exact descriptor proof", () => {
    const store = createDurableRemoteOperationStore(root);
    const admission = createAdmission();
    store.admit(admission);
    const completedAt = "2026-07-17T00:00:01.000Z";
    const resultDigest = "e".repeat(64);
    store.recordResult(
      admission.intent.operationId,
      {
        outcome: "succeeded",
        operationId: admission.intent.operationId,
        remoteResourceRevision: uint64(5n),
        resultDigest,
        completedAt
      },
      {
        type: "remote-operation.succeeded",
        operationId: admission.intent.operationId,
        remoteResourceRevision: uint64(5n),
        resultDigest,
        completedAt
      }
    );
    const snapshot = createInitialState("/bin/sh");
    snapshot.remoteOperations[admission.intent.operationId] = {
      ...admission.pendingFact.projection,
      state: "succeeded",
      completedAt,
      resultDigest
    };

    expect(
      store.compactAfterDurableSnapshot(admission.intent.operationId, snapshot)
    ).toBe(false);
    store.recordResourceReceipt(
      createResourceReceipt({
        lastOperationId: admission.intent.operationId,
        lastOperationPayloadHash: admission.intent.canonicalPayloadHash,
        lastResultDigest: resultDigest,
        remoteResourceRevision: uint64(5n),
        processState: "exited"
      })
    );

    expect(
      store.compactAfterDurableSnapshot(admission.intent.operationId, snapshot)
    ).toBe(true);
    expect(store.get(admission.intent.operationId)).toBeNull();
    expect(store.listResourceReceipts()).toHaveLength(1);
  });
});

function createAdmission(
  options: {
    operationId?: string;
    sessionId?: string;
  } = {}
) {
  const operationId = options.operationId ?? "operation_1";
  const sessionId = options.sessionId ?? "session_1";
  const payload: RemoteOperationPayloadDto = {
    kind: "session.terminate",
    sessionId
  };
  const canonicalPayload = canonicalizeRemoteOperationPayload(payload);
  const intent: RemoteOperationIntent = {
    operationId,
    kind: payload.kind,
    resourceKey: {
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      workspaceId: "workspace_1",
      sessionId
    },
    expectedWorkspaceRevision: "a".repeat(64),
    expectedRemoteResourceRevision: uint64(4n),
    nextRemoteResourceRevision: uint64(5n),
    canonicalPayloadHash: createHash("sha256")
      .update(canonicalPayload, "utf8")
      .digest("hex"),
    createdAt: "2026-07-17T00:00:00.000Z"
  };
  return {
    intent,
    payload,
    pendingFact: createRemoteOperationPendingFact(undefined, intent, payload),
    outbox: { admittedAt: intent.createdAt }
  };
}

function createResourceReceipt(
  overrides: Partial<
    Parameters<
      ReturnType<
        typeof createDurableRemoteOperationStore
      >["recordResourceReceipt"]
    >[0]
  > = {}
) {
  return {
    resourceKey: {
      desktopInstallationId: "desktop_1",
      targetId: "target_1",
      workspaceId: "workspace_1",
      sessionId: "session_1"
    },
    remoteResourceRevision: uint64(4n),
    keeperGeneration: "keeper_1",
    processState: "running" as const,
    createOperationId: "create_1",
    canonicalCreatePayloadHash: "a".repeat(64),
    lastOperationId: "create_1",
    lastOperationPayloadHash: "a".repeat(64),
    lastResultDigest: "b".repeat(64),
    observedAt: "2026-07-17T00:00:00.000Z",
    ...overrides
  };
}
