import { parseUint64Decimal } from "./uint64";
import type { Id, RemotePersistenceLevel } from "./index";

export const REMOTE_PROTOCOL_VERSION = 1 as const;

export interface RemoteSessionStorageStatusDto {
  state: "normal" | "degraded" | "backpressured";
  journalAdmitted: string;
  journalSynced: string;
  emergencyBytes: number;
  lastSyncDurationMs?: number;
}

export interface RemoteRetentionPolicyDto {
  sessionQuotaMiB: number;
  targetQuotaMiB: number;
}

export interface RemoteResourceKeyDto {
  desktopInstallationId: Id;
  targetId: Id;
  workspaceId: Id;
  sessionId?: Id;
}

export interface RemoteRuntimeRootsDto {
  installRoot: string;
  authorityRoot: string;
  stateRoot: string;
  runtimeRoot: string;
}

export interface RemoteConversionSessionLaunchDto {
  cwd: string;
  shell?: string;
  args?: string[];
  env?: Record<string, string>;
  title?: string;
}

export interface RemoteConversionPrepareRequestDto {
  transactionId: Id;
  workspaceCreateOperationId: Id;
  sessionCreateOperationId: Id;
  workspaceResourceKey: RemoteResourceKeyDto;
  sessionResourceKey: RemoteResourceKeyDto & { sessionId: Id };
  sourceWorkspaceRevision: string;
  remoteSnapshot: string;
  remoteSnapshotHash: string;
  launch: RemoteConversionSessionLaunchDto;
  preparedAt: string;
}

export interface RemoteConversionPromoteRequestDto {
  transactionId: Id;
  workspaceCreateOperationId: Id;
  sessionCreateOperationId: Id;
  workspaceResourceKey: RemoteResourceKeyDto;
  sessionResourceKey: RemoteResourceKeyDto & { sessionId: Id };
  remoteSnapshotHash: string;
}

export interface RemoteProvisionalReclaimRequestDto {
  desktopInstallationId: Id;
  targetId: Id;
  protectedTransactionIds: Id[];
  now: string;
}

export interface RemoteTerminalInjectRequestDto {
  resourceKey: RemoteResourceKeyDto & { sessionId: Id };
  expectedKeeperGeneration: Id;
  operationId: Id;
  payloadHash: string;
  input: string;
}

export interface RemoteSurfaceCaptureRequestDto {
  resourceKey: RemoteResourceKeyDto & { sessionId: Id };
  expectedKeeperGeneration: Id;
  captureId: Id;
  lineLimit: number;
  maxBytes: number;
}

export interface RemoteSpoolEventDto {
  version: 1;
  sequence: string;
  eventId: Id;
  kind: "agent-hook" | "notification" | "osc-notification";
  name: string;
  resourceKey: RemoteResourceKeyDto & { sessionId: Id };
  surfaceId: Id;
  keeperGeneration: Id;
  createdAtUnixMs: string;
  payload: unknown;
}

export type RemoteBridgeRequestBody =
  | { type: "hello" }
  | { type: "operation.execute"; intent: unknown; payload: unknown }
  | {
      type: "observe";
      desktopInstallationId: Id;
      targetId: Id;
    }
  | {
      type: "git.inspect";
      desktopInstallationId: Id;
      targetId: Id;
      cwd: string;
      dirtyLimit: number;
      branch?: string;
    }
  | {
      type: "ports.inspect";
      resourceKey: RemoteResourceKeyDto & { sessionId: Id };
    }
  | {
      type: "history.scan";
      desktopInstallationId: Id;
      targetId: Id;
      maxRecords: number;
    }
  | {
      type: "usage.scan";
      desktopInstallationId: Id;
      targetId: Id;
      startAtUnixMs: string;
      maxRecords: number;
    }
  | {
      type: "forwards.observe";
      desktopInstallationId: Id;
      targetId: Id;
    }
  | {
      type: "attach.authorize";
      resourceKey: RemoteResourceKeyDto & { sessionId: Id };
      expectedKeeperGeneration?: Id;
      access: "read" | "write";
    }
  | ({ type: "terminal.inject" } & RemoteTerminalInjectRequestDto)
  | ({ type: "surface.capture" } & RemoteSurfaceCaptureRequestDto)
  | {
      type: "events.replay";
      desktopInstallationId: Id;
      targetId: Id;
      afterSequence: string;
    }
  | {
      type: "events.ack";
      desktopInstallationId: Id;
      targetId: Id;
      throughSequence: string;
    }
  | ({ type: "conversion.prepare" } & RemoteConversionPrepareRequestDto)
  | ({ type: "conversion.promote" } & RemoteConversionPromoteRequestDto)
  | ({ type: "provisional.reclaim" } & RemoteProvisionalReclaimRequestDto);

export interface RemoteBridgeRequestEnvelope {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  requestId: Id;
  token: string;
  roots: RemoteRuntimeRootsDto;
  retentionPolicy?: RemoteRetentionPolicyDto;
  request: RemoteBridgeRequestBody;
}

