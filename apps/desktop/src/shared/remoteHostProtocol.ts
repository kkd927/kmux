import {
  decodeRemoteOperationIntentDto,
  decodeRemoteOperationPayload,
  encodeRemoteOperationIntentDto,
  type SshProfile,
  type RemoteOperationIntent,
  type RemoteOperationIntentDto,
  type RemoteOperationPayloadDto,
  type RemoteResourceKey
} from "@kmux/core";
import {
  IncrementalSha256,
  parseUint64Decimal,
  uint64,
  type Id,
  type RemoteConversionPrepareRequestDto,
  type RemoteConversionPromoteRequestDto,
  type RemoteProvisionalReclaimRequestDto,
  type RemoteSurfaceCaptureRequestDto,
  type RemoteTerminalInjectRequestDto,
  type RemoteRuntimeRootsDto,
  type RemoteRetentionPolicyDto,
  type Uint64
} from "@kmux/proto";
import type { TerminalSessionRef } from "@kmux/proto";

export const REMOTE_ATTACHMENT_FILE_PREFIX = "kmux-attachment-v1-";

export interface RemoteHostEffectiveSshConfig {
  hostName: string;
  user: string;
  port: number;
  identityFiles: string[];
  proxyJump?: string;
  proxyCommand?: string;
  canonicalLines: string[];
  policyHash: string;
}

export interface RemoteHostSshConfigResolveRequest {
  type: "ssh-config.resolve";
  requestId: Id;
  sshPath: string;
  configPath: string;
  host: string;
}

/**
 * First-connect transport/bootstrap request. It deliberately has no targetId:
 * the immutable target identity does not exist until doctor reports the
 * authenticated remote authority.
 */
export interface RemoteHostTargetVerifyRequest {
  type: "target.verify";
  requestId: Id;
  verificationId: Id;
  connectionAttemptId: Id;
  effectiveConnectionPolicyHash: string;
  sshPath: string;
  configPath: string;
  host: string;
  controlRoot?: string;
  askpassPath?: string;
  runtimeArtifactRoot: string;
  bootstrapShellOverride?: string;
  transferRoot: string;
  sftpPath?: string;
  rootOverrides: Partial<RemoteRuntimeRootsDto>;
}

export interface RemoteHostTargetPromoteRequest {
  type: "target.promote";
  requestId: Id;
  verificationId: Id;
  desktopInstallationId: Id;
  targetId: Id;
  effectiveConnectionPolicyHash: string;
  retentionPolicy: RemoteRetentionPolicyDto;
  token: string;
}

export interface RemoteHostTargetVerificationDiscardRequest {
  type: "target.verification-discard";
  requestId: Id;
  verificationId: Id;
}

export const DEFAULT_REMOTE_RETENTION_POLICY: RemoteRetentionPolicyDto = {
  sessionQuotaMiB: 256,
  targetQuotaMiB: 2 * 1024
};

export function resolveRemoteRetentionPolicyForSshProfile(
  profile: Pick<
    SshProfile,
    "sessionRetentionQuotaMiB" | "targetRetentionQuotaMiB"
  >
): RemoteRetentionPolicyDto {
  return decodeRemoteRetentionPolicy({
    sessionQuotaMiB:
      profile.sessionRetentionQuotaMiB ??
      DEFAULT_REMOTE_RETENTION_POLICY.sessionQuotaMiB,
    targetQuotaMiB:
      profile.targetRetentionQuotaMiB ??
      DEFAULT_REMOTE_RETENTION_POLICY.targetQuotaMiB
  });
}

export function decodeRemoteRetentionPolicy(
  value: unknown
): RemoteRetentionPolicyDto {
  const record = requireRecord(value, "remote retention policy");
  assertExactKeys(record, ["sessionQuotaMiB", "targetQuotaMiB"]);
  const sessionQuotaMiB = requireBoundedPositiveInteger(
    record.sessionQuotaMiB,
    "sessionQuotaMiB",
    4 * 1024
  );
  const targetQuotaMiB = requireBoundedPositiveInteger(
    record.targetQuotaMiB,
    "targetQuotaMiB",
    32 * 1024
  );
  if (
    sessionQuotaMiB < 64 ||
    targetQuotaMiB < 256 ||
    targetQuotaMiB < sessionQuotaMiB
  ) {
    throw new TypeError("remote retention policy is outside its allowed range");
  }
  return { sessionQuotaMiB, targetQuotaMiB };
}

export interface RemoteHostOperationExecuteRequest {
  type: "operation.execute";
  requestId: Id;
  targetId: Id;
  intent: RemoteOperationIntentDto;
  payload: RemoteOperationPayloadDto;
}

export interface RemoteHostObserveRequest {
  type: "target.observe";
  requestId: Id;
  targetId: Id;
  desktopInstallationId: Id;
}

export interface RemoteHostGitInspectRequest {
  type: "git.inspect";
  requestId: Id;
  targetId: Id;
  desktopInstallationId: Id;
  cwd: string;
  dirtyLimit: number;
  branch?: string;
}

export interface RemoteHostPortsInspectRequest {
  type: "ports.inspect";
  requestId: Id;
  targetId: Id;
  resourceKey: RemoteResourceKey & { sessionId: Id };
}

export interface RemoteHostHistoryScanRequest {
  type: "history.scan";
  requestId: Id;
  targetId: Id;
  desktopInstallationId: Id;
  maxRecords: number;
}

export interface RemoteHostUsageScanRequest {
  type: "usage.scan";
  requestId: Id;
  targetId: Id;
  desktopInstallationId: Id;
  startAtUnixMs: number;
  maxRecords: number;
}

