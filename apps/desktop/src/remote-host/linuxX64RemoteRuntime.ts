import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";

import {
  decodeRemoteOperationPayload,
  encodeRemoteOperationIntentDto,
  type RemoteOperationIntent,
  type RemoteOperationPayloadDto,
  type RemoteResourceKey
} from "@kmux/core";
import {
  REMOTE_PROTOCOL_VERSION,
  REMOTE_CHECKPOINT_HARD_MAX_CHUNKS,
  REMOTE_TERMINAL_INPUT_HARD_MAX_BYTES,
  UINT64_MAX,
  RemoteFrameDecoder,
  TERMINAL_DATA_PLANE_MAX_CHECKPOINT_BYTES,
  decodeRemoteBridgeResponseEnvelope,
  decodeRemoteKeeperControlMessage,
  decodeRemoteTerminalWireMessage,
  encodeRemoteControlJson,
  encodeRemoteFrame,
  encodeRemoteTerminalWireMessage,
  makeId,
  parseUint64Decimal,
  uint64,
  type Id,
  type RemoteConversionPrepareRequestDto,
  type RemoteConversionPromoteRequestDto,
  type RemoteProvisionalReclaimRequestDto,
  type RemoteSpoolEventDto,
  type RemoteSurfaceCaptureRequestDto,
  type RemoteTerminalInjectRequestDto,
  type RemoteBridgeRequestBody,
  type RemoteBridgeResponseBody,
  type RemoteKeeperAttachRequest,
  type RemoteKeeperControlMessage,
  type RemoteRuntimeRootsDto,
  type RemoteRetentionPolicyDto,
  type Uint64
} from "@kmux/proto";

import {
  spawnMuxOnlyChannel,
  type MuxOnlyChannelRequest
} from "./muxOnlyOpenSshChannel";
import {
  buildBootstrapHelperCommand,
  type BootstrapShellPolicy
} from "./bootstrapShellAdapter";
import type { AssignedSshMaster, SshTransportPool } from "./sshTransportPool";
import {
  MuxOnlyRemoteSftpClient,
  RemoteSftpError,
  type RemoteSftpTransferResult,
  type RemoteSftpUploadResult
} from "./remoteSftpClient";
import {
  MuxOnlyRemoteForwardManager,
  type ActiveRemoteForward
} from "./remoteForwardManager";

const BRIDGE_REQUEST_TIMEOUT_MS = 30_000;
const CHANNEL_CLOSE_TIMEOUT_MS = 5_000;
const CHANNEL_TERM_TIMEOUT_MS = 2_000;
const CHANNEL_KILL_WAIT_MS = 250;
const MAX_PENDING_BRIDGE_REQUESTS = 1_024;
const TERMINAL_REQUEST_TIMEOUT_MS = 30_000;
const MAX_PENDING_TERMINAL_MUTATIONS = 4_096;
const MAX_PENDING_TERMINAL_MUTATION_BYTES = 4 * 1024 * 1024;
const MAX_CHANNEL_STDERR_TAIL_BYTES = 64 * 1024;

export class RemoteRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    options: { cause?: unknown } = {}
  ) {
    super(message, options);
    this.name = "RemoteRuntimeError";
  }
}

export interface LinuxX64RemoteRuntimeOptions {
  pool: SshTransportPool;
  assigned: AssignedSshMaster;
  runtimePath: string;
  roots: RemoteRuntimeRootsDto;
  retentionPolicy?: RemoteRetentionPolicyDto;
  token: string;
  transferRoot: string;
  sftpPath?: string;
  bootstrapShellPolicy?: BootstrapShellPolicy;
}

export type RemoteRuntimeOperationOutcome =
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

export interface RemoteTerminalInputAcknowledgement {
  resourceKey: RemoteResourceKey & { sessionId: Id };
  keeperGeneration: Id;
  operationId: Id;
  writerLeaseId: Id;
  byteLength: number;
  boundary: "pty-write";
}

export interface RemoteSurfaceCaptureResult {
  captureId: Id;
  resourceKey: RemoteResourceKey & { sessionId: Id };
  keeperGeneration: Id;
  mutationSequence: Uint64;
  cols: number;
  rows: number;
  text: string;
  lineCount: number;
  byteLength: number;
  linesTruncated: boolean;
  bytesTruncated: boolean;
  retainedRangeTruncated: boolean;
}

export interface RemoteEventReplayPage {
  targetId: Id;
  events: RemoteSpoolEventDto[];
  acknowledgedThrough: Uint64;
  hasMore: boolean;
  admittedCount: Uint64;
  droppedLowValueCount: Uint64;
}

export type RemoteGitInspection = Extract<
  RemoteBridgeResponseBody,
  { type: "git.inspected" }
>;

export type RemotePortsInspection = Extract<
  RemoteBridgeResponseBody,
  { type: "ports.inspected" }
>;

export type RemoteHistoryScan = Extract<
  RemoteBridgeResponseBody,
  { type: "history.scanned" }
>;

export type RemoteUsageScan = Extract<
  RemoteBridgeResponseBody,
  { type: "usage.scanned" }
>;

export type RemoteDesiredForwards = Extract<
  RemoteBridgeResponseBody,
  { type: "forwards.observed" }
>;

export interface RemoteTerminalMutation {
  sequence: Uint64;
  kind: "output" | "resize" | "exit";
  data?: Uint8Array;
  cols?: number;
  rows?: number;
  exitCode?: number;
}

export interface RemoteTerminalCheckpointTransfer {
  metadata: Extract<RemoteKeeperControlMessage, { type: "checkpoint.begin" }>;
  chunks: Uint8Array[];
  sha256: string;
}

export interface RemoteTerminalAttachReady {
  keeperGeneration: Id;
  attachmentId: Id;
  writerLeaseId?: Id;
  checkpointAvailable: boolean;
  cols: number;
  rows: number;
  earliestAvailableSequence: Uint64;
  replayFromSequence: Uint64;
  liveStartsAfterSequence: Uint64;
  truncatedBeforeSequence?: Uint64;
}

export class LinuxX64RemoteRuntime {
  private bridge: BridgeConnection | undefined;
  private metadataBridge: BridgeConnection | undefined;
  private metadataBridgeOpening: Promise<BridgeConnection> | undefined;
  private readonly sftp: MuxOnlyRemoteSftpClient;
  private readonly forwards: MuxOnlyRemoteForwardManager;

  constructor(private readonly options: LinuxX64RemoteRuntimeOptions) {
    validateRuntimeOptions(options);
    this.sftp = new MuxOnlyRemoteSftpClient({
      pool: options.pool,
      assigned: options.assigned,
      transferRoot: options.transferRoot,
      ...(options.sftpPath === undefined ? {} : { sftpPath: options.sftpPath })
    });
    this.forwards = new MuxOnlyRemoteForwardManager({
      pool: options.pool,
      assigned: options.assigned
    });
  }

  async connect(): Promise<
    Extract<RemoteBridgeResponseBody, { type: "hello" }>
  > {
    const bridge = await this.requireBridge();
    const body = await bridge.request({ type: "hello" });
    if (body.type !== "hello") {
      throw new RemoteRuntimeError(
        "protocol-error",
        "bridge returned a non-hello response to hello",
        false
      );
    }
    return body;
  }

