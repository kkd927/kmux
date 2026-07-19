import { parseUint64Decimal, type Id, type Uint64 } from "@kmux/proto";

import {
  decodeRemoteHostRequest,
  type DecodedRemoteHostRequest,
  type RemoteHostEffectiveSshConfig,
  type RemoteHostResponse,
  type RemoteHostTargetPromoteRequest,
  type RemoteHostTargetVerifyRequest
} from "../shared/remoteHostProtocol";
import {
  LinuxX64RemoteRuntime,
  RemoteRuntimeError,
  type LinuxX64RemoteRuntimeOptions
} from "./linuxX64RemoteRuntime";
import {
  RemoteTerminalDataPlaneAdapter,
  type RemoteTerminalDataPortLike
} from "./remoteTerminalDataPlane";
import {
  SshTransportPool,
  SshTransportPoolError,
  type AssignedSshMaster,
  type SshTargetLostEvent
} from "./sshTransportPool";
import {
  prepareRemoteRuntime,
  RemoteRuntimeBootstrapError,
  type PrepareRemoteRuntimeOptions,
  type PreparedRemoteRuntime
} from "./remoteRuntimeBootstrap";
import {
  assertSystemOpenSshExecutable,
  resolveEffectiveSshConfig
} from "./openSshProcess";

export interface RemoteHostControlTransport {
  postMessage(message: RemoteHostResponse): void;
  onMessage(
    listener: (message: unknown, ports: RemoteTerminalDataPortLike[]) => void
  ): { dispose(): void };
}

interface TargetRuntime {
  runtime: RemoteHostRuntimeLike;
  hello: Awaited<ReturnType<LinuxX64RemoteRuntime["connect"]>>;
  prepared: PreparedRemoteRuntime;
}

interface TargetVerification {
  request: RemoteHostTargetVerifyRequest;
  assigned: AssignedSshMaster;
  prepared: PreparedRemoteRuntime;
  expires: ReturnType<typeof setTimeout>;
}

type RemoteHostRuntimeLike = Pick<
  LinuxX64RemoteRuntime,
  | "connect"
  | "executeOperation"
  | "observe"
  | "inspectGit"
  | "inspectPorts"
  | "scanHistory"
  | "scanUsage"
  | "observeForwards"
  | "reconcileForwards"
  | "closeWorkspaceForwards"
  | "prepareConversion"
  | "promoteConversion"
  | "reclaimProvisionals"
  | "injectTerminal"
  | "captureSurface"
  | "replayEvents"
  | "acknowledgeEvents"
  | "fileExists"
  | "downloadFile"
  | "uploadFile"
  | "releaseFile"
  | "attach"
  | "close"
>;

export interface RemoteHostServiceDependencies {
  pool?: SshTransportPool;
  createRuntime?: (
    options: LinuxX64RemoteRuntimeOptions
  ) => RemoteHostRuntimeLike;
  prepareRuntime?: (
    options: PrepareRemoteRuntimeOptions
  ) => Promise<PreparedRemoteRuntime>;
  resolveSshConfig?: (options: {
    sshPath: string;
    configPath: string;
    host: string;
  }) => Promise<RemoteHostEffectiveSshConfig>;
  maximumConnectedTargets?: number;
}

interface BoundAttachment {
  targetId: Id;
  adapter: RemoteTerminalDataPlaneAdapter;
  cursorKey: string;
}

interface PendingCursor {
  response: Extract<RemoteHostResponse, { type: "terminal.cursor" }>;
  timer: ReturnType<typeof setTimeout>;
}

const CURSOR_COALESCE_MS = 2_000;
const MAX_REMOTE_ATTACHMENTS = 1_024;
const MAX_TARGET_VERIFICATIONS = 64;
const MAX_CONNECTED_TARGETS = 256;
const TARGET_VERIFICATION_TTL_MS = 5 * 60_000;

export class RemoteHostService {
  private readonly targets = new Map<Id, TargetRuntime>();
  private readonly verifications = new Map<Id, TargetVerification>();
  private readonly pendingVerificationIds = new Set<Id>();
  private readonly pendingTargetIds = new Set<Id>();
  private readonly attachments = new Map<Id, BoundAttachment>();
  private readonly pendingCursors = new Map<string, PendingCursor>();
  private readonly targetQueues = new Map<Id, Promise<unknown>>();
  private subscription: { dispose(): void } | null = null;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private readonly pool: SshTransportPool;
  private readonly targetLossSubscription: { dispose(): void };
  private readonly createRuntime: (
    options: LinuxX64RemoteRuntimeOptions
  ) => RemoteHostRuntimeLike;
  private readonly prepareRuntime: (
    options: PrepareRemoteRuntimeOptions
  ) => Promise<PreparedRemoteRuntime>;
  private readonly resolveSshConfig: NonNullable<
    RemoteHostServiceDependencies["resolveSshConfig"]
  >;
  private readonly maximumConnectedTargets: number;

