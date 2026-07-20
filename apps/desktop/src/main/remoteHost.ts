import { lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

import type { ForkOptions, MessagePortMain, UtilityProcess } from "electron";

import type {
  RemoteOperationIntent,
  RemoteOperationPayloadDto,
  RemoteResourceKey
} from "@kmux/core";
import {
  decodeRemoteBridgeResponseBody,
  decodeRemoteSpoolEventDto,
  incrementUint64,
  makeId,
  parseUint64Decimal,
  uint64,
  type Id,
  type RemoteBridgeResponseBody,
  type RemoteConversionPrepareRequestDto,
  type RemoteConversionPromoteRequestDto,
  type RemoteProvisionalReclaimRequestDto,
  type RemoteRetentionPolicyDto,
  type RemoteRuntimeRootsDto,
  type RemoteSurfaceCaptureRequestDto,
  type RemoteTerminalInjectRequestDto,
  type Uint64
} from "@kmux/proto";

import type {
  RemoteEventReplayPage,
  RemoteDesiredForwards,
  RemoteGitInspection,
  RemoteHistoryScan,
  RemotePortsInspection,
  RemoteUsageScan,
  RemoteRuntimeOperationOutcome,
  RemoteSurfaceCaptureResult,
  RemoteTerminalInputAcknowledgement
} from "../remote-host/linuxX64RemoteRuntime";
import type {
  RemoteSftpAttachmentPruneResult,
  RemoteSftpTransferResult,
  RemoteSftpUploadResult
} from "../remote-host/remoteSftpClient";
import type { ActiveRemoteForward } from "../remote-host/remoteForwardManager";
import type {
  RemoteDoctorReport,
  RemoteGenerationGcReport,
  RemoteGenerationResetReport
} from "../remote-host/remoteRuntimeBootstrap";
import {
  decodeRemoteHostOperationOutcome,
  decodeRemoteRetentionPolicy,
  decodeRemoteHostResponse,
  encodeRemoteHostOperationRequest,
  type RemoteHostEffectiveSshConfig,
  type RemoteHostResponse,
  type RemoteHostSshConfigResolveRequest,
  type RemoteHostTargetPromoteRequest,
  type RemoteHostTargetVerifyRequest,
  type RemoteHostTerminalBindRequest
} from "../shared/remoteHostProtocol";

const REQUEST_TIMEOUT_MS = 30_000;
const TARGET_CONNECT_TIMEOUT_MS = 5 * 60_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const MAX_PENDING_REQUESTS = 1_024;
const FILE_TRANSFER_TIMEOUT_MS = 16 * 60_000;

export type ForkRemoteHostProcess = (
  modulePath: string,
  args?: string[],
  options?: ForkOptions
) => UtilityProcess;

export interface RemoteHostLaunchOptions {
  entry: string;
  cwd: string;
}

export function resolveRemoteHostLaunchOptions(
  currentDir: string
): RemoteHostLaunchOptions {
  return {
    entry: resolve(currentDir, "remoteHost.js"),
    cwd: currentDir
  };
}

/**
 * Main-owned reconnect recipe for an already verified target. This is not a
 * remote-host wire request: every use must go through target.verify followed
 * by target.promote so an immutable target cannot be assigned by assertion.
 */
export interface RemoteHostTargetConnectOptions {
  desktopInstallationId: Id;
  targetId: Id;
  connectionAttemptId: Id;
  effectiveConnectionPolicyHash: string;
  sshPath: string;
  configPath: string;
  host: string;
  controlRoot?: string;
  askpassPath?: string;
  roots: RemoteRuntimeRootsDto;
  retentionPolicy?: RemoteRetentionPolicyDto;
  token: string;
  bootstrapShellOverride?: string;
}

export type RemoteHostTargetVerifyOptions = Omit<
  RemoteHostTargetVerifyRequest,
  "type" | "requestId" | "runtimeArtifactRoot" | "transferRoot" | "sftpPath"
>;

export type RemoteHostTargetPromoteOptions = Omit<
  RemoteHostTargetPromoteRequest,
  "type" | "requestId" | "retentionPolicy"
> & {
  retentionPolicy?: RemoteHostTargetPromoteRequest["retentionPolicy"];
};

export interface RemoteHostTargetVerification {
  verificationId: Id;
  effectiveConnectionPolicyHash: string;
  generation: string;
  runtimePath: string;
  remoteHome: string;
  roots: RemoteRuntimeRootsDto;
  doctor: RemoteDoctorReport;
}

export interface RemoteHostManagerOptions {
  runtimeArtifactRoot: string;
  transferRoot: string;
  sftpPath?: string;
}

export interface RemoteHostCursorEvent {
  type: "terminal.cursor";
  targetId: Id;
  resourceKey: Extract<
    RemoteHostResponse,
    { type: "terminal.cursor" }
  >["resourceKey"];
  keeperGeneration: Id;
  sequence: Extract<
    RemoteHostResponse,
    { type: "terminal.cursor" }
  >["sequence"];
}

export type RemoteHostTargetLostEvent = Extract<
  RemoteHostResponse,
  { type: "target.lost" }
>;

interface PendingRequest {
  resolve: (body: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class RemoteHostManager extends EventEmitter {
  private child: UtilityProcess | null = null;
  private intentionallyStopped = false;
  private readonly pending = new Map<Id, PendingRequest>();

  constructor(
    private readonly forkProcess: ForkRemoteHostProcess,
    private readonly options: RemoteHostManagerOptions = defaultRemoteHostManagerOptions()
  ) {
    super();
    assertLocalAbsolutePath(
      options.runtimeArtifactRoot,
      "remote runtime artifact root"
    );
    assertLocalAbsolutePath(options.transferRoot, "remote transfer root");
    if (options.sftpPath !== undefined) {
      assertLocalAbsolutePath(options.sftpPath, "system SFTP path");
    }
  }

  start(env: NodeJS.ProcessEnv = process.env): void {
    if (this.child) return;
    this.intentionallyStopped = false;
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const launch = resolveRemoteHostLaunchOptions(currentDir);
    let child: UtilityProcess;
    try {
      child = this.forkProcess(launch.entry, [], {
        cwd: launch.cwd,
        env: env as Record<string, string>,
        stdio: ["ignore", "inherit", "inherit"],
        serviceName: "kmux Remote Transport"
      });
    } catch (error) {
      this.emit(
        "error",
        new Error(
          `remote-host failed to start: ${error instanceof Error ? error.message : String(error)}`
        )
      );
      return;
    }
    this.child = child;
    child.on("message", (rawMessage: unknown) =>
      this.receive(child, rawMessage)
    );
    child.on("exit", () => this.childExited(child));
    child.on("error", (type, location) => {
      this.emit(
        "error",
        new Error(
          `remote-host utility process failed: ${type}${location ? ` at ${location}` : ""}`
        )
      );
    });
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  async resolveSshConfig(options: {
    sshPath: string;
    configPath: string;
    host: string;
  }): Promise<RemoteHostEffectiveSshConfig> {
    assertLocalAbsolutePath(options.sshPath, "system OpenSSH path");
    assertLocalAbsolutePath(options.configPath, "OpenSSH config path");
    requireBoundedBodyString(options.host, "OpenSSH host alias", 4 * 1024);
    const body = await this.request({
      type: "ssh-config.resolve",
      ...options
    });
    const record = requireBodyRecord(body, "ssh-config.resolved");
    assertBodyExactKeys(record, [
      "type",
      "sshPath",
      "configPath",
      "host",
      "effective"
    ]);
    if (
      record.sshPath !== options.sshPath ||
      record.configPath !== options.configPath ||
      record.host !== options.host
    ) {
      throw new Error("remote-host resolved another OpenSSH configuration");
    }
    return decodeEffectiveSshConfig(record.effective);
  }

  async verifyTarget(
    options: RemoteHostTargetVerifyOptions
  ): Promise<RemoteHostTargetVerification> {
    const body = await this.requestWithId(
      {
        type: "target.verify",
        requestId: makeId("remote-host-request"),
        ...structuredClone(options),
        runtimeArtifactRoot: this.options.runtimeArtifactRoot,
        transferRoot: this.options.transferRoot,
        ...(this.options.sftpPath === undefined
          ? {}
          : { sftpPath: this.options.sftpPath })
      },
      TARGET_CONNECT_TIMEOUT_MS
    );
    const record = requireBodyRecord(body, "target.verified");
    assertBodyExactKeys(record, [
      "type",
      "verificationId",
      "effectiveConnectionPolicyHash",
      "generation",
      "runtimePath",
      "remoteHome",
      "roots",
      "doctor"
    ]);
    if (
      record.verificationId !== options.verificationId ||
      record.effectiveConnectionPolicyHash !==
        options.effectiveConnectionPolicyHash ||
      !isValidControlId(record.generation) ||
      typeof record.runtimePath !== "string"
    ) {
      throw new Error("remote-host returned a mismatched target verification");
    }
    const roots = decodeVerifiedRoots(record.roots, options.rootOverrides);
    if (
      typeof record.remoteHome !== "string" ||
      !record.remoteHome.startsWith("/") ||
      record.remoteHome.length > 32 * 1024 ||
      /[\0\r\n]/u.test(record.remoteHome)
    ) {
      throw new Error("remote-host returned an invalid authenticated HOME");
    }
    const doctor = decodeVerifiedDoctor(record.doctor, roots);
    if (
      record.runtimePath !==
      posix.join(roots.installRoot, "bin", record.generation, "kmuxd")
    ) {
      throw new Error(
        "remote-host target verification returned another runtime path"
      );
    }
    return {
      verificationId: options.verificationId,
      effectiveConnectionPolicyHash: options.effectiveConnectionPolicyHash,
      generation: record.generation,
      runtimePath: record.runtimePath,
      remoteHome: record.remoteHome,
      roots,
      doctor
    };
  }

  async promoteVerifiedTarget(
    options: RemoteHostTargetPromoteOptions
  ): Promise<Extract<RemoteBridgeResponseBody, { type: "hello" }>> {
    const body = await this.requestWithId(
      {
        type: "target.promote",
        requestId: makeId("remote-host-request"),
        ...structuredClone(options),
        retentionPolicy: decodeRemoteRetentionPolicy(
          options.retentionPolicy ?? {
            sessionQuotaMiB: 256,
            targetQuotaMiB: 2 * 1024
          }
        )
      },
      TARGET_CONNECT_TIMEOUT_MS
    );
    const record = requireBodyRecord(body, "target.ready");
    if (record.targetId !== options.targetId) {
      throw new Error("remote-host promoted another target");
    }
    return decodeExpectedBridgeBody(record.hello, "hello");
  }

  async discardTargetVerification(verificationId: Id): Promise<void> {
    const body = await this.request({
      type: "target.verification-discard",
      verificationId
    });
    const record = requireBodyRecord(body, "target.verification-discarded");
    if (record.verificationId !== verificationId) {
      throw new Error("remote-host discarded another target verification");
    }
  }

  async executeOperation(
    targetId: Id,
    intent: RemoteOperationIntent,
    payload: RemoteOperationPayloadDto
  ): Promise<RemoteRuntimeOperationOutcome> {
    const requestId = makeId("remote-host-request");
    const body = await this.requestWithId(
      encodeRemoteHostOperationRequest({
        requestId,
        targetId,
        intent,
        payload
      })
    );
    const record = requireBodyRecord(body, "operation.result");
    if (record.targetId !== targetId) {
      throw new Error("remote-host operation result target does not match");
    }
    return decodeRemoteHostOperationOutcome(
      record.outcome
    ) satisfies RemoteRuntimeOperationOutcome;
  }

  async observe(
    targetId: Id,
    desktopInstallationId: Id
  ): Promise<Extract<RemoteBridgeResponseBody, { type: "observed" }>> {
    const body = await this.request({
      type: "target.observe",
      targetId,
      desktopInstallationId
    });
    const record = requireBodyRecord(body, "target.observed");
    if (record.targetId !== targetId) {
      throw new Error("remote-host observation target does not match");
    }
    return decodeExpectedBridgeBody(record.observed, "observed");
  }

  async inspectGit(options: {
    targetId: Id;
    desktopInstallationId: Id;
    cwd: string;
    dirtyLimit: number;
    branch?: string;
  }): Promise<RemoteGitInspection> {
    const body = await this.request({ type: "git.inspect", ...options });
    const record = requireBodyRecord(body, "git.inspected");
    if (record.targetId !== options.targetId) {
      throw new Error("remote-host inspected Git on another target");
    }
    const inspection = decodeExpectedBridgeBody(
      record.inspection,
      "git.inspected"
    );
    if (inspection.type !== "git.inspected" || inspection.cwd !== options.cwd) {
      throw new Error("remote-host returned the wrong Git inspection");
    }
    return inspection;
  }

  async inspectPorts(options: {
    targetId: Id;
    resourceKey: RemoteResourceKey & { sessionId: Id };
  }): Promise<RemotePortsInspection> {
    if (options.resourceKey.targetId !== options.targetId) {
      throw new Error("remote port inspection resource target does not match");
    }
    const body = await this.request({ type: "ports.inspect", ...options });
    const record = requireBodyRecord(body, "ports.inspected");
    if (record.targetId !== options.targetId) {
      throw new Error("remote-host inspected ports on another target");
    }
    const inspection = decodeExpectedBridgeBody(
      record.inspection,
      "ports.inspected"
    );
    if (
      inspection.type !== "ports.inspected" ||
      !sameRemoteResourceKey(inspection.resourceKey, options.resourceKey)
    ) {
      throw new Error("remote-host returned the wrong port inspection");
    }
    return inspection;
  }

  async scanHistory(options: {
    targetId: Id;
    desktopInstallationId: Id;
    maxRecords: number;
  }): Promise<RemoteHistoryScan> {
    const body = await this.request({ type: "history.scan", ...options });
    const record = requireBodyRecord(body, "history.scanned");
    if (record.targetId !== options.targetId) {
      throw new Error("remote-host scanned history on another target");
    }
    const scan = decodeExpectedBridgeBody(record.scan, "history.scanned");
    if (scan.type !== "history.scanned" || scan.targetId !== options.targetId) {
      throw new Error("remote-host returned the wrong history scan");
    }
    return scan;
  }

  async scanUsage(options: {
    targetId: Id;
    desktopInstallationId: Id;
    startAtUnixMs: number;
    maxRecords: number;
  }): Promise<RemoteUsageScan> {
    const body = await this.request({ type: "usage.scan", ...options });
    const record = requireBodyRecord(body, "usage.scanned");
    if (record.targetId !== options.targetId) {
      throw new Error("remote-host scanned usage on another target");
    }
    const scan = decodeExpectedBridgeBody(record.scan, "usage.scanned");
    if (scan.type !== "usage.scanned" || scan.targetId !== options.targetId) {
      throw new Error("remote-host returned the wrong usage scan");
    }
    return scan;
  }

  async observeForwards(options: {
    targetId: Id;
    desktopInstallationId: Id;
  }): Promise<RemoteDesiredForwards> {
    const body = await this.request({ type: "forwards.observe", ...options });
    const record = requireBodyRecord(body, "forwards.observed");
    if (record.targetId !== options.targetId) {
      throw new Error("remote-host observed forwards on another target");
    }
    const observed = decodeExpectedBridgeBody(
      record.observed,
      "forwards.observed"
    );
    if (
      observed.type !== "forwards.observed" ||
      observed.targetId !== options.targetId
    ) {
      throw new Error("remote-host returned the wrong desired forwards");
    }
    return observed;
  }

  async reconcileForwards(options: {
    targetId: Id;
    desktopInstallationId: Id;
  }): Promise<ActiveRemoteForward[]> {
    const body = await this.requestWithId({
      type: "forward.reconcile",
      requestId: makeId("remote-host-request"),
      ...options
    });
    const record = requireBodyRecord(body, "forward.reconciled");
    assertBodyExactKeys(record, ["type", "targetId", "mappings"]);
    if (record.targetId !== options.targetId) {
      throw new Error("remote-host reconciled forwards for another target");
    }
    return decodeActiveForwardMappings(record.mappings);
  }

  async closeWorkspaceForwards(targetId: Id, workspaceId: Id): Promise<void> {
    const body = await this.requestWithId({
      type: "forward.close-workspace",
      requestId: makeId("remote-host-request"),
      targetId,
      workspaceId
    });
    const record = requireBodyRecord(body, "forward.workspace-closed");
    assertBodyExactKeys(record, ["type", "targetId", "workspaceId"]);
    if (record.targetId !== targetId || record.workspaceId !== workspaceId) {
      throw new Error("remote-host closed forwards for another workspace");
    }
  }

  async prepareConversion(
    targetId: Id,
    conversion: RemoteConversionPrepareRequestDto
  ): Promise<
    Extract<RemoteBridgeResponseBody, { type: "conversion.prepared" }>
  > {
    const body = await this.requestWithId({
      type: "conversion.prepare",
      requestId: makeId("remote-host-request"),
      targetId,
      conversion: structuredClone(conversion)
    });
    const record = requireBodyRecord(body, "conversion.prepared");
    if (record.targetId !== targetId) {
      throw new Error("remote-host prepared another target conversion");
    }
    return decodeExpectedBridgeBody(record.prepared, "conversion.prepared");
  }

  async promoteConversion(
    targetId: Id,
    conversion: RemoteConversionPromoteRequestDto
  ): Promise<
    Extract<RemoteBridgeResponseBody, { type: "conversion.promoted" }>
  > {
    const body = await this.requestWithId({
      type: "conversion.promote",
      requestId: makeId("remote-host-request"),
      targetId,
      conversion: structuredClone(conversion)
    });
    const record = requireBodyRecord(body, "conversion.promoted");
    if (record.targetId !== targetId) {
      throw new Error("remote-host promoted another target conversion");
    }
    return decodeExpectedBridgeBody(record.promoted, "conversion.promoted");
  }

  async reclaimProvisionals(
    targetId: Id,
    reclaim: RemoteProvisionalReclaimRequestDto
  ): Promise<
    Extract<RemoteBridgeResponseBody, { type: "provisional.reclaimed" }>
  > {
    const body = await this.requestWithId({
      type: "provisional.reclaim",
      requestId: makeId("remote-host-request"),
      targetId,
      reclaim: structuredClone(reclaim)
    });
    const record = requireBodyRecord(body, "provisional.reclaimed");
    if (record.targetId !== targetId) {
      throw new Error("remote-host reclaimed another target");
    }
    return decodeExpectedBridgeBody(record.reclaimed, "provisional.reclaimed");
  }

  async injectTerminal(
    targetId: Id,
    injection: RemoteTerminalInjectRequestDto
  ): Promise<RemoteTerminalInputAcknowledgement> {
    const body = await this.requestWithId({
      type: "terminal.inject",
      requestId: makeId("remote-host-request"),
      targetId,
      injection: structuredClone(injection)
    });
    const record = requireBodyRecord(body, "terminal.input-ack");
    assertBodyExactKeys(record, ["type", "targetId", "acknowledgement"]);
    if (record.targetId !== targetId) {
      throw new Error(
        "remote-host acknowledged terminal input for another target"
      );
    }
    const acknowledgement = requireBodyObject(
      record.acknowledgement,
      "remote-host terminal input acknowledgement"
    );
    assertBodyExactKeys(acknowledgement, [
      "resourceKey",
      "keeperGeneration",
      "operationId",
      "writerLeaseId",
      "byteLength",
      "boundary"
    ]);
    const resourceKey = requireSessionResourceKey(
      acknowledgement.resourceKey,
      targetId
    );
    if (
      resourceKey.desktopInstallationId !==
        injection.resourceKey.desktopInstallationId ||
      resourceKey.workspaceId !== injection.resourceKey.workspaceId ||
      resourceKey.sessionId !== injection.resourceKey.sessionId ||
      acknowledgement.keeperGeneration !== injection.expectedKeeperGeneration ||
      acknowledgement.operationId !== injection.operationId ||
      acknowledgement.boundary !== "pty-write" ||
      acknowledgement.byteLength !==
        Buffer.byteLength(injection.input, "utf8") ||
      !isValidControlId(acknowledgement.writerLeaseId)
    ) {
      throw new Error(
        "remote-host returned an invalid terminal input acknowledgement"
      );
    }
    return acknowledgement as unknown as RemoteTerminalInputAcknowledgement;
  }

  async captureSurface(
    targetId: Id,
    captureRequest: RemoteSurfaceCaptureRequestDto
  ): Promise<RemoteSurfaceCaptureResult> {
    const body = await this.requestWithId({
      type: "surface.capture",
      requestId: makeId("remote-host-request"),
      targetId,
      capture: structuredClone(captureRequest)
    });
    const record = requireBodyRecord(body, "surface.captured");
    assertBodyExactKeys(record, ["type", "targetId", "capture"]);
    if (record.targetId !== targetId) {
      throw new Error("remote-host captured a surface on another target");
    }
    const capture = requireBodyObject(
      record.capture,
      "remote-host surface capture"
    );
    assertBodyExactKeys(capture, [
      "captureId",
      "resourceKey",
      "keeperGeneration",
      "mutationSequence",
      "cols",
      "rows",
      "text",
      "lineCount",
      "byteLength",
      "linesTruncated",
      "bytesTruncated",
      "retainedRangeTruncated"
    ]);
    const resourceKey = requireSessionResourceKey(
      capture.resourceKey,
      targetId
    );
    const text = typeof capture.text === "string" ? capture.text : undefined;
    const textByteLength =
      text === undefined ? -1 : Buffer.byteLength(text, "utf8");
    const textLineCount =
      text === undefined || text.length === 0 ? 0 : text.split("\n").length;
    if (
      capture.captureId !== captureRequest.captureId ||
      resourceKey.desktopInstallationId !==
        captureRequest.resourceKey.desktopInstallationId ||
      resourceKey.workspaceId !== captureRequest.resourceKey.workspaceId ||
      resourceKey.sessionId !== captureRequest.resourceKey.sessionId ||
      capture.keeperGeneration !== captureRequest.expectedKeeperGeneration ||
      typeof capture.mutationSequence !== "bigint" ||
      text === undefined ||
      !isTerminalDimension(capture.cols) ||
      !isTerminalDimension(capture.rows) ||
      !Number.isSafeInteger(capture.lineCount) ||
      (capture.lineCount as number) < 0 ||
      (capture.lineCount as number) > captureRequest.lineLimit ||
      capture.lineCount !== textLineCount ||
      !Number.isSafeInteger(capture.byteLength) ||
      (capture.byteLength as number) < 0 ||
      (capture.byteLength as number) > captureRequest.maxBytes ||
      capture.byteLength !== textByteLength ||
      typeof capture.linesTruncated !== "boolean" ||
      typeof capture.bytesTruncated !== "boolean" ||
      typeof capture.retainedRangeTruncated !== "boolean"
    ) {
      throw new Error("remote-host returned an invalid surface capture");
    }
    return {
      captureId: capture.captureId as Id,
      resourceKey: structuredClone(
        resourceKey
      ) as RemoteSurfaceCaptureResult["resourceKey"],
      keeperGeneration: capture.keeperGeneration as Id,
      mutationSequence: uint64(capture.mutationSequence),
      cols: capture.cols as number,
      rows: capture.rows as number,
      text,
      lineCount: capture.lineCount as number,
      byteLength: capture.byteLength as number,
      linesTruncated: capture.linesTruncated as boolean,
      bytesTruncated: capture.bytesTruncated as boolean,
      retainedRangeTruncated: capture.retainedRangeTruncated as boolean
    };
  }

  async replayEvents(
    targetId: Id,
    desktopInstallationId: Id,
    afterSequence: Uint64
  ): Promise<RemoteEventReplayPage> {
    const body = await this.requestWithId({
      type: "events.replay",
      requestId: makeId("remote-host-request"),
      targetId,
      desktopInstallationId,
      afterSequence: afterSequence.toString(10)
    });
    const record = requireBodyRecord(body, "events.replayed");
    assertBodyExactKeys(record, ["type", "targetId", "replay"]);
    if (record.targetId !== targetId) {
      throw new Error("remote-host replayed events from another target");
    }
    const replay = requireBodyObject(record.replay, "remote-host event replay");
    assertBodyExactKeys(replay, [
      "targetId",
      "events",
      "acknowledgedThrough",
      "hasMore",
      "admittedCount",
      "droppedLowValueCount"
    ]);
    if (
      replay.targetId !== targetId ||
      !Array.isArray(replay.events) ||
      replay.events.length > 128 ||
      typeof replay.acknowledgedThrough !== "bigint" ||
      typeof replay.admittedCount !== "bigint" ||
      typeof replay.droppedLowValueCount !== "bigint" ||
      typeof replay.hasMore !== "boolean"
    ) {
      throw new Error("remote-host returned an invalid event replay");
    }
    const acknowledgedThrough = uint64(replay.acknowledgedThrough);
    const admittedCount = uint64(replay.admittedCount);
    const droppedLowValueCount = uint64(replay.droppedLowValueCount);
    if (acknowledgedThrough > afterSequence) {
      throw new Error(
        "remote-host event acknowledgement is ahead of the request"
      );
    }
    let previousSequence = afterSequence;
    const eventIds = new Set<Id>();
    const events = replay.events.map((value) => {
      const event = decodeRemoteSpoolEventDto(value);
      const sequence = parseUint64Decimal(event.sequence);
      if (
        event.resourceKey.desktopInstallationId !== desktopInstallationId ||
        event.resourceKey.targetId !== targetId ||
        sequence !== incrementUint64(previousSequence) ||
        eventIds.has(event.eventId)
      ) {
        throw new Error("remote-host event replay order or scope is invalid");
      }
      previousSequence = sequence;
      eventIds.add(event.eventId);
      return structuredClone(event);
    });
    if (replay.hasMore && events.length === 0) {
      throw new Error("remote-host event replay cannot make progress");
    }
    return {
      targetId,
      events,
      acknowledgedThrough,
      hasMore: replay.hasMore,
      admittedCount,
      droppedLowValueCount
    };
  }

  async acknowledgeEvents(
    targetId: Id,
    desktopInstallationId: Id,
    throughSequence: Uint64
  ): Promise<Uint64> {
    const body = await this.requestWithId({
      type: "events.ack",
      requestId: makeId("remote-host-request"),
      targetId,
      desktopInstallationId,
      throughSequence: throughSequence.toString(10)
    });
    const record = requireBodyRecord(body, "events.acknowledged");
    assertBodyExactKeys(record, ["type", "targetId", "acknowledgedThrough"]);
    if (
      record.targetId !== targetId ||
      typeof record.acknowledgedThrough !== "bigint"
    ) {
      throw new Error("remote-host acknowledged events for another target");
    }
    const acknowledgedThrough = uint64(record.acknowledgedThrough);
    if (acknowledgedThrough !== throughSequence) {
      throw new Error("remote-host event acknowledgement changed its cursor");
    }
    return acknowledgedThrough;
  }

  async fileExists(targetId: Id, remotePath: string): Promise<boolean> {
    const body = await this.requestWithId({
      type: "file.exists",
      requestId: makeId("remote-host-request"),
      targetId,
      remotePath
    });
    const record = requireBodyRecord(body, "file.exists-result");
    assertBodyExactKeys(record, ["type", "targetId", "remotePath", "exists"]);
    if (
      record.targetId !== targetId ||
      record.remotePath !== remotePath ||
      typeof record.exists !== "boolean"
    ) {
      throw new Error("remote-host returned an invalid file existence result");
    }
    return record.exists;
  }

  async downloadFile(options: {
    targetId: Id;
    transferId: Id;
    remotePath: string;
    maxBytes: number;
  }): Promise<RemoteSftpTransferResult> {
    const body = await this.requestWithId(
      {
        type: "file.download",
        requestId: makeId("remote-host-request"),
        ...options
      },
      FILE_TRANSFER_TIMEOUT_MS
    );
    const record = requireBodyRecord(body, "file.downloaded");
    assertBodyExactKeys(record, ["type", "targetId", "transfer"]);
    if (record.targetId !== options.targetId) {
      throw new Error("remote-host downloaded a file from another target");
    }
    const transfer = decodeDownloadTransfer(record.transfer, options);
    await assertStagedDownload(
      this.options.transferRoot,
      transfer.localPath,
      transfer.byteLength
    );
    return transfer;
  }

  async uploadFile(options: {
    targetId: Id;
    transferId: Id;
    localPath: string;
    remotePath: string;
    maxBytes: number;
    sha256: string;
  }): Promise<RemoteSftpUploadResult> {
    await assertStagedFile(
      this.options.transferRoot,
      options.localPath,
      options.maxBytes
    );
    const body = await this.requestWithId(
      {
        type: "file.upload",
        requestId: makeId("remote-host-request"),
        ...options
      },
      FILE_TRANSFER_TIMEOUT_MS
    );
    const record = requireBodyRecord(body, "file.uploaded");
    assertBodyExactKeys(record, ["type", "targetId", "transfer"]);
    if (record.targetId !== options.targetId) {
      throw new Error("remote-host uploaded a file to another target");
    }
    return decodeUploadTransfer(record.transfer, options);
  }

  async releaseFile(targetId: Id, localPath: string): Promise<void> {
    assertStagingPath(this.options.transferRoot, localPath);
    const body = await this.requestWithId({
      type: "file.release",
      requestId: makeId("remote-host-request"),
      targetId,
      localPath
    });
    const record = requireBodyRecord(body, "file.released");
    assertBodyExactKeys(record, ["type", "targetId", "localPath"]);
    if (record.targetId !== targetId || record.localPath !== localPath) {
      throw new Error("remote-host released another staged file");
    }
  }

  async pruneRemoteAttachments(options: {
    targetId: Id;
    remoteDirectory: string;
    nowUnixMs: number;
    maxAgeMs: number;
    maxTotalBytes: number;
  }): Promise<RemoteSftpAttachmentPruneResult> {
    const body = await this.requestWithId({
      type: "file.attachments-prune",
      requestId: makeId("remote-host-request"),
      ...options
    });
    const record = requireBodyRecord(body, "file.attachments-pruned");
    assertBodyExactKeys(record, ["type", "targetId", "result"]);
    if (record.targetId !== options.targetId) {
      throw new Error("remote-host pruned attachments for another target");
    }
    const result = requireBodyRecord(record.result, "attachment prune result");
    assertBodyExactKeys(result, [
      "deletedCount",
      "deletedBytes",
      "remainingBytes"
    ]);
    for (const field of [
      "deletedCount",
      "deletedBytes",
      "remainingBytes"
    ] as const) {
      if (
        !Number.isSafeInteger(result[field]) ||
        (result[field] as number) < 0
      ) {
        throw new Error(
          "remote-host returned invalid attachment cleanup totals"
        );
      }
    }
    return {
      deletedCount: result.deletedCount as number,
      deletedBytes: result.deletedBytes as number,
      remainingBytes: result.remainingBytes as number
    };
  }

  async disconnectTarget(targetId: Id): Promise<void> {
    const body = await this.request({ type: "target.disconnect", targetId });
    const record = requireBodyRecord(body, "target.disconnected");
    if (record.targetId !== targetId) {
      throw new Error("remote-host disconnected another target");
    }
  }

  async cleanTargetRuntime(targetId: Id): Promise<RemoteGenerationGcReport> {
    const body = await this.request({ type: "target.runtime-clean", targetId });
    const record = requireBodyRecord(body, "target.runtime-cleaned");
    assertBodyExactKeys(record, ["type", "targetId", "report"]);
    if (record.targetId !== targetId) {
      throw new Error("remote-host cleaned another target runtime");
    }
    return decodeGenerationGcReport(record.report);
  }

  async resetTargetRuntime(targetId: Id): Promise<RemoteGenerationResetReport> {
    const body = await this.request({ type: "target.runtime-reset", targetId });
    const record = requireBodyRecord(body, "target.runtime-reset");
    assertBodyExactKeys(record, ["type", "targetId", "report"]);
    if (record.targetId !== targetId) {
      throw new Error("remote-host reset another target runtime");
    }
    return decodeGenerationResetReport(record.report);
  }

  bindTerminalStream(
    request: Omit<RemoteHostTerminalBindRequest, "type">,
    port: MessagePortMain
  ): boolean {
    const child = this.child;
    if (!child) return false;
    try {
      child.postMessage({ type: "terminal.bind", ...request }, [port]);
      return true;
    } catch (error) {
      this.emit(
        "error",
        new Error(
          `remote-host terminal bind failed: ${error instanceof Error ? error.message : String(error)}`
        )
      );
      return false;
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.intentionallyStopped = true;
    try {
      await Promise.race([
        this.request({ type: "shutdown" }),
        delay(SHUTDOWN_TIMEOUT_MS).then(() => {
          throw new Error("remote-host shutdown timed out");
        })
      ]);
    } catch {
      if (this.child === child) child.kill();
    }
  }

  private request(
    request:
      | Omit<RemoteHostSshConfigResolveRequest, "requestId">
      | Omit<RemoteHostTargetVerifyRequest, "requestId">
      | Omit<RemoteHostTargetPromoteRequest, "requestId">
      | {
          type: "target.verification-discard";
          verificationId: Id;
        }
      | { type: "target.observe"; targetId: Id; desktopInstallationId: Id }
      | {
          type: "git.inspect";
          targetId: Id;
          desktopInstallationId: Id;
          cwd: string;
          dirtyLimit: number;
          branch?: string;
        }
      | {
          type: "ports.inspect";
          targetId: Id;
          resourceKey: RemoteResourceKey & { sessionId: Id };
        }
      | {
          type: "history.scan";
          targetId: Id;
          desktopInstallationId: Id;
          maxRecords: number;
        }
      | {
          type: "usage.scan";
          targetId: Id;
          desktopInstallationId: Id;
          startAtUnixMs: number;
          maxRecords: number;
        }
      | {
          type: "forwards.observe";
          targetId: Id;
          desktopInstallationId: Id;
        }
      | { type: "target.disconnect"; targetId: Id }
      | { type: "target.runtime-clean"; targetId: Id }
      | { type: "target.runtime-reset"; targetId: Id }
      | { type: "shutdown" }
  ): Promise<unknown> {
    return this.requestWithId({
      ...request,
      requestId: makeId("remote-host-request")
    });
  }

  private requestWithId<
    T extends {
      requestId: Id;
      type: string;
    }
  >(request: T, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const child = this.child;
    if (!child) {
      return Promise.reject(new Error("remote-host is not running"));
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error("remote-host request limit is full"));
    }
    if (this.pending.has(request.requestId)) {
      return Promise.reject(
        new Error("remote-host request ID is already pending")
      );
    }
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(request.requestId)) {
          reject(new Error("remote-host request timed out"));
          // The UtilityProcess may still be executing the timed-out request.
          // Retiring the whole control generation prevents a late response
          // from becoming an unknown-response protocol fault and, more
          // importantly, prevents callers from retrying alongside stale
          // bootstrap, file-transfer, or maintenance work.
          if (this.child === child) child.kill();
        }
      }, timeoutMs);
      timeout.unref();
      this.pending.set(request.requestId, { resolve, reject, timeout });
      try {
        child.postMessage(request);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(request.requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private receive(child: UtilityProcess, rawMessage: unknown): void {
    if (this.child !== child) return;
    let message: RemoteHostResponse;
    try {
      message = decodeRemoteHostResponse(rawMessage);
    } catch (error) {
      this.emit(
        "error",
        new Error(
          `remote-host emitted an invalid control message: ${error instanceof Error ? error.message : String(error)}`
        )
      );
      child.kill();
      return;
    }
    if (message.type === "terminal.cursor") {
      this.emit("cursor", message satisfies RemoteHostCursorEvent);
      return;
    }
    if (message.type === "terminal.bind-failed") {
      this.emit("bind-failed", message);
      return;
    }
    if (message.type === "target.lost") {
      this.emit("target-lost", message satisfies RemoteHostTargetLostEvent);
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) {
      this.emit(
        "error",
        new Error("remote-host emitted an unknown or duplicate response")
      );
      child.kill();
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(message.requestId);
    if (message.status === "error") {
      pending.reject(
        new RemoteHostManagerError(
          message.error.code,
          message.error.message,
          message.error.retryable
        )
      );
    } else {
      pending.resolve(message.body);
    }
  }

  private childExited(child: UtilityProcess): void {
    if (this.child !== child) return;
    this.child = null;
    const error = new Error("remote-host exited before its requests completed");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.intentionallyStopped) {
      this.emit("runtime-lost");
      this.emit("error", error);
    }
  }
}

export class RemoteHostManagerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "RemoteHostManagerError";
  }
}

function decodeExpectedBridgeBody<
  Type extends RemoteBridgeResponseBody["type"]
>(
  value: unknown,
  expectedType: Type
): Extract<RemoteBridgeResponseBody, { type: Type }> {
  const body = decodeRemoteBridgeResponseBody(value);
  if (body.type !== expectedType) {
    throw new Error(
      `remote-host returned ${body.type} instead of ${expectedType}`
    );
  }
  return body as Extract<RemoteBridgeResponseBody, { type: Type }>;
}

function requireBodyRecord(
  value: unknown,
  expectedType: string
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("remote-host response body must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.type !== expectedType) {
    throw new Error(
      `remote-host returned ${String(record.type)} instead of ${expectedType}`
    );
  }
  return record;
}

function requireBodyObject(
  value: unknown,
  field: string
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function decodeEffectiveSshConfig(
  value: unknown
): RemoteHostEffectiveSshConfig {
  const effective = requireBodyObject(value, "effective OpenSSH config");
  assertBodyExactKeys(effective, [
    "hostName",
    "user",
    "port",
    "identityFiles",
    "proxyJump",
    "proxyCommand",
    "canonicalLines",
    "policyHash"
  ]);
  if (
    !Number.isSafeInteger(effective.port) ||
    (effective.port as number) < 1 ||
    (effective.port as number) > 65_535 ||
    !Array.isArray(effective.identityFiles) ||
    effective.identityFiles.length > 256 ||
    !Array.isArray(effective.canonicalLines) ||
    effective.canonicalLines.length > 4_096 ||
    typeof effective.policyHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(effective.policyHash)
  ) {
    throw new Error("remote-host returned an invalid effective OpenSSH config");
  }
  const identityFiles = effective.identityFiles.map((entry) =>
    requireBoundedBodyString(entry, "OpenSSH identity file", 32 * 1024)
  );
  const canonicalLines = effective.canonicalLines.map((entry) =>
    requireBoundedBodyString(entry, "OpenSSH canonical config line", 32 * 1024)
  );
  if (Buffer.byteLength(canonicalLines.join("\n"), "utf8") > 512 * 1024) {
    throw new Error("remote-host effective OpenSSH config is oversized");
  }
  return {
    hostName: requireBoundedBodyString(
      effective.hostName,
      "effective OpenSSH hostname",
      4 * 1024
    ),
    user: requireBoundedBodyString(
      effective.user,
      "effective OpenSSH user",
      4 * 1024
    ),
    port: effective.port as number,
    identityFiles,
    ...(effective.proxyJump === undefined
      ? {}
      : {
          proxyJump: requireBoundedBodyString(
            effective.proxyJump,
            "effective OpenSSH ProxyJump",
            32 * 1024
          )
        }),
    ...(effective.proxyCommand === undefined
      ? {}
      : {
          proxyCommand: requireBoundedBodyString(
            effective.proxyCommand,
            "effective OpenSSH ProxyCommand",
            32 * 1024
          )
        }),
    canonicalLines,
    policyHash: effective.policyHash
  };
}

function requireBoundedBodyString(
  value: unknown,
  field: string,
  maxBytes: number
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function decodeGenerationGcReport(value: unknown): RemoteGenerationGcReport {
  const record = requireBodyObject(value, "runtime generation clean report");
  assertBodyExactKeys(record, [
    "inspected",
    "removed",
    "live",
    "incompleteOrCorrupt"
  ]);
  if (
    !Number.isSafeInteger(record.inspected) ||
    (record.inspected as number) < 0 ||
    (record.inspected as number) > 256 ||
    !isGenerationList(record.removed) ||
    !isGenerationList(record.live) ||
    !isGenerationList(record.incompleteOrCorrupt)
  ) {
    throw new Error("remote-host returned an invalid runtime clean report");
  }
  return record as unknown as RemoteGenerationGcReport;
}

function decodeGenerationResetReport(
  value: unknown
): RemoteGenerationResetReport {
  const record = requireBodyObject(value, "runtime generation reset report");
  assertBodyExactKeys(record, ["generation", "status"]);
  if (
    !isRuntimeGeneration(record.generation) ||
    (record.status !== "reset" && record.status !== "already-absent")
  ) {
    throw new Error("remote-host returned an invalid runtime reset report");
  }
  return record as unknown as RemoteGenerationResetReport;
}

function isGenerationList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 256 &&
    value.every(isRuntimeGeneration)
  );
}

function isRuntimeGeneration(value: unknown): value is string {
  return typeof value === "string" && /^\d+\+[a-f0-9]{64}$/u.test(value);
}

function decodeVerifiedRoots(
  value: unknown,
  expected: RemoteHostTargetVerifyRequest["rootOverrides"]
): RemoteRuntimeRootsDto {
  const roots = requireBodyObject(value, "verified remote runtime roots");
  assertBodyExactKeys(roots, [
    "installRoot",
    "authorityRoot",
    "stateRoot",
    "runtimeRoot"
  ]);
  for (const key of [
    "installRoot",
    "authorityRoot",
    "stateRoot",
    "runtimeRoot"
  ] as const) {
    if (
      (expected[key] !== undefined && roots[key] !== expected[key]) ||
      typeof roots[key] !== "string" ||
      !roots[key].startsWith("/") ||
      roots[key].length > 32 * 1024 ||
      /[\0\r\n]/u.test(roots[key])
    ) {
      throw new Error("remote-host returned mismatched runtime roots");
    }
  }
  return roots as unknown as RemoteRuntimeRootsDto;
}

function decodeVerifiedDoctor(
  value: unknown,
  roots: RemoteRuntimeRootsDto
): RemoteDoctorReport {
  const doctor = requireBodyObject(value, "verified remote doctor report");
  assertBodyExactKeys(doctor, [
    "remoteInstallationId",
    "executionNodeId",
    "authenticatedPrincipal",
    "platform",
    "arch",
    "abi",
    "installRoot",
    "authorityRoot",
    "stateRoot",
    "runtimeRoot"
  ]);
  const principal = requireBodyObject(
    doctor.authenticatedPrincipal,
    "verified authenticated principal"
  );
  assertBodyExactKeys(principal, ["uid", "accountName"]);
  if (
    !isUuid(doctor.remoteInstallationId) ||
    !isUuid(doctor.executionNodeId) ||
    !Number.isSafeInteger(principal.uid) ||
    (principal.uid as number) < 0 ||
    typeof principal.accountName !== "string" ||
    principal.accountName.length === 0 ||
    Buffer.byteLength(principal.accountName, "utf8") > 4 * 1024 ||
    /[\0\r\n]/u.test(principal.accountName) ||
    (doctor.platform !== "linux" && doctor.platform !== "macos") ||
    (doctor.arch !== "x86_64" && doctor.arch !== "aarch64") ||
    (doctor.abi !== "musl" && doctor.abi !== "native") ||
    doctor.installRoot !== roots.installRoot ||
    doctor.authorityRoot !== roots.authorityRoot ||
    doctor.stateRoot !== roots.stateRoot ||
    doctor.runtimeRoot !== roots.runtimeRoot
  ) {
    throw new Error("remote-host returned an invalid doctor authority report");
  }
  return doctor as unknown as RemoteDoctorReport;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value
    )
  );
}