  async executeOperation(
    intent: RemoteOperationIntent,
    payload: RemoteOperationPayloadDto
  ): Promise<RemoteRuntimeOperationOutcome> {
    const validatedPayload = decodeRemoteOperationPayload(payload);
    const body = await (
      await this.requireBridge()
    ).request({
      type: "operation.execute",
      intent: encodeRemoteOperationIntentDto(intent),
      payload: validatedPayload
    });
    if (body.type !== "operation.result") {
      throw new RemoteRuntimeError(
        "protocol-error",
        "bridge returned the wrong operation response",
        false
      );
    }
    if (body.operationId !== intent.operationId) {
      throw new RemoteRuntimeError(
        "protocol-error",
        "bridge operation result identity does not match the request",
        false
      );
    }
    return body.outcome === "succeeded"
      ? {
          status: "succeeded",
          operationId: body.operationId,
          remoteResourceRevision: parseUint64Decimal(
            body.remoteResourceRevision
          ),
          resultDigest: body.resultDigest,
          ...(body.keeperGeneration === undefined
            ? {}
            : { keeperGeneration: body.keeperGeneration })
        }
      : {
          status: "failed",
          operationId: body.operationId,
          resultDigest: body.resultDigest,
          code: body.code,
          message: body.message
        };
  }

  async observe(options: {
    desktopInstallationId: Id;
    targetId: Id;
  }): Promise<Extract<RemoteBridgeResponseBody, { type: "observed" }>> {
    const body = await (
      await this.requireBridge()
    ).request({ type: "observe", ...options });
    if (body.type !== "observed") {
      throw new RemoteRuntimeError(
        "protocol-error",
        "bridge returned the wrong observation response",
        false
      );
    }
    if (body.targetId !== options.targetId) {
      throw new RemoteRuntimeError(
        "protocol-error",
        "bridge observation target does not match the request",
        false
      );
    }
    return body;
  }

  async inspectGit(options: {
    desktopInstallationId: Id;
    targetId: Id;
    cwd: string;
    dirtyLimit: number;
    branch?: string;
  }): Promise<RemoteGitInspection> {
    if (options.targetId !== this.options.assigned.targetId) {
      throw new RemoteRuntimeError(
        "target-mismatch",
        "git inspection target does not match the assigned SSH master",
        false
      );
    }
    const body = await (
      await this.requireMetadataBridge()
    ).request({ type: "git.inspect", ...structuredClone(options) });
    if (body.type !== "git.inspected" || body.cwd !== options.cwd) {
      throw new RemoteRuntimeError(
        "protocol-error",
        "bridge returned the wrong Git inspection response",
        false
      );
    }
    return body;
  }

  async inspectPorts(options: {
    resourceKey: RemoteResourceKey & { sessionId: Id };
  }): Promise<RemotePortsInspection> {
    if (options.resourceKey.targetId !== this.options.assigned.targetId) {
      throw new RemoteRuntimeError(
        "target-mismatch",
        "port inspection target does not match the assigned SSH master",
        false
      );
    }
    const body = await (
      await this.requireMetadataBridge()
    ).request({
      type: "ports.inspect",
      resourceKey: structuredClone(options.resourceKey)
    });
    if (
      body.type !== "ports.inspected" ||
      !sameResourceKey(body.resourceKey, options.resourceKey)
    ) {
      throw new RemoteRuntimeError(
        "protocol-error",
        "bridge returned the wrong port inspection response",
        false
      );
    }
    return body;
  }

  async scanHistory(options: {
    desktopInstallationId: Id;
    targetId: Id;
    maxRecords: number;
  }): Promise<RemoteHistoryScan> {
    if (
      options.targetId !== this.options.assigned.targetId ||
      !Number.isSafeInteger(options.maxRecords) ||
      options.maxRecords < 1 ||
      options.maxRecords > 100
    ) {
      throw new RemoteRuntimeError(
        "invalid-request",
        "history scan target or bound is invalid",
        false
      );
    }
    const body = await (
      await this.requireMetadataBridge()
    ).request({ type: "history.scan", ...structuredClone(options) });
    if (body.type !== "history.scanned" || body.targetId !== options.targetId) {
      throw new RemoteRuntimeError(
        "protocol-error",
        "bridge returned the wrong history scan response",
        false
      );
    }
    return body;
  }

  async scanUsage(options: {
    desktopInstallationId: Id;
    targetId: Id;
    startAtUnixMs: number;
    maxRecords: number;
  }): Promise<RemoteUsageScan> {
    if (
      options.targetId !== this.options.assigned.targetId ||
      !Number.isSafeInteger(options.startAtUnixMs) ||
      options.startAtUnixMs < 0 ||
      !Number.isSafeInteger(options.maxRecords) ||
      options.maxRecords < 1 ||
      options.maxRecords > 64
    ) {
      throw new RemoteRuntimeError(
        "invalid-request",
        "usage scan target or bound is invalid",
        false
      );
    }
    const body = await (
      await this.requireMetadataBridge()
    ).request({
      type: "usage.scan",
      desktopInstallationId: options.desktopInstallationId,
      targetId: options.targetId,
      startAtUnixMs: options.startAtUnixMs.toString(10),
      maxRecords: options.maxRecords
    });
    if (body.type !== "usage.scanned" || body.targetId !== options.targetId) {
      throw new RemoteRuntimeError(
        "protocol-error",
        "bridge returned the wrong usage scan response",
        false
      );
    }
    return body;
  }

  async observeForwards(options: {
    desktopInstallationId: Id;
    targetId: Id;
  }): Promise<RemoteDesiredForwards> {
    if (options.targetId !== this.options.assigned.targetId) {
      throw new RemoteRuntimeError(
        "target-mismatch",
        "forward observation target does not match the assigned SSH master",
        false
      );
    }
    const body = await (
      await this.requireBridge()
    ).request({ type: "forwards.observe", ...structuredClone(options) });
    if (
      body.type !== "forwards.observed" ||
      body.targetId !== options.targetId
    ) {
      throw new RemoteRuntimeError(
        "protocol-error",
        "bridge returned the wrong desired-forward response",
        false
      );
    }
    for (const forward of body.forwards) {
      if (
        forward.resourceKey.desktopInstallationId !==
          options.desktopInstallationId ||
        forward.resourceKey.targetId !== options.targetId ||
        forward.resourceKey.sessionId !== undefined
      ) {
        throw new RemoteRuntimeError(
          "protocol-error",
          "bridge returned a desired forward outside the requested target scope",
          false
        );
      }
    }
    return body;
  }

  async reconcileForwards(options: {
    desktopInstallationId: Id;
    targetId: Id;
  }): Promise<ActiveRemoteForward[]> {
    const observed = await this.observeForwards(options);
    return await this.forwards.reconcile(observed.forwards);
  }

  async closeWorkspaceForwards(workspaceId: Id): Promise<void> {
    await this.forwards.closeWorkspace(workspaceId);
  }

  async prepareConversion(options: RemoteConversionPrepareRequestDto) {
    const body = await (
      await this.requireBridge()
    ).request({ type: "conversion.prepare", ...structuredClone(options) });
    if (
      body.type !== "conversion.prepared" ||
      body.transactionId !== options.transactionId ||
      body.remoteSnapshotHash !== options.remoteSnapshotHash
    ) {
      throw new RemoteRuntimeError(
        "protocol-error",
        "bridge returned the wrong conversion preparation response",
        false
      );
    }
    return body;
  }

  async promoteConversion(options: RemoteConversionPromoteRequestDto) {
    const body = await (
      await this.requireBridge()
    ).request({ type: "conversion.promote", ...structuredClone(options) });
    if (
      body.type !== "conversion.promoted" ||
      body.transactionId !== options.transactionId ||
      body.remoteSnapshotHash !== options.remoteSnapshotHash
    ) {
      throw new RemoteRuntimeError(
        "protocol-error",
        "bridge returned the wrong conversion promotion response",
        false
      );
    }
    return body;
  }