  constructor(
    private readonly transport: RemoteHostControlTransport,
    dependencies: RemoteHostServiceDependencies = {}
  ) {
    this.pool = dependencies.pool ?? new SshTransportPool();
    this.targetLossSubscription = this.pool.onTargetLost((event) =>
      this.targetTransportLost(event)
    );
    this.createRuntime =
      dependencies.createRuntime ??
      ((options) => new LinuxX64RemoteRuntime(options));
    this.prepareRuntime = dependencies.prepareRuntime ?? prepareRemoteRuntime;
    this.resolveSshConfig =
      dependencies.resolveSshConfig ?? resolveEffectiveSshConfig;
    this.maximumConnectedTargets =
      dependencies.maximumConnectedTargets ?? MAX_CONNECTED_TARGETS;
    if (
      !Number.isSafeInteger(this.maximumConnectedTargets) ||
      this.maximumConnectedTargets < 1 ||
      this.maximumConnectedTargets > MAX_CONNECTED_TARGETS
    ) {
      throw new TypeError(
        `maximumConnectedTargets must be within 1..${MAX_CONNECTED_TARGETS}`
      );
    }
  }

  start(): void {
    if (this.subscription) return;
    this.subscription = this.transport.onMessage((message, ports) => {
      this.receive(message, ports);
    });
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeAll();
    return this.closePromise;
  }

  private async closeAll(): Promise<void> {
    this.closing = true;
    this.targetLossSubscription.dispose();
    this.subscription?.dispose();
    this.subscription = null;
    // A target request may already have crossed the receive boundary. Let all
    // accepted, bounded target queues settle before tearing down runtimes and
    // the shared pool, otherwise a late connect can repopulate `targets` after
    // shutdown has cleared it.
    await Promise.allSettled([...this.targetQueues.values()]);
    await Promise.allSettled(
      [...this.attachments.values()].map((entry) => entry.adapter.dispose())
    );
    this.attachments.clear();
    this.flushAllCursors();
    await Promise.allSettled(
      [...this.targets.values()].map((entry) => entry.runtime.close())
    );
    this.targets.clear();
    for (const verification of this.verifications.values()) {
      clearTimeout(verification.expires);
    }
    this.verifications.clear();
    await this.pool.close();
  }

  private receive(
    rawMessage: unknown,
    ports: RemoteTerminalDataPortLike[]
  ): void {
    let request: DecodedRemoteHostRequest;
    try {
      request = decodeRemoteHostRequest(rawMessage);
    } catch (error) {
      closePorts(ports);
      this.reportMalformedRequest(rawMessage, error);
      return;
    }
    if (this.closing && request.type !== "shutdown") {
      closePorts(ports);
      this.respondError(
        request,
        "remote-host-closed",
        "remote-host is closing",
        true
      );
      return;
    }
    if (request.type === "terminal.bind") {
      this.bindTerminal(request, ports);
      return;
    }
    closePorts(ports);
    const execution =
      request.type === "shutdown"
        ? this.executeRequest(request)
        : isFileRequest(request)
          ? this.executeRequest(request)
          : this.enqueueTarget(requestQueueKey(request), () =>
              this.executeRequest(request)
            );
    void execution.catch((error: unknown) =>
      this.handleRequestFailure(request, error)
    );
  }