export type RemoteBridgeResponseBody =
  | {
      type: "hello";
      protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
      runtimeVersion: string;
      bridgeGeneration: Id;
      capabilities: string[];
      authority: {
        remoteInstallationId: Id;
        executionNodeId: Id;
        authenticatedPrincipal: { uid: number; accountName: string };
      };
      platform: string;
      arch: string;
      abi: string;
      persistenceLevel: RemotePersistenceLevel;
    }
  | {
      type: "operation.result";
      outcome: "succeeded";
      operationId: Id;
      remoteResourceRevision: string;
      resultDigest: string;
      keeperGeneration?: Id;
    }
  | {
      type: "operation.result";
      outcome: "failed";
      operationId: Id;
      resultDigest: string;
      code: string;
      message: string;
    }
  | {
      type: "observed";
      targetId: Id;
      bridgeGeneration: Id;
      observedAt: string;
      workspaces?: Array<{
        resourceKey: RemoteResourceKeyDto;
        state: "active" | "terminated" | "provisional" | "abandoned";
        remoteResourceRevision: string;
        createOperationId: Id;
        canonicalCreatePayloadHash: string;
        lastOperationId: Id;
        lastOperationPayloadHash: string;
        lastResultDigest: string;
      }>;
      keepers: Array<{
        resourceKey: RemoteResourceKeyDto & { sessionId: Id };
        keeperGeneration: Id;
        descriptorState?: "creating" | "running" | "exited" | "terminated";
        processState: "running" | "exited";
        remoteResourceRevision: string;
        exitCode?: number;
        createOperationId: Id;
        canonicalCreatePayloadHash: string;
        lastOperationId: Id;
        lastOperationPayloadHash: string;
        lastResultDigest: string;
        launch: RemoteConversionSessionLaunchDto;
        lifecycleState: "committed" | "provisional" | "abandoned";
        conversionTransactionId?: Id;
        remoteSnapshotHash?: string;
        provisionalCreatedAt?: string;
        everGrantedWriterLease: boolean;
        storageStatus: RemoteSessionStorageStatusDto;
        checkpointAvailable: boolean;
        retainedRangeTruncated: boolean;
      }>;
    }
  | {
      type: "git.inspected";
      cwd: string;
      repository?: {
        root: string;
        gitDir: string;
        commonGitDir: string;
        linkedWorktree: boolean;
      };
      branch?: string;
      dirtyEntries: string[];
      dirtyEntriesTruncated: boolean;
      branchExists?: boolean;
    }
  | {
      type: "ports.inspected";
      resourceKey: RemoteResourceKeyDto & { sessionId: Id };
      ports: number[];
    }
  | {
      type: "history.scanned";
      targetId: Id;
      principal: { uid: number; accountName: string };
      records: Array<{
        vendor: "codex" | "claude" | "antigravity";
        sessionId: string;
        updatedAtUnixMs: string;
        canResume: boolean;
        cwd?: string;
        title?: string;
        recentConversation?: string;
        model?: string;
        createdAt?: string;
        updatedAt?: string;
      }>;
    }
  | {
      type: "usage.scanned";
      targetId: Id;
      principal: { uid: number; accountName: string };
      truncated: boolean;
      records: Array<{
        vendor: "codex" | "claude" | "antigravity";
        sampleId: string;
        timestampUnixMs: string;
        sessionId?: string;
        model?: string;
        cwd?: string;
        projectPath?: string;
        inputTokens: string;
        outputTokens: string;
        thinkingTokens: string;
        cacheReadTokens: string;
        cacheWriteTokens: string;
        cacheWriteTokensKnown: boolean;
        totalTokens: string;
      }>;
    }
  | {
      type: "forwards.observed";
      targetId: Id;
      forwards: Array<{
        resourceKey: RemoteResourceKeyDto;
        forwardId: Id;
        remoteHost: string;
        remotePort: number;
        localBindHost: "127.0.0.1" | "::1";
        localPort?: number;
        operationId: Id;
        remoteResourceRevision: string;
      }>;
    }
  | {
      type: "conversion.prepared";
      transactionId: Id;
      remoteSnapshotHash: string;
      workspaceDescriptorHash: string;
      sessionDescriptorHash: string;
      keeperGeneration: Id;
      remoteResourceRevision: string;
      remoteCreatedAt: string;
    }
  | {
      type: "conversion.promoted";
      transactionId: Id;
      remoteSnapshotHash: string;
      remotePromotionHash: string;
    }
  | {
      type: "provisional.reclaimed";
      protectedCount: number;
      terminatedTransactionIds: Id[];
      skippedEverLeasedTransactionIds: Id[];
    }
  | {
      type: "attach.authorized";
      resourceKey: RemoteResourceKeyDto & { sessionId: Id };
      keeperGeneration: Id;
      attachCapability: string;
      expiresAt: string;
      access: "read" | "write";
      terminalProxy:
        | { kind: "direct" }
        | {
            kind: "cohort";
            executablePath: string;
            socketPath: string;
            keeperLocalProtocolMajor: number;
          };
    }
  | {
      type: "terminal.input-ack";
      resourceKey: RemoteResourceKeyDto & { sessionId: Id };
      keeperGeneration: Id;
      operationId: Id;
      writerLeaseId: Id;
      byteLength: number;
      boundary: "pty-write";
    }
  | {
      type: "surface.capture-chunk";
      captureId: Id;
      index: number;
      text: string;
    }
  | {
      type: "surface.capture-completed";
      captureId: Id;
      resourceKey: RemoteResourceKeyDto & { sessionId: Id };
      keeperGeneration: Id;
      mutationSequence: string;
      cols: number;
      rows: number;
      lineCount: number;
      byteLength: number;
      chunkCount: number;
      sha256: string;
      linesTruncated: boolean;
      bytesTruncated: boolean;
      retainedRangeTruncated: boolean;
    }
  | {
      type: "events.replayed";
      targetId: Id;
      events: RemoteSpoolEventDto[];
      acknowledgedThrough: string;
      hasMore: boolean;
      admittedCount: string;
      droppedLowValueCount: string;
    }
  | {
      type: "events.acknowledged";
      targetId: Id;
      acknowledgedThrough: string;
      removedCount: number;
    };

export type RemoteBridgeResponseEnvelope =
  | {
      protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
      requestId: Id;
      status: "ok";
      body: RemoteBridgeResponseBody;
    }
  | {
      protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
      requestId: Id;
      status: "error";
      error: { code: string; message: string; retryable: boolean };
    };

export interface RemoteKeeperAttachRequest {
  type: "keeper.attach";
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  roots: RemoteRuntimeRootsDto;
  resourceKey: RemoteResourceKeyDto & { sessionId: Id };
  keeperGeneration: Id;
  attachCapability: string;
  attachmentId: Id;
  access: "read" | "write";
  lastReceivedSequence?: string;
}

export type RemoteKeeperControlMessage =
  | {
      type: "attach.ready";
      keeperGeneration: Id;
      attachmentId: Id;
      writerLeaseId?: Id;
      checkpointAvailable: boolean;
      cols: number;
      rows: number;
      earliestAvailableSequence: string;
      replayFromSequence: string;
      liveStartsAfterSequence: string;
      truncatedBeforeSequence?: string;
    }
  | {
      type: "checkpoint.begin";
      checkpointId: Id;
      format: string;
      parserVersion: string;
      lastMutationSequence: string;
      cols: number;
      rows: number;
      byteLength: string;
    }
  | { type: "checkpoint.end"; checkpointId: Id; sha256: string }
  | {
      type: "input.ack";
      writerLeaseId: Id;
      attachmentId: Id;
      highestAppliedInputSequence: string;
      boundary: "pty-write";
    }
  | {
      type: "resize.ack";
      writerLeaseId: Id;
      attachmentId: Id;
      mutationSequence: string;
      cols: number;
      rows: number;
    }
  | {
      type: "terminal.error";
      code: string;
      message: string;
      retryable: boolean;
    };

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();

export function encodeRemoteControlJson(value: unknown): Uint8Array {
  const encoded = textEncoder.encode(JSON.stringify(value));
  if (encoded.byteLength > 256 * 1024) {
    throw new RangeError("remote control JSON exceeds 256 KiB");
  }
  return encoded;
}

export function decodeRemoteBridgeResponseEnvelope(
  payload: Uint8Array
): RemoteBridgeResponseEnvelope {
  const record = parseControlRecord(payload, "bridge response");
  assertExactKeys(record, [
    "protocolVersion",
    "requestId",
    "status",
    "body",
    "error"
  ]);
  requireProtocolVersion(record.protocolVersion);
  const requestId = requireId(record.requestId, "requestId");
  if (record.status === "error") {
    if (record.body !== undefined) {
      throw new TypeError("an error bridge response cannot contain a body");
    }
    return {
      protocolVersion: 1,
      requestId,
      status: "error",
      error: decodeBridgeError(record.error)
    };
  }
  if (record.status !== "ok" || record.error !== undefined) {
    throw new TypeError("bridge response status is invalid");
  }
  return {
    protocolVersion: 1,
    requestId,
    status: "ok",
    body: decodeRemoteBridgeResponseBody(record.body)
  };
}