export interface RemoteHostForwardsObserveRequest {
  type: "forwards.observe";
  requestId: Id;
  targetId: Id;
  desktopInstallationId: Id;
}

export interface RemoteHostForwardReconcileRequest {
  type: "forward.reconcile";
  requestId: Id;
  targetId: Id;
  desktopInstallationId: Id;
}

export interface RemoteHostForwardCloseWorkspaceRequest {
  type: "forward.close-workspace";
  requestId: Id;
  targetId: Id;
  workspaceId: Id;
}

export interface RemoteHostConversionPrepareRequest {
  type: "conversion.prepare";
  requestId: Id;
  targetId: Id;
  conversion: RemoteConversionPrepareRequestDto;
}

export interface RemoteHostConversionPromoteRequest {
  type: "conversion.promote";
  requestId: Id;
  targetId: Id;
  conversion: RemoteConversionPromoteRequestDto;
}

export interface RemoteHostProvisionalReclaimRequest {
  type: "provisional.reclaim";
  requestId: Id;
  targetId: Id;
  reclaim: RemoteProvisionalReclaimRequestDto;
}

export interface RemoteHostTerminalInjectRequest {
  type: "terminal.inject";
  requestId: Id;
  targetId: Id;
  injection: RemoteTerminalInjectRequestDto;
}

export interface RemoteHostSurfaceCaptureRequest {
  type: "surface.capture";
  requestId: Id;
  targetId: Id;
  capture: RemoteSurfaceCaptureRequestDto;
}

export interface RemoteHostEventsReplayRequest {
  type: "events.replay";
  requestId: Id;
  targetId: Id;
  desktopInstallationId: Id;
  afterSequence: string;
}

export interface RemoteHostEventsAckRequest {
  type: "events.ack";
  requestId: Id;
  targetId: Id;
  desktopInstallationId: Id;
  throughSequence: string;
}

export interface RemoteHostFileExistsRequest {
  type: "file.exists";
  requestId: Id;
  targetId: Id;
  remotePath: string;
}

export interface RemoteHostFileDownloadRequest {
  type: "file.download";
  requestId: Id;
  targetId: Id;
  transferId: Id;
  remotePath: string;
  maxBytes: number;
}

export interface RemoteHostFileUploadRequest {
  type: "file.upload";
  requestId: Id;
  targetId: Id;
  transferId: Id;
  localPath: string;
  remotePath: string;
  maxBytes: number;
  sha256: string;
}

export interface RemoteHostFileReleaseRequest {
  type: "file.release";
  requestId: Id;
  targetId: Id;
  localPath: string;
}

export interface RemoteHostFileAttachmentsPruneRequest {
  type: "file.attachments-prune";
  requestId: Id;
  targetId: Id;
  remoteDirectory: string;
  nowUnixMs: number;
  maxAgeMs: number;
  maxTotalBytes: number;
}

export interface RemoteHostTerminalBindRequest {
  type: "terminal.bind";
  targetId: Id;
  attachId: Id;
  session: TerminalSessionRef;
  resourceKey: RemoteResourceKey & { sessionId: Id };
  expectedKeeperGeneration: Id;
}

export interface RemoteHostTargetDisconnectRequest {
  type: "target.disconnect";
  requestId: Id;
  targetId: Id;
}

export interface RemoteHostTargetRuntimeCleanRequest {
  type: "target.runtime-clean";
  requestId: Id;
  targetId: Id;
}

export interface RemoteHostTargetRuntimeResetRequest {
  type: "target.runtime-reset";
  requestId: Id;
  targetId: Id;
}

export interface RemoteHostShutdownRequest {
  type: "shutdown";
  requestId: Id;
}

export type RemoteHostRequest =
  | RemoteHostSshConfigResolveRequest
  | RemoteHostTargetVerifyRequest
  | RemoteHostTargetPromoteRequest
  | RemoteHostTargetVerificationDiscardRequest
  | RemoteHostOperationExecuteRequest
  | RemoteHostObserveRequest
  | RemoteHostGitInspectRequest
  | RemoteHostPortsInspectRequest
  | RemoteHostHistoryScanRequest
  | RemoteHostUsageScanRequest
  | RemoteHostForwardsObserveRequest
  | RemoteHostForwardReconcileRequest
  | RemoteHostForwardCloseWorkspaceRequest
  | RemoteHostConversionPrepareRequest
  | RemoteHostConversionPromoteRequest
  | RemoteHostProvisionalReclaimRequest
  | RemoteHostTerminalInjectRequest
  | RemoteHostSurfaceCaptureRequest
  | RemoteHostEventsReplayRequest
  | RemoteHostEventsAckRequest
  | RemoteHostFileExistsRequest
  | RemoteHostFileDownloadRequest
  | RemoteHostFileUploadRequest
  | RemoteHostFileReleaseRequest
  | RemoteHostFileAttachmentsPruneRequest
  | RemoteHostTerminalBindRequest
  | RemoteHostTargetDisconnectRequest
  | RemoteHostTargetRuntimeCleanRequest
  | RemoteHostTargetRuntimeResetRequest
  | RemoteHostShutdownRequest;

