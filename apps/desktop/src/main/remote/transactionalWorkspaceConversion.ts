import { createHash, randomUUID } from "node:crypto";

import {
  cloneState,
  encodeAppStateDto,
  terminalSessionForSurface,
  validateRemoteTargetBinding,
  type AppState,
  type RemoteTargetBinding
} from "@kmux/core";
import {
  applySshWorkspaceAdditionPatch,
  applySshWorkspaceReplacementPatch,
  computeWorkspaceRevision,
  createSshWorkspaceAdditionPatch,
  createSshWorkspaceReplacementPatch
} from "@kmux/core/main";
import {
  parseUint64Decimal,
  type ExternalAgentSessionRef,
  type Id
} from "@kmux/proto";

import {
  conversionPatchHash,
  type ConversionCleanupAcknowledgement,
  type ConversionCommitDecidedRecord,
  type ConversionLocalCleanupTarget,
  type ConversionPreparingRecord,
  type ConversionProductInstalledRecord,
  type ConversionRemoteCreatedEvidence,
  type ConversionRemoteCreatedRecord,
  type ConversionWalRecord,
  type ConversionWalStore
} from "./conversionWal";

export type ConversionFaultPoint =
  | "preparing-persisted"
  | "remote-prepare-returned"
  | "remote-created-persisted"
  | "commit-decided-persisted"
  | "desktop-snapshot-forced"
  | "desktop-state-installed"
  | "product-installed-persisted"
  | "remote-promoted"
  | "committed-persisted"
  | "local-cleanup-acknowledged"
  | "cleanup-complete-persisted";

interface StartSshWorkspaceTransactionCommonRequest {
  targetId: Id;
  effectiveConnectionPolicyHash: string;
  initialWorkspaceName: string;
  defaultCwd: string;
  launch?: {
    cwd?: string;
    shell?: string;
    args?: string[];
    env?: Record<string, string>;
    title?: string;
  };
  agentSessionRef?: ExternalAgentSessionRef;
  initialInput?: string;
}

export type StartSshWorkspaceTransactionRequest =
  | (StartSshWorkspaceTransactionCommonRequest & {
      kind: "convert-existing";
      sourceWorkspaceId: Id;
    })
  | (StartSshWorkspaceTransactionCommonRequest & {
      kind: "create-new";
      destinationWindowId: Id;
    });

export function decodeStartSshWorkspaceTransactionRequest(
  value: unknown
): StartSshWorkspaceTransactionRequest {
  const record = requireConversionRequestRecord(
    value,
    "SSH workspace transaction request"
  );
  const commonKeys = [
    "kind",
    "targetId",
    "effectiveConnectionPolicyHash",
    "initialWorkspaceName",
    "defaultCwd",
    "launch",
    "agentSessionRef",
    "initialInput"
  ];
  if (record.kind === "convert-existing") {
    assertConversionRequestKeys(record, [...commonKeys, "sourceWorkspaceId"]);
  } else if (record.kind === "create-new") {
    assertConversionRequestKeys(record, [...commonKeys, "destinationWindowId"]);
  } else {
    throw new TypeError("SSH workspace transaction kind is invalid");
  }
  const launch =
    record.launch === undefined
      ? undefined
      : decodeConversionLaunch(record.launch);
  const agentSessionRef =
    record.agentSessionRef === undefined
      ? undefined
      : decodeConversionAgentSessionRef(record.agentSessionRef);
  const common: StartSshWorkspaceTransactionCommonRequest = {
    targetId: requireConversionRequestText(record.targetId, "targetId", 256),
    effectiveConnectionPolicyHash: requirePolicyHash(
      record.effectiveConnectionPolicyHash
    ),
    initialWorkspaceName: requireConversionRequestText(
      record.initialWorkspaceName,
      "initialWorkspaceName",
      4 * 1024
    ),
    defaultCwd: requireConversionRequestText(
      record.defaultCwd,
      "defaultCwd",
      32 * 1024
    ),
    ...(launch === undefined ? {} : { launch }),
    ...(agentSessionRef === undefined ? {} : { agentSessionRef }),
    ...(record.initialInput === undefined
      ? {}
      : {
          initialInput: requireConversionInitialInput(record.initialInput)
        })
  };
  return record.kind === "convert-existing"
    ? {
        ...common,
        kind: record.kind,
        sourceWorkspaceId: requireConversionRequestText(
          record.sourceWorkspaceId,
          "sourceWorkspaceId",
          256
        )
      }
    : {
        ...common,
        kind: record.kind,
        destinationWindowId: requireConversionRequestText(
          record.destinationWindowId,
          "destinationWindowId",
          256
        )
      };
}