  async reclaimProvisionals(options: RemoteProvisionalReclaimRequestDto) {
    const body = await (
      await this.requireBridge()
    ).request({ type: "provisional.reclaim", ...structuredClone(options) });
    if (body.type !== "provisional.reclaimed") {
      throw new RemoteRuntimeError(
        "protocol-error",
        "bridge returned the wrong provisional reclaim response",
        false
      );
    }
    return body;
  }

  async injectTerminal(
    request: RemoteTerminalInjectRequestDto
  ): Promise<RemoteTerminalInputAcknowledgement> {
    const body = await (
      await this.requireBridge()
    ).request({ type: "terminal.inject", ...structuredClone(request) });
    if (
      body.type !== "terminal.input-ack" ||
      body.operationId !== request.operationId ||
      body.keeperGeneration !== request.expectedKeeperGeneration ||
      body.resourceKey.desktopInstallationId !==
        request.resourceKey.desktopInstallationId ||
      body.resourceKey.targetId !== request.resourceKey.targetId ||
      body.resourceKey.workspaceId !== request.resourceKey.workspaceId ||
      body.resourceKey.sessionId !== request.resourceKey.sessionId ||
      body.byteLength !== Buffer.byteLength(request.input, "utf8") ||
      body.boundary !== "pty-write"
    ) {
      throw new RemoteRuntimeError(
        "protocol-error",
        "bridge returned the wrong terminal input acknowledgement",
        false
      );
    }
    return {
      resourceKey: structuredClone(body.resourceKey),
      keeperGeneration: body.keeperGeneration,
      operationId: body.operationId,
      writerLeaseId: body.writerLeaseId,
      byteLength: body.byteLength,
      boundary: body.boundary
    };
  }

  async captureSurface(
    request: RemoteSurfaceCaptureRequestDto
  ): Promise<RemoteSurfaceCaptureResult> {
    return (await this.requireBridge()).requestCapture({
      type: "surface.capture",
      ...structuredClone(request)
    });
  }

  async replayEvents(options: {
    desktopInstallationId: Id;
    targetId: Id;
    afterSequence: Uint64;
  }): Promise<RemoteEventReplayPage> {
    const body = await (
      await this.requireBridge()
    ).request({
      type: "events.replay",
      desktopInstallationId: options.desktopInstallationId,
      targetId: options.targetId,
      afterSequence: options.afterSequence.toString(10)
    });
    if (body.type !== "events.replayed" || body.targetId !== options.targetId) {
      throw new RemoteRuntimeError(
        "protocol-error",
        "bridge returned the wrong remote event replay",
        false
      );
    }
    return {
      targetId: body.targetId,
      events: structuredClone(body.events),
      acknowledgedThrough: parseUint64Decimal(body.acknowledgedThrough),
      hasMore: body.hasMore,
      admittedCount: parseUint64Decimal(body.admittedCount),
      droppedLowValueCount: parseUint64Decimal(body.droppedLowValueCount)
    };
  }

  async acknowledgeEvents(options: {
    desktopInstallationId: Id;
    targetId: Id;
    throughSequence: Uint64;
  }): Promise<Uint64> {
    const body = await (
      await this.requireBridge()
    ).request({
      type: "events.ack",
      desktopInstallationId: options.desktopInstallationId,
      targetId: options.targetId,
      throughSequence: options.throughSequence.toString(10)
    });
    if (
      body.type !== "events.acknowledged" ||
      body.targetId !== options.targetId
    ) {
      throw new RemoteRuntimeError(
        "protocol-error",
        "bridge returned the wrong remote event acknowledgement",
        false
      );
    }
    const acknowledged = parseUint64Decimal(body.acknowledgedThrough);
    if (acknowledged < options.throughSequence) {
      throw new RemoteRuntimeError(
        "protocol-error",
        "bridge event acknowledgement moved backward",
        false
      );
    }
    return acknowledged;
  }

  async fileExists(remotePath: string): Promise<boolean> {
    return await this.withSftpError(() => this.sftp.exists(remotePath));
  }

  async downloadFile(request: {
    transferId: string;
    remotePath: string;
    maxBytes: number;
  }): Promise<RemoteSftpTransferResult> {
    return await this.withSftpError(() => this.sftp.download(request));
  }

  async uploadFile(request: {
    transferId: string;
    localPath: string;
    remotePath: string;
    maxBytes: number;
    sha256: string;
  }): Promise<RemoteSftpUploadResult> {
    return await this.withSftpError(() => this.sftp.upload(request));
  }

  async releaseFile(localPath: string): Promise<void> {
    await this.withSftpError(() => this.sftp.release(localPath));
  }

  async attach(options: {
    resourceKey: RemoteResourceKey & { sessionId: Id };
    expectedKeeperGeneration?: Id;
    access: "read" | "write";
    lastReceivedSequence?: Uint64;
    attachmentId?: Id;
  }): Promise<RemoteTerminalAttachment> {
    const authorization = await (
      await this.requireBridge()
    ).request({
      type: "attach.authorize",
      resourceKey: options.resourceKey,
      ...(options.expectedKeeperGeneration === undefined
        ? {}
        : {
            expectedKeeperGeneration: options.expectedKeeperGeneration
          }),
      access: options.access
    });
    if (authorization.type !== "attach.authorized") {
      throw new RemoteRuntimeError(
        "protocol-error",
        "bridge returned the wrong attach authorization response",
        false
      );
    }
    if (
      authorization.resourceKey.desktopInstallationId !==
        options.resourceKey.desktopInstallationId ||
      authorization.resourceKey.targetId !== options.resourceKey.targetId ||
      authorization.resourceKey.workspaceId !==
        options.resourceKey.workspaceId ||
      authorization.resourceKey.sessionId !== options.resourceKey.sessionId ||
      authorization.access !== options.access
    ) {
      throw new RemoteRuntimeError(
        "protocol-error",
        "bridge attach authorization scope does not match the request",
        false
      );
    }
    const attachmentId = options.attachmentId ?? makeId("attachment");
    const { runtimePath: proxyRuntimePath, args: proxyArgs } =
      resolveTerminalProxyCommand(
        authorization.terminalProxy,
        this.options.runtimePath
      );
    const child = await spawnMuxOnlyChannel(
      this.channelRequest("terminal", proxyArgs, proxyRuntimePath),
      {
        isCurrentGeneration: (generation) =>
          this.options.pool.isCurrentGeneration(
            this.options.assigned.targetId,
            generation
          )
      }
    );
    const request: RemoteKeeperAttachRequest = {
      type: "keeper.attach",
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      roots: structuredClone(this.options.roots),
      resourceKey: structuredClone(options.resourceKey),
      keeperGeneration: authorization.keeperGeneration,
      attachCapability: authorization.attachCapability,
      attachmentId,
      access: options.access,
      ...(options.lastReceivedSequence === undefined
        ? {}
        : {
            lastReceivedSequence: options.lastReceivedSequence.toString(10)
          })
    };
    const attachment = new RemoteTerminalAttachment(child, request);
    try {
      await withTimeout(
        attachment.ready,
        TERMINAL_REQUEST_TIMEOUT_MS,
        "remote terminal attach readiness timed out"
      );
    } catch (error) {
      await terminateChildChannel(child);
      throw error;
    }
    return attachment;
  }

  async closeBridge(): Promise<void> {
    const bridge = this.bridge;
    const metadataBridge = this.metadataBridge;
    const metadataBridgeOpening = this.metadataBridgeOpening;
    this.bridge = undefined;
    this.metadataBridge = undefined;
    this.metadataBridgeOpening = undefined;
    await Promise.allSettled([
      bridge?.close(),
      metadataBridge?.close(),
      metadataBridgeOpening?.then(async (opening) => await opening.close())
    ]);
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled([
      this.sftp.close(),
      this.forwards.close(),
      this.closeBridge()
    ]);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (failure) throw failure.reason;
  }