  private async executeRequest(
    request: Exclude<DecodedRemoteHostRequest, { type: "terminal.bind" }>
  ): Promise<void> {
    switch (request.type) {
      case "ssh-config.resolve": {
        await assertSystemOpenSshExecutable(request.sshPath);
        const effective = await this.resolveSshConfig({
          sshPath: request.sshPath,
          configPath: request.configPath,
          host: request.host
        });
        this.respondOk(request.requestId, {
          type: "ssh-config.resolved",
          sshPath: request.sshPath,
          configPath: request.configPath,
          host: request.host,
          effective: structuredClone(effective)
        });
        return;
      }
      case "target.verify": {
        const verified = await this.verifyTarget(request);
        this.respondOk(request.requestId, {
          type: "target.verified",
          verificationId: request.verificationId,
          effectiveConnectionPolicyHash: request.effectiveConnectionPolicyHash,
          generation: verified.prepared.generation,
          runtimePath: verified.prepared.runtimePath,
          remoteHome: verified.prepared.remoteHome,
          roots: structuredClone(verified.prepared.roots),
          doctor: structuredClone(verified.prepared.doctor)
        });
        return;
      }
      case "target.promote": {
        const hello = await this.promoteVerifiedTarget(request);
        this.respondOk(request.requestId, {
          type: "target.ready",
          targetId: request.targetId,
          hello
        });
        return;
      }
      case "target.verification-discard": {
        await this.discardVerification(request.verificationId);
        this.respondOk(request.requestId, {
          type: "target.verification-discarded",
          verificationId: request.verificationId
        });
        return;
      }
      case "operation.execute": {
        const target = this.requireTarget(request.targetId);
        if (request.intent.resourceKey.targetId !== request.targetId) {
          throw new TypeError(
            "operation target is outside its remote-host scope"
          );
        }
        const outcome = await target.runtime.executeOperation(
          request.intent,
          request.payload
        );
        this.respondOk(request.requestId, {
          type: "operation.result",
          targetId: request.targetId,
          outcome
        });
        return;
      }
      case "target.observe": {
        const target = this.requireTarget(request.targetId);
        const observed = await target.runtime.observe({
          desktopInstallationId: request.desktopInstallationId,
          targetId: request.targetId
        });
        this.respondOk(request.requestId, {
          type: "target.observed",
          targetId: request.targetId,
          observed
        });
        return;
      }
      case "git.inspect": {
        const target = this.requireTarget(request.targetId);
        const inspection = await target.runtime.inspectGit({
          desktopInstallationId: request.desktopInstallationId,
          targetId: request.targetId,
          cwd: request.cwd,
          dirtyLimit: request.dirtyLimit,
          ...(request.branch === undefined ? {} : { branch: request.branch })
        });
        this.respondOk(request.requestId, {
          type: "git.inspected",
          targetId: request.targetId,
          inspection
        });
        return;
      }
      case "ports.inspect": {
        const target = this.requireTarget(request.targetId);
        const inspection = await target.runtime.inspectPorts({
          resourceKey: request.resourceKey
        });
        this.respondOk(request.requestId, {
          type: "ports.inspected",
          targetId: request.targetId,
          inspection
        });
        return;
      }
      case "history.scan": {
        const target = this.requireTarget(request.targetId);
        const scan = await target.runtime.scanHistory({
          desktopInstallationId: request.desktopInstallationId,
          targetId: request.targetId,
          maxRecords: request.maxRecords
        });
        this.respondOk(request.requestId, {
          type: "history.scanned",
          targetId: request.targetId,
          scan
        });
        return;
      }
      case "usage.scan": {
        const target = this.requireTarget(request.targetId);
        const scan = await target.runtime.scanUsage({
          desktopInstallationId: request.desktopInstallationId,
          targetId: request.targetId,
          startAtUnixMs: request.startAtUnixMs,
          maxRecords: request.maxRecords
        });
        this.respondOk(request.requestId, {
          type: "usage.scanned",
          targetId: request.targetId,
          scan
        });
        return;
      }
      case "forwards.observe": {
        const target = this.requireTarget(request.targetId);
        const observed = await target.runtime.observeForwards({
          desktopInstallationId: request.desktopInstallationId,
          targetId: request.targetId
        });
        this.respondOk(request.requestId, {
          type: "forwards.observed",
          targetId: request.targetId,
          observed
        });
        return;
      }
      case "forward.reconcile": {
        const target = this.requireTarget(request.targetId);
        const mappings = await target.runtime.reconcileForwards({
          desktopInstallationId: request.desktopInstallationId,
          targetId: request.targetId
        });
        this.respondOk(request.requestId, {
          type: "forward.reconciled",
          targetId: request.targetId,
          mappings
        });
        return;
      }
      case "forward.close-workspace": {
        const target = this.requireTarget(request.targetId);
        await target.runtime.closeWorkspaceForwards(request.workspaceId);
        this.respondOk(request.requestId, {
          type: "forward.workspace-closed",
          targetId: request.targetId,
          workspaceId: request.workspaceId
        });
        return;
      }
      case "conversion.prepare": {
        const target = this.requireTarget(request.targetId);
        if (
          request.conversion.workspaceResourceKey.targetId !== request.targetId
        ) {
          throw new TypeError(
            "conversion target is outside its remote-host scope"
          );
        }
        const prepared = await target.runtime.prepareConversion(
          request.conversion
        );
        this.respondOk(request.requestId, {
          type: "conversion.prepared",
          targetId: request.targetId,
          prepared
        });
        return;
      }
      case "conversion.promote": {
        const target = this.requireTarget(request.targetId);
        if (
          request.conversion.workspaceResourceKey.targetId !== request.targetId
        ) {
          throw new TypeError(
            "conversion target is outside its remote-host scope"
          );
        }
        const promoted = await target.runtime.promoteConversion(
          request.conversion
        );
        this.respondOk(request.requestId, {
          type: "conversion.promoted",
          targetId: request.targetId,
          promoted
        });
        return;
      }
      case "provisional.reclaim": {
        const target = this.requireTarget(request.targetId);
        if (request.reclaim.targetId !== request.targetId) {
          throw new TypeError(
            "reclaim target is outside its remote-host scope"
          );
        }
        const reclaimed = await target.runtime.reclaimProvisionals(
          request.reclaim
        );
        this.respondOk(request.requestId, {
          type: "provisional.reclaimed",
          targetId: request.targetId,
          reclaimed
        });
        return;
      }
      case "terminal.inject": {
        const target = this.requireTarget(request.targetId);
        if (request.injection.resourceKey.targetId !== request.targetId) {
          throw new TypeError(
            "terminal injection target is outside its remote-host scope"
          );
        }
        const acknowledgement = await target.runtime.injectTerminal(
          request.injection
        );
        this.respondOk(request.requestId, {
          type: "terminal.input-ack",
          targetId: request.targetId,
          acknowledgement
        });
        return;
      }
      case "surface.capture": {
        const target = this.requireTarget(request.targetId);
        if (request.capture.resourceKey.targetId !== request.targetId) {
          throw new TypeError(
            "surface capture target is outside its remote-host scope"
          );
        }
        const capture = await target.runtime.captureSurface(request.capture);
        this.respondOk(request.requestId, {
          type: "surface.captured",
          targetId: request.targetId,
          capture
        });
        return;
      }
      case "events.replay": {
        const target = this.requireTarget(request.targetId);
        const replay = await target.runtime.replayEvents({
          desktopInstallationId: request.desktopInstallationId,
          targetId: request.targetId,
          afterSequence: parseUint64Decimal(request.afterSequence)
        });
        this.respondOk(request.requestId, {
          type: "events.replayed",
          targetId: request.targetId,
          replay
        });
        return;
      }
      case "events.ack": {
        const target = this.requireTarget(request.targetId);
        const acknowledgedThrough = await target.runtime.acknowledgeEvents({
          desktopInstallationId: request.desktopInstallationId,
          targetId: request.targetId,
          throughSequence: parseUint64Decimal(request.throughSequence)
        });
        this.respondOk(request.requestId, {
          type: "events.acknowledged",
          targetId: request.targetId,
          acknowledgedThrough
        });
        return;
      }
      case "file.exists": {
        const target = this.requireTarget(request.targetId);
        const exists = await target.runtime.fileExists(request.remotePath);
        this.respondOk(request.requestId, {
          type: "file.exists-result",
          targetId: request.targetId,
          remotePath: request.remotePath,
          exists
        });
        return;
      }
      case "file.download": {
        const target = this.requireTarget(request.targetId);
        const transfer = await target.runtime.downloadFile({
          transferId: request.transferId,
          remotePath: request.remotePath,
          maxBytes: request.maxBytes
        });
        this.respondOk(request.requestId, {
          type: "file.downloaded",
          targetId: request.targetId,
          transfer
        });
        return;
      }
      case "file.upload": {
        const target = this.requireTarget(request.targetId);
        const transfer = await target.runtime.uploadFile({
          transferId: request.transferId,
          localPath: request.localPath,
          remotePath: request.remotePath,
          maxBytes: request.maxBytes,
          sha256: request.sha256
        });
        this.respondOk(request.requestId, {
          type: "file.uploaded",
          targetId: request.targetId,
          transfer
        });
        return;
      }
      case "file.release": {
        const target = this.requireTarget(request.targetId);
        await target.runtime.releaseFile(request.localPath);
        this.respondOk(request.requestId, {
          type: "file.released",
          targetId: request.targetId,
          localPath: request.localPath
        });
        return;
      }
      case "target.disconnect":
        await this.disconnectTarget(request.targetId);
        this.respondOk(request.requestId, {
          type: "target.disconnected",
          targetId: request.targetId
        });
        return;
      case "target.runtime-clean": {
        const report = await this.requireTarget(
          request.targetId
        ).prepared.runGenerationGc();
        this.respondOk(request.requestId, {
          type: "target.runtime-cleaned",
          targetId: request.targetId,
          report
        });
        return;
      }
      case "target.runtime-reset": {
        const report = await this.resetTargetRuntime(request.targetId);
        this.respondOk(request.requestId, {
          type: "target.runtime-reset",
          targetId: request.targetId,
          report
        });
        return;
      }
      case "shutdown":
        await this.close();
        this.respondOk(request.requestId, { type: "shutdown.complete" });
        return;
    }
  }