export type RemoteHostResponse =
  | {
      type: "response";
      requestId: Id;
      status: "ok";
      body: unknown;
    }
  | {
      type: "response";
      requestId: Id;
      status: "error";
      error: { code: string; message: string; retryable: boolean };
    }
  | {
      type: "terminal.cursor";
      targetId: Id;
      resourceKey: RemoteResourceKey & { sessionId: Id };
      keeperGeneration: Id;
      sequence: Uint64;
    }
  | {
      type: "terminal.bind-failed";
      targetId: Id;
      attachId: Id;
      code: string;
      message: string;
    }
  | {
      type: "target.lost";
      targetId: Id;
      masterGeneration: Id;
      code: "master-closed";
      message: string;
    };

export interface DecodedRemoteHostOperationExecuteRequest extends Omit<
  RemoteHostOperationExecuteRequest,
  "intent"
> {
  intent: RemoteOperationIntent;
}

export type DecodedRemoteHostRequest =
  | Exclude<RemoteHostRequest, RemoteHostOperationExecuteRequest>
  | DecodedRemoteHostOperationExecuteRequest;

const MAX_ID_BYTES = 512;
const MAX_PATH_BYTES = 32 * 1024;
const MAX_HOST_BYTES = 4 * 1024;
const MAX_TOKEN_BYTES = 4 * 1024;
const MAX_TRANSFER_BYTES = 1024 ** 3;

export type DecodedRemoteHostOperationOutcome =
  | {
      status: "succeeded";
      operationId: Id;
      remoteResourceRevision: Uint64;
      resultDigest: string;
      keeperGeneration?: Id;
    }
  | {
      status: "failed";
      operationId: Id;
      resultDigest: string;
      code: string;
      message: string;
    };