  private async withSftpError<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RemoteSftpError) {
        throw new RemoteRuntimeError(
          error.code,
          error.message,
          error.retryable,
          {
            cause: error
          }
        );
      }
      throw error;
    }
  }

  private async requireBridge(): Promise<BridgeConnection> {
    if (this.bridge?.isOpen()) return this.bridge;
    const child = await spawnMuxOnlyChannel(
      this.channelRequest("control", ["bridge", "serve"]),
      {
        isCurrentGeneration: (generation) =>
          this.options.pool.isCurrentGeneration(
            this.options.assigned.targetId,
            generation
          )
      }
    );
    const bridge = new BridgeConnection(child, this.options);
    this.bridge = bridge;
    return bridge;
  }

  private async requireMetadataBridge(): Promise<BridgeConnection> {
    if (this.metadataBridge?.isOpen()) return this.metadataBridge;
    if (this.metadataBridgeOpening) return await this.metadataBridgeOpening;
    const opening = this.openMetadataBridge();
    this.metadataBridgeOpening = opening;
    try {
      const bridge = await opening;
      if (this.metadataBridgeOpening !== opening) {
        await bridge.close();
        throw new RemoteRuntimeError(
          "bridge-closed",
          "remote metadata bridge closed while opening",
          true
        );
      }
      this.metadataBridge = bridge;
      return bridge;
    } finally {
      if (this.metadataBridgeOpening === opening) {
        this.metadataBridgeOpening = undefined;
      }
    }
  }

  private async openMetadataBridge(): Promise<BridgeConnection> {
    const child = await spawnMuxOnlyChannel(
      this.channelRequest("metadata", ["bridge", "serve"]),
      {
        isCurrentGeneration: (generation) =>
          this.options.pool.isCurrentGeneration(
            this.options.assigned.targetId,
            generation
          )
      }
    );
    const bridge = new BridgeConnection(child, this.options);
    try {
      const hello = await bridge.request({ type: "hello" });
      if (hello.type !== "hello") {
        throw new RemoteRuntimeError(
          "protocol-error",
          "metadata bridge returned a non-hello response to hello",
          false
        );
      }
      return bridge;
    } catch (error) {
      await bridge.close().catch(() => undefined);
      throw error;
    }
  }

  private channelRequest(
    kind: "control" | "terminal" | "metadata",
    runtimeArgs: readonly string[],
    runtimePath = this.options.runtimePath
  ): MuxOnlyChannelRequest {
    const master = this.options.assigned.master;
    return {
      kind,
      sshPath: master.sshPath,
      configPath: master.configPath,
      controlPath: master.controlPath,
      host: master.host,
      masterGeneration: master.generation,
      remoteCommand: buildBootstrapHelperCommand(
        this.options.bootstrapShellPolicy ?? DEFAULT_BOOTSTRAP_SHELL_POLICY,
        runtimePath,
        runtimeArgs
      )
    };
  }
}

type PendingBridgeRequest =
  | {
      kind: "single";
      deferred: Deferred<RemoteBridgeResponseBody>;
    }
  | {
      kind: "capture";
      captureId: Id;
      resourceKey: RemoteResourceKey & { sessionId: Id };
      expectedKeeperGeneration: Id;
      lineLimit: number;
      maxBytes: number;
      byteLength: number;
      chunks: string[];
      deferred: Deferred<RemoteSurfaceCaptureResult>;
    };

export class BridgeConnection {
  private readonly decoder = new RemoteFrameDecoder();
  private readonly pending = new Map<Id, PendingBridgeRequest>();
  private open = true;
  private stderrTail = Buffer.alloc(0);
  private terminationPromise: Promise<void> | undefined;