  private async verifyTarget(
    request: RemoteHostTargetVerifyRequest
  ): Promise<TargetVerification> {
    if (
      this.verifications.has(request.verificationId) ||
      this.pendingVerificationIds.has(request.verificationId) ||
      this.verifications.size + this.pendingVerificationIds.size >=
        MAX_TARGET_VERIFICATIONS
    ) {
      throw new RemoteRuntimeError(
        "verification-limit",
        "remote target verification is duplicate or over its bounded limit",
        false
      );
    }
    this.pendingVerificationIds.add(request.verificationId);
    try {
      await this.pool.connectProvisional({
        connectionAttemptId: request.connectionAttemptId,
        effectiveConnectionPolicyHash: request.effectiveConnectionPolicyHash,
        sshPath: request.sshPath,
        configPath: request.configPath,
        host: request.host,
        ...(request.controlRoot === undefined
          ? {}
          : { controlRoot: request.controlRoot }),
        ...(request.askpassPath === undefined
          ? {}
          : { askpassPath: request.askpassPath })
      });
      const assigned = await this.pool.beginAuthorityVerification({
        connectionAttemptId: request.connectionAttemptId,
        verificationId: request.verificationId,
        effectiveConnectionPolicyHash: request.effectiveConnectionPolicyHash
      });
      try {
        const prepared = await this.prepareRuntime({
          pool: this.pool,
          assigned,
          artifactRoot: request.runtimeArtifactRoot,
          transferRoot: request.transferRoot,
          rootOverrides: structuredClone(request.rootOverrides),
          ...(request.sftpPath === undefined
            ? {}
            : { sftpPath: request.sftpPath }),
          ...(request.bootstrapShellOverride === undefined
            ? {}
            : { bootstrapShellOverride: request.bootstrapShellOverride })
        });
        const expires = setTimeout(() => {
          void this.discardVerification(request.verificationId).catch(
            () => undefined
          );
        }, TARGET_VERIFICATION_TTL_MS);
        expires.unref();
        const verification = {
          request: structuredClone(request),
          assigned,
          prepared,
          expires
        } satisfies TargetVerification;
        this.verifications.set(request.verificationId, verification);
        return verification;
      } catch (error) {
        await this.pool
          .discardAuthorityVerification(request.verificationId)
          .catch(() => undefined);
        throw error;
      }
    } finally {
      this.pendingVerificationIds.delete(request.verificationId);
    }
  }