export function decodeRemoteHostRequest(
  value: unknown
): DecodedRemoteHostRequest {
  const record = requireRecord(value, "remote-host request");
  switch (record.type) {
    case "ssh-config.resolve":
      assertExactKeys(record, [
        "type",
        "requestId",
        "sshPath",
        "configPath",
        "host"
      ]);
      return {
        type: record.type,
        requestId: requireId(record.requestId, "requestId"),
        sshPath: requireAbsoluteBoundedPath(record.sshPath, "sshPath"),
        configPath: requireAbsoluteBoundedPath(record.configPath, "configPath"),
        host: requireString(record.host, "host", MAX_HOST_BYTES)
      };
    case "target.verify":
      assertExactKeys(record, [
        "type",
        "requestId",
        "verificationId",
        "connectionAttemptId",
        "effectiveConnectionPolicyHash",
        "sshPath",
        "configPath",
        "host",
        "controlRoot",
        "askpassPath",
        "runtimeArtifactRoot",
        "bootstrapShellOverride",
        "transferRoot",
        "sftpPath",
        "rootOverrides"
      ]);
      return {
        type: record.type,
        requestId: requireId(record.requestId, "requestId"),
        verificationId: requireId(record.verificationId, "verificationId"),
        connectionAttemptId: requireId(
          record.connectionAttemptId,
          "connectionAttemptId"
        ),
        effectiveConnectionPolicyHash: requireHash(
          record.effectiveConnectionPolicyHash,
          "effectiveConnectionPolicyHash"
        ),
        sshPath: requireString(record.sshPath, "sshPath", MAX_PATH_BYTES),
        configPath: requireString(
          record.configPath,
          "configPath",
          MAX_PATH_BYTES
        ),
        host: requireString(record.host, "host", MAX_HOST_BYTES),
        ...(record.controlRoot === undefined
          ? {}
          : {
              controlRoot: requireString(
                record.controlRoot,
                "controlRoot",
                MAX_PATH_BYTES
              )
            }),
        ...(record.askpassPath === undefined
          ? {}
          : {
              askpassPath: requireString(
                record.askpassPath,
                "askpassPath",
                MAX_PATH_BYTES
              )
            }),
        runtimeArtifactRoot: requireAbsoluteBoundedPath(
          record.runtimeArtifactRoot,
          "runtimeArtifactRoot"
        ),
        ...(record.bootstrapShellOverride === undefined
          ? {}
          : {
              bootstrapShellOverride: requireAbsoluteBoundedPath(
                record.bootstrapShellOverride,
                "bootstrapShellOverride"
              )
            }),
        transferRoot: requireAbsoluteBoundedPath(
          record.transferRoot,
          "transferRoot"
        ),
        ...(record.sftpPath === undefined
          ? {}
          : {
              sftpPath: requireAbsoluteBoundedPath(record.sftpPath, "sftpPath")
            }),
        rootOverrides: decodeRuntimeRootOverrides(record.rootOverrides)
      };
    case "target.promote":
      assertExactKeys(record, [
        "type",
        "requestId",
        "verificationId",
        "desktopInstallationId",
        "targetId",
        "effectiveConnectionPolicyHash",
        "retentionPolicy",
        "token"
      ]);
      return {
        type: record.type,
        requestId: requireId(record.requestId, "requestId"),
        verificationId: requireId(record.verificationId, "verificationId"),
        desktopInstallationId: requireId(
          record.desktopInstallationId,
          "desktopInstallationId"
        ),
        targetId: requireId(record.targetId, "targetId"),
        effectiveConnectionPolicyHash: requireHash(
          record.effectiveConnectionPolicyHash,
          "effectiveConnectionPolicyHash"
        ),
        retentionPolicy: decodeRemoteRetentionPolicy(record.retentionPolicy),
        token: requireString(record.token, "token", MAX_TOKEN_BYTES)
      };
    case "target.verification-discard":
      assertExactKeys(record, ["type", "requestId", "verificationId"]);
      return {
        type: record.type,
        requestId: requireId(record.requestId, "requestId"),
        verificationId: requireId(record.verificationId, "verificationId")
      };
    case "operation.execute": {
      assertExactKeys(record, [
        "type",
        "requestId",
        "targetId",
        "intent",
        "payload"
      ]);
      const intent = decodeRemoteOperationIntentDto(record.intent);
      const payload = decodeRemoteOperationPayload(record.payload);
      if (intent.kind !== payload.kind) {
        throw new TypeError("remote-host operation intent and payload differ");
      }
      return {
        type: record.type,
        requestId: requireId(record.requestId, "requestId"),
        targetId: requireId(record.targetId, "targetId"),
        intent,
        payload
      };
    }
    case "target.observe":
      assertExactKeys(record, [
        "type",
        "requestId",
        "targetId",
        "desktopInstallationId"
      ]);
      return {
        type: record.type,
        requestId: requireId(record.requestId, "requestId"),
        targetId: requireId(record.targetId, "targetId"),
        desktopInstallationId: requireId(
          record.desktopInstallationId,
          "desktopInstallationId"
        )
      };
    case "git.inspect":
      assertExactKeys(record, [
        "type",
        "requestId",
        "targetId",
        "desktopInstallationId",
        "cwd",
        "dirtyLimit",
        "branch"
      ]);
      return {
        type: record.type,
        requestId: requireId(record.requestId, "requestId"),
        targetId: requireId(record.targetId, "targetId"),
        desktopInstallationId: requireId(
          record.desktopInstallationId,
          "desktopInstallationId"
        ),
        cwd: requireString(record.cwd, "cwd", MAX_PATH_BYTES),
        dirtyLimit: requireBoundedNonNegativeInteger(
          record.dirtyLimit,
          "dirtyLimit",
          256
        ),
        ...(record.branch === undefined
          ? {}
          : {
              branch: requireString(record.branch, "branch", MAX_PATH_BYTES)
            })
      };
    case "ports.inspect": {
      assertExactKeys(record, ["type", "requestId", "targetId", "resourceKey"]);
      const targetId = requireId(record.targetId, "targetId");
      const resourceKey = decodeSessionResourceKey(record.resourceKey);
      if (resourceKey.targetId !== targetId) {
        throw new TypeError("port inspection resource is outside its target");
      }
      return {
        type: record.type,
        requestId: requireId(record.requestId, "requestId"),
        targetId,
        resourceKey
      };
    }
    case "history.scan":
      assertExactKeys(record, [
        "type",
        "requestId",
        "targetId",
        "desktopInstallationId",
        "maxRecords"
      ]);
      return {
        type: record.type,
        requestId: requireId(record.requestId, "requestId"),
        targetId: requireId(record.targetId, "targetId"),
        desktopInstallationId: requireId(
          record.desktopInstallationId,
          "desktopInstallationId"
        ),
        maxRecords: requireBoundedPositiveInteger(
          record.maxRecords,
          "maxRecords",
          100
        )
      };
    case "usage.scan":
      assertExactKeys(record, [
        "type",
        "requestId",
        "targetId",
        "desktopInstallationId",
        "startAtUnixMs",
        "maxRecords"
      ]);
      return {
        type: record.type,
        requestId: requireId(record.requestId, "requestId"),
        targetId: requireId(record.targetId, "targetId"),
        desktopInstallationId: requireId(
          record.desktopInstallationId,
          "desktopInstallationId"
        ),
        startAtUnixMs: requireBoundedNonNegativeInteger(
          record.startAtUnixMs,
          "startAtUnixMs",
          Number.MAX_SAFE_INTEGER
        ),
        maxRecords: requireBoundedPositiveInteger(
          record.maxRecords,
          "maxRecords",
          64
        )
      };
    case "forwards.observe":
      assertExactKeys(record, [
        "type",
        "requestId",
        "targetId",
        "desktopInstallationId"
      ]);
      return {
        type: record.type,
        requestId: requireId(record.requestId, "requestId"),
        targetId: requireId(record.targetId, "targetId"),
        desktopInstallationId: requireId(
          record.desktopInstallationId,
          "desktopInstallationId"
        )
      };
    case "forward.reconcile":
      assertExactKeys(record, [
        "type",
        "requestId",
        "targetId",
        "desktopInstallationId"
      ]);
      return {
        type: record.type,
        requestId: requireId(record.requestId, "requestId"),
        targetId: requireId(record.targetId, "targetId"),
        desktopInstallationId: requireId(
          record.desktopInstallationId,
          "desktopInstallationId"
        )
      };
    case "forward.close-workspace":
      assertExactKeys(record, ["type", "requestId", "targetId", "workspaceId"]);
      return {
        type: record.type,
        requestId: requireId(record.requestId, "requestId"),
        targetId: requireId(record.targetId, "targetId"),
        workspaceId: requireId(record.workspaceId, "workspaceId")
      };
    case "conversion.prepare":
      assertExactKeys(record, ["type", "requestId", "targetId", "conversion"]);
      return {
        type: record.type,
        requestId: requireId(record.requestId, "requestId"),
        targetId: requireId(record.targetId, "targetId"),
        conversion: decodeConversionPrepare(record.conversion)
      };
    case "conversion.promote":
      assertExactKeys(record, ["type", "requestId", "targetId", "conversion"]);
      return {
        type: record.type,
        requestId: requireId(record.requestId, "requestId"),
        targetId: requireId(record.targetId, "targetId"),
        conversion: decodeConversionPromote(record.conversion)
      };
    case "provisional.reclaim":
      assertExactKeys(record, ["type", "requestId", "targetId", "reclaim"]);
      return {
        type: record.type,
        requestId: requireId(record.requestId, "requestId"),
        targetId: requireId(record.targetId, "targetId"),
        reclaim: decodeProvisionalReclaim(record.reclaim)
      };
    case "terminal.inject":
      assertExactKeys(record, ["type", "requestId", "targetId", "injection"]);
      return {
        type: record.type,
        requestId: requireId(record.requestId, "requestId"),
        targetId: requireId(record.targetId, "targetId"),
        injection: decodeTerminalInjection(record.injection)
      };
    case "surface.capture":
      assertExactKeys(record, ["type", "requestId", "targetId", "capture"]);
      return {
        type: record.type,
        requestId: requireId(record.requestId, "requestId"),
        targetId: requireId(record.targetId, "targetId"),
        capture: decodeSurfaceCapture(record.capture)
      };
    case "events.replay":
      assertExactKeys(record, [
        "type",
        "requestId",
        "targetId",
        "desktopInstallationId",
        "afterSequence"
      ]);
      return {
        type: record.type,
        requestId: requireId(record.requestId, "requestId"),
        targetId: requireId(record.targetId, "targetId"),
        desktopInstallationId: requireId(
          record.desktopInstallationId,
          "desktopInstallationId"
        ),
        afterSequence: requireUint64String(
          record.afterSequence,
          "afterSequence"
        )
      };
    case "events.ack":
      assertExactKeys(record, [
        "type",
        "requestId",
        "targetId",
        "desktopInstallationId",
        "throughSequence"
      ]);
      return {
        type: record.type,
        requestId: requireId(record.requestId, "requestId"),
        targetId: requireId(record.targetId, "targetId"),
        desktopInstallationId: requireId(
          record.desktopInstallationId,
          "desktopInstallationId"
        ),
        throughSequence: requireUint64String(
          record.throughSequence,
          "throughSequence"
        )
      };
    case "file.exists":
      assertExactKeys(record, ["type", "requestId", "targetId", "remotePath"]);
      return {
        type: record.type,
        requestId: requireId(record.requestId, "requestId"),
        targetId: requireId(record.targetId, "targetId"),
        remotePath: requireAbsoluteBoundedPath(record.remotePath, "remotePath")
      };
    case "file.download":
      assertExactKeys(record, [
        "type",
        "requestId",
        "targetId",
        "transferId",
        "remotePath",
        "maxBytes"
      ]);
      return {
        type: record.type,
        requestId: requireId(record.requestId, "requestId"),
        targetId: requireId(record.targetId, "targetId"),
        transferId: requireId(record.transferId, "transferId"),
        remotePath: requireAbsoluteBoundedPath(record.remotePath, "remotePath"),
        maxBytes: requireBoundedPositiveInteger(
          record.maxBytes,
          "maxBytes",
          MAX_TRANSFER_BYTES
        )
      };
    case "file.upload":
      assertExactKeys(record, [
        "type",
        "requestId",
        "targetId",
        "transferId",
        "localPath",
        "remotePath",
        "maxBytes",
        "sha256"
      ]);
      return {
        type: record.type,
        requestId: requireId(record.requestId, "requestId"),
        targetId: requireId(record.targetId, "targetId"),
        transferId: requireId(record.transferId, "transferId"),
        localPath: requireAbsoluteBoundedPath(record.localPath, "localPath"),
        remotePath: requireAbsoluteBoundedPath(record.remotePath, "remotePath"),
        maxBytes: requireBoundedPositiveInteger(
          record.maxBytes,
          "maxBytes",
          MAX_TRANSFER_BYTES
        ),
        sha256: requireHash(record.sha256, "sha256")
      };
    case "file.release":
      assertExactKeys(record, ["type", "requestId", "targetId", "localPath"]);
      return {
        type: record.type,
        requestId: requireId(record.requestId, "requestId"),
        targetId: requireId(record.targetId, "targetId"),
        localPath: requireAbsoluteBoundedPath(record.localPath, "localPath")
      };
    case "file.attachments-prune":
      assertExactKeys(record, [
        "type",
        "requestId",
        "targetId",
        "remoteDirectory",
        "nowUnixMs",
        "maxAgeMs",
        "maxTotalBytes"
      ]);
      return {
        type: record.type,
        requestId: requireId(record.requestId, "requestId"),
        targetId: requireId(record.targetId, "targetId"),
        remoteDirectory: requireAbsoluteBoundedPath(
          record.remoteDirectory,
          "remoteDirectory"
        ),
        nowUnixMs: requireBoundedNonNegativeInteger(
          record.nowUnixMs,
          "nowUnixMs",
          Number.MAX_SAFE_INTEGER
        ),
        maxAgeMs: requireBoundedPositiveInteger(
          record.maxAgeMs,
          "maxAgeMs",
          365 * 24 * 60 * 60 * 1000
        ),
        maxTotalBytes: requireBoundedPositiveInteger(
          record.maxTotalBytes,
          "maxTotalBytes",
          MAX_TRANSFER_BYTES
        )
      };
    case "terminal.bind":
      assertExactKeys(record, [
        "type",
        "targetId",
        "attachId",
        "session",
        "resourceKey",
        "expectedKeeperGeneration"
      ]);
      return {
        type: record.type,
        targetId: requireId(record.targetId, "targetId"),
        attachId: requireId(record.attachId, "attachId"),
        session: decodeSessionRef(record.session),
        resourceKey: decodeSessionResourceKey(record.resourceKey),
        expectedKeeperGeneration: requireId(
          record.expectedKeeperGeneration,
          "expectedKeeperGeneration"
        )
      };
    case "target.disconnect":
      assertExactKeys(record, ["type", "requestId", "targetId"]);
      return {
        type: record.type,
        requestId: requireId(record.requestId, "requestId"),
        targetId: requireId(record.targetId, "targetId")
      };
    case "target.runtime-clean":
    case "target.runtime-reset":
      assertExactKeys(record, ["type", "requestId", "targetId"]);
      return {
        type: record.type,
        requestId: requireId(record.requestId, "requestId"),
        targetId: requireId(record.targetId, "targetId")
      };
    case "shutdown":
      assertExactKeys(record, ["type", "requestId"]);
      return {
        type: record.type,
        requestId: requireId(record.requestId, "requestId")
      };
    default:
      throw new TypeError("unsupported remote-host request type");
  }
}