  constructor(
    private readonly child: ChildProcess,
    private readonly options: LinuxX64RemoteRuntimeOptions
  ) {
    requireChildPipes(child);
    child.stdin.on("error", (error) => this.onClose(error));
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.appendStderr(chunk));
    child.once("error", (error) => this.onClose(error));
    child.once("close", (code, signal) =>
      this.onClose(
        new RemoteRuntimeError(
          "bridge-closed",
          `remote bridge channel closed (${code ?? signal ?? "unknown"})${
            this.stderrTail.byteLength === 0
              ? ""
              : `: ${this.stderrTail.toString("utf8").trim()}`
          }`,
          true
        )
      )
    );
  }

  isOpen(): boolean {
    return this.open && this.child.exitCode === null;
  }

  async request(
    request: RemoteBridgeRequestBody
  ): Promise<RemoteBridgeResponseBody> {
    if (!this.isOpen()) {
      throw new RemoteRuntimeError(
        "bridge-closed",
        "remote bridge channel is closed",
        true
      );
    }
    if (this.pending.size >= MAX_PENDING_BRIDGE_REQUESTS) {
      throw new RemoteRuntimeError(
        "request-limit",
        "remote bridge request limit is full",
        true
      );
    }
    const requestId = makeId("bridge-request");
    const deferred = createDeferred<RemoteBridgeResponseBody>();
    this.pending.set(requestId, { kind: "single", deferred });
    const timeout = setTimeout(() => {
      if (this.pending.delete(requestId)) {
        const error = new RemoteRuntimeError(
          "timed-out",
          "remote bridge request timed out",
          true
        );
        deferred.reject(error);
        this.onClose(error);
        void this.stopChild(false);
      }
    }, BRIDGE_REQUEST_TIMEOUT_MS);
    timeout.unref();
    try {
      await writeChildStdin(
        this.child,
        encodeRemoteFrame(
          1,
          encodeRemoteControlJson({
            protocolVersion: REMOTE_PROTOCOL_VERSION,
            requestId,
            token: this.options.token,
            roots: this.options.roots,
            retentionPolicy: resolvedRetentionPolicy(this.options),
            request
          })
        )
      );
      return await deferred.promise;
    } finally {
      clearTimeout(timeout);
      this.pending.delete(requestId);
    }
  }

  async requestCapture(
    request: Extract<RemoteBridgeRequestBody, { type: "surface.capture" }>
  ): Promise<RemoteSurfaceCaptureResult> {
    if (
      !Number.isSafeInteger(request.lineLimit) ||
      request.lineLimit < 1 ||
      request.lineLimit > 65_536 ||
      !Number.isSafeInteger(request.maxBytes) ||
      request.maxBytes < 1 ||
      request.maxBytes > 1024 * 1024
    ) {
      throw new RemoteRuntimeError(
        "invalid-request",
        "remote surface capture bounds are invalid",
        false
      );
    }
    if (!this.isOpen()) {
      throw new RemoteRuntimeError(
        "bridge-closed",
        "remote bridge channel is closed",
        true
      );
    }
    if (this.pending.size >= MAX_PENDING_BRIDGE_REQUESTS) {
      throw new RemoteRuntimeError(
        "request-limit",
        "remote bridge request limit is full",
        true
      );
    }
    const requestId = makeId("bridge-request");
    const deferred = createDeferred<RemoteSurfaceCaptureResult>();
    this.pending.set(requestId, {
      kind: "capture",
      captureId: request.captureId,
      resourceKey: structuredClone(request.resourceKey),
      expectedKeeperGeneration: request.expectedKeeperGeneration,
      lineLimit: request.lineLimit,
      maxBytes: request.maxBytes,
      byteLength: 0,
      chunks: [],
      deferred
    });
    const timeout = setTimeout(() => {
      if (this.pending.delete(requestId)) {
        const error = new RemoteRuntimeError(
          "timed-out",
          "remote surface capture timed out",
          true
        );
        deferred.reject(error);
        this.onClose(error);
        void this.stopChild(false);
      }
    }, BRIDGE_REQUEST_TIMEOUT_MS);
    timeout.unref();
    try {
      await writeChildStdin(
        this.child,
        encodeRemoteFrame(
          1,
          encodeRemoteControlJson({
            protocolVersion: REMOTE_PROTOCOL_VERSION,
            requestId,
            token: this.options.token,
            roots: this.options.roots,
            retentionPolicy: resolvedRetentionPolicy(this.options),
            request
          })
        )
      );
      return await deferred.promise;
    } finally {
      clearTimeout(timeout);
      this.pending.delete(requestId);
    }
  }

  async close(): Promise<void> {
    if (this.open) {
      this.open = false;
      this.child.stdin?.end();
      await this.stopChild(true);
    } else if (this.terminationPromise) {
      await this.terminationPromise;
    }
    this.rejectPending(
      new RemoteRuntimeError(
        "bridge-closed",
        "remote bridge was closed by its owner",
        true
      )
    );
  }

  private onData(chunk: Buffer): void {
    if (!this.open) return;
    try {
      for (const frame of this.decoder.push(chunk)) {
        if (frame.kind !== 1) {
          throw new RemoteRuntimeError(
            "protocol-error",
            "bridge emitted a non-control frame",
            false
          );
        }
        const response = decodeRemoteBridgeResponseEnvelope(frame.payload);
        const pending = this.pending.get(response.requestId);
        if (!pending) {
          throw new RemoteRuntimeError(
            "protocol-error",
            "bridge emitted an unknown or duplicate request response",
            false
          );
        }
        if (response.status === "error") {
          this.pending.delete(response.requestId);
          pending.deferred.reject(
            new RemoteRuntimeError(
              response.error.code,
              response.error.message,
              response.error.retryable
            )
          );
          continue;
        }
        if (pending.kind === "single") {
          if (
            response.body.type === "surface.capture-chunk" ||
            response.body.type === "surface.capture-completed"
          ) {
            throw new RemoteRuntimeError(
              "protocol-error",
              "bridge emitted capture frames for a non-capture request",
              false
            );
          }
          this.pending.delete(response.requestId);
          pending.deferred.resolve(response.body);
          continue;
        }
        if (response.body.type === "surface.capture-chunk") {
          const chunkBytes = Buffer.byteLength(response.body.text, "utf8");
          if (
            response.body.captureId !== pending.captureId ||
            response.body.index !== pending.chunks.length ||
            pending.byteLength + chunkBytes > pending.maxBytes
          ) {
            throw new RemoteRuntimeError(
              "protocol-error",
              "remote surface capture chunk order or identity changed",
              false
            );
          }
          pending.byteLength += chunkBytes;
          pending.chunks.push(response.body.text);
          continue;
        }
        if (response.body.type !== "surface.capture-completed") {
          throw new RemoteRuntimeError(
            "protocol-error",
            "bridge emitted a non-capture result for a capture request",
            false
          );
        }
        const completed = response.body;
        const text = pending.chunks.join("");
        const digest = createHash("sha256").update(text, "utf8").digest("hex");
        if (
          completed.captureId !== pending.captureId ||
          completed.resourceKey.desktopInstallationId !==
            pending.resourceKey.desktopInstallationId ||
          completed.resourceKey.targetId !== pending.resourceKey.targetId ||
          completed.resourceKey.workspaceId !==
            pending.resourceKey.workspaceId ||
          completed.resourceKey.sessionId !== pending.resourceKey.sessionId ||
          completed.keeperGeneration !== pending.expectedKeeperGeneration ||
          completed.chunkCount !== pending.chunks.length ||
          completed.byteLength !== pending.byteLength ||
          completed.byteLength > pending.maxBytes ||
          completed.lineCount > pending.lineLimit ||
          completed.sha256 !== digest
        ) {
          throw new RemoteRuntimeError(
            "protocol-error",
            "remote surface capture completion failed identity or digest validation",
            false
          );
        }
        this.pending.delete(response.requestId);
        pending.deferred.resolve({
          captureId: completed.captureId,
          resourceKey: structuredClone(completed.resourceKey),
          keeperGeneration: completed.keeperGeneration,
          mutationSequence: parseUint64Decimal(completed.mutationSequence),
          cols: completed.cols,
          rows: completed.rows,
          text,
          lineCount: completed.lineCount,
          byteLength: completed.byteLength,
          linesTruncated: completed.linesTruncated,
          bytesTruncated: completed.bytesTruncated,
          retainedRangeTruncated: completed.retainedRangeTruncated
        });
      }
    } catch (error) {
      this.onClose(error);
      void this.stopChild(false);
    }
  }

  private stopChild(graceful: boolean): Promise<void> {
    this.terminationPromise ??= graceful
      ? waitForChildClose(this.child, CHANNEL_CLOSE_TIMEOUT_MS)
      : terminateChildChannel(this.child);
    return this.terminationPromise;
  }

  private onClose(error: unknown): void {
    if (!this.open && this.pending.size === 0) return;
    this.open = false;
    this.rejectPending(
      error instanceof Error
        ? error
        : new RemoteRuntimeError(
            "bridge-closed",
            "remote bridge channel closed",
            true
          )
    );
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.deferred.reject(error);
    }
    this.pending.clear();
  }

  private appendStderr(chunk: Buffer): void {
    const combined = Buffer.concat([this.stderrTail, chunk]);
    this.stderrTail =
      combined.byteLength <= MAX_CHANNEL_STDERR_TAIL_BYTES
        ? combined
        : combined.subarray(
            combined.byteLength - MAX_CHANNEL_STDERR_TAIL_BYTES
          );
  }
}

export class RemoteTerminalAttachment {
  readonly ready: Promise<RemoteTerminalAttachReady>;
  readonly checkpoint: Promise<RemoteTerminalCheckpointTransfer | null>;

  private readonly decoder = new RemoteFrameDecoder();
  private readonly readyDeferred = createDeferred<RemoteTerminalAttachReady>();
  private readonly checkpointDeferred =
    createDeferred<RemoteTerminalCheckpointTransfer | null>();
  private readonly mutations: RemoteTerminalMutation[] = [];
  private readonly mutationWaiters: Array<
    Deferred<RemoteTerminalMutation | null>
  > = [];
  private pendingInput:
    | {
        sequence: Uint64;
        deferred: Deferred<
          Extract<RemoteKeeperControlMessage, { type: "input.ack" }>
        >;
      }
    | undefined;
  private pendingResize:
    | {
        cols: number;
        rows: number;
        deferred: Deferred<
          Extract<RemoteKeeperControlMessage, { type: "resize.ack" }>
        >;
      }
    | undefined;
  private attachReady: RemoteTerminalAttachReady | undefined;
  private checkpointState:
    | {
        metadata: Extract<
          RemoteKeeperControlMessage,
          { type: "checkpoint.begin" }
        >;
        expectedBytes: number;
        receivedBytes: number;
        chunks: Uint8Array[];
        digest: ReturnType<typeof createHash>;
      }
    | undefined;
  private nextMutationSequence: bigint | undefined;
  private queuedMutationBytes = 0;
  private checkpointComplete = false;
  private open = true;
  private closeError: Error | undefined;
  private stderrTail = Buffer.alloc(0);
  private terminationPromise: Promise<void> | undefined;