/** @deprecated Use the intent-discriminated transaction decoder. */
export const decodeStartWorkspaceConversionRequest =
  decodeStartSshWorkspaceTransactionRequest;
/** @deprecated Use StartSshWorkspaceTransactionRequest. */
export type StartWorkspaceConversionRequest =
  StartSshWorkspaceTransactionRequest;

export interface ConversionRemotePrepareRequest {
  record: ConversionPreparingRecord;
  remoteSnapshot: string;
  remoteSnapshotHash: string;
}

export interface ConversionRemotePromotionResult {
  transactionId: Id;
  remoteSnapshotHash: string;
  remotePromotionHash: string;
}

export interface SshWorkspaceTransactionRemoteGateway {
  prepare(
    request: ConversionRemotePrepareRequest
  ): Promise<ConversionRemoteCreatedEvidence>;
  promote(
    record: ConversionProductInstalledRecord
  ): Promise<ConversionRemotePromotionResult>;
}

export type ConversionRemoteGateway = SshWorkspaceTransactionRemoteGateway;

export interface TransactionalSshWorkspaceRuntimeOptions {
  desktopInstallationId: Id;
  wal: ConversionWalStore;
  remote: SshWorkspaceTransactionRemoteGateway;
  getState: () => AppState;
  getTargetBinding: (targetId: Id) => RemoteTargetBinding | undefined;
  getLocalRuntimeEpoch: (surfaceId: Id, sessionId: Id) => Id | null;
  forceDesktopSnapshot: (
    state: AppState,
    expectedSnapshotHash: string
  ) => Promise<string> | string;
  installDesktopState: (state: AppState) => void;
  terminateLocalSession: (
    target: ConversionLocalCleanupTarget
  ) => Promise<ConversionCleanupAcknowledgement>;
  makeTransactionId?: () => Id;
  now?: () => string;
  faultPoint?: (
    point: ConversionFaultPoint,
    record: ConversionWalRecord
  ) => void;
}

export interface TransactionalSshWorkspaceRuntime {
  start(
    request: StartSshWorkspaceTransactionRequest
  ): Promise<ConversionWalRecord>;
  recover(): Promise<ConversionWalRecord[]>;
  recoverTarget(targetId: Id): Promise<ConversionWalRecord[]>;
  resume(transactionId: Id): Promise<ConversionWalRecord>;
  compactCompleted(transactionId: Id): void;
}

/**
 * Main-owned low-frequency conversion coordinator. It never sends terminal
 * bytes and cannot terminate a local generation before `committed` is durable.
 */