function decodeTerminalInjection(
  value: unknown
): RemoteTerminalInjectRequestDto {
  const record = requireRecord(value, "terminal injection");
  assertExactKeys(record, [
    "resourceKey",
    "expectedKeeperGeneration",
    "operationId",
    "payloadHash",
    "input"
  ]);
  const input = requireByteBoundedString(record.input, "input", 64 * 1024);
  const payloadHash = requireHash(record.payloadHash, "payloadHash");
  const actualHash = new IncrementalSha256()
    .update(new TextEncoder().encode(input))
    .digestHex();
  if (payloadHash !== actualHash) {
    throw new TypeError("terminal injection payload hash does not match input");
  }
  return {
    resourceKey: decodeSessionResourceKey(record.resourceKey),
    expectedKeeperGeneration: requireId(
      record.expectedKeeperGeneration,
      "expectedKeeperGeneration"
    ),
    operationId: requireId(record.operationId, "operationId"),
    payloadHash,
    input
  };
}

function decodeSurfaceCapture(value: unknown): RemoteSurfaceCaptureRequestDto {
  const record = requireRecord(value, "surface capture");
  assertExactKeys(record, [
    "resourceKey",
    "expectedKeeperGeneration",
    "captureId",
    "lineLimit",
    "maxBytes"
  ]);
  return {
    resourceKey: decodeSessionResourceKey(record.resourceKey),
    expectedKeeperGeneration: requireId(
      record.expectedKeeperGeneration,
      "expectedKeeperGeneration"
    ),
    captureId: requireId(record.captureId, "captureId"),
    lineLimit: requireBoundedPositiveInteger(
      record.lineLimit,
      "lineLimit",
      65_536
    ),
    maxBytes: requireBoundedPositiveInteger(
      record.maxBytes,
      "maxBytes",
      1024 * 1024
    )
  };
}