  constructor(
    private readonly child: ChildProcess,
    private readonly request: RemoteKeeperAttachRequest
  ) {
    this.ready = this.readyDeferred.promise;
    this.checkpoint = this.withAttachmentTimeout(
      this.checkpointDeferred.promise,
      "remote terminal checkpoint timed out"
    );
    void this.ready.catch(() => undefined);
    void this.checkpoint.catch(() => undefined);
    requireChildPipes(child);
    child.stdin.on("error", (error) => this.onClose(error));
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.appendStderr(chunk));
    child.once("error", (error) => this.onClose(error));
    child.once("close", (code, signal) =>
      this.onClose(
        new RemoteRuntimeError(
          "attachment-closed",
          `remote terminal attachment closed (${code ?? signal ?? "unknown"})${
            this.stderrTail.byteLength === 0
              ? ""
              : `: ${this.stderrTail.toString("utf8").trim()}`
          }`,
          true
        )
      )
    );
    void writeChildStdin(
      child,
      encodeRemoteFrame(1, encodeRemoteControlJson(request))
    ).catch((error: unknown) => this.onClose(error));
  }

  isOpen(): boolean {
    return this.open && this.child.exitCode === null;
  }

  async nextMutation(): Promise<RemoteTerminalMutation | null> {
    const mutation = this.mutations.shift();
    if (mutation) {
      this.queuedMutationBytes -= mutationByteLength(mutation);
      return mutation;
    }
    if (!this.open) {
      if (
        this.closeError &&
        (!(this.closeError instanceof RemoteRuntimeError) ||
          this.closeError.code !== "attachment-closed")
      ) {
        throw this.closeError;
      }
      return null;
    }
    if (this.mutationWaiters.length !== 0) {
      throw new RemoteRuntimeError(
        "consumer-conflict",
        "only one terminal mutation read may be pending",
        false
      );
    }
    const deferred = createDeferred<RemoteTerminalMutation | null>();
    this.mutationWaiters.push(deferred);
    return await deferred.promise;
  }

  async sendInput(
    inputSequence: Uint64,
    data: Uint8Array
  ): Promise<Extract<RemoteKeeperControlMessage, { type: "input.ack" }>> {
    const ready = await this.ready;
    if (!ready.writerLeaseId) {
      throw new RemoteRuntimeError(
        "writer-fenced",
        "attachment has no writer lease",
        false
      );
    }
    if (!(data instanceof Uint8Array)) {
      throw new TypeError("remote terminal input must be bytes");
    }
    if (data.byteLength > REMOTE_TERMINAL_INPUT_HARD_MAX_BYTES) {
      throw new RangeError("remote terminal input exceeds 64 KiB");
    }
    if (this.pendingInput) {
      throw new RemoteRuntimeError(
        "input-conflict",
        "another terminal input is already pending",
        false
      );
    }
    const deferred =
      createDeferred<
        Extract<RemoteKeeperControlMessage, { type: "input.ack" }>
      >();
    this.pendingInput = { sequence: inputSequence, deferred };
    try {
      await this.writeTerminal({
        kind: "input",
        writerLeaseId: ready.writerLeaseId,
        attachmentId: ready.attachmentId,
        inputSequence,
        data
      });
      return await this.withAttachmentTimeout(
        deferred.promise,
        "remote terminal input acknowledgement timed out"
      );
    } finally {
      if (this.pendingInput?.deferred === deferred)
        this.pendingInput = undefined;
    }
  }

  async resize(
    cols: number,
    rows: number
  ): Promise<Extract<RemoteKeeperControlMessage, { type: "resize.ack" }>> {
    const ready = await this.ready;
    if (!ready.writerLeaseId) {
      throw new RemoteRuntimeError(
        "writer-fenced",
        "attachment has no writer lease",
        false
      );
    }
    if (this.pendingResize) {
      throw new RemoteRuntimeError(
        "resize-conflict",
        "another resize is pending",
        false
      );
    }
    const deferred =
      createDeferred<
        Extract<RemoteKeeperControlMessage, { type: "resize.ack" }>
      >();
    this.pendingResize = { cols, rows, deferred };
    try {
      await this.writeTerminal({
        kind: "resize-request",
        writerLeaseId: ready.writerLeaseId,
        attachmentId: ready.attachmentId,
        cols,
        rows
      });
      return await this.withAttachmentTimeout(
        deferred.promise,
        "remote terminal resize acknowledgement timed out"
      );
    } finally {
      if (this.pendingResize?.deferred === deferred)
        this.pendingResize = undefined;
    }
  }

  async detach(): Promise<void> {
    if (this.open) {
      this.open = false;
      this.child.stdin?.end();
      await this.stopChild(true);
    } else if (this.terminationPromise) {
      await this.terminationPromise;
    }
    this.resolveMutationWaiters();
  }

  private async writeTerminal(
    message: Parameters<typeof encodeRemoteTerminalWireMessage>[0]
  ): Promise<void> {
    if (!this.isOpen()) {
      throw new RemoteRuntimeError(
        "attachment-closed",
        "remote terminal attachment is closed",
        true
      );
    }
    await writeChildStdin(
      this.child,
      encodeRemoteFrame(2, encodeRemoteTerminalWireMessage(message))
    );
  }

  private onData(chunk: Buffer): void {
    if (!this.open) return;
    try {
      for (const frame of this.decoder.push(chunk)) {
        switch (frame.kind) {
          case 1:
            this.onControl(decodeRemoteKeeperControlMessage(frame.payload));
            break;
          case 2:
            this.onTerminal(frame.payload);
            break;
          case 3:
            this.onCheckpointChunk(frame.payload);
            break;
          default:
            throw new RemoteRuntimeError(
              "protocol-error",
              "terminal attachment emitted an invalid frame kind",
              false
            );
        }
      }
    } catch (error) {
      this.onClose(error);
      void this.stopChild(false);
    }
  }

  private stopChild(graceful: boolean): Promise<void> {
    this.terminationPromise ??= graceful
      ? waitForChildClose(this.child, CHANNEL_CLOSE_TIMEOUT_MS)
      : terminateChildChannel(this.child);
    return this.terminationPromise;
  }

  private async withAttachmentTimeout<T>(
    promise: Promise<T>,
    message: string
  ): Promise<T> {
    try {
      return await withTimeout(promise, TERMINAL_REQUEST_TIMEOUT_MS, message);
    } catch (error) {
      if (error instanceof RemoteRuntimeError && error.code === "timed-out") {
        this.onClose(error);
        await this.stopChild(false);
      }
      throw error;
    }
  }

  private onControl(control: RemoteKeeperControlMessage): void {
    switch (control.type) {
      case "attach.ready": {
        if (this.attachReady) {
          throw new RemoteRuntimeError(
            "protocol-error",
            "keeper emitted duplicate attach readiness",
            false
          );
        }
        if (
          control.keeperGeneration !== this.request.keeperGeneration ||
          control.attachmentId !== this.request.attachmentId
        ) {
          throw new RemoteRuntimeError(
            "protocol-error",
            "keeper attach scope does not match its authorization",
            false
          );
        }
        this.attachReady = {
          keeperGeneration: control.keeperGeneration,
          attachmentId: control.attachmentId,
          ...(control.writerLeaseId === undefined
            ? {}
            : { writerLeaseId: control.writerLeaseId }),
          checkpointAvailable: control.checkpointAvailable,
          cols: control.cols,
          rows: control.rows,
          earliestAvailableSequence: parseUint64Decimal(
            control.earliestAvailableSequence
          ),
          replayFromSequence: parseUint64Decimal(control.replayFromSequence),
          liveStartsAfterSequence: parseUint64Decimal(
            control.liveStartsAfterSequence
          ),
          ...(control.truncatedBeforeSequence === undefined
            ? {}
            : {
                truncatedBeforeSequence: parseUint64Decimal(
                  control.truncatedBeforeSequence
                )
              })
        };
        if (
          this.attachReady.replayFromSequence >
            this.attachReady.liveStartsAfterSequence + 1n ||
          this.attachReady.earliestAvailableSequence >
            this.attachReady.liveStartsAfterSequence + 1n
        ) {
          throw new RemoteRuntimeError(
            "protocol-error",
            "keeper attach replay bounds are inconsistent",
            false
          );
        }
        this.nextMutationSequence =
          this.attachReady.truncatedBeforeSequence !== undefined &&
          this.attachReady.replayFromSequence <
            this.attachReady.truncatedBeforeSequence
            ? this.attachReady.truncatedBeforeSequence
            : this.attachReady.replayFromSequence;
        this.readyDeferred.resolve(this.attachReady);
        if (!control.checkpointAvailable) {
          this.checkpointComplete = true;
          this.checkpointDeferred.resolve(null);
        }
        return;
      }
      case "checkpoint.begin": {
        if (!this.attachReady?.checkpointAvailable || this.checkpointState) {
          throw new RemoteRuntimeError(
            "protocol-error",
            "checkpoint begin is unexpected",
            false
          );
        }
        const expectedBytesBig = parseUint64Decimal(control.byteLength);
        const checkpointSequence = parseUint64Decimal(
          control.lastMutationSequence
        );
        const requestedSequence =
          this.request.lastReceivedSequence === undefined
            ? uint64(0n)
            : parseUint64Decimal(this.request.lastReceivedSequence);
        const expectedReplayFrom =
          saturatingIncrementUint64(requestedSequence) >
          saturatingIncrementUint64(checkpointSequence)
            ? saturatingIncrementUint64(requestedSequence)
            : saturatingIncrementUint64(checkpointSequence);
        if (
          checkpointSequence > this.attachReady.liveStartsAfterSequence ||
          expectedReplayFrom !== this.attachReady.replayFromSequence
        ) {
          throw new RemoteRuntimeError(
            "protocol-error",
            "checkpoint sequence does not match the attach replay barrier",
            false
          );
        }
        if (
          expectedBytesBig > BigInt(TERMINAL_DATA_PLANE_MAX_CHECKPOINT_BYTES)
        ) {
          throw new RemoteRuntimeError(
            "checkpoint-limit",
            "remote checkpoint exceeds 16 MiB",
            false
          );
        }
        this.checkpointState = {
          metadata: control,
          expectedBytes: Number(expectedBytesBig),
          receivedBytes: 0,
          chunks: [],
          digest: createHash("sha256")
        };
        return;
      }
      case "checkpoint.end": {
        const checkpoint = this.checkpointState;
        if (
          !checkpoint ||
          checkpoint.metadata.checkpointId !== control.checkpointId ||
          checkpoint.receivedBytes !== checkpoint.expectedBytes
        ) {
          throw new RemoteRuntimeError(
            "protocol-error",
            "checkpoint completion does not match its transfer",
            false
          );
        }
        const digest = checkpoint.digest.digest("hex");
        if (digest !== control.sha256) {
          throw new RemoteRuntimeError(
            "checkpoint-digest",
            "remote checkpoint digest does not match",
            false
          );
        }
        this.checkpointDeferred.resolve({
          metadata: checkpoint.metadata,
          chunks: checkpoint.chunks,
          sha256: digest
        });
        this.checkpointState = undefined;
        this.checkpointComplete = true;
        return;
      }
      case "input.ack": {
        const pending = this.pendingInput;
        const ready = this.attachReady;
        if (
          !pending ||
          !ready?.writerLeaseId ||
          control.writerLeaseId !== ready.writerLeaseId ||
          control.attachmentId !== ready.attachmentId ||
          parseUint64Decimal(control.highestAppliedInputSequence) <
            pending.sequence
        ) {
          throw new RemoteRuntimeError(
            "protocol-error",
            "input acknowledgement does not match its pending request",
            false
          );
        }
        pending.deferred.resolve(control);
        return;
      }
      case "resize.ack": {
        const pending = this.pendingResize;
        const ready = this.attachReady;
        if (
          !pending ||
          !ready?.writerLeaseId ||
          control.writerLeaseId !== ready.writerLeaseId ||
          control.attachmentId !== ready.attachmentId ||
          control.cols !== pending.cols ||
          control.rows !== pending.rows
        ) {
          throw new RemoteRuntimeError(
            "protocol-error",
            "resize acknowledgement does not match its pending request",
            false
          );
        }
        pending.deferred.resolve(control);
        return;
      }
      case "terminal.error": {
        const error = new RemoteRuntimeError(
          control.code,
          control.message,
          control.retryable
        );
        this.pendingInput?.deferred.reject(error);
        this.pendingResize?.deferred.reject(error);
        return;
      }
    }
  }

  private onTerminal(payload: Uint8Array): void {
    if (!this.attachReady) {
      throw new RemoteRuntimeError(
        "protocol-error",
        "terminal mutation arrived before attach readiness",
        false
      );
    }
    if (!this.checkpointComplete) {
      throw new RemoteRuntimeError(
        "protocol-error",
        "terminal mutation arrived before checkpoint completion",
        false
      );
    }
    const message = decodeRemoteTerminalWireMessage(payload);
    if (message.kind === "input" || message.kind === "resize-request") {
      throw new RemoteRuntimeError(
        "protocol-error",
        "keeper sent a client-direction terminal message",
        false
      );
    }
    if (
      this.nextMutationSequence === undefined ||
      message.sequence !== this.nextMutationSequence
    ) {
      throw new RemoteRuntimeError(
        "mutation-gap",
        "remote terminal mutation sequence is not contiguous",
        false
      );
    }
    this.nextMutationSequence = message.sequence + 1n;
    const mutation: RemoteTerminalMutation =
      message.kind === "output"
        ? {
            kind: "output",
            sequence: message.sequence,
            data: message.data
          }
        : message.kind === "resize"
          ? {
              kind: "resize",
              sequence: message.sequence,
              cols: message.cols,
              rows: message.rows
            }
          : {
              kind: "exit",
              sequence: message.sequence,
              ...(message.exitCode === undefined
                ? {}
                : { exitCode: message.exitCode })
            };
    const waiter = this.mutationWaiters.shift();
    if (waiter) waiter.resolve(mutation);
    else {
      const bytes = mutationByteLength(mutation);
      if (
        this.mutations.length >= MAX_PENDING_TERMINAL_MUTATIONS ||
        this.queuedMutationBytes + bytes > MAX_PENDING_TERMINAL_MUTATION_BYTES
      ) {
        throw new RemoteRuntimeError(
          "terminal-backpressure",
          "remote terminal consumer exceeded its 4 MiB queue",
          true
        );
      }
      this.queuedMutationBytes += bytes;
      this.mutations.push(mutation);
    }
  }

  private onCheckpointChunk(payload: Uint8Array): void {
    const checkpoint = this.checkpointState;
    if (!checkpoint || payload.byteLength < 8) {
      throw new RemoteRuntimeError(
        "protocol-error",
        "checkpoint chunk is unexpected or truncated",
        false
      );
    }
    const offset = new DataView(
      payload.buffer,
      payload.byteOffset,
      8
    ).getBigUint64(0, false);
    if (offset !== BigInt(checkpoint.receivedBytes)) {
      throw new RemoteRuntimeError(
        "checkpoint-offset",
        "checkpoint chunk offset is not contiguous",
        false
      );
    }
    const data = payload.slice(8);
    if (
      (data.byteLength === 0 &&
        checkpoint.receivedBytes < checkpoint.expectedBytes) ||
      checkpoint.chunks.length >= REMOTE_CHECKPOINT_HARD_MAX_CHUNKS
    ) {
      throw new RemoteRuntimeError(
        "checkpoint-limit",
        "checkpoint chunk count or size is outside its bound",
        false
      );
    }
    if (checkpoint.receivedBytes + data.byteLength > checkpoint.expectedBytes) {
      throw new RemoteRuntimeError(
        "checkpoint-limit",
        "checkpoint chunks exceed the declared total",
        false
      );
    }
    checkpoint.receivedBytes += data.byteLength;
    checkpoint.digest.update(data);
    checkpoint.chunks.push(data);
  }

  private onClose(error: unknown): void {
    if (!this.open && this.closeError) return;
    this.open = false;
    const closeError =
      error instanceof Error
        ? error
        : new RemoteRuntimeError(
            "attachment-closed",
            "remote terminal attachment closed",
            true
          );
    this.closeError = closeError;
    this.readyDeferred.reject(closeError);
    this.checkpointDeferred.reject(closeError);
    this.pendingInput?.deferred.reject(closeError);
    this.pendingResize?.deferred.reject(closeError);
    this.resolveMutationWaiters();
  }

  private resolveMutationWaiters(): void {
    for (const waiter of this.mutationWaiters.splice(0)) waiter.resolve(null);
  }

  private appendStderr(chunk: Buffer): void {
    const combined = Buffer.concat([this.stderrTail, chunk]);
    this.stderrTail =
      combined.byteLength <= MAX_CHANNEL_STDERR_TAIL_BYTES
        ? combined
        : combined.subarray(
            combined.byteLength - MAX_CHANNEL_STDERR_TAIL_BYTES
          );
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function mutationByteLength(mutation: RemoteTerminalMutation): number {
  return mutation.kind === "output"
    ? (mutation.data?.byteLength ?? 0) + 32
    : 32;
}

function saturatingIncrementUint64(value: Uint64): Uint64 {
  return value === UINT64_MAX ? value : uint64(value + 1n);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new RemoteRuntimeError("timed-out", message, true));
        }, timeoutMs);
        timeout.unref();
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function validateRuntimeOptions(options: LinuxX64RemoteRuntimeOptions): void {
  if (options.assigned.targetId.length === 0) {
    throw new TypeError("assigned remote target is missing");
  }
  if (
    !options.runtimePath.startsWith("/") ||
    options.runtimePath.length > 32 * 1024 ||
    options.runtimePath.includes("\0")
  ) {
    throw new TypeError("remote runtime path must be a bounded absolute path");
  }
  if (!/^[a-f0-9]{64,128}$/u.test(options.token)) {
    throw new TypeError("remote runtime token is invalid");
  }
  if (
    !isAbsolute(options.transferRoot) ||
    options.transferRoot.length > 32 * 1024 ||
    /[\0\r\n]/u.test(options.transferRoot)
  ) {
    throw new TypeError(
      "local SFTP transfer root must be a bounded absolute path"
    );
  }
  if (
    options.sftpPath !== undefined &&
    (!isAbsolute(options.sftpPath) ||
      options.sftpPath.length > 32 * 1024 ||
      /[\0\r\n]/u.test(options.sftpPath))
  ) {
    throw new TypeError("system SFTP path must be a bounded absolute path");
  }
  for (const value of Object.values(options.roots)) {
    if (
      typeof value !== "string" ||
      !value.startsWith("/") ||
      value.length > 32 * 1024 ||
      value.includes("\0")
    ) {
      throw new TypeError(
        "remote runtime roots must be bounded absolute paths"
      );
    }
  }
  const retentionPolicy = resolvedRetentionPolicy(options);
  if (
    !Number.isSafeInteger(retentionPolicy.sessionQuotaMiB) ||
    retentionPolicy.sessionQuotaMiB < 64 ||
    retentionPolicy.sessionQuotaMiB > 4 * 1024 ||
    !Number.isSafeInteger(retentionPolicy.targetQuotaMiB) ||
    retentionPolicy.targetQuotaMiB < 256 ||
    retentionPolicy.targetQuotaMiB > 32 * 1024 ||
    retentionPolicy.targetQuotaMiB < retentionPolicy.sessionQuotaMiB
  ) {
    throw new TypeError("remote retention policy is outside its allowed range");
  }
}