function requireSessionResourceKey(
  value: unknown,
  targetId: Id
): Record<
  "desktopInstallationId" | "targetId" | "workspaceId" | "sessionId",
  string
> {
  const resourceKey = requireBodyObject(value, "remote session resource key");
  assertBodyExactKeys(resourceKey, [
    "desktopInstallationId",
    "targetId",
    "workspaceId",
    "sessionId"
  ]);
  if (
    !isValidControlId(resourceKey.desktopInstallationId) ||
    resourceKey.targetId !== targetId ||
    !isValidControlId(resourceKey.workspaceId) ||
    !isValidControlId(resourceKey.sessionId)
  ) {
    throw new Error("remote session resource key is outside its target scope");
  }
  return resourceKey as Record<
    "desktopInstallationId" | "targetId" | "workspaceId" | "sessionId",
    string
  >;
}

function assertBodyExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[]
): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(record).find((key) => !allowedKeys.has(key));
  if (unexpected) {
    throw new Error(
      `remote-host response contains unexpected field ${unexpected}`
    );
  }
}

function sameRemoteResourceKey(
  left: RemoteResourceKey,
  right: RemoteResourceKey
): boolean {
  return (
    left.desktopInstallationId === right.desktopInstallationId &&
    left.targetId === right.targetId &&
    left.workspaceId === right.workspaceId &&
    left.sessionId === right.sessionId
  );
}