function decodeConversionPrepare(
  value: unknown
): RemoteConversionPrepareRequestDto {
  const record = requireRecord(value, "conversion prepare request");
  assertExactKeys(record, [
    "transactionId",
    "workspaceCreateOperationId",
    "sessionCreateOperationId",
    "workspaceResourceKey",
    "sessionResourceKey",
    "sourceWorkspaceRevision",
    "remoteSnapshot",
    "remoteSnapshotHash",
    "launch",
    "preparedAt"
  ]);
  const workspaceResourceKey = decodeWorkspaceResourceKey(
    record.workspaceResourceKey
  );
  const sessionResourceKey = decodeSessionResourceKey(
    record.sessionResourceKey
  );
  assertSharedResourceScope(workspaceResourceKey, sessionResourceKey);
  const remoteSnapshot = requireString(
    record.remoteSnapshot,
    "remoteSnapshot",
    128 * 1024
  );
  return {
    transactionId: requireId(record.transactionId, "transactionId"),
    workspaceCreateOperationId: requireId(
      record.workspaceCreateOperationId,
      "workspaceCreateOperationId"
    ),
    sessionCreateOperationId: requireId(
      record.sessionCreateOperationId,
      "sessionCreateOperationId"
    ),
    workspaceResourceKey,
    sessionResourceKey,
    sourceWorkspaceRevision: requireHash(
      record.sourceWorkspaceRevision,
      "sourceWorkspaceRevision"
    ),
    remoteSnapshot,
    remoteSnapshotHash: requireHash(
      record.remoteSnapshotHash,
      "remoteSnapshotHash"
    ),
    launch: decodeConversionLaunch(record.launch),
    preparedAt: requireTimestamp(record.preparedAt, "preparedAt")
  };
}

function decodeConversionPromote(
  value: unknown
): RemoteConversionPromoteRequestDto {
  const record = requireRecord(value, "conversion promote request");
  assertExactKeys(record, [
    "transactionId",
    "workspaceCreateOperationId",
    "sessionCreateOperationId",
    "workspaceResourceKey",
    "sessionResourceKey",
    "remoteSnapshotHash"
  ]);
  const workspaceResourceKey = decodeWorkspaceResourceKey(
    record.workspaceResourceKey
  );
  const sessionResourceKey = decodeSessionResourceKey(
    record.sessionResourceKey
  );
  assertSharedResourceScope(workspaceResourceKey, sessionResourceKey);
  return {
    transactionId: requireId(record.transactionId, "transactionId"),
    workspaceCreateOperationId: requireId(
      record.workspaceCreateOperationId,
      "workspaceCreateOperationId"
    ),
    sessionCreateOperationId: requireId(
      record.sessionCreateOperationId,
      "sessionCreateOperationId"
    ),
    workspaceResourceKey,
    sessionResourceKey,
    remoteSnapshotHash: requireHash(
      record.remoteSnapshotHash,
      "remoteSnapshotHash"
    )
  };
}