export function decodeRemoteKeeperControlMessage(
  payload: Uint8Array
): RemoteKeeperControlMessage {
  const record = parseControlRecord(payload, "keeper control message");
  switch (record.type) {
    case "attach.ready":
      assertExactKeys(record, [
        "type",
        "keeperGeneration",
        "attachmentId",
        "writerLeaseId",
        "checkpointAvailable",
        "cols",
        "rows",
        "earliestAvailableSequence",
        "replayFromSequence",
        "liveStartsAfterSequence",
        "truncatedBeforeSequence"
      ]);
      return {
        type: record.type,
        keeperGeneration: requireId(
          record.keeperGeneration,
          "keeperGeneration"
        ),
        attachmentId: requireId(record.attachmentId, "attachmentId"),
        ...(record.writerLeaseId === undefined
          ? {}
          : {
              writerLeaseId: requireId(record.writerLeaseId, "writerLeaseId")
            }),
        checkpointAvailable: requireBoolean(
          record.checkpointAvailable,
          "checkpointAvailable"
        ),
        cols: requireDimension(record.cols),
        rows: requireDimension(record.rows),
        earliestAvailableSequence: requireUint64String(
          record.earliestAvailableSequence,
          "earliestAvailableSequence"
        ),
        replayFromSequence: requireUint64String(
          record.replayFromSequence,
          "replayFromSequence"
        ),
        liveStartsAfterSequence: requireUint64String(
          record.liveStartsAfterSequence,
          "liveStartsAfterSequence"
        ),
        ...(record.truncatedBeforeSequence === undefined
          ? {}
          : {
              truncatedBeforeSequence: requireUint64String(
                record.truncatedBeforeSequence,
                "truncatedBeforeSequence"
              )
            })
      };
    case "checkpoint.begin":
      assertExactKeys(record, [
        "type",
        "checkpointId",
        "format",
        "parserVersion",
        "lastMutationSequence",
        "cols",
        "rows",
        "byteLength"
      ]);
      return {
        type: record.type,
        checkpointId: requireId(record.checkpointId, "checkpointId"),
        format: requireString(record.format, "format", 256),
        parserVersion: requireString(
          record.parserVersion,
          "parserVersion",
          256
        ),
        lastMutationSequence: requireUint64String(
          record.lastMutationSequence,
          "lastMutationSequence"
        ),
        cols: requireDimension(record.cols),
        rows: requireDimension(record.rows),
        byteLength: requireUint64String(record.byteLength, "byteLength")
      };
    case "checkpoint.end":
      assertExactKeys(record, ["type", "checkpointId", "sha256"]);
      return {
        type: record.type,
        checkpointId: requireId(record.checkpointId, "checkpointId"),
        sha256: requireHash(record.sha256, "sha256")
      };
    case "input.ack":
      assertExactKeys(record, [
        "type",
        "writerLeaseId",
        "attachmentId",
        "highestAppliedInputSequence",
        "boundary"
      ]);
      if (record.boundary !== "pty-write") {
        throw new TypeError("input acknowledgement boundary is invalid");
      }
      return {
        type: record.type,
        writerLeaseId: requireId(record.writerLeaseId, "writerLeaseId"),
        attachmentId: requireId(record.attachmentId, "attachmentId"),
        highestAppliedInputSequence: requireUint64String(
          record.highestAppliedInputSequence,
          "highestAppliedInputSequence"
        ),
        boundary: record.boundary
      };
    case "resize.ack":
      assertExactKeys(record, [
        "type",
        "writerLeaseId",
        "attachmentId",
        "mutationSequence",
        "cols",
        "rows"
      ]);
      return {
        type: record.type,
        writerLeaseId: requireId(record.writerLeaseId, "writerLeaseId"),
        attachmentId: requireId(record.attachmentId, "attachmentId"),
        mutationSequence: requireUint64String(
          record.mutationSequence,
          "mutationSequence"
        ),
        cols: requireDimension(record.cols),
        rows: requireDimension(record.rows)
      };
    case "terminal.error":
      assertExactKeys(record, ["type", "code", "message", "retryable"]);
      if (typeof record.retryable !== "boolean") {
        throw new TypeError("terminal error retryable must be boolean");
      }
      return {
        type: record.type,
        code: requireString(record.code, "code", 256),
        message: requireString(record.message, "message", 4 * 1024),
        retryable: record.retryable
      };
    default:
      throw new TypeError("keeper control message type is unknown");
  }
}