  private async promoteVerifiedTarget(
    request: RemoteHostTargetPromoteRequest
  ): Promise<TargetRuntime["hello"]> {
    const verification = this.verifications.get(request.verificationId);
    if (!verification) {
      throw new RemoteRuntimeError(
        "verification-missing",
        "remote target verification expired or was already consumed",
        false
      );
    }
    if (
      verification.request.effectiveConnectionPolicyHash !==
      request.effectiveConnectionPolicyHash
    ) {
      throw new RemoteRuntimeError(
        "target-policy-mismatch",
        "remote target policy changed after authority verification",
        false
      );
    }
    const reservesNewTarget = !this.targets.has(request.targetId);
    if (
      reservesNewTarget &&
      this.targets.size + this.pendingTargetIds.size >=
        this.maximumConnectedTargets
    ) {
      throw new RemoteRuntimeError(
        "target-limit",
        "remote-host connected target limit is full",
        false
      );
    }
    if (reservesNewTarget) this.pendingTargetIds.add(request.targetId);
    try {
      return await this.promoteVerifiedTargetWithinReservation(
        request,
        verification
      );
    } finally {
      if (reservesNewTarget) this.pendingTargetIds.delete(request.targetId);
    }
  }

  private async promoteVerifiedTargetWithinReservation(
    request: RemoteHostTargetPromoteRequest,
    verification: TargetVerification
  ): Promise<TargetRuntime["hello"]> {
    await verification.prepared.rotateBridgeToken({
      desktopInstallationId: request.desktopInstallationId,
      targetId: request.targetId,
      token: request.token
    });
    clearTimeout(verification.expires);
    this.verifications.delete(request.verificationId);
    let assigned: AssignedSshMaster;
    try {
      assigned = await this.pool.promoteAuthorityVerification({
        verificationId: request.verificationId,
        targetId: request.targetId,
        effectiveConnectionPolicyHash: request.effectiveConnectionPolicyHash
      });
    } catch (error) {
      await this.pool
        .discardAuthorityVerification(request.verificationId)
        .catch(() => undefined);
      throw error;
    }

    const existing = this.targets.get(request.targetId);
    if (
      existing &&
      assigned.generation !==
        this.pool.getAssigned(request.targetId)?.generation
    ) {
      throw new RemoteRuntimeError(
        "target-policy-mismatch",
        "remote target promotion did not converge on its assigned master",
        false
      );
    }
    if (!existing && assigned.generation !== verification.assigned.generation) {
      throw new RemoteRuntimeError(
        "target-promotion-race",
        "another authority-equivalent target promotion is still initializing",
        true
      );
    }

    let runtime: RemoteHostRuntimeLike | undefined;
    try {
      runtime = this.createRuntime({
        pool: this.pool,
        assigned,
        runtimePath: verification.prepared.runtimePath,
        roots: structuredClone(verification.prepared.roots),
        retentionPolicy: structuredClone(request.retentionPolicy),
        token: request.token,
        transferRoot: verification.request.transferRoot,
        bootstrapShellPolicy: verification.prepared.shellPolicy,
        ...(verification.request.sftpPath === undefined
          ? {}
          : { sftpPath: verification.request.sftpPath })
      });
      const hello = await runtime.connect();
      this.targets.set(request.targetId, {
        runtime,
        hello,
        prepared: verification.prepared
      });
      await existing?.runtime.close().catch(() => undefined);
      void verification.prepared.runGenerationGc().catch(() => undefined);
      return hello;
    } catch (error) {
      await runtime?.close().catch(() => undefined);
      if (existing) {
        this.targets.delete(request.targetId);
        await existing.runtime.close().catch(() => undefined);
      }
      await this.pool.disconnectTarget(request.targetId).catch(() => undefined);
      throw error;
    }
  }