function decodeProvisionalReclaim(
  value: unknown
): RemoteProvisionalReclaimRequestDto {
  const record = requireRecord(value, "provisional reclaim request");
  assertExactKeys(record, [
    "desktopInstallationId",
    "targetId",
    "protectedTransactionIds",
    "now"
  ]);
  if (
    !Array.isArray(record.protectedTransactionIds) ||
    record.protectedTransactionIds.length > 64
  ) {
    throw new TypeError("protectedTransactionIds must be a bounded array");
  }
  const protectedTransactionIds = record.protectedTransactionIds.map((item) =>
    requireId(item, "protectedTransactionId")
  );
  if (
    new Set(protectedTransactionIds).size !== protectedTransactionIds.length
  ) {
    throw new TypeError("protectedTransactionIds contains duplicates");
  }
  return {
    desktopInstallationId: requireId(
      record.desktopInstallationId,
      "desktopInstallationId"
    ),
    targetId: requireId(record.targetId, "targetId"),
    protectedTransactionIds,
    now: requireTimestamp(record.now, "now")
  };
}

function decodeConversionLaunch(
  value: unknown
): RemoteConversionPrepareRequestDto["launch"] {
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
    cwd: requireString(record.cwd, "launch.cwd", MAX_PATH_BYTES),
    ...(record.shell === undefined
      ? {}
      : { shell: requireString(record.shell, "launch.shell", MAX_PATH_BYTES) }),
    ...(record.args === undefined
      ? {}
      : {
          args: record.args.map((argument) =>
            requireString(argument, "launch argument", MAX_PATH_BYTES)
          )
        }),
    ...(env === undefined
      ? {}
      : {
          env: Object.fromEntries(
            Object.entries(env).map(([key, item]) => [
              requireString(key, "launch env key", 256),
              requireString(item, "launch env value", MAX_PATH_BYTES)
            ])
          )
        }),
    ...(record.title === undefined
      ? {}
      : { title: requireString(record.title, "launch.title", 4 * 1024) })
  };
}

function decodeWorkspaceResourceKey(value: unknown): RemoteResourceKey {
  const record = requireRecord(value, "remote workspace resource key");
  assertExactKeys(record, ["desktopInstallationId", "targetId", "workspaceId"]);
  return {
    desktopInstallationId: requireId(
      record.desktopInstallationId,
      "desktopInstallationId"
    ),
    targetId: requireId(record.targetId, "targetId"),
    workspaceId: requireId(record.workspaceId, "workspaceId")
  };
}

function assertSharedResourceScope(
  workspace: RemoteResourceKey,
  session: RemoteResourceKey & { sessionId: Id }
): void {
  if (
    workspace.desktopInstallationId !== session.desktopInstallationId ||
    workspace.targetId !== session.targetId ||
    workspace.workspaceId !== session.workspaceId
  ) {
    throw new TypeError("conversion resource scopes do not match");
  }
}

export function encodeRemoteHostOperationRequest(options: {
  requestId: Id;
  targetId: Id;
  intent: RemoteOperationIntent;
  payload: RemoteOperationPayloadDto;
}): RemoteHostOperationExecuteRequest {
  return {
    type: "operation.execute",
    requestId: options.requestId,
    targetId: options.targetId,
    intent: encodeRemoteOperationIntentDto(options.intent),
    payload: decodeRemoteOperationPayload(options.payload)
  };
}

export function decodeRemoteHostResponse(value: unknown): RemoteHostResponse {
  const record = requireRecord(value, "remote-host response");
  switch (record.type) {
    case "response": {
      const requestId = requireId(record.requestId, "requestId");
      if (record.status === "ok") {
        assertExactKeys(record, ["type", "requestId", "status", "body"]);
        return {
          type: record.type,
          requestId,
          status: record.status,
          body: record.body
        };
      }
      if (record.status !== "error") {
        throw new TypeError("remote-host response status is invalid");
      }
      assertExactKeys(record, ["type", "requestId", "status", "error"]);
      const error = requireRecord(record.error, "remote-host error");
      assertExactKeys(error, ["code", "message", "retryable"]);
      if (typeof error.retryable !== "boolean") {
        throw new TypeError("remote-host error retryable must be a boolean");
      }
      return {
        type: record.type,
        requestId,
        status: record.status,
        error: {
          code: requireString(error.code, "error.code", 256),
          message: requireString(error.message, "error.message", 4 * 1024),
          retryable: error.retryable
        }
      };
    }
    case "terminal.cursor":
      assertExactKeys(record, [
        "type",
        "targetId",
        "resourceKey",
        "keeperGeneration",
        "sequence"
      ]);
      if (typeof record.sequence !== "bigint") {
        throw new TypeError("terminal cursor sequence must be a bigint");
      }
      return {
        type: record.type,
        targetId: requireId(record.targetId, "targetId"),
        resourceKey: decodeSessionResourceKey(record.resourceKey),
        keeperGeneration: requireId(
          record.keeperGeneration,
          "keeperGeneration"
        ),
        sequence: parseUint64Decimal(record.sequence.toString(10))
      };
    case "terminal.bind-failed":
      assertExactKeys(record, [
        "type",
        "targetId",
        "attachId",
        "code",
        "message"
      ]);
      return {
        type: record.type,
        targetId: requireId(record.targetId, "targetId"),
        attachId: requireId(record.attachId, "attachId"),
        code: requireString(record.code, "code", 256),
        message: requireString(record.message, "message", 4 * 1024)
      };
    case "target.lost":
      assertExactKeys(record, [
        "type",
        "targetId",
        "masterGeneration",
        "code",
        "message"
      ]);
      return {
        type: record.type,
        targetId: requireId(record.targetId, "targetId"),
        masterGeneration: requireId(
          record.masterGeneration,
          "masterGeneration"
        ),
        code: requireLiteral(record.code, "master-closed", "code"),
        message: requireString(record.message, "message", 4 * 1024)
      };
    default:
      throw new TypeError("unsupported remote-host response type");
  }
}