export function decodeRemoteBridgeResponseBody(
  value: unknown
): RemoteBridgeResponseBody {
  const record = requireRecord(value, "bridge response body");
  switch (record.type) {
    case "hello": {
      assertExactKeys(record, [
        "type",
        "protocolVersion",
        "runtimeVersion",
        "bridgeGeneration",
        "capabilities",
        "authority",
        "platform",
        "arch",
        "abi",
        "persistenceLevel"
      ]);
      requireProtocolVersion(record.protocolVersion);
      const authority = requireRecord(record.authority, "authority");
      assertExactKeys(authority, [
        "remoteInstallationId",
        "executionNodeId",
        "authenticatedPrincipal"
      ]);
      const principal = requireRecord(
        authority.authenticatedPrincipal,
        "authenticatedPrincipal"
      );
      assertExactKeys(principal, ["uid", "accountName"]);
      if (
        !Number.isSafeInteger(principal.uid) ||
        (principal.uid as number) < 0 ||
        (principal.uid as number) > 0xffff_ffff
      ) {
        throw new TypeError("authenticated uid is invalid");
      }
      if (
        !Array.isArray(record.capabilities) ||
        record.capabilities.length > 256
      ) {
        throw new TypeError("capabilities must be a bounded array");
      }
      const persistenceLevel = record.persistenceLevel;
      if (
        persistenceLevel !== "ssh-disconnect" &&
        persistenceLevel !== "user-logout" &&
        persistenceLevel !== "host-reboot"
      ) {
        throw new TypeError("persistenceLevel is invalid");
      }
      return {
        type: record.type,
        protocolVersion: 1,
        runtimeVersion: requireString(
          record.runtimeVersion,
          "runtimeVersion",
          256
        ),
        bridgeGeneration: requireId(
          record.bridgeGeneration,
          "bridgeGeneration"
        ),
        capabilities: record.capabilities.map((capability) =>
          requireString(capability, "capability", 256)
        ),
        authority: {
          remoteInstallationId: requireId(
            authority.remoteInstallationId,
            "remoteInstallationId"
          ),
          executionNodeId: requireId(
            authority.executionNodeId,
            "executionNodeId"
          ),
          authenticatedPrincipal: {
            uid: principal.uid as number,
            accountName: requireString(
              principal.accountName,
              "accountName",
              4 * 1024
            )
          }
        },
        platform: requireString(record.platform, "platform", 256),
        arch: requireString(record.arch, "arch", 256),
        abi: requireString(record.abi, "abi", 256),
        persistenceLevel
      };
    }
    case "operation.result": {
      const outcome = record.outcome;
      if (outcome === "succeeded") {
        assertExactKeys(record, [
          "type",
          "outcome",
          "operationId",
          "remoteResourceRevision",
          "resultDigest",
          "keeperGeneration"
        ]);
        return {
          type: record.type,
          outcome,
          operationId: requireId(record.operationId, "operationId"),
          remoteResourceRevision: requireUint64String(
            record.remoteResourceRevision,
            "remoteResourceRevision"
          ),
          resultDigest: requireHash(record.resultDigest, "resultDigest"),
          ...(record.keeperGeneration === undefined
            ? {}
            : {
                keeperGeneration: requireId(
                  record.keeperGeneration,
                  "keeperGeneration"
                )
              })
        };
      }
      if (outcome !== "failed") {
        throw new TypeError("operation outcome is invalid");
      }
      assertExactKeys(record, [
        "type",
        "outcome",
        "operationId",
        "resultDigest",
        "code",
        "message"
      ]);
      return {
        type: record.type,
        outcome,
        operationId: requireId(record.operationId, "operationId"),
        resultDigest: requireHash(record.resultDigest, "resultDigest"),
        code: requireString(record.code, "code", 256),
        message: requireString(record.message, "message", 4 * 1024)
      };
    }
    case "observed":
      return decodeObservedBody(record);
    case "git.inspected": {
      assertExactKeys(record, [
        "type",
        "cwd",
        "repository",
        "branch",
        "dirtyEntries",
        "dirtyEntriesTruncated",
        "branchExists"
      ]);
      if (
        !Array.isArray(record.dirtyEntries) ||
        record.dirtyEntries.length > 256
      ) {
        throw new TypeError("dirtyEntries must be a bounded array");
      }
      const repository =
        record.repository === undefined
          ? undefined
          : decodeGitRepository(record.repository);
      return {
        type: record.type,
        cwd: requireAbsoluteRemotePath(record.cwd, "cwd", 32 * 1024),
        ...(repository === undefined ? {} : { repository }),
        ...(record.branch === undefined
          ? {}
          : { branch: requireString(record.branch, "branch", 32 * 1024) }),
        dirtyEntries: record.dirtyEntries.map((entry) =>
          requireString(entry, "dirty entry", 32 * 1024, true)
        ),
        dirtyEntriesTruncated: requireBoolean(
          record.dirtyEntriesTruncated,
          "dirtyEntriesTruncated"
        ),
        ...(record.branchExists === undefined
          ? {}
          : {
              branchExists: requireBoolean(record.branchExists, "branchExists")
            })
      };
    }
    case "ports.inspected": {
      assertExactKeys(record, ["type", "resourceKey", "ports"]);
      if (!Array.isArray(record.ports) || record.ports.length > 64) {
        throw new TypeError("inspected ports must be a bounded array");
      }
      const ports = record.ports.map((port) => {
        if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
          throw new TypeError("inspected port is invalid");
        }
        return port;
      });
      if (new Set(ports).size !== ports.length) {
        throw new TypeError("inspected ports must be unique");
      }
      return {
        type: record.type,
        resourceKey: decodeSessionResourceKey(record.resourceKey),
        ports
      };
    }
    case "history.scanned": {
      assertExactKeys(record, ["type", "targetId", "principal", "records"]);
      const principal = requireRecord(record.principal, "history principal");
      assertExactKeys(principal, ["uid", "accountName"]);
      const principalUid = principal.uid;
      if (
        typeof principalUid !== "number" ||
        !Number.isSafeInteger(principalUid) ||
        principalUid < 0 ||
        principalUid > 0xffff_ffff
      ) {
        throw new TypeError("history principal uid is invalid");
      }
      if (!Array.isArray(record.records) || record.records.length > 100) {
        throw new TypeError("history records must be a bounded array");
      }
      return {
        type: record.type,
        targetId: requireId(record.targetId, "targetId"),
        principal: {
          uid: principalUid,
          accountName: requireString(
            principal.accountName,
            "history principal accountName",
            4 * 1024
          )
        },
        records: record.records.map(decodeRemoteHistoryRecord)
      };
    }
    case "usage.scanned": {
      assertExactKeys(record, [
        "type",
        "targetId",
        "principal",
        "truncated",
        "records"
      ]);
      const principal = decodeRemotePrincipal(record.principal, "usage");
      if (!Array.isArray(record.records) || record.records.length > 64) {
        throw new TypeError("usage records must be a bounded array");
      }
      const records = record.records.map(decodeRemoteUsageRecord);
      if (
        new Set(records.map((sample) => sample.sampleId)).size !==
        records.length
      ) {
        throw new TypeError("remote usage sample IDs must be unique");
      }
      return {
        type: record.type,
        targetId: requireId(record.targetId, "targetId"),
        principal,
        truncated: requireBoolean(record.truncated, "usage.truncated"),
        records
      };
    }
    case "forwards.observed": {
      assertExactKeys(record, ["type", "targetId", "forwards"]);
      if (!Array.isArray(record.forwards) || record.forwards.length > 4_096) {
        throw new TypeError("observed forwards must be a bounded array");
      }
      return {
        type: record.type,
        targetId: requireId(record.targetId, "targetId"),
        forwards: record.forwards.map(decodeDesiredForward)
      };
    }
    case "conversion.prepared":
      assertExactKeys(record, [
        "type",
        "transactionId",
        "remoteSnapshotHash",
        "workspaceDescriptorHash",
        "sessionDescriptorHash",
        "keeperGeneration",
        "remoteResourceRevision",
        "remoteCreatedAt"
      ]);
      return {
        type: record.type,
        transactionId: requireId(record.transactionId, "transactionId"),
        remoteSnapshotHash: requireHash(
          record.remoteSnapshotHash,
          "remoteSnapshotHash"
        ),
        workspaceDescriptorHash: requireHash(
          record.workspaceDescriptorHash,
          "workspaceDescriptorHash"
        ),
        sessionDescriptorHash: requireHash(
          record.sessionDescriptorHash,
          "sessionDescriptorHash"
        ),
        keeperGeneration: requireId(
          record.keeperGeneration,
          "keeperGeneration"
        ),
        remoteResourceRevision: requireUint64String(
          record.remoteResourceRevision,
          "remoteResourceRevision"
        ),
        remoteCreatedAt: requireTimestamp(
          record.remoteCreatedAt,
          "remoteCreatedAt"
        )
      };
    case "conversion.promoted":
      assertExactKeys(record, [
        "type",
        "transactionId",
        "remoteSnapshotHash",
        "remotePromotionHash"
      ]);
      return {
        type: record.type,
        transactionId: requireId(record.transactionId, "transactionId"),
        remoteSnapshotHash: requireHash(
          record.remoteSnapshotHash,
          "remoteSnapshotHash"
        ),
        remotePromotionHash: requireHash(
          record.remotePromotionHash,
          "remotePromotionHash"
        )
      };
    case "provisional.reclaimed":
      assertExactKeys(record, [
        "type",
        "protectedCount",
        "terminatedTransactionIds",
        "skippedEverLeasedTransactionIds"
      ]);
      if (
        !Number.isSafeInteger(record.protectedCount) ||
        (record.protectedCount as number) < 0 ||
        (record.protectedCount as number) > 4_096
      ) {
        throw new TypeError("protectedCount is invalid");
      }
      return {
        type: record.type,
        protectedCount: record.protectedCount as number,
        terminatedTransactionIds: decodeBoundedIds(
          record.terminatedTransactionIds,
          "terminatedTransactionIds"
        ),
        skippedEverLeasedTransactionIds: decodeBoundedIds(
          record.skippedEverLeasedTransactionIds,
          "skippedEverLeasedTransactionIds"
        )
      };
    case "attach.authorized": {
      assertExactKeys(record, [
        "type",
        "resourceKey",
        "keeperGeneration",
        "attachCapability",
        "expiresAt",
        "access",
        "terminalProxy"
      ]);
      const terminalProxy = decodeTerminalProxy(record.terminalProxy);
      return {
        type: record.type,
        resourceKey: decodeSessionResourceKey(record.resourceKey),
        keeperGeneration: requireId(
          record.keeperGeneration,
          "keeperGeneration"
        ),
        attachCapability: requireSecret(
          record.attachCapability,
          "attachCapability"
        ),
        expiresAt: requireTimestamp(record.expiresAt, "expiresAt"),
        access: requireAccess(record.access),
        terminalProxy
      };
    }
    case "terminal.input-ack":
      assertExactKeys(record, [
        "type",
        "resourceKey",
        "keeperGeneration",
        "operationId",
        "writerLeaseId",
        "byteLength",
        "boundary"
      ]);
      if (record.boundary !== "pty-write") {
        throw new TypeError(
          "terminal input acknowledgement boundary is invalid"
        );
      }
      return {
        type: record.type,
        resourceKey: decodeSessionResourceKey(record.resourceKey),
        keeperGeneration: requireId(
          record.keeperGeneration,
          "keeperGeneration"
        ),
        operationId: requireId(record.operationId, "operationId"),
        writerLeaseId: requireId(record.writerLeaseId, "writerLeaseId"),
        byteLength: requireBoundedInteger(
          record.byteLength,
          "byteLength",
          64 * 1024
        ),
        boundary: record.boundary
      };
    case "surface.capture-chunk":
      assertExactKeys(record, ["type", "captureId", "index", "text"]);
      return {
        type: record.type,
        captureId: requireId(record.captureId, "captureId"),
        index: requireBoundedInteger(record.index, "index", 64),
        text: requireString(record.text, "capture text chunk", 32 * 1024)
      };
    case "surface.capture-completed":
      assertExactKeys(record, [
        "type",
        "captureId",
        "resourceKey",
        "keeperGeneration",
        "mutationSequence",
        "cols",
        "rows",
        "lineCount",
        "byteLength",
        "chunkCount",
        "sha256",
        "linesTruncated",
        "bytesTruncated",
        "retainedRangeTruncated"
      ]);
      return {
        type: record.type,
        captureId: requireId(record.captureId, "captureId"),
        resourceKey: decodeSessionResourceKey(record.resourceKey),
        keeperGeneration: requireId(
          record.keeperGeneration,
          "keeperGeneration"
        ),
        mutationSequence: requireUint64String(
          record.mutationSequence,
          "mutationSequence"
        ),
        cols: requireDimension(record.cols),
        rows: requireDimension(record.rows),
        lineCount: requireBoundedInteger(record.lineCount, "lineCount", 65_536),
        byteLength: requireBoundedInteger(
          record.byteLength,
          "byteLength",
          1024 * 1024
        ),
        chunkCount: requireBoundedInteger(record.chunkCount, "chunkCount", 64),
        sha256: requireHash(record.sha256, "sha256"),
        linesTruncated: requireBoolean(record.linesTruncated, "linesTruncated"),
        bytesTruncated: requireBoolean(record.bytesTruncated, "bytesTruncated"),
        retainedRangeTruncated: requireBoolean(
          record.retainedRangeTruncated,
          "retainedRangeTruncated"
        )
      };
    case "events.replayed":
      assertExactKeys(record, [
        "type",
        "targetId",
        "events",
        "acknowledgedThrough",
        "hasMore",
        "admittedCount",
        "droppedLowValueCount"
      ]);
      if (!Array.isArray(record.events) || record.events.length > 128) {
        throw new TypeError("replayed events must be a bounded array");
      }
      return {
        type: record.type,
        targetId: requireId(record.targetId, "targetId"),
        events: record.events.map(decodeRemoteSpoolEventDto),
        acknowledgedThrough: requireUint64String(
          record.acknowledgedThrough,
          "acknowledgedThrough"
        ),
        hasMore: requireBoolean(record.hasMore, "hasMore"),
        admittedCount: requireUint64String(
          record.admittedCount,
          "admittedCount"
        ),
        droppedLowValueCount: requireUint64String(
          record.droppedLowValueCount,
          "droppedLowValueCount"
        )
      };
    case "events.acknowledged":
      assertExactKeys(record, [
        "type",
        "targetId",
        "acknowledgedThrough",
        "removedCount"
      ]);
      return {
        type: record.type,
        targetId: requireId(record.targetId, "targetId"),
        acknowledgedThrough: requireUint64String(
          record.acknowledgedThrough,
          "acknowledgedThrough"
        ),
        removedCount: requireBoundedInteger(
          record.removedCount,
          "removedCount",
          4_096
        )
      };
    default:
      throw new TypeError("bridge response body type is unknown");
  }
}