  private async discardVerification(verificationId: Id): Promise<void> {
    const verification = this.verifications.get(verificationId);
    if (verification) {
      clearTimeout(verification.expires);
      this.verifications.delete(verificationId);
    }
    await this.pool.discardAuthorityVerification(verificationId);
  }

  private bindTerminal(
    request: Extract<DecodedRemoteHostRequest, { type: "terminal.bind" }>,
    ports: RemoteTerminalDataPortLike[]
  ): void {
    const port = ports[0];
    if (ports.length !== 1 || !port) {
      closePorts(ports);
      this.bindFailed(
        request.targetId,
        request.attachId,
        "invalid-port",
        "terminal bind requires exactly one transferred MessagePort"
      );
      return;
    }
    if (this.attachments.size >= MAX_REMOTE_ATTACHMENTS) {
      port.close();
      this.bindFailed(
        request.targetId,
        request.attachId,
        "attachment-limit",
        "remote terminal attachment limit is full"
      );
      return;
    }
    const target = this.targets.get(request.targetId);
    if (
      !target ||
      request.resourceKey.targetId !== request.targetId ||
      request.resourceKey.sessionId !== request.session.sessionId ||
      request.expectedKeeperGeneration !== request.session.epoch ||
      this.attachments.has(request.attachId)
    ) {
      port.close();
      this.bindFailed(
        request.targetId,
        request.attachId,
        "stale-capability",
        "terminal bind capability is stale or outside its target scope"
      );
      return;
    }

    const cursorKey = serializeCursorKey(
      request.targetId,
      request.resourceKey.sessionId,
      request.expectedKeeperGeneration
    );
    let adapter: RemoteTerminalDataPlaneAdapter;
    try {
      adapter = new RemoteTerminalDataPlaneAdapter({
        runtime: target.runtime,
        resourceKey: structuredClone(request.resourceKey),
        expectedKeeperGeneration: request.expectedKeeperGeneration,
        attachId: request.attachId,
        session: structuredClone(request.session),
        port,
        onCursorAdvanced: (sequence) =>
          this.recordCursor(request, cursorKey, sequence),
        onClosed: () => {
          // `port.start()` may synchronously expose an already-closed port from
          // inside the adapter constructor. Defer cleanup until after the map
          // entry below has been installed.
          queueMicrotask(() =>
            this.attachmentClosed(request.attachId, cursorKey)
          );
        },
        onRuntimeLost: () => {
          void this.pool
            .reconcileTargetAfterChannelFailure(request.targetId)
            .catch(() => undefined);
        }
      });
    } catch (error) {
      port.close();
      this.bindFailed(
        request.targetId,
        request.attachId,
        "bind-failed",
        error instanceof Error ? error.message : String(error)
      );
      return;
    }
    this.attachments.set(request.attachId, {
      targetId: request.targetId,
      adapter,
      cursorKey
    });
  }