function resolvedRetentionPolicy(
  options: LinuxX64RemoteRuntimeOptions
): RemoteRetentionPolicyDto {
  return (
    options.retentionPolicy ?? {
      sessionQuotaMiB: 256,
      targetQuotaMiB: 2 * 1024
    }
  );
}

function requireAbsoluteRemotePath(value: string, name: string): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.length > 32 * 1024 ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    throw new RemoteRuntimeError(
      "protocol-error",
      `${name} must be a bounded absolute path`,
      false
    );
  }
  return value;
}

function sameResourceKey(
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

export function resolveTerminalProxyCommand(
  proxy: Extract<
    RemoteBridgeResponseBody,
    { type: "attach.authorized" }
  >["terminalProxy"],
  currentRuntimePath: string
): { runtimePath: string; args: string[] } {
  if (proxy.kind === "direct") {
    return {
      runtimePath: requireAbsoluteRemotePath(
        currentRuntimePath,
        "current runtime path"
      ),
      args: ["keeper", "proxy"]
    };
  }
  const runtimePath = requireAbsoluteRemotePath(
    proxy.executablePath,
    "cohort executable path"
  );
  const socketPath = requireAbsoluteRemotePath(
    proxy.socketPath,
    "cohort socket path"
  );
  return {
    runtimePath,
    args: ["bridge", "cohort-proxy", "attach", "--socket-path", socketPath]
  };
}

const DEFAULT_BOOTSTRAP_SHELL_POLICY: BootstrapShellPolicy = Object.freeze({
  accountShellPath: "/bin/sh",
  accountShellKind: "bourne",
  bootstrapShellPath: "/bin/sh"
});

function requireChildPipes(
  child: ChildProcess
): asserts child is ChildProcess & {
  stdin: NonNullable<ChildProcess["stdin"]>;
  stdout: NonNullable<ChildProcess["stdout"]>;
  stderr: NonNullable<ChildProcess["stderr"]>;
} {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new RemoteRuntimeError(
      "channel-launch",
      "remote channel did not expose bounded pipes",
      false
    );
  }
}