function decodeGitRepository(value: unknown): {
  root: string;
  gitDir: string;
  commonGitDir: string;
  linkedWorktree: boolean;
} {
  const repository = requireRecord(value, "git repository");
  assertExactKeys(repository, [
    "root",
    "gitDir",
    "commonGitDir",
    "linkedWorktree"
  ]);
  return {
    root: requireAbsoluteRemotePath(
      repository.root,
      "repository.root",
      32 * 1024
    ),
    gitDir: requireAbsoluteRemotePath(
      repository.gitDir,
      "repository.gitDir",
      32 * 1024
    ),
    commonGitDir: requireAbsoluteRemotePath(
      repository.commonGitDir,
      "repository.commonGitDir",
      32 * 1024
    ),
    linkedWorktree: requireBoolean(
      repository.linkedWorktree,
      "repository.linkedWorktree"
    )
  };
}

function decodeDesiredForward(
  value: unknown
): Extract<
  RemoteBridgeResponseBody,
  { type: "forwards.observed" }
>["forwards"][number] {
  const forward = requireRecord(value, "desired forward");
  assertExactKeys(forward, [
    "resourceKey",
    "forwardId",
    "remoteHost",
    "remotePort",
    "localBindHost",
    "localPort",
    "operationId",
    "remoteResourceRevision"
  ]);
  if (
    forward.localBindHost !== "127.0.0.1" &&
    forward.localBindHost !== "::1"
  ) {
    throw new TypeError("desired forward bind host is not loopback");
  }
  return {
    resourceKey: decodeResourceKey(forward.resourceKey),
    forwardId: requireId(forward.forwardId, "forwardId"),
    remoteHost: requireString(forward.remoteHost, "remoteHost", 4 * 1024),
    remotePort: requirePort(forward.remotePort, "remotePort"),
    localBindHost: forward.localBindHost,
    ...(forward.localPort === undefined
      ? {}
      : { localPort: requirePort(forward.localPort, "localPort") }),
    operationId: requireId(forward.operationId, "operationId"),
    remoteResourceRevision: requireUint64String(
      forward.remoteResourceRevision,
      "remoteResourceRevision"
    )
  };
}

function decodeTerminalProxy(
  value: unknown
): Extract<
  RemoteBridgeResponseBody,
  { type: "attach.authorized" }
>["terminalProxy"] {
  const proxy = requireRecord(value, "terminalProxy");
  if (proxy.kind === "direct") {
    assertExactKeys(proxy, ["kind"]);
    return { kind: "direct" };
  }
  if (proxy.kind !== "cohort") {
    throw new TypeError("terminalProxy kind is invalid");
  }
  assertExactKeys(proxy, [
    "kind",
    "executablePath",
    "socketPath",
    "keeperLocalProtocolMajor"
  ]);
  if (
    !Number.isSafeInteger(proxy.keeperLocalProtocolMajor) ||
    (proxy.keeperLocalProtocolMajor as number) <= 0 ||
    (proxy.keeperLocalProtocolMajor as number) > 0xffff
  ) {
    throw new TypeError("keeperLocalProtocolMajor is invalid");
  }
  return {
    kind: "cohort",
    executablePath: requireString(
      proxy.executablePath,
      "executablePath",
      32 * 1024
    ),
    socketPath: requireString(proxy.socketPath, "socketPath", 32 * 1024),
    keeperLocalProtocolMajor: proxy.keeperLocalProtocolMajor as number
  };
}