  private recordCursor(
    request: Extract<DecodedRemoteHostRequest, { type: "terminal.bind" }>,
    cursorKey: string,
    sequence: Uint64
  ): void {
    const existing = this.pendingCursors.get(cursorKey);
    if (existing) {
      existing.response.sequence = sequence;
      return;
    }
    const response: Extract<RemoteHostResponse, { type: "terminal.cursor" }> = {
      type: "terminal.cursor",
      targetId: request.targetId,
      resourceKey: structuredClone(request.resourceKey),
      keeperGeneration: request.expectedKeeperGeneration,
      sequence
    };
    const timer = setTimeout(
      () => this.flushCursor(cursorKey),
      CURSOR_COALESCE_MS
    );
    timer.unref();
    this.pendingCursors.set(cursorKey, { response, timer });
  }

  private attachmentClosed(attachId: Id, cursorKey: string): void {
    this.attachments.delete(attachId);
    this.flushCursor(cursorKey);
  }

  private flushCursor(cursorKey: string): void {
    const cursor = this.pendingCursors.get(cursorKey);
    if (!cursor) return;
    clearTimeout(cursor.timer);
    this.pendingCursors.delete(cursorKey);
    this.transport.postMessage(cursor.response);
  }

  private flushAllCursors(): void {
    for (const key of [...this.pendingCursors.keys()]) this.flushCursor(key);
  }

  private async disconnectTarget(targetId: Id): Promise<void> {
    await this.disposeTargetAttachments(targetId);
    const target = this.targets.get(targetId);
    this.targets.delete(targetId);
    const cleanup = await Promise.allSettled([
      target?.runtime.close(),
      this.pool.disconnectTarget(targetId)
    ]);
    const failure = cleanup.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (failure) throw failure.reason;
  }

  private async resetTargetRuntime(targetId: Id) {
    const target = this.requireTarget(targetId);
    await this.disposeTargetAttachments(targetId);
    this.targets.delete(targetId);
    try {
      await target.runtime.close();
    } catch (error) {
      await this.pool.disconnectTarget(targetId).catch(() => undefined);
      throw error;
    }
    try {
      return await target.prepared.resetCurrentGeneration();
    } finally {
      await this.pool.disconnectTarget(targetId).catch(() => undefined);
    }
  }

  private async disposeTargetAttachments(targetId: Id): Promise<void> {
    const attachments = [...this.attachments.entries()].filter(
      ([, entry]) => entry.targetId === targetId
    );
    await Promise.allSettled(
      attachments.map(async ([attachId, entry]) => {
        this.attachments.delete(attachId);
        await entry.adapter.dispose();
        this.flushCursor(entry.cursorKey);
      })
    );
  }

  private targetTransportLost(event: SshTargetLostEvent): void {
    if (this.closing) return;
    void this.enqueueTarget(event.targetId, async () => {
      if (this.closing || !this.targets.has(event.targetId)) return;
      await this.disconnectTarget(event.targetId).catch(() => undefined);
      this.transport.postMessage({ type: "target.lost", ...event });
    }).catch(() => undefined);
  }

