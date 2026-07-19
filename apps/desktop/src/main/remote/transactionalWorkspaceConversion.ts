import { createHash, randomUUID } from "node:crypto";

import {
  cloneState,
  encodeAppStateDto,
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
import { parseUint64Decimal, type Id } from "@kmux/proto";

import {
  conversionPatchHash,
  type ConversionCleanupAcknowledgement,
  type ConversionCommitDecidedRecord,
  type ConversionLocalCleanupTarget,
  type ConversionPreparingRecord,
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
  | "remote-promoted"
  | "committed-persisted"
  | "local-cleanup-acknowledged"
  | "cleanup-complete-persisted";

export interface StartWorkspaceConversionRequest {
  workspaceId: Id;
  targetId: Id;
  effectiveConnectionPolicyHash: string;
  connectionName: string;
  defaultCwd: string;
  continuation?: "convert" | "create";
  launch?: {
    cwd?: string;
    shell?: string;
    args?: string[];
    env?: Record<string, string>;
    title?: string;
  };
}

export function decodeStartWorkspaceConversionRequest(
  value: unknown
): StartWorkspaceConversionRequest {
  const record = requireConversionRequestRecord(value, "conversion request");
  assertConversionRequestKeys(record, [
    "workspaceId",
    "targetId",
    "effectiveConnectionPolicyHash",
    "connectionName",
    "defaultCwd",
    "continuation",
    "launch"
  ]);
  const launch =
    record.launch === undefined
      ? undefined
      : decodeConversionLaunch(record.launch);
  return {
    workspaceId: requireConversionRequestText(
      record.workspaceId,
      "workspaceId",
      256
    ),
    targetId: requireConversionRequestText(record.targetId, "targetId", 256),
    effectiveConnectionPolicyHash: requirePolicyHash(
      record.effectiveConnectionPolicyHash
    ),
    connectionName: requireConversionRequestText(
      record.connectionName,
      "connectionName",
      4 * 1024
    ),
    defaultCwd: requireConversionRequestText(
      record.defaultCwd,
      "defaultCwd",
      32 * 1024
    ),
    ...(record.continuation === undefined
      ? {}
      : { continuation: requireContinuation(record.continuation) }),
    ...(launch === undefined ? {} : { launch })
  };
}

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

export interface ConversionRemoteGateway {
  prepare(
    request: ConversionRemotePrepareRequest
  ): Promise<ConversionRemoteCreatedEvidence>;
  promote(
    record: ConversionCommitDecidedRecord
  ): Promise<ConversionRemotePromotionResult>;
}

export interface TransactionalWorkspaceConversionRuntimeOptions {
  desktopInstallationId: Id;
  wal: ConversionWalStore;
  remote: ConversionRemoteGateway;
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

export interface TransactionalWorkspaceConversionRuntime {
  start(request: StartWorkspaceConversionRequest): Promise<ConversionWalRecord>;
  recover(): Promise<ConversionWalRecord[]>;
  recoverTarget(targetId: Id): Promise<ConversionWalRecord[]>;
  resume(transactionId: Id): Promise<ConversionWalRecord>;
  compactCompleted(transactionId: Id): void;
}

/**
 * Main-owned low-frequency conversion coordinator. It never sends terminal
 * bytes and cannot terminate a local generation before `committed` is durable.
 */
export function createTransactionalWorkspaceConversionRuntime(
  options: TransactionalWorkspaceConversionRuntimeOptions
): TransactionalWorkspaceConversionRuntime {
  const makeTransactionId =
    options.makeTransactionId ?? (() => stableId("conversion", cryptoSeed()));
  const now = options.now ?? (() => new Date().toISOString());
  const queues = new Map<Id, Promise<ConversionWalRecord>>();

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

    if (record.state === "remote-created") {
      const state = options.getState();
      if (
        computeWorkspaceRevision(state, record.preservation.workspaceId) !==
        record.sourceWorkspaceRevision
      ) {
        throw new Error("conversion source workspace changed before commit");
      }
      const patch = createPatch(record, state);
      record = options.wal.decideCommit(transactionId, {
        replacementPatch: patch,
        replacementPatchHash: conversionPatchHash(patch),
        decidedAt: now()
      });
      notify("commit-decided-persisted", record);
    }

    if (record.state === "commit-decided") {
      const candidate = cloneState(options.getState());
      if (record.continuation === "convert") {
        applySshWorkspaceReplacementPatch(candidate, record.replacementPatch);
      } else {
        applySshWorkspaceAdditionPatch(candidate, record.replacementPatch);
      }
      const expectedSnapshotHash = desktopSnapshotHash(candidate);
      const persistedSnapshotHash = await options.forceDesktopSnapshot(
        candidate,
        expectedSnapshotHash
      );
      if (persistedSnapshotHash !== expectedSnapshotHash) {
        throw new Error("forced desktop snapshot hash does not match");
      }
      notify("desktop-snapshot-forced", record);
      options.installDesktopState(candidate);
      if (
        computeWorkspaceRevision(
          options.getState(),
          record.workspaceResourceKey.workspaceId
        ) !== record.replacementPatch.replacementWorkspaceRevision
      ) {
        throw new Error("installed desktop conversion patch does not match");
      }
      notify("desktop-state-installed", record);
      const promotion = await options.remote.promote(record);
      if (
        promotion.transactionId !== record.transactionId ||
        promotion.remoteSnapshotHash !== record.remoteSnapshotHash
      ) {
        throw new Error("remote conversion promotion identity does not match");
      }
      notify("remote-promoted", record);
      record = options.wal.recordCommitted(transactionId, {
        desktopSnapshotHash: persistedSnapshotHash,
        remotePromotionHash: promotion.remotePromotionHash,
        committedAt: now()
      });
      notify("committed-persisted", record);
    }

    if (record.state === "committed") {
      const acknowledgements: ConversionCleanupAcknowledgement[] = [];
      for (const target of record.cleanupSet) {
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
      request: StartWorkspaceConversionRequest
    ): Promise<ConversionWalRecord> {
      const state = options.getState();
      const workspace = state.workspaces[request.workspaceId];
      const continuation = request.continuation ?? "convert";
      if (!workspace) {
        throw new Error("SSH workspace source must exist");
      }
      if (
        continuation === "convert" &&
        workspace.location.target.kind !== "local"
      ) {
        throw new Error(
          "conversion source must be an existing local workspace"
        );
      }
      if (
        options.wal
          .loadAll()
          .some(
            (record) =>
              record.preservation.workspaceId === workspace.id &&
              record.state !== "cleanup-complete"
          )
      ) {
        throw new Error(
          "conversion source workspace already has an unfinished transaction"
        );
      }
      const binding = requireBinding(
        request.targetId,
        request.effectiveConnectionPolicyHash
      );
      const transactionId = makeTransactionId();
      const ids = conversionIds(transactionId);
      const resourceWorkspaceId =
        continuation === "convert" ? workspace.id : ids.workspaceId;
      const cleanupSet =
        continuation === "convert"
          ? captureCleanupSet(state, workspace.id, options.getLocalRuntimeEpoch)
          : [];
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
          : { title: request.launch.title })
      };
      const record = options.wal.begin({
        continuation,
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
        sourceWorkspaceRevision: computeWorkspaceRevision(state, workspace.id),
        effectiveConnectionPolicyHash:
          binding.locator.effectiveConnectionPolicyHash,
        preservation: {
          workspaceId: workspace.id,
          windowId: workspace.windowId,
          name: workspace.name,
          nameLocked: workspace.nameLocked === true,
          pinned: workspace.pinned
        },
        cleanupSet,
        connectionName: request.connectionName,
        defaultCwd: request.defaultCwd,
        launch,
        preparedAt: now()
      });
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
      return Promise.all(
        records.map((record) =>
          enqueue(record.transactionId, () => resumeNow(record.transactionId))
        )
      );
    },

    recoverTarget(targetId: Id): Promise<ConversionWalRecord[]> {
      const records = options.wal
        .loadAll()
        .filter((record) => record.workspaceResourceKey.targetId === targetId)
        .sort(
          (left, right) =>
            left.preparedAt.localeCompare(right.preparedAt) ||
            left.transactionId.localeCompare(right.transactionId)
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
    connectionName: record.connectionName,
    defaultCwd: record.defaultCwd,
    paneId: ids.paneId,
    nodeId: ids.nodeId,
    surfaceId: ids.surfaceId,
    sessionId: record.sessionResourceKey.sessionId,
    authToken: ids.authToken,
    keeperGeneration: record.keeperGeneration,
    remoteResourceRevision: parseUint64Decimal(record.remoteResourceRevision),
    launch: record.launch
  };
  return record.continuation === "convert"
    ? createSshWorkspaceReplacementPatch(state, {
        ...common,
        workspaceId: record.preservation.workspaceId
      })
    : createSshWorkspaceAdditionPatch(state, {
        ...common,
        sourceWorkspaceId: record.preservation.workspaceId,
        workspaceId: record.workspaceResourceKey.workspaceId
      });
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
      const session = state.sessions[surface.sessionId];
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
    surfaceId: stableId("surface", transactionId, "replacement"),
    sessionId: stableId("session", transactionId, "replacement"),
    authToken: stableId("auth", transactionId, "replacement")
  };
}

function buildRemoteSnapshot(record: ConversionPreparingRecord): string {
  return canonicalJson({
    version: 1,
    continuation: record.continuation,
    transactionId: record.transactionId,
    workspaceCreateOperationId: record.workspaceCreateOperationId,
    sessionCreateOperationId: record.sessionCreateOperationId,
    workspaceResourceKey: record.workspaceResourceKey,
    sessionResourceKey: record.sessionResourceKey,
    connectionName: record.connectionName,
    defaultCwd: record.defaultCwd,
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

function requireContinuation(value: unknown): "convert" | "create" {
  if (value !== "convert" && value !== "create") {
    throw new TypeError("conversion continuation is invalid");
  }
  return value;
}