export function decodeRemoteSpoolEventDto(value: unknown): RemoteSpoolEventDto {
  const event = requireRecord(value, "remote spool event");
  assertExactKeys(event, [
    "version",
    "sequence",
    "eventId",
    "kind",
    "name",
    "resourceKey",
    "surfaceId",
    "keeperGeneration",
    "createdAtUnixMs",
    "payload"
  ]);
  if (event.version !== 1) {
    throw new TypeError("remote spool event version is incompatible");
  }
  if (
    event.kind !== "agent-hook" &&
    event.kind !== "notification" &&
    event.kind !== "osc-notification"
  ) {
    throw new TypeError("remote spool event kind is invalid");
  }
  if (!Object.hasOwn(event, "payload")) {
    throw new TypeError("remote spool event payload is missing");
  }
  const payloadBytes = textEncoder.encode(JSON.stringify(event.payload));
  if (payloadBytes.byteLength > 64 * 1024) {
    throw new TypeError("remote spool event payload is oversized");
  }
  return {
    version: 1,
    sequence: requireUint64String(event.sequence, "event.sequence"),
    eventId: requireId(event.eventId, "eventId"),
    kind: event.kind,
    name: requireString(event.name, "event.name", 512, true),
    resourceKey: decodeSessionResourceKey(event.resourceKey),
    surfaceId: requireId(event.surfaceId, "surfaceId"),
    keeperGeneration: requireId(event.keeperGeneration, "keeperGeneration"),
    createdAtUnixMs: requireUint64String(
      event.createdAtUnixMs,
      "createdAtUnixMs"
    ),
    payload: event.payload
  };
}

function decodeRemoteHistoryRecord(
  value: unknown
): Extract<
  RemoteBridgeResponseBody,
  { type: "history.scanned" }
>["records"][number] {
  const record = requireRecord(value, "remote history record");
  assertExactKeys(record, [
    "vendor",
    "sessionId",
    "updatedAtUnixMs",
    "canResume",
    "cwd",
    "title",
    "recentConversation",
    "model",
    "createdAt",
    "updatedAt"
  ]);
  if (
    record.vendor !== "codex" &&
    record.vendor !== "claude" &&
    record.vendor !== "antigravity"
  ) {
    throw new TypeError("remote history vendor is invalid");
  }
  const createdAt =
    record.createdAt === undefined
      ? undefined
      : requireTimestamp(record.createdAt, "history.createdAt");
  const updatedAt =
    record.updatedAt === undefined
      ? undefined
      : requireTimestamp(record.updatedAt, "history.updatedAt");
  return {
    vendor: record.vendor,
    sessionId: requireString(record.sessionId, "history.sessionId", 4 * 1024),
    updatedAtUnixMs: requireUint64String(
      record.updatedAtUnixMs,
      "history.updatedAtUnixMs"
    ),
    canResume: requireBoolean(record.canResume, "history.canResume"),
    ...(record.cwd === undefined
      ? {}
      : {
          cwd: requireAbsoluteRemotePath(record.cwd, "history.cwd", 32 * 1024)
        }),
    ...(record.title === undefined
      ? {}
      : { title: requireString(record.title, "history.title", 512) }),
    ...(record.recentConversation === undefined
      ? {}
      : {
          recentConversation: requireString(
            record.recentConversation,
            "history.recentConversation",
            4 * 1024
          )
        }),
    ...(record.model === undefined
      ? {}
      : { model: requireString(record.model, "history.model", 512) }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt })
  };
}

function decodeRemoteUsageRecord(
  value: unknown
): Extract<
  RemoteBridgeResponseBody,
  { type: "usage.scanned" }
>["records"][number] {
  const record = requireRecord(value, "remote usage record");
  assertExactKeys(record, [
    "vendor",
    "sampleId",
    "timestampUnixMs",
    "sessionId",
    "model",
    "cwd",
    "projectPath",
    "inputTokens",
    "outputTokens",
    "thinkingTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "cacheWriteTokensKnown",
    "totalTokens"
  ]);
  if (
    record.vendor !== "codex" &&
    record.vendor !== "claude" &&
    record.vendor !== "antigravity"
  ) {
    throw new TypeError("remote usage vendor is invalid");
  }
  return {
    vendor: record.vendor,
    sampleId: requireString(record.sampleId, "usage.sampleId", 512),
    timestampUnixMs: requireUint64String(
      record.timestampUnixMs,
      "usage.timestampUnixMs"
    ),
    ...(record.sessionId === undefined
      ? {}
      : {
          sessionId: requireString(record.sessionId, "usage.sessionId", 512)
        }),
    ...(record.model === undefined
      ? {}
      : { model: requireString(record.model, "usage.model", 512) }),
    ...(record.cwd === undefined
      ? {}
      : {
          cwd: requireAbsoluteRemotePath(record.cwd, "usage.cwd", 4 * 1024)
        }),
    ...(record.projectPath === undefined
      ? {}
      : {
          projectPath: requireAbsoluteRemotePath(
            record.projectPath,
            "usage.projectPath",
            4 * 1024
          )
        }),
    inputTokens: requireUint64String(record.inputTokens, "usage.inputTokens"),
    outputTokens: requireUint64String(
      record.outputTokens,
      "usage.outputTokens"
    ),
    thinkingTokens: requireUint64String(
      record.thinkingTokens,
      "usage.thinkingTokens"
    ),
    cacheReadTokens: requireUint64String(
      record.cacheReadTokens,
      "usage.cacheReadTokens"
    ),
    cacheWriteTokens: requireUint64String(
      record.cacheWriteTokens,
      "usage.cacheWriteTokens"
    ),
    cacheWriteTokensKnown: requireBoolean(
      record.cacheWriteTokensKnown,
      "usage.cacheWriteTokensKnown"
    ),
    totalTokens: requireUint64String(record.totalTokens, "usage.totalTokens")
  };
}

function decodeRemotePrincipal(
  value: unknown,
  context: string
): { uid: number; accountName: string } {
  const principal = requireRecord(value, `${context} principal`);
  assertExactKeys(principal, ["uid", "accountName"]);
  if (
    typeof principal.uid !== "number" ||
    !Number.isSafeInteger(principal.uid) ||
    principal.uid < 0 ||
    principal.uid > 0xffff_ffff
  ) {
    throw new TypeError(`${context} principal uid is invalid`);
  }
  return {
    uid: principal.uid,
    accountName: requireString(
      principal.accountName,
      `${context} principal accountName`,
      4 * 1024
    )
  };
}

function requireAbsoluteRemotePath(
  value: unknown,
  field: string,
  maximumBytes: number
): string {
  const path = requireString(value, field, maximumBytes);
  if (!path.startsWith("/")) {
    throw new TypeError(`${field} must be an absolute remote path`);
  }
  return path;
}