function isValidControlId(value: unknown): value is Id {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 256 &&
    !/\p{Cc}/u.test(value)
  );
}

function isTerminalDimension(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) > 0 &&
    (value as number) <= 0xffff
  );
}

function decodeDownloadTransfer(
  value: unknown,
  expected: {
    transferId: Id;
    remotePath: string;
    maxBytes: number;
  }
): RemoteSftpTransferResult {
  const transfer = requireBodyObject(value, "remote-host file download");
  assertBodyExactKeys(transfer, [
    "transferId",
    "localPath",
    "remotePath",
    "byteLength",
    "sha256"
  ]);
  if (
    transfer.transferId !== expected.transferId ||
    transfer.remotePath !== expected.remotePath ||
    typeof transfer.localPath !== "string" ||
    !Number.isSafeInteger(transfer.byteLength) ||
    (transfer.byteLength as number) < 0 ||
    (transfer.byteLength as number) > expected.maxBytes ||
    typeof transfer.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(transfer.sha256)
  ) {
    throw new Error("remote-host returned invalid file download metadata");
  }
  assertLocalAbsolutePath(transfer.localPath, "download staging path");
  return transfer as unknown as RemoteSftpTransferResult;
}

function decodeActiveForwardMappings(value: unknown): ActiveRemoteForward[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error("remote-host forward mappings must be a bounded array");
  }
  const identities = new Set<string>();
  const listeners = new Set<string>();
  return value.map((item) => {
    const mapping = requireBodyObject(item, "remote-host forward mapping");
    assertBodyExactKeys(mapping, [
      "forwardId",
      "workspaceId",
      "remoteHost",
      "remotePort",
      "localBindHost",
      "requestedLocalPort",
      "localPort",
      "status"
    ]);
    if (
      !isValidControlId(mapping.forwardId) ||
      !isValidControlId(mapping.workspaceId) ||
      typeof mapping.remoteHost !== "string" ||
      mapping.remoteHost.length < 1 ||
      Buffer.byteLength(mapping.remoteHost, "utf8") > 4 * 1024 ||
      /[\0\r\n]/u.test(mapping.remoteHost) ||
      !isPort(mapping.remotePort) ||
      (mapping.localBindHost !== "127.0.0.1" &&
        mapping.localBindHost !== "::1") ||
      (mapping.requestedLocalPort !== undefined &&
        !isPort(mapping.requestedLocalPort)) ||
      !isPort(mapping.localPort) ||
      mapping.status !== "active"
    ) {
      throw new Error("remote-host returned an invalid forward mapping");
    }
    const listener = `${mapping.localBindHost}:${mapping.localPort}`;
    if (identities.has(mapping.forwardId) || listeners.has(listener)) {
      throw new Error("remote-host returned duplicate forward mappings");
    }
    identities.add(mapping.forwardId);
    listeners.add(listener);
    return mapping as unknown as ActiveRemoteForward;
  });
}