export function createTransactionalSshWorkspaceRuntime(
  options: TransactionalSshWorkspaceRuntimeOptions
): TransactionalSshWorkspaceRuntime {
  const makeTransactionId =
    options.makeTransactionId ?? (() => stableId("conversion", cryptoSeed()));
  const now = options.now ?? (() => new Date().toISOString());
  const queues = new Map<Id, Promise<ConversionWalRecord>>();
  const productCommitReservations = new Map<Id, ProductCommitReservation>();
  const windowProductCommitTails = new Map<Id, Promise<void>>();
  let globalProductCommitTail = Promise.resolve();

  const reserveProductCommit = (record: ConversionWalRecord): void => {
    if (
      record.state === "product-installed" ||
      record.state === "committed" ||
      record.state === "cleanup-complete" ||
      productCommitReservations.has(record.transactionId)
    ) {
      return;
    }
    const windowId = productIntentWindowId(record);
    const predecessor =
      windowProductCommitTails.get(windowId) ?? Promise.resolve();
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const tail = predecessor.catch(() => undefined).then(() => completion);
    windowProductCommitTails.set(windowId, tail);
    void tail.finally(() => {
      if (windowProductCommitTails.get(windowId) === tail) {
        windowProductCommitTails.delete(windowId);
      }
    });
    productCommitReservations.set(record.transactionId, {
      predecessor: predecessor.catch(() => undefined),
      release: resolveCompletion,
      released: false
    });
  };

  const releaseProductCommit = (transactionId: Id): void => {
    const reservation = productCommitReservations.get(transactionId);
    if (!reservation || reservation.released) return;
    reservation.released = true;
    reservation.release();
    productCommitReservations.delete(transactionId);
  };

  const withGlobalProductCommit = async <T>(
    task: () => Promise<T>
  ): Promise<T> => {
    const predecessor = globalProductCommitTail.catch(() => undefined);
    let release!: () => void;
    globalProductCommitTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await task();
    } finally {
      release();
    }
  };

  const reserveRecordsInOrder = (records: ConversionWalRecord[]): void => {
    for (const record of records) reserveProductCommit(record);
  };

  const requireBinding = (
    targetId: Id,
    expectedPolicyHash?: string
  ): RemoteTargetBinding => {
    const candidate = options.getTargetBinding(targetId);
    const binding = candidate
      ? validateRemoteTargetBinding(candidate)
      : undefined;
    if (!binding || binding.id !== targetId) {
      throw new Error("conversion requires a verified remote target binding");
    }
    if (
      expectedPolicyHash !== undefined &&
      binding.locator.effectiveConnectionPolicyHash !== expectedPolicyHash
    ) {
      throw new Error("conversion target connection policy changed");
    }
    return binding;
  };

  const notify = (
    point: ConversionFaultPoint,
    record: ConversionWalRecord
  ): void => options.faultPoint?.(point, structuredClone(record));

  const resumeNow = async (transactionId: Id): Promise<ConversionWalRecord> => {
    let record = options.wal.get(transactionId);
    if (!record) {
      throw new Error(`conversion ${transactionId} is not durable`);
    }
    requireBinding(
      record.workspaceResourceKey.targetId,
      record.effectiveConnectionPolicyHash
    );

    if (record.state === "preparing") {
      const remoteSnapshot = buildRemoteSnapshot(record);
      const remoteSnapshotHash = sha256(remoteSnapshot);
      const evidence = await options.remote.prepare({
        record,
        remoteSnapshot,
        remoteSnapshotHash
      });
      notify("remote-prepare-returned", record);
      if (evidence.remoteSnapshotHash !== remoteSnapshotHash) {
        throw new Error("remote conversion snapshot hash does not match");
      }
      record = options.wal.recordRemoteCreated(transactionId, evidence);
      notify("remote-created-persisted", record);
    }

    if (
      record.state === "remote-created" ||
      record.state === "commit-decided"
    ) {
      reserveProductCommit(record);
      const reservation = productCommitReservations.get(transactionId);
      if (!reservation) {
        throw new Error("SSH workspace product commit reservation is missing");
      }
      await reservation.predecessor;
      record = await withGlobalProductCommit(async () => {
        let committing = options.wal.get(transactionId);
        if (!committing) {
          throw new Error(`conversion ${transactionId} is not durable`);
        }
        if (committing.state === "remote-created") {
          assertProductIntentStillCurrent(committing, options.getState());
          const patch = createPatch(committing, options.getState());
          committing = options.wal.decideCommit(transactionId, {
            replacementPatch: patch,
            replacementPatchHash: conversionPatchHash(patch),
            decidedAt: now()
          });
          notify("commit-decided-persisted", committing);
        }
        if (committing.state === "commit-decided") {
          const candidate = cloneState(options.getState());
          applyProductPatch(candidate, committing);
          const expectedSnapshotHash = desktopSnapshotHash(candidate);
          const persistedSnapshotHash = await options.forceDesktopSnapshot(
            candidate,
            expectedSnapshotHash
          );
          if (persistedSnapshotHash !== expectedSnapshotHash) {
            throw new Error("forced desktop snapshot hash does not match");
          }
          notify("desktop-snapshot-forced", committing);
          options.installDesktopState(candidate);
          if (
            computeWorkspaceRevision(
              options.getState(),
              committing.workspaceResourceKey.workspaceId
            ) !== committing.replacementPatch.replacementWorkspaceRevision
          ) {
            throw new Error(
              "installed desktop conversion patch does not match"
            );
          }
          notify("desktop-state-installed", committing);
          committing = options.wal.recordProductInstalled(transactionId, {
            desktopSnapshotHash: persistedSnapshotHash,
            productInstalledAt: now()
          });
          releaseProductCommit(transactionId);
          notify("product-installed-persisted", committing);
        }
        return committing;
      });
    }

    if (record.state === "product-installed") {
      releaseProductCommit(transactionId);
      const promotion = await options.remote.promote(record);
      if (
        promotion.transactionId !== record.transactionId ||
        promotion.remoteSnapshotHash !== record.remoteSnapshotHash
      ) {
        throw new Error("remote conversion promotion identity does not match");
      }
      notify("remote-promoted", record);
      record = options.wal.recordCommitted(transactionId, {
        remotePromotionHash: promotion.remotePromotionHash,
        committedAt: now()
      });
      notify("committed-persisted", record);
    }

    if (record.state === "committed") {
      const acknowledgements: ConversionCleanupAcknowledgement[] = [];
      const cleanupSet =
        record.productIntent.kind === "convert-existing"
          ? record.productIntent.cleanupSet
          : [];
      for (const target of cleanupSet) {
        const acknowledgement = await options.terminateLocalSession(target);
        assertCleanupAcknowledgement(target, acknowledgement);
        acknowledgements.push(acknowledgement);
        notify("local-cleanup-acknowledged", record);
      }
      record = options.wal.recordCleanupComplete(
        transactionId,
        acknowledgements,
        now()
      );
      notify("cleanup-complete-persisted", record);
    }
    return record;
  };

  const enqueue = (
    transactionId: Id,
    task: () => Promise<ConversionWalRecord>
  ): Promise<ConversionWalRecord> => {
    const previous = queues.get(transactionId) ?? Promise.resolve(undefined);
    const current = previous.catch(() => undefined).then(task);
    queues.set(transactionId, current);
    void current
      .finally(() => {
        if (queues.get(transactionId) === current) queues.delete(transactionId);
      })
      .catch(() => undefined);
    return current;
  };

  return Object.freeze({
    async start(
      request: StartSshWorkspaceTransactionRequest
    ): Promise<ConversionWalRecord> {
      const state = options.getState();
      const sourceWorkspace =
        request.kind === "convert-existing"
          ? state.workspaces[request.sourceWorkspaceId]
          : undefined;
      if (request.kind === "convert-existing") {
        if (!sourceWorkspace) {
          throw new Error("SSH workspace source must exist");
        }
        if (sourceWorkspace.location.target.kind !== "local") {
          throw new Error(
            "conversion source must be an existing local workspace"
          );
        }
        if (
          options.wal
            .loadAll()
            .some(
              (record) =>
                record.productIntent.kind === "convert-existing" &&
                record.productIntent.sourceWorkspaceId === sourceWorkspace.id &&
                record.state !== "cleanup-complete"
            )
        ) {
          throw new Error(
            "conversion source workspace already has an unfinished transaction"
          );
        }
      } else if (!state.windows[request.destinationWindowId]) {
        throw new Error("SSH workspace destination window no longer exists");
      }
      const binding = requireBinding(
        request.targetId,
        request.effectiveConnectionPolicyHash
      );
      const transactionId = makeTransactionId();
      const ids = conversionIds(transactionId);
      const resourceWorkspaceId =
        request.kind === "convert-existing"
          ? request.sourceWorkspaceId
          : ids.workspaceId;
      const launch = {
        cwd: request.launch?.cwd ?? request.defaultCwd,
        ...(request.launch?.shell === undefined
          ? {}
          : { shell: request.launch.shell }),
        ...(request.launch?.args === undefined
          ? {}
          : { args: [...request.launch.args] }),
        ...(request.launch?.env === undefined
          ? {}
          : { env: { ...request.launch.env } }),
        ...(request.launch?.title === undefined
          ? {}
          : { title: request.launch.title }),
        ...(request.initialInput === undefined
          ? {}
          : { initialInput: request.initialInput })
      };
      const productIntent =
        request.kind === "convert-existing"
          ? {
              kind: request.kind,
              sourceWorkspaceId: request.sourceWorkspaceId,
              sourceWorkspaceRevision: computeWorkspaceRevision(
                state,
                request.sourceWorkspaceId
              ),
              preservation: {
                workspaceId: request.sourceWorkspaceId,
                windowId: sourceWorkspace!.windowId,
                name: sourceWorkspace!.name,
                nameLocked: sourceWorkspace!.nameLocked === true,
                pinned: sourceWorkspace!.pinned
              },
              cleanupSet: captureCleanupSet(
                state,
                request.sourceWorkspaceId,
                options.getLocalRuntimeEpoch
              )
            }
          : {
              kind: request.kind,
              destinationWindowId: request.destinationWindowId
            };
      const record = options.wal.begin({
        transactionId,
        workspaceCreateOperationId: ids.workspaceCreateOperationId,
        sessionCreateOperationId: ids.sessionCreateOperationId,
        workspaceResourceKey: {
          desktopInstallationId: options.desktopInstallationId,
          targetId: binding.id,
          workspaceId: resourceWorkspaceId
        },
        sessionResourceKey: {
          desktopInstallationId: options.desktopInstallationId,
          targetId: binding.id,
          workspaceId: resourceWorkspaceId,
          sessionId: ids.sessionId
        },
        effectiveConnectionPolicyHash:
          binding.locator.effectiveConnectionPolicyHash,
        productIntent,
        initialWorkspaceName: request.initialWorkspaceName,
        defaultCwd: request.defaultCwd,
        launch,
        ...(request.agentSessionRef === undefined
          ? {}
          : { agentSessionRef: structuredClone(request.agentSessionRef) }),
        ...(request.initialInput === undefined
          ? {}
          : { initialInput: request.initialInput }),
        preparedAt: now()
      });
      reserveProductCommit(record);
      notify("preparing-persisted", record);
      return enqueue(transactionId, () => resumeNow(transactionId));
    },

    recover(): Promise<ConversionWalRecord[]> {
      const records = options.wal
        .loadAll()
        .sort(
          (left, right) =>
            left.preparedAt.localeCompare(right.preparedAt) ||
            left.transactionId.localeCompare(right.transactionId)
        );
      reserveRecordsInOrder(records);
      return Promise.all(
        records.map((record) =>
          enqueue(record.transactionId, () => resumeNow(record.transactionId))
        )
      );
    },

    recoverTarget(targetId: Id): Promise<ConversionWalRecord[]> {
      const allRecords = options.wal
        .loadAll()
        .sort(
          (left, right) =>
            left.preparedAt.localeCompare(right.preparedAt) ||
            left.transactionId.localeCompare(right.transactionId)
        );
      reserveRecordsInOrder(allRecords);
      const records = allRecords.filter(
        (record) => record.workspaceResourceKey.targetId === targetId
      );
      return Promise.all(
        records.map((record) =>
          enqueue(record.transactionId, () => resumeNow(record.transactionId))
        )
      );
    },

    resume(transactionId: Id): Promise<ConversionWalRecord> {
      return enqueue(transactionId, () => resumeNow(transactionId));
    },

    compactCompleted(transactionId: Id): void {
      options.wal.compact(transactionId);
    }
  });
}