function decodeObservedBody(
  record: Record<string, unknown>
): Extract<RemoteBridgeResponseBody, { type: "observed" }> {
  assertExactKeys(record, [
    "type",
    "targetId",
    "bridgeGeneration",
    "observedAt",
    "workspaces",
    "keepers"
  ]);
  if (
    record.workspaces !== undefined &&
    (!Array.isArray(record.workspaces) || record.workspaces.length > 4_096)
  ) {
    throw new TypeError("observed workspaces must be a bounded array");
  }
  if (!Array.isArray(record.keepers) || record.keepers.length > 4_096) {
    throw new TypeError("observed keepers must be a bounded array");
  }
  return {
    type: "observed",
    targetId: requireId(record.targetId, "targetId"),
    bridgeGeneration: requireId(record.bridgeGeneration, "bridgeGeneration"),
    observedAt: requireTimestamp(record.observedAt, "observedAt"),
    ...(record.workspaces === undefined
      ? {}
      : {
          workspaces: record.workspaces.map((value) => {
            const workspace = requireRecord(value, "observed workspace");
            assertExactKeys(workspace, [
              "resourceKey",
              "state",
              "remoteResourceRevision",
              "createOperationId",
              "canonicalCreatePayloadHash",
              "lastOperationId",
              "lastOperationPayloadHash",
              "lastResultDigest"
            ]);
            if (
              workspace.state !== "active" &&
              workspace.state !== "terminated" &&
              workspace.state !== "provisional" &&
              workspace.state !== "abandoned"
            ) {
              throw new TypeError("observed workspace state is invalid");
            }
            const resourceKey = decodeResourceKey(workspace.resourceKey);
            if (resourceKey.sessionId !== undefined) {
              throw new TypeError(
                "observed workspace resource key cannot identify a session"
              );
            }
            return {
              resourceKey,
              state: workspace.state,
              remoteResourceRevision: requireUint64String(
                workspace.remoteResourceRevision,
                "remoteResourceRevision"
              ),
              createOperationId: requireId(
                workspace.createOperationId,
                "createOperationId"
              ),
              canonicalCreatePayloadHash: requireHash(
                workspace.canonicalCreatePayloadHash,
                "canonicalCreatePayloadHash"
              ),
              lastOperationId: requireId(
                workspace.lastOperationId,
                "lastOperationId"
              ),
              lastOperationPayloadHash: requireHash(
                workspace.lastOperationPayloadHash,
                "lastOperationPayloadHash"
              ),
              lastResultDigest: requireHash(
                workspace.lastResultDigest,
                "lastResultDigest"
              )
            };
          })
        }),
    keepers: record.keepers.map((value) => {
      const keeper = requireRecord(value, "observed keeper");
      assertExactKeys(keeper, [
        "resourceKey",
        "keeperGeneration",
        "descriptorState",
        "processState",
        "remoteResourceRevision",
        "exitCode",
        "createOperationId",
        "canonicalCreatePayloadHash",
        "lastOperationId",
        "lastOperationPayloadHash",
        "lastResultDigest",
        "launch",
        "lifecycleState",
        "conversionTransactionId",
        "remoteSnapshotHash",
        "provisionalCreatedAt",
        "everGrantedWriterLease",
        "storageStatus",
        "checkpointAvailable",
        "retainedRangeTruncated"
      ]);
      if (
        keeper.processState !== "running" &&
        keeper.processState !== "exited"
      ) {
        throw new TypeError("observed keeper processState is invalid");
      }
      if (
        keeper.descriptorState !== undefined &&
        keeper.descriptorState !== "creating" &&
        keeper.descriptorState !== "running" &&
        keeper.descriptorState !== "exited" &&
        keeper.descriptorState !== "terminated"
      ) {
        throw new TypeError("observed keeper descriptorState is invalid");
      }
      if (
        keeper.exitCode !== undefined &&
        !Number.isSafeInteger(keeper.exitCode)
      ) {
        throw new TypeError("observed keeper exitCode is invalid");
      }
      if (
        keeper.lifecycleState !== "committed" &&
        keeper.lifecycleState !== "provisional" &&
        keeper.lifecycleState !== "abandoned"
      ) {
        throw new TypeError("observed keeper lifecycleState is invalid");
      }
      if (typeof keeper.everGrantedWriterLease !== "boolean") {
        throw new TypeError(
          "observed keeper everGrantedWriterLease must be a boolean"
        );
      }
      if (
        typeof keeper.checkpointAvailable !== "boolean" ||
        typeof keeper.retainedRangeTruncated !== "boolean"
      ) {
        throw new TypeError(
          "observed keeper retention capability fields must be booleans"
        );
      }
      return {
        resourceKey: decodeSessionResourceKey(keeper.resourceKey),
        keeperGeneration: requireId(
          keeper.keeperGeneration,
          "keeperGeneration"
        ),
        ...(keeper.descriptorState === undefined
          ? {}
          : { descriptorState: keeper.descriptorState }),
        processState: keeper.processState,
        remoteResourceRevision: requireUint64String(
          keeper.remoteResourceRevision,
          "remoteResourceRevision"
        ),
        ...(keeper.exitCode === undefined
          ? {}
          : { exitCode: keeper.exitCode as number }),
        createOperationId: requireId(
          keeper.createOperationId,
          "createOperationId"
        ),
        canonicalCreatePayloadHash: requireHash(
          keeper.canonicalCreatePayloadHash,
          "canonicalCreatePayloadHash"
        ),
        lastOperationId: requireId(keeper.lastOperationId, "lastOperationId"),
        lastOperationPayloadHash: requireHash(
          keeper.lastOperationPayloadHash,
          "lastOperationPayloadHash"
        ),
        lastResultDigest: requireHash(
          keeper.lastResultDigest,
          "lastResultDigest"
        ),
        launch: decodeConversionLaunch(keeper.launch),
        lifecycleState: keeper.lifecycleState,
        ...(keeper.conversionTransactionId === undefined
          ? {}
          : {
              conversionTransactionId: requireId(
                keeper.conversionTransactionId,
                "conversionTransactionId"
              )
            }),
        ...(keeper.remoteSnapshotHash === undefined
          ? {}
          : {
              remoteSnapshotHash: requireHash(
                keeper.remoteSnapshotHash,
                "remoteSnapshotHash"
              )
            }),
        ...(keeper.provisionalCreatedAt === undefined
          ? {}
          : {
              provisionalCreatedAt: requireTimestamp(
                keeper.provisionalCreatedAt,
                "provisionalCreatedAt"
              )
            }),
        everGrantedWriterLease: keeper.everGrantedWriterLease,
        storageStatus: decodeRemoteSessionStorageStatus(keeper.storageStatus),
        checkpointAvailable: keeper.checkpointAvailable,
        retainedRangeTruncated: keeper.retainedRangeTruncated
      };
    })
  };
}