/** Exact UtilityProcess boundary for authority-bearing operation results. */
export function decodeRemoteHostOperationOutcome(
  value: unknown
): DecodedRemoteHostOperationOutcome {
  const record = requireRecord(value, "remote-host operation outcome");
  if (record.status === "succeeded") {
    assertExactKeys(record, [
      "status",
      "operationId",
      "remoteResourceRevision",
      "resultDigest",
      "keeperGeneration"
    ]);
    if (typeof record.remoteResourceRevision !== "bigint") {
      throw new TypeError(
        "remote-host operation revision must be an in-memory bigint"
      );
    }
    return {
      status: record.status,
      operationId: requireId(record.operationId, "operationId"),
      remoteResourceRevision: uint64(record.remoteResourceRevision),
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
  if (record.status !== "failed") {
    throw new TypeError("remote-host operation status is invalid");
  }
  assertExactKeys(record, [
    "status",
    "operationId",
    "resultDigest",
    "code",
    "message"
  ]);
  return {
    status: record.status,
    operationId: requireId(record.operationId, "operationId"),
    resultDigest: requireHash(record.resultDigest, "resultDigest"),
    code: requireString(record.code, "code", 256),
    message: requireString(record.message, "message", 4 * 1024)
  };
}

function decodeRuntimeRootOverrides(
  value: unknown
): Partial<RemoteRuntimeRootsDto> {
  const record = requireRecord(value, "runtime root overrides");
  assertExactKeys(record, [
    "installRoot",
    "authorityRoot",
    "stateRoot",
    "runtimeRoot"
  ]);
  return {
    ...(record.installRoot === undefined
      ? {}
      : {
          installRoot: requireAbsoluteBoundedPath(
            record.installRoot,
            "installRoot"
          )
        }),
    ...(record.authorityRoot === undefined
      ? {}
      : {
          authorityRoot: requireAbsoluteBoundedPath(
            record.authorityRoot,
            "authorityRoot"
          )
        }),
    ...(record.stateRoot === undefined
      ? {}
      : {
          stateRoot: requireAbsoluteBoundedPath(record.stateRoot, "stateRoot")
        }),
    ...(record.runtimeRoot === undefined
      ? {}
      : {
          runtimeRoot: requireAbsoluteBoundedPath(
            record.runtimeRoot,
            "runtimeRoot"
          )
        })
  };
}

function decodeSessionRef(value: unknown): TerminalSessionRef {
  const record = requireRecord(value, "terminal session ref");
  assertExactKeys(record, ["surfaceId", "sessionId", "epoch"]);
  return {
    surfaceId: requireId(record.surfaceId, "surfaceId"),
    sessionId: requireId(record.sessionId, "sessionId"),
    epoch: requireId(record.epoch, "epoch")
  };
}

function decodeSessionResourceKey(
  value: unknown
): RemoteResourceKey & { sessionId: Id } {
  const record = requireRecord(value, "remote session resource key");
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
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`unexpected remote-host field ${key}`);
    }
  }
}

function requireId(value: unknown, field: string): Id {
  const id = requireString(value, field, MAX_ID_BYTES);
  if (/\p{Cc}/u.test(id)) {
    throw new TypeError(`${field} contains a control character`);
  }
  return id;
}

function requireHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireAbsoluteBoundedPath(value: unknown, field: string): string {
  const path = requireString(value, field, MAX_PATH_BYTES);
  if (!path.startsWith("/") || /[\0\r\n]/u.test(path)) {
    throw new TypeError(`${field} must be a bounded absolute path`);
  }
  return path;
}

function requireUint64String(value: unknown, field: string): string {
  try {
    return parseUint64Decimal(value).toString(10);
  } catch {
    throw new TypeError(`${field} must be a canonical uint64 decimal string`);
  }
}

function requireBoundedPositiveInteger(
  value: unknown,
  field: string,
  maximum: number
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximum
  ) {
    throw new TypeError(`${field} must be an integer between 1 and ${maximum}`);
  }
  return value as number;
}

function requireBoundedNonNegativeInteger(
  value: unknown,
  field: string,
  maximum: number
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > maximum
  ) {
    throw new TypeError(`${field} must be an integer between 0 and ${maximum}`);
  }
  return value as number;
}

function requireTimestamp(value: unknown, field: string): string {
  const timestamp = requireString(value, field, 64);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  return timestamp;
}

function requireLiteral<T extends string>(
  value: unknown,
  expected: T,
  field: string
): T {
  if (value !== expected) {
    throw new TypeError(`${field} must be ${expected}`);
  }
  return expected;
}

function requireString(
  value: unknown,
  field: string,
  maxBytes: number
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maxBytes ||
    /\0/u.test(value)
  ) {
    throw new TypeError(`${field} must be a bounded non-empty string`);
  }
  return value;
}

function requireByteBoundedString(
  value: unknown,
  field: string,
  maxBytes: number
): string {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength > maxBytes
  ) {
    throw new TypeError(`${field} must be a byte-bounded string`);
  }
  return value;
}