function isPort(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= 65_535
  );
}

function decodeUploadTransfer(
  value: unknown,
  expected: {
    transferId: Id;
    remotePath: string;
    maxBytes: number;
    sha256: string;
  }
): RemoteSftpUploadResult {
  const transfer = requireBodyObject(value, "remote-host file upload");
  assertBodyExactKeys(transfer, [
    "transferId",
    "remotePath",
    "byteLength",
    "sha256"
  ]);
  if (
    transfer.transferId !== expected.transferId ||
    transfer.remotePath !== expected.remotePath ||
    !Number.isSafeInteger(transfer.byteLength) ||
    (transfer.byteLength as number) < 0 ||
    (transfer.byteLength as number) > expected.maxBytes ||
    transfer.sha256 !== expected.sha256
  ) {
    throw new Error("remote-host returned invalid file upload metadata");
  }
  return transfer as unknown as RemoteSftpUploadResult;
}

async function assertStagedDownload(
  transferRoot: string,
  localPath: string,
  expectedBytes: number
): Promise<void> {
  const metadata = await assertStagedFile(
    transferRoot,
    localPath,
    expectedBytes
  );
  if (metadata.size !== expectedBytes) {
    throw new Error("remote-host staged download size does not match metadata");
  }
}

async function assertStagedFile(
  transferRoot: string,
  localPath: string,
  maxBytes: number
): Promise<Awaited<ReturnType<typeof lstat>>> {
  assertStagingPath(transferRoot, localPath);
  const metadata = await lstat(localPath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > maxBytes
  ) {
    throw new Error("remote-host staging path is not a bounded regular file");
  }
  const [canonicalRoot, canonicalFile] = await Promise.all([
    realpath(transferRoot),
    realpath(localPath)
  ]);
  assertStagingPath(canonicalRoot, canonicalFile);
  return metadata;
}

function assertStagingPath(transferRoot: string, localPath: string): void {
  assertLocalAbsolutePath(localPath, "remote-host staging path");
  const root = resolve(transferRoot);
  const candidate = resolve(localPath);
  const suffix = relative(root, candidate);
  if (
    suffix.length === 0 ||
    suffix === ".." ||
    suffix.startsWith(`..${sep}`) ||
    isAbsolute(suffix)
  ) {
    throw new Error("remote-host staging path is outside its private root");
  }
}

function assertLocalAbsolutePath(value: string, name: string): void {
  if (
    !isAbsolute(value) ||
    Buffer.byteLength(value, "utf8") > 32 * 1024 ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new TypeError(`${name} must be a bounded absolute path`);
  }
}

function defaultRemoteHostManagerOptions(): RemoteHostManagerOptions {
  return {
    runtimeArtifactRoot: resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../remote/kmuxd/dist"
    ),
    transferRoot: resolve(
      tmpdir(),
      `kmux-remote-transfers-${process.getuid?.() ?? "user"}`
    )
  };
}

async function delay(durationMs: number): Promise<void> {
  await new Promise<void>((resolveDelay) => {
    const timer = setTimeout(resolveDelay, durationMs);
    timer.unref();
  });
}