function decodeRemoteSessionStorageStatus(
  value: unknown
): RemoteSessionStorageStatusDto {
  if (value === undefined) {
    return {
      state: "normal",
      journalAdmitted: "0",
      journalSynced: "0",
      emergencyBytes: 0
    };
  }
  const record = requireRecord(value, "remote session storage status");
  assertExactKeys(record, [
    "state",
    "journalAdmitted",
    "journalSynced",
    "emergencyBytes",
    "lastSyncDurationMs"
  ]);
  if (
    record.state !== "normal" &&
    record.state !== "degraded" &&
    record.state !== "backpressured"
  ) {
    throw new TypeError("remote session storage state is invalid");
  }
  if (
    typeof record.emergencyBytes !== "number" ||
    !Number.isSafeInteger(record.emergencyBytes) ||
    record.emergencyBytes < 0 ||
    record.emergencyBytes > 4 * 1024 * 1024
  ) {
    throw new TypeError("remote session emergencyBytes is invalid");
  }
  if (
    record.lastSyncDurationMs !== undefined &&
    (typeof record.lastSyncDurationMs !== "number" ||
      !Number.isSafeInteger(record.lastSyncDurationMs) ||
      record.lastSyncDurationMs < 0)
  ) {
    throw new TypeError("remote session lastSyncDurationMs is invalid");
  }
  const journalAdmitted = requireUint64String(
    record.journalAdmitted,
    "journalAdmitted"
  );
  const journalSynced = requireUint64String(
    record.journalSynced,
    "journalSynced"
  );
  if (parseUint64Decimal(journalSynced) > parseUint64Decimal(journalAdmitted)) {
    throw new TypeError(
      "remote session journalSynced cannot exceed journalAdmitted"
    );
  }
  return {
    state: record.state,
    journalAdmitted,
    journalSynced,
    emergencyBytes: record.emergencyBytes,
    ...(record.lastSyncDurationMs === undefined
      ? {}
      : { lastSyncDurationMs: record.lastSyncDurationMs })
  };
}

function decodeConversionLaunch(
  value: unknown
): RemoteConversionSessionLaunchDto {
  const record = requireRecord(value, "conversion launch");
  assertExactKeys(record, ["cwd", "shell", "args", "env", "title"]);
  if (
    record.args !== undefined &&
    (!Array.isArray(record.args) || record.args.length > 256)
  ) {
    throw new TypeError("conversion launch args are invalid");
  }
  const env =
    record.env === undefined
      ? undefined
      : requireRecord(record.env, "launch.env");
  if (env && Object.keys(env).length > 256) {
    throw new TypeError("conversion launch env is oversized");
  }
  return {
    cwd: requireString(record.cwd, "launch.cwd", 32 * 1024),
    ...(record.shell === undefined
      ? {}
      : { shell: requireString(record.shell, "launch.shell", 32 * 1024) }),
    ...(record.args === undefined
      ? {}
      : {
          args: record.args.map((argument) =>
            requireString(argument, "launch argument", 32 * 1024)
          )
        }),
    ...(env === undefined
      ? {}
      : {
          env: Object.fromEntries(
            Object.entries(env).map(([key, item]) => [
              requireString(key, "launch environment key", 256),
              requireString(item, "launch environment value", 32 * 1024)
            ])
          )
        }),
    ...(record.title === undefined
      ? {}
      : { title: requireString(record.title, "launch.title", 4 * 1024) })
  };
}

function decodeBoundedIds(value: unknown, field: string): Id[] {
  if (!Array.isArray(value) || value.length > 4_096) {
    throw new TypeError(`${field} must be a bounded array`);
  }
  const ids = value.map((item) => requireId(item, field));
  if (new Set(ids).size !== ids.length) {
    throw new TypeError(`${field} contains duplicates`);
  }
  return ids;
}

function decodeSessionResourceKey(
  value: unknown
): RemoteResourceKeyDto & { sessionId: Id } {
  const record = requireRecord(value, "resourceKey");
  assertExactKeys(record, [
    "desktopInstallationId",
    "targetId",
    "workspaceId",
    "sessionId"
  ]);
  return {
    desktopInstallationId: requireId(
      record.desktopInstallationId,
      "desktopInstallationId"
    ),
    targetId: requireId(record.targetId, "targetId"),
    workspaceId: requireId(record.workspaceId, "workspaceId"),
    sessionId: requireId(record.sessionId, "sessionId")
  };
}

function decodeResourceKey(value: unknown): RemoteResourceKeyDto {
  const record = requireRecord(value, "resourceKey");
  assertExactKeys(record, [
    "desktopInstallationId",
    "targetId",
    "workspaceId",
    "sessionId"
  ]);
  return {
    desktopInstallationId: requireId(
      record.desktopInstallationId,
      "desktopInstallationId"
    ),
    targetId: requireId(record.targetId, "targetId"),
    workspaceId: requireId(record.workspaceId, "workspaceId"),
    ...(record.sessionId === undefined
      ? {}
      : { sessionId: requireId(record.sessionId, "sessionId") })
  };
}

function decodeBridgeError(value: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  const record = requireRecord(value, "bridge error");
  assertExactKeys(record, ["code", "message", "retryable"]);
  if (typeof record.retryable !== "boolean") {
    throw new TypeError("bridge error retryable must be boolean");
  }
  return {
    code: requireString(record.code, "code", 256),
    message: requireString(record.message, "message", 4 * 1024),
    retryable: record.retryable
  };
}

function parseControlRecord(
  payload: Uint8Array,
  field: string
): Record<string, unknown> {
  if (!(payload instanceof Uint8Array) || payload.byteLength > 256 * 1024) {
    throw new TypeError(`${field} payload is invalid or oversized`);
  }
  let value: unknown;
  try {
    value = JSON.parse(textDecoder.decode(payload)) as unknown;
  } catch (error) {
    throw new TypeError(`${field} is not valid UTF-8 JSON`, { cause: error });
  }
  return requireRecord(value, field);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${field} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[]
): void {
  const keys = new Set(allowed);
  const unexpected = Object.keys(record).find((key) => !keys.has(key));
  if (unexpected) {
    throw new TypeError(`unexpected remote control field: ${unexpected}`);
  }
}

function requireProtocolVersion(value: unknown): void {
  if (value !== REMOTE_PROTOCOL_VERSION) {
    throw new TypeError("remote protocol version is incompatible");
  }
}

function requireId(value: unknown, field: string): Id {
  return requireString(value, field, 256, true);
}

function requireString(
  value: unknown,
  field: string,
  maxBytes: number,
  rejectControls = false
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    textEncoder.encode(value).byteLength > maxBytes ||
    (rejectControls && /\p{Cc}/u.test(value))
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function requireHash(value: unknown, field: string): string {
  const hash = requireString(value, field, 64);
  if (!/^[a-f0-9]{64}$/u.test(hash)) {
    throw new TypeError(`${field} must be a lowercase SHA-256 digest`);
  }
  return hash;
}

function requireSecret(value: unknown, field: string): string {
  const secret = requireString(value, field, 128);
  if (!/^[a-f0-9]{64,128}$/u.test(secret)) {
    throw new TypeError(`${field} is invalid`);
  }
  return secret;
}

function requireUint64String(value: unknown, field: string): string {
  try {
    return parseUint64Decimal(value).toString(10);
  } catch (error) {
    throw new TypeError(`${field} must be a canonical uint64 string`, {
      cause: error
    });
  }
}

function requireTimestamp(value: unknown, field: string): string {
  const timestamp = requireString(value, field, 64);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new TypeError(`${field} is not a timestamp`);
  }
  return timestamp;
}

function requireDimension(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 32_767
  ) {
    throw new TypeError("terminal dimension is invalid");
  }
  return value as number;
}

function requireBoundedInteger(
  value: unknown,
  field: string,
  maximum: number
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > maximum
  ) {
    throw new TypeError(`${field} is outside its bounded integer range`);
  }
  return value as number;
}

function requirePort(value: unknown, field: string): number {
  const port = requireBoundedInteger(value, field, 65_535);
  if (port === 0) {
    throw new TypeError(`${field} must be a non-zero TCP port`);
  }
  return port;
}

function requireAccess(value: unknown): "read" | "write" {
  if (value !== "read" && value !== "write") {
    throw new TypeError("attachment access is invalid");
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${field} must be boolean`);
  }
  return value;
}