async function writeChildStdin(
  child: ChildProcess,
  bytes: Uint8Array
): Promise<void> {
  requireChildPipes(child);
  await new Promise<void>((resolve, reject) => {
    const stdin = child.stdin;
    const onError = (error: Error): void => {
      stdin.off("error", onError);
      reject(error);
    };
    stdin.once("error", onError);
    stdin.write(bytes, (error) => {
      if (error) {
        // Some Node streams invoke the write callback before emitting their
        // matching error event. Keep the one-shot listener installed so that
        // the later event cannot become process-fatal.
        reject(error);
      } else {
        stdin.off("error", onError);
        resolve();
      }
    });
  });
}

async function waitForChildClose(
  child: ChildProcess,
  timeoutMs: number
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (await waitForChildCloseEvent(child, timeoutMs)) return;
  await terminateChildChannel(child);
}

async function terminateChildChannel(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForChildCloseEvent(child, CHANNEL_TERM_TIMEOUT_MS)) return;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  await waitForChildCloseEvent(child, CHANNEL_KILL_WAIT_MS);
}

async function waitForChildCloseEvent(
  child: ChildProcess,
  timeoutMs: number
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let didClose = false;
  let resolveClose: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  const onClose = (): void => {
    didClose = true;
    resolveClose?.();
  };
  child.once("close", onClose);
  let timeout: NodeJS.Timeout | undefined;
  await Promise.race([
    closed,
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs);
      timeout.unref();
    })
  ]);
  if (timeout) clearTimeout(timeout);
  if (!didClose) child.removeListener("close", onClose);
  return didClose;
}

export function createRemoteRuntimeToken(): string {
  return randomBytes(32).toString("hex");
}

export function createRemoteOperationId(): Id {
  return `remote-operation_${randomUUID()}`;
}

export function asUint64(value: bigint): Uint64 {
  return uint64(value);
}