  private async handleRequestFailure(
    request: Exclude<DecodedRemoteHostRequest, { type: "terminal.bind" }>,
    error: unknown
  ): Promise<void> {
    if (
      request.type === "operation.execute" ||
      request.type === "target.observe" ||
      request.type === "git.inspect" ||
      request.type === "ports.inspect" ||
      request.type === "history.scan" ||
      request.type === "usage.scan" ||
      request.type === "forwards.observe" ||
      request.type === "forward.reconcile" ||
      request.type === "terminal.inject" ||
      request.type === "surface.capture" ||
      request.type === "events.replay" ||
      request.type === "events.ack"
    ) {
      await this.pool
        .reconcileTargetAfterChannelFailure(request.targetId)
        .catch(() => undefined);
    }
    this.respondFailure(request, error);
  }

  private requireTarget(targetId: Id): TargetRuntime {
    const target = this.targets.get(targetId);
    if (!target) throw new Error("remote target is not connected");
    return target;
  }

  private enqueueTarget<T>(targetId: Id, task: () => Promise<T>): Promise<T> {
    const previous = this.targetQueues.get(targetId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    this.targetQueues.set(targetId, current);
    void current
      .finally(() => {
        if (this.targetQueues.get(targetId) === current) {
          this.targetQueues.delete(targetId);
        }
      })
      .catch(() => undefined);
    return current;
  }

  private respondOk(requestId: Id, body: unknown): void {
    this.transport.postMessage({
      type: "response",
      requestId,
      status: "ok",
      body
    });
  }

  private respondFailure(
    request: Exclude<DecodedRemoteHostRequest, { type: "terminal.bind" }>,
    error: unknown
  ): void {
    const remoteError = error instanceof RemoteRuntimeError ? error : null;
    const bootstrapError =
      error instanceof RemoteRuntimeBootstrapError ? error : null;
    const transportError =
      error instanceof SshTransportPoolError ? error : null;
    this.transport.postMessage({
      type: "response",
      requestId: request.requestId,
      status: "error",
      error: {
        code:
          remoteError?.code ??
          bootstrapError?.code ??
          transportError?.code ??
          "remote-host-error",
        message: error instanceof Error ? error.message : String(error),
        retryable:
          remoteError?.retryable ??
          (transportError?.code === "master-closed" ||
            transportError?.code === "master-start-failed")
      }
    });
  }

  private respondError(
    request: DecodedRemoteHostRequest,
    code: string,
    message: string,
    retryable: boolean
  ): void {
    if (!("requestId" in request)) {
      this.bindFailed(request.targetId, request.attachId, code, message);
      return;
    }
    this.transport.postMessage({
      type: "response",
      requestId: request.requestId,
      status: "error",
      error: { code, message, retryable }
    });
  }

  private bindFailed(
    targetId: Id,
    attachId: Id,
    code: string,
    message: string
  ): void {
    this.transport.postMessage({
      type: "terminal.bind-failed",
      targetId,
      attachId,
      code,
      message
    });
  }

  private reportMalformedRequest(rawMessage: unknown, error: unknown): void {
    const record = asRecord(rawMessage);
    const requestId =
      typeof record?.requestId === "string" ? record.requestId : null;
    if (!requestId) return;
    this.transport.postMessage({
      type: "response",
      requestId,
      status: "error",
      error: {
        code: "invalid-request",
        message: error instanceof Error ? error.message : String(error),
        retryable: false
      }
    });
  }
}

function requestQueueKey(
  request: Exclude<
    DecodedRemoteHostRequest,
    { type: "terminal.bind" | "shutdown" }
  >
): Id {
  if (request.type === "ssh-config.resolve") {
    // OpenSSH config evaluation is low-frequency and deliberately serialized
    // away from target/data-plane queues.
    return "ssh-config-resolution";
  }
  if (
    request.type === "target.verify" ||
    request.type === "target.verification-discard"
  ) {
    return `verification:${request.verificationId}`;
  }
  return request.targetId;
}

function isFileRequest(
  request: DecodedRemoteHostRequest
): request is Extract<
  DecodedRemoteHostRequest,
  { type: "file.exists" | "file.download" | "file.upload" | "file.release" }
> {
  return (
    request.type === "file.exists" ||
    request.type === "file.download" ||
    request.type === "file.upload" ||
    request.type === "file.release"
  );
}

function serializeCursorKey(
  targetId: Id,
  sessionId: Id,
  keeperGeneration: Id
): string {
  return JSON.stringify([targetId, sessionId, keeperGeneration]);
}

function closePorts(ports: RemoteTerminalDataPortLike[]): void {
  for (const port of ports) {
    try {
      port.close();
    } catch {
      // Invalid transferred capabilities are always fenced and discarded.
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