function createPatch(record: ConversionRemoteCreatedRecord, state: AppState) {
  const ids = conversionIds(record.transactionId);
  const common = {
    targetId: record.workspaceResourceKey.targetId,
    initialWorkspaceName: record.initialWorkspaceName,
    defaultCwd: record.defaultCwd,
    paneId: ids.paneId,
    nodeId: ids.nodeId,
    surfaceId: ids.surfaceId,
    sessionId: record.sessionResourceKey.sessionId,
    authToken: ids.authToken,
    keeperGeneration: record.keeperGeneration,
    remoteResourceRevision: parseUint64Decimal(record.remoteResourceRevision),
    launch: record.launch,
    ...(record.initialInput === undefined
      ? {}
      : { initialInput: record.initialInput }),
    ...(record.agentSessionRef === undefined
      ? {}
      : { agentSessionRef: record.agentSessionRef })
  };
  return record.productIntent.kind === "convert-existing"
    ? createSshWorkspaceReplacementPatch(state, {
        ...common,
        workspaceId: record.productIntent.sourceWorkspaceId
      })
    : createSshWorkspaceAdditionPatch(state, {
        ...common,
        destinationWindowId: record.productIntent.destinationWindowId,
        workspaceId: record.workspaceResourceKey.workspaceId
      });
}

function assertProductIntentStillCurrent(
  record: ConversionRemoteCreatedRecord,
  state: AppState
): void {
  if (record.productIntent.kind === "convert-existing") {
    if (
      computeWorkspaceRevision(
        state,
        record.productIntent.sourceWorkspaceId
      ) !== record.productIntent.sourceWorkspaceRevision
    ) {
      throw new Error("conversion source workspace changed before commit");
    }
    return;
  }
  if (!state.windows[record.productIntent.destinationWindowId]) {
    throw new Error(
      "SSH workspace transaction conflict: destination window no longer exists"
    );
  }
}

function applyProductPatch(
  state: AppState,
  record: ConversionCommitDecidedRecord
): void {
  if (record.productIntent.kind === "convert-existing") {
    applySshWorkspaceReplacementPatch(state, record.replacementPatch);
  } else {
    applySshWorkspaceAdditionPatch(state, record.replacementPatch);
  }
}

function productIntentWindowId(record: ConversionWalRecord): Id {
  return record.productIntent.kind === "convert-existing"
    ? record.productIntent.preservation.windowId
    : record.productIntent.destinationWindowId;
}

function captureCleanupSet(
  state: AppState,
  workspaceId: Id,
  getRuntimeEpoch: (surfaceId: Id, sessionId: Id) => Id | null
): ConversionLocalCleanupTarget[] {
  const paneIds = new Set(
    Object.values(state.panes)
      .filter((pane) => pane.workspaceId === workspaceId)
      .map((pane) => pane.id)
  );
  return Object.values(state.surfaces)
    .filter((surface) => paneIds.has(surface.paneId))
    .map((surface) => {
      const session = terminalSessionForSurface(state, surface.id);
      if (!session || session.surfaceId !== surface.id) {
        throw new Error(
          "conversion source graph has inconsistent session ownership"
        );
      }
      const runtimeEpoch = getRuntimeEpoch(surface.id, session.id);
      if (
        runtimeEpoch === null &&
        session.runtimeStatus.processState !== "exited"
      ) {
        throw new Error(
          "conversion source has a live session without a fenced local runtime generation"
        );
      }
      return {
        sessionId: session.id,
        surfaceId: surface.id,
        ...(runtimeEpoch === null ? {} : { runtimeEpoch })
      };
    })
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

function assertCleanupAcknowledgement(
  target: ConversionLocalCleanupTarget,
  acknowledgement: ConversionCleanupAcknowledgement
): void {
  if (
    acknowledgement.sessionId !== target.sessionId ||
    acknowledgement.surfaceId !== target.surfaceId ||
    acknowledgement.runtimeEpoch !== target.runtimeEpoch ||
    (target.runtimeEpoch === undefined &&
      acknowledgement.outcome !== "already-exited")
  ) {
    throw new Error("local conversion cleanup acknowledgement does not match");
  }
}

function conversionIds(transactionId: Id): {
  workspaceId: Id;
  workspaceCreateOperationId: Id;
  sessionCreateOperationId: Id;
  paneId: Id;
  nodeId: Id;
  surfaceId: Id;
  sessionId: Id;
  authToken: Id;
} {
  return {
    workspaceId: stableId("workspace", transactionId, "created"),
    workspaceCreateOperationId: stableId(
      "operation",
      transactionId,
      "workspace-create"
    ),
    sessionCreateOperationId: stableId(
      "operation",
      transactionId,
      "session-create"
    ),
    paneId: stableId("pane", transactionId, "replacement"),
    nodeId: stableId("node", transactionId, "replacement"),
    surfaceId: conversionSurfaceIdForTransaction(transactionId),
    sessionId: stableId("session", transactionId, "replacement"),
    authToken: stableId("auth", transactionId, "replacement")
  };
}

export function conversionSurfaceIdForTransaction(transactionId: Id): Id {
  return stableId("surface", transactionId, "replacement");
}

function buildRemoteSnapshot(record: ConversionPreparingRecord): string {
  return canonicalJson({
    version: 3,
    transactionId: record.transactionId,
    workspaceCreateOperationId: record.workspaceCreateOperationId,
    sessionCreateOperationId: record.sessionCreateOperationId,
    workspaceResourceKey: record.workspaceResourceKey,
    sessionResourceKey: record.sessionResourceKey,
    launch: record.launch
  });
}

export function desktopSnapshotHash(state: AppState): string {
  return sha256(canonicalJson(encodeAppStateDto(state)));
}

function stableId(prefix: string, ...parts: string[]): Id {
  return `${prefix}_${sha256(parts.join("\0")).slice(0, 32)}`;
}

function cryptoSeed(): string {
  return randomUUID();
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("conversion snapshot accepts finite numbers only");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("conversion snapshot value cannot be canonicalized");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function decodeConversionLaunch(
  value: unknown
): NonNullable<StartWorkspaceConversionRequest["launch"]> {
  const record = requireConversionRequestRecord(value, "conversion launch");
  assertConversionRequestKeys(record, ["cwd", "shell", "args", "env", "title"]);
  if (
    record.args !== undefined &&
    (!Array.isArray(record.args) || record.args.length > 256)
  ) {
    throw new TypeError("conversion launch args are invalid");
  }
  const environment =
    record.env === undefined
      ? undefined
      : requireConversionRequestRecord(record.env, "conversion launch env");
  if (environment && Object.keys(environment).length > 256) {
    throw new TypeError("conversion launch env is oversized");
  }
  return {
    ...(record.cwd === undefined
      ? {}
      : {
          cwd: requireConversionRequestText(record.cwd, "launch.cwd", 32 * 1024)
        }),
    ...(record.shell === undefined
      ? {}
      : {
          shell: requireConversionRequestText(
            record.shell,
            "launch.shell",
            32 * 1024
          )
        }),
    ...(record.args === undefined
      ? {}
      : {
          args: record.args.map((item) =>
            requireConversionRequestText(item, "launch arg", 32 * 1024)
          )
        }),
    ...(environment === undefined
      ? {}
      : {
          env: Object.fromEntries(
            Object.entries(environment).map(([key, item]) => [
              requireConversionRequestText(key, "launch env key", 1024),
              requireConversionRequestText(item, "launch env value", 32 * 1024)
            ])
          )
        }),
    ...(record.title === undefined
      ? {}
      : {
          title: requireConversionRequestText(
            record.title,
            "launch.title",
            4 * 1024
          )
        })
  };
}

function requireConversionRequestRecord(
  value: unknown,
  field: string
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertConversionRequestKeys(
  record: Record<string, unknown>,
  allowed: readonly string[]
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unexpected) {
    throw new TypeError(`unexpected conversion request field: ${unexpected}`);
  }
}

function requireConversionRequestText(
  value: unknown,
  field: string,
  maxBytes: number
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maxBytes ||
    /\p{Cc}/u.test(value)
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function requirePolicyHash(value: unknown): string {
  const hash = requireConversionRequestText(
    value,
    "effectiveConnectionPolicyHash",
    64
  );
  if (!/^[a-f0-9]{64}$/u.test(hash)) {
    throw new TypeError(
      "effectiveConnectionPolicyHash must be a lowercase SHA-256 value"
    );
  }
  return hash;
}

function decodeConversionAgentSessionRef(
  value: unknown
): ExternalAgentSessionRef {
  const record = requireConversionRequestRecord(value, "agentSessionRef");
  assertConversionRequestKeys(record, ["vendor", "externalKey", "sessionId"]);
  if (
    record.vendor !== "codex" &&
    record.vendor !== "claude" &&
    record.vendor !== "antigravity"
  ) {
    throw new TypeError("agentSessionRef vendor is invalid");
  }
  return {
    vendor: record.vendor,
    externalKey: requireConversionRequestText(
      record.externalKey,
      "agentSessionRef.externalKey",
      4 * 1024
    ),
    sessionId: requireConversionRequestText(
      record.sessionId,
      "agentSessionRef.sessionId",
      4 * 1024
    )
  };
}

function requireConversionInitialInput(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 64 * 1024 ||
    /\0/u.test(value)
  ) {
    throw new TypeError("initialInput is invalid");
  }
  return value;
}

interface ProductCommitReservation {
  predecessor: Promise<void>;
  release: () => void;
  released: boolean;
}

export type TransactionalWorkspaceConversionRuntimeOptions =
  TransactionalSshWorkspaceRuntimeOptions;
export type TransactionalWorkspaceConversionRuntime =
  TransactionalSshWorkspaceRuntime;
/** @deprecated Use createTransactionalSshWorkspaceRuntime. */
export const createTransactionalWorkspaceConversionRuntime =
  createTransactionalSshWorkspaceRuntime;
