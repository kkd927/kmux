import { createHash, randomBytes } from "node:crypto";

import {
  decodeRemoteBridgeResponseEnvelope,
  encodeRemoteControlJson,
  formatUint64Decimal,
  incrementUint64,
  makeId,
  normalizeAgentHookInvocation,
  normalizeHookNotificationInvocation,
  parseUint64Decimal,
  REMOTE_PROTOCOL_VERSION,
  uint64,
  type Id,
  type RemoteBridgeResponseBody,
  type RemoteInitialInputOutcome,
  type RemotePersistenceLevel,
  type RemoteSpoolEventDto,
  type RetainedRemoteSessionsSnapshot,
  type TerminalKeyInput,
  type UsageVendor
} from "@kmux/proto";
import {
  canonicalizeRemoteOperationPayload,
  cloneState,
  defaultNewSurfaceCwd,
  encodeLocatedPathDto,
  terminalSessionForSurface,
  validateRemoteTargetBinding,
  type AppAction,
  type AppState,
  type RemoteOperationAdmissionCommand,
  type RemoteOperationCommandResult,
  type RemoteOperationIntent,
  type RemoteOperationPayloadDto,
  type RemoteOperationProjection,
  type RemoteEventProductAction,
  type RemoteResourceKey,
  type RemoteTargetBinding
} from "@kmux/core";
import {
  applyMainRemoteOperationCheckpointFact,
  MainFactConflictError,
  type MainFact
} from "@kmux/core/main";

import { RemoteHostManagerError } from "../remoteHost";
import type {
  RemoteRuntimeOperationOutcome,
  RemoteSurfaceCaptureResult,
  RemoteTerminalInputAcknowledgement
} from "../../remote-host/linuxX64RemoteRuntime";
import { encodeTerminalKeyInput } from "../../pty-host/terminalInput";
import type {
  RemoteHostManager,
  RemoteHostCursorEvent,
  RemoteHostTargetLostEvent,
  RemoteHostTargetConnectOptions,
  RemoteHostTargetPromoteOptions,
  RemoteHostTargetVerification
} from "../remoteHost";
import type { DurableRemoteOperationStore } from "./durableRemoteOperationStore";
import type { DurableRemoteOperationRecord } from "./durableRemoteOperationStore";
import { logDiagnostics } from "../../shared/diagnostics";
import { classifyAgentTerminalNotification } from "../agentTerminalNotificationPolicy";
import type {
  ConversionCleanupAcknowledgement,
  ConversionLocalCleanupTarget,
  ConversionWalRecord,
  ConversionWalStore
} from "./conversionWal";
import type {
  RetainedSessionInventoryEntry,
  RetainedSessionInventoryStore
} from "./retainedSessionInventory";
import type { RemoteEventReceiptStore } from "./remoteEventReceiptStore";
import { RemoteEventCheckpointConflictError } from "./remoteEventCheckpointRecovery";
import { createBoundRemoteTerminalControlProvider } from "./remoteTerminalControlProvider";
import { createRemoteHostSshWorkspaceTransactionGateway } from "./remoteConversionGateway";
import {
  createRemoteOperationCoordinator,
  type RemoteOperationExecutionOutcome,
  type RemoteOperationProductMetadata
} from "./remoteOperationCoordinator";
import {
  createRemoteReconciler,
  type RemoteObservedState
} from "./remoteReconciler";
import {
  createTransactionalSshWorkspaceRuntime,
  decodeStartSshWorkspaceTransactionRequest,
  type StartSshWorkspaceTransactionRequest
} from "./transactionalWorkspaceConversion";

export interface CreateRemoteLifecycleRuntimeOptions {
  desktopInstallationId: Id;
  operationStore: DurableRemoteOperationStore;
  host: RemoteHostManager;
  getState: () => AppState;
  getTargetBinding: (targetId: Id) => RemoteTargetBinding | undefined;
  replaceTargetBinding: (binding: RemoteTargetBinding) => void;
  dispatchFact: (fact: MainFact) => void;
  dispatchAppAction?: (action: AppAction) => void;
  getSurfaceVendor?: (surfaceId: Id) => UsageVendor;
  isSurfaceVisibleToUser?: (surfaceId: Id) => boolean;
  eventReceiptStore?: RemoteEventReceiptStore;
  reportError?: (error: Error) => void;
  reconnectTarget?: (targetId: Id) => Promise<unknown>;
  ensureRetainedTargetConnected?: (targetId: Id) => Promise<unknown>;
  onTargetConnected?: (targetId: Id) => void;
  retainedInventory?: RetainedSessionInventoryStore;
  closeWorkspaceProduct?: (workspaceId: Id) => void;
  persistDurableProductSnapshot?: (state: AppState) => void;
  sshWorkspaceTransactions?: {
    wal: ConversionWalStore;
    getLocalRuntimeEpoch: (surfaceId: Id, sessionId: Id) => Id | null;
    forceDesktopSnapshot: (
      state: AppState,
      expectedSnapshotHash: string
    ) => Promise<string> | string;
    installDesktopState: (state: AppState) => void;
    terminateLocalSession: (
      target: ConversionLocalCleanupTarget
    ) => Promise<ConversionCleanupAcknowledgement>;
  };
  /** @deprecated Use sshWorkspaceTransactions. */
  conversion?: CreateRemoteLifecycleRuntimeOptions["sshWorkspaceTransactions"];
}

export type RemoteRendererLifecycleAction = Extract<
  AppAction,
  {
    type:
      | "pane.split"
      | "pane.close"
      | "surface.create"
      | "surface.close"
      | "surface.closeOthers"
      | "surface.restartSession";
  }
>;

const SESSION_LAUNCH_INPUT_INLINE_CAPABILITY = "session.launch-input-inline-v1";
const INITIAL_INPUT_OUTCOME_UNKNOWN_MESSAGE =
  "The session was created, but its initial command may not have been delivered completely. Check the terminal before retrying.";

/**
 * Main-owned remote control-plane composition. It is deliberately absent from
 * terminal byte handling: its only terminal responsibility is returning an
 * exact, already-authorized MessagePort bind capability to the common attach
 * controller.
 */
export class RemoteLifecycleRuntime {
  private readonly coordinator;
  private readonly reconciler;
  private readonly sshWorkspaceTransactionRuntime;
  private readonly sshWorkspaceTransactionOptions;
  private readonly connections = new Map<Id, RemoteHostTargetConnectOptions>();
  private readonly connectedTargets = new Set<Id>();
  private readonly targetPersistenceLevels = new Map<
    Id,
    RemotePersistenceLevel
  >();
  private readonly targetQueues = new Map<Id, Promise<unknown>>();
  private readonly eventReplayScheduled = new Set<Id>();
  private readonly warnedInitialInputOperations = new Set<Id>();
  private readonly eventReplayTimer?: ReturnType<typeof setInterval>;
  private runtimeReconnectTimer?: ReturnType<typeof setTimeout>;
  private consecutiveRuntimeLosses = 0;
  private recovered = false;
  private stopping = false;

  private readonly onCursor = (event: RemoteHostCursorEvent): void => {
    if (
      this.stopping ||
      !this.connectedTargets.has(event.targetId) ||
      event.resourceKey.desktopInstallationId !==
        this.options.desktopInstallationId ||
      event.resourceKey.targetId !== event.targetId
    ) {
      return;
    }
    try {
      this.options.dispatchFact({
        type: "remote-session.cursor",
        resourceKey: structuredClone(event.resourceKey),
        keeperGeneration: event.keeperGeneration,
        sequence: event.sequence
      });
    } catch (error) {
      // A detached old generation can race an authoritative restart result.
      // Its cursor is metadata only and must never roll the new generation
      // backward or take down Main.
      if (
        error instanceof MainFactConflictError &&
        error.code === "remote-revision-conflict"
      ) {
        return;
      }
      this.report(error);
    }
  };

  private readonly onRuntimeLost = (): void => {
    if (this.stopping) return;
    this.connectedTargets.clear();
    for (const connection of this.connections.values()) {
      this.markObservationUnknown(connection.targetId);
    }
    this.scheduleRuntimeReconnect();
  };

  private scheduleRuntimeReconnect(): void {
    if (this.runtimeReconnectTimer || this.connections.size === 0) return;
    const delayMs =
      this.consecutiveRuntimeLosses === 0
        ? 0
        : Math.min(250 * 2 ** (this.consecutiveRuntimeLosses - 1), 30_000);
    this.consecutiveRuntimeLosses = Math.min(
      this.consecutiveRuntimeLosses + 1,
      32
    );
    this.runtimeReconnectTimer = setTimeout(() => {
      this.runtimeReconnectTimer = undefined;
      if (this.stopping) return;
      const reconnect = [...this.connections.values()].map((connection) =>
        structuredClone(connection)
      );
      for (const connection of reconnect) {
        void (async () => {
          try {
            if (this.options.reconnectTarget) {
              await this.options.reconnectTarget(connection.targetId);
            } else {
              await this.enqueueTarget(connection.targetId, () =>
                this.connectTargetNow(connection)
              );
            }
          } catch (error) {
            this.report(error);
            // A replacement UtilityProcess that fails before ready must not
            // emit runtime-lost: it never owned a usable runtime generation.
            // Keep this recovery loop alive here instead, where we know there
            // are previously connected targets waiting to be restored.
            if (!this.options.host.isReady()) {
              this.scheduleRuntimeReconnect();
            }
          }
        })();
      }
    }, delayMs);
    this.runtimeReconnectTimer.unref();
  }

  private readonly onTargetLost = (event: RemoteHostTargetLostEvent): void => {
    if (this.stopping) return;
    const connection = this.connections.get(event.targetId);
    if (!connection) return;
    this.connectedTargets.delete(event.targetId);
    this.markObservationUnknown(event.targetId);
    void (async () => {
      if (
        this.stopping ||
        this.connections.get(event.targetId) !== connection
      ) {
        return;
      }
      try {
        if (this.options.reconnectTarget) {
          await this.options.reconnectTarget(event.targetId);
        } else {
          await this.enqueueTarget(event.targetId, () =>
            this.connectTargetNow(structuredClone(connection))
          );
        }
      } catch (error) {
        this.report(error);
      }
    })();
  };

  constructor(private readonly options: CreateRemoteLifecycleRuntimeOptions) {
    this.sshWorkspaceTransactionOptions =
      options.sshWorkspaceTransactions ?? options.conversion;
    this.coordinator = createRemoteOperationCoordinator({
      desktopInstallationId: options.desktopInstallationId,
      store: options.operationStore,
      getState: options.getState,
      getTargetBinding: options.getTargetBinding,
      dispatchFact: (fact) => options.dispatchFact(fact),
      ...(options.persistDurableProductSnapshot === undefined
        ? {}
        : {
            dispatchDiscardedFact: (fact) => options.dispatchFact(fact),
            persistDurableProductSnapshot: options.persistDurableProductSnapshot
          })
    });
    this.reconciler = createRemoteReconciler({
      desktopInstallationId: options.desktopInstallationId,
      getState: options.getState,
      dispatchFact: (fact) => options.dispatchFact(fact),
      resourceReceiptStore: options.operationStore,
      ...(options.retainedInventory === undefined
        ? {}
        : { retainedInventory: options.retainedInventory })
    });
    this.sshWorkspaceTransactionRuntime = this.sshWorkspaceTransactionOptions
      ? createTransactionalSshWorkspaceRuntime({
          desktopInstallationId: options.desktopInstallationId,
          wal: this.sshWorkspaceTransactionOptions.wal,
          remote: createRemoteHostSshWorkspaceTransactionGateway(options.host),
          getState: options.getState,
          getTargetBinding: options.getTargetBinding,
          getLocalRuntimeEpoch:
            this.sshWorkspaceTransactionOptions.getLocalRuntimeEpoch,
          forceDesktopSnapshot:
            this.sshWorkspaceTransactionOptions.forceDesktopSnapshot,
          installDesktopState:
            this.sshWorkspaceTransactionOptions.installDesktopState,
          terminateLocalSession:
            this.sshWorkspaceTransactionOptions.terminateLocalSession
        })
      : undefined;
    options.host.on("cursor", this.onCursor);
    options.host.on("runtime-lost", this.onRuntimeLost);
    options.host.on("target-lost", this.onTargetLost);
    if (
      options.eventReceiptStore &&
      options.dispatchAppAction &&
      options.persistDurableProductSnapshot
    ) {
      this.eventReplayTimer = setInterval(() => {
        for (const targetId of this.connectedTargets) {
          this.scheduleRemoteEventReplay(targetId);
        }
      }, 1_000);
      this.eventReplayTimer.unref();
    }
  }

  /** Replays durable facts without starting the remote UtilityProcess. */
  recover(): void {
    if (this.recovered) return;
    const recovered = this.coordinator.recover();
    for (const operation of recovered) {
      this.warnForInitialInputOutcome(operation);
    }
    this.pruneCheckpointedOperationProjections();
    this.recovered = true;
  }

  async connectTarget(
    connection: RemoteHostTargetConnectOptions
  ): Promise<Extract<RemoteBridgeResponseBody, { type: "hello" }>> {
    const candidate = structuredClone(connection);
    return await this.enqueueTarget(candidate.targetId, () =>
      this.connectTargetNow(candidate)
    );
  }

  /**
   * Completes a first connection after remote-host has verified authority on a
   * provisional master. The candidate binding is persisted only after the
   * promoted bridge hello proves the same authority and policy.
   */
  async promoteVerifiedTarget(options: {
    verificationId: Id;
    binding: RemoteTargetBinding;
    connection: RemoteHostTargetConnectOptions;
    token: RemoteHostTargetPromoteOptions["token"];
    retentionPolicy?: RemoteHostTargetPromoteOptions["retentionPolicy"];
    assertPromotionCurrent?: () => void;
  }): Promise<Extract<RemoteBridgeResponseBody, { type: "hello" }>> {
    const binding = validateRemoteTargetBinding(
      structuredClone(options.binding)
    );
    const connection = structuredClone(options.connection);
    if (
      binding.id !== connection.targetId ||
      connection.desktopInstallationId !== this.options.desktopInstallationId ||
      binding.locator.effectiveConnectionPolicyHash !==
        connection.effectiveConnectionPolicyHash
    ) {
      throw new Error(
        "verified target promotion binding does not match its connection"
      );
    }
    return await this.enqueueTarget(binding.id, async () => {
      if (this.stopping) {
        throw new Error("remote lifecycle is stopping");
      }
      try {
        options.assertPromotionCurrent?.();
      } catch (error) {
        await this.options.host
          .discardTargetVerification(options.verificationId)
          .catch(() => undefined);
        throw error;
      }
      let hello: Extract<RemoteBridgeResponseBody, { type: "hello" }>;
      try {
        hello = decodeHello(
          await this.options.host.promoteVerifiedTarget({
            verificationId: options.verificationId,
            desktopInstallationId: connection.desktopInstallationId,
            targetId: binding.id,
            effectiveConnectionPolicyHash:
              binding.locator.effectiveConnectionPolicyHash,
            token: options.token,
            ...(options.retentionPolicy === undefined
              ? {}
              : { retentionPolicy: options.retentionPolicy })
          })
        );
      } catch (error) {
        await this.options.host
          .discardTargetVerification(options.verificationId)
          .catch(() => undefined);
        throw error;
      }
      try {
        options.assertPromotionCurrent?.();
      } catch (error) {
        // A profile edit can happen while remote-host is promoting. The
        // verification has already been consumed at that point, so tear down
        // the stale target before a newer attempt enters this target queue.
        this.connections.delete(binding.id);
        this.connectedTargets.delete(binding.id);
        this.targetPersistenceLevels.delete(binding.id);
        this.markObservationUnknown(binding.id);
        await this.options.host
          .disconnectTarget(binding.id)
          .catch(() => undefined);
        throw error;
      }
      return await this.acceptConnectedTarget(connection, binding, hello);
    });
  }

  async disconnectTarget(targetId: Id): Promise<void> {
    await this.enqueueTarget(targetId, async () => {
      // State removal belongs inside the target queue. Otherwise an earlier
      // in-flight connect can repopulate these maps after they were cleared,
      // leaving Main convinced that a transport we just closed is connected.
      this.connections.delete(targetId);
      this.connectedTargets.delete(targetId);
      this.targetPersistenceLevels.delete(targetId);
      this.markObservationUnknown(targetId);
      if (this.options.host.isReady()) {
        await this.options.host.disconnectTarget(targetId);
      }
    });
  }

  async cleanTargetRuntime(targetId: Id) {
    return await this.enqueueTarget(targetId, async () => {
      if (
        !this.connectedTargets.has(targetId) ||
        !this.options.host.isReady()
      ) {
        throw new Error("remote target must be connected before runtime clean");
      }
      return await this.options.host.cleanTargetRuntime(targetId);
    });
  }

  async resetTargetRuntime(
    targetId: Id,
    assertTargetUnreferenced?: () => void
  ) {
    return await this.enqueueTarget(targetId, async () => {
      assertTargetUnreferenced?.();
      if (
        !this.connectedTargets.has(targetId) ||
        !this.options.host.isReady()
      ) {
        throw new Error("remote target must be connected before runtime reset");
      }
      // The remote-host reset closes the bridge before removing its current
      // executable generation. Clear Main's route inside the same target queue
      // so no operation can race onto that intentionally retired runtime.
      this.connections.delete(targetId);
      this.connectedTargets.delete(targetId);
      this.targetPersistenceLevels.delete(targetId);
      this.markObservationUnknown(targetId);
      return await this.options.host.resetTargetRuntime(targetId);
    });
  }

  getTargetRuntimeRoots(
    targetId: Id
  ): RemoteHostTargetConnectOptions["roots"] | null {
    const roots = this.connections.get(targetId)?.roots;
    return roots ? structuredClone(roots) : null;
  }

  isTargetConnected(targetId: Id): boolean {
    return this.connectedTargets.has(targetId);
  }

  async executeCommand(
    command: RemoteOperationAdmissionCommand,
    product: RemoteOperationProductMetadata = {},
    operationId?: Id
  ): Promise<RemoteOperationCommandResult> {
    const operation = this.coordinator.admit(command, product, operationId);
    const outcome = await this.executeOperation(operation.intent.operationId);
    if (
      outcome.status === "pending" &&
      this.connectedTargets.has(operation.intent.resourceKey.targetId)
    ) {
      await this.retryPendingForTarget(
        operation.intent.resourceKey.targetId
      ).catch((error: unknown) => this.report(error));
    }
    return { operationId: operation.intent.operationId, outcome };
  }

  async executeRendererLifecycleAction(
    action: RemoteRendererLifecycleAction
  ): Promise<void> {
    switch (action.type) {
      case "pane.split":
      case "surface.create":
        await this.createProductSession(action);
        return;
      case "surface.restartSession":
        await this.restartProductSession(action.surfaceId);
        return;
      case "surface.close":
        await this.closeProductSurface(action.surfaceId);
        return;
      case "surface.closeOthers": {
        const state = this.options.getState();
        const surface = state.surfaces[action.surfaceId];
        const { pane } = surface
          ? requireRemotePaneContext(state, surface.paneId)
          : { pane: undefined };
        if (!surface || !pane) return;
        const closeSurfaceIds = pane.surfaceIds.filter(
          (surfaceId) => surfaceId !== action.surfaceId
        );
        for (const surfaceId of closeSurfaceIds) {
          await this.closeProductSurface(surfaceId);
        }
        return;
      }
      case "pane.close": {
        const state = this.options.getState();
        const { pane, workspace } = requireRemotePaneContext(
          state,
          action.paneId
        );
        if (countWorkspacePanes(workspace) <= 1) return;
        const closeSurfaceIds = [...pane.surfaceIds];
        for (const surfaceId of closeSurfaceIds) {
          await this.closeProductSurface(surfaceId);
        }
      }
    }
  }

  private async createProductSession(
    action: Extract<
      RemoteRendererLifecycleAction,
      { type: "pane.split" | "surface.create" }
    >
  ): Promise<void> {
    const state = this.options.getState();
    const paneId = action.paneId;
    const { workspace, pane } = requireRemotePaneContext(state, paneId);
    const sourceSession = pane.surfaceIds
      .map((surfaceId) => terminalSessionForSurface(state, surfaceId))
      .find((session) => session !== undefined);
    const requestedLaunch =
      action.type === "surface.create" ? action.launch : undefined;
    const cwd =
      requestedLaunch?.cwd ??
      (action.type === "surface.create" ? action.cwd : undefined) ??
      encodeLocatedPathDto(defaultNewSurfaceCwd(state, paneId)).path;
    const title =
      requestedLaunch?.title ??
      (action.type === "surface.create" ? action.title : undefined);
    const initialInput = normalizeInitialInput(requestedLaunch?.initialInput);
    const sessionId = makeId("session");
    const payload: Extract<
      RemoteOperationPayloadDto,
      { kind: "session.create" }
    > = {
      kind: "session.create",
      sessionId,
      surfaceId: makeId("surface"),
      paneId,
      ...(action.type === "pane.split" ? { direction: action.direction } : {}),
      launch: {
        cwd,
        ...(requestedLaunch?.shell !== undefined
          ? { shell: requestedLaunch.shell }
          : sourceSession?.launch.shell === undefined
            ? {}
            : { shell: sourceSession.launch.shell }),
        ...(requestedLaunch?.args === undefined
          ? {}
          : { args: [...requestedLaunch.args] }),
        ...(requestedLaunch?.env === undefined
          ? {}
          : { env: { ...requestedLaunch.env } }),
        ...(title === undefined ? {} : { title }),
        ...(initialInput === undefined ? {} : { initialInput })
      }
    };
    await this.executeCommand(
      {
        type: "remote-operation.command",
        workspaceId: workspace.id,
        payload,
        expectedRemoteResourceRevision: uint64(0n)
      },
      initialInput === undefined ? {} : { initialInput }
    );
  }

  private async restartProductSession(surfaceId: Id): Promise<void> {
    const state = this.options.getState();
    const { workspace, surface, session } = requireRemoteSurfaceContext(
      state,
      surfaceId
    );
    if (
      session.runtimeStatus.processState === "pending" ||
      !session.remoteRuntime
    ) {
      return;
    }
    const expectedRevision = session.remoteRuntime.remoteResourceRevision;
    await this.executeCommand({
      type: "remote-operation.command",
      workspaceId: workspace.id,
      expectedRemoteResourceRevision: expectedRevision,
      payload: {
        kind: "session.restart",
        sessionId: session.id,
        surfaceId: surface.id,
        launch: encodeStoredLaunch(session.launch)
      }
    });
  }

  private async terminateProductSurface(surfaceId: Id): Promise<void> {
    const state = this.options.getState();
    const { workspace, pane, session } = requireRemoteSurfaceContext(
      state,
      surfaceId
    );
    if (pane.surfaceIds.length === 1 && countWorkspacePanes(workspace) <= 1) {
      return;
    }
    if (
      Object.values(state.remoteRecovery.operations).some(
        (operation) =>
          operation.kind === "session.terminate" &&
          operation.resourceKey.workspaceId === workspace.id &&
          operation.resourceKey.sessionId === session.id &&
          operation.state === "termination-pending"
      )
    ) {
      return;
    }
    await this.executeCommand({
      type: "remote-operation.command",
      workspaceId: workspace.id,
      expectedRemoteResourceRevision: latestProjectedSessionRevision(
        state,
        workspace.id,
        session.id
      ),
      payload: { kind: "session.terminate", sessionId: session.id }
    });
  }

  private async closeProductSurface(surfaceId: Id): Promise<void> {
    const surface = this.options.getState().surfaces[surfaceId];
    if (!surface) return;
    if (surface.content.kind === "markdown") {
      this.options.dispatchAppAction?.({ type: "surface.close", surfaceId });
      return;
    }
    await this.terminateProductSurface(surfaceId);
  }

  async startSshWorkspaceTransaction(
    request: StartSshWorkspaceTransactionRequest
  ) {
    const validated = decodeStartSshWorkspaceTransactionRequest(request);
    if (
      !this.sshWorkspaceTransactionRuntime ||
      !this.connectedTargets.has(validated.targetId)
    ) {
      throw new Error(
        "workspace conversion requires a connected conversion runtime"
      );
    }
    const record = await this.sshWorkspaceTransactionRuntime.start(validated);
    if (record.state === "cleanup-complete") {
      this.warnForConversionInitialInputOutcome(record);
      await this.tryReconcile(validated.targetId);
      this.sshWorkspaceTransactionRuntime.compactCompleted(
        record.transactionId
      );
    }
    return record;
  }

  /** @deprecated Use startSshWorkspaceTransaction. */
  async startWorkspaceConversion(request: StartSshWorkspaceTransactionRequest) {
    return await this.startSshWorkspaceTransaction(request);
  }

  listRetainedSessions(): RetainedSessionInventoryEntry[] {
    return this.reconciler.listRetainedSessions();
  }

  getRetainedSessionsSnapshot(): RetainedRemoteSessionsSnapshot {
    return {
      sessions: this.reconciler.listRetainedSessions().map((entry) => ({
        resourceKey: structuredClone(entry.resourceKey),
        reason: entry.reason!,
        keeperGeneration: entry.keeperGeneration,
        remoteResourceRevision: formatUint64Decimal(
          entry.remoteResourceRevision
        ),
        processState: entry.processState,
        persistenceLevel: entry.persistenceLevel,
        storageStatus: {
          state: entry.storageStatus.state,
          journalAdmitted: formatUint64Decimal(
            entry.storageStatus.journalAdmitted
          ),
          journalSynced: formatUint64Decimal(entry.storageStatus.journalSynced),
          emergencyBytes: entry.storageStatus.emergencyBytes,
          ...(entry.storageStatus.lastSyncDurationMs === undefined
            ? {}
            : {
                lastSyncDurationMs: entry.storageStatus.lastSyncDurationMs
              })
        },
        checkpointAvailable: entry.checkpointAvailable,
        retainedRangeTruncated: entry.retainedRangeTruncated,
        ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
        launch: {
          cwd: entry.descriptor.launch.cwd,
          ...(entry.descriptor.launch.shell === undefined
            ? {}
            : { shell: entry.descriptor.launch.shell }),
          ...(entry.descriptor.launch.args === undefined
            ? {}
            : { args: [...entry.descriptor.launch.args] }),
          ...(entry.descriptor.launch.title === undefined
            ? {}
            : { title: entry.descriptor.launch.title })
        },
        retainedAt: entry.retainedAt!,
        lastObservedAt: entry.lastObservedAt,
        ...(entry.termination === undefined
          ? {}
          : {
              termination: {
                operationId: entry.termination.operationId,
                admittedAt: entry.termination.admittedAt,
                state:
                  entry.termination.resultDigest === undefined
                    ? ("pending" as const)
                    : ("awaiting-tombstone" as const)
              }
            }),
        ...(entry.lastTerminationFailure === undefined
          ? {}
          : {
              lastTerminationFailure: {
                operationId: entry.lastTerminationFailure.operationId,
                code: entry.lastTerminationFailure.code,
                message: entry.lastTerminationFailure.message,
                completedAt: entry.lastTerminationFailure.completedAt
              }
            }),
        canTerminate: entry.processState === "running"
      })),
      updatedAt: new Date().toISOString()
    };
  }

  retainOwnedForRestoreDisabled(): {
    retained: RetainedSessionInventoryEntry[];
    missingDescriptorKeys: Array<{
      desktopInstallationId: Id;
      targetId: Id;
      workspaceId: Id;
      sessionId: Id;
    }>;
  } {
    return this.reconciler.retainOwnedForRestoreDisabled();
  }

  closeWorkspaceRetained(workspaceId: Id): RetainedSessionInventoryEntry[] {
    if (!this.options.closeWorkspaceProduct) {
      throw new Error("retained workspace close is not configured");
    }
    const state = this.options.getState();
    const window = state.windows[state.activeWindowId];
    if (
      !window ||
      !window.workspaceOrder.includes(workspaceId) ||
      window.workspaceOrder.length <= 1
    ) {
      return [];
    }
    const retained = this.reconciler.retainWorkspace(
      workspaceId,
      "workspace-close"
    );
    // Inventory fsync is the acknowledgement boundary. Product ownership is
    // removed only after every session descriptor became traceable together.
    this.options.closeWorkspaceProduct(workspaceId);
    return retained;
  }

  closeOtherWorkspacesRetained(
    retainedWorkspaceId: Id
  ): RetainedSessionInventoryEntry[] {
    if (!this.options.closeWorkspaceProduct) {
      throw new Error("retained workspace close is not configured");
    }
    const state = this.options.getState();
    const window = state.windows[state.activeWindowId];
    if (!window || !window.workspaceOrder.includes(retainedWorkspaceId)) {
      throw new Error(
        "retained close-others workspace is not in the active window"
      );
    }
    const workspaceIds = window.workspaceOrder
      .filter((workspaceId) => workspaceId !== retainedWorkspaceId)
      .filter(
        (workspaceId) =>
          state.workspaces[workspaceId]?.location.target.kind === "ssh"
      )
      .sort();
    // Make every remote workspace traceable before removing the first product
    // owner. If any descriptor is missing, no workspace is closed.
    const retained = this.reconciler.retainWorkspaces(
      workspaceIds,
      "workspace-close"
    );
    for (const workspaceId of workspaceIds) {
      this.options.closeWorkspaceProduct(workspaceId);
    }
    return retained;
  }

  async terminateRetainedSession(
    resourceKey: RemoteResourceKey & { sessionId: Id }
  ): Promise<void> {
    const inventory = this.requireRetainedInventory();
    const initialEntry = inventory.get(resourceKey);
    if (
      resourceKey.desktopInstallationId !== this.options.desktopInstallationId
    ) {
      throw new Error(
        "retained-session termination belongs to another desktop installation"
      );
    }
    if (!initialEntry || initialEntry.ownership !== "retained") {
      throw new Error("retained-session termination target is unavailable");
    }
    const trustedResourceKey = initialEntry.resourceKey;
    this.requireBinding(trustedResourceKey.targetId);
    const existingOperationId = initialEntry.termination?.operationId;
    if (!this.connectedTargets.has(trustedResourceKey.targetId)) {
      if (!this.options.ensureRetainedTargetConnected) {
        throw new Error(
          "retained-session termination requires an SSH connection"
        );
      }
      try {
        await this.options.ensureRetainedTargetConnected(
          trustedResourceKey.targetId
        );
      } catch (error) {
        if (!inventory.get(trustedResourceKey)) return;
        throw error;
      }
    }
    await this.enqueueTarget(trustedResourceKey.targetId, async () => {
      if (!this.connectedTargets.has(trustedResourceKey.targetId)) {
        throw new Error(
          "retained-session termination requires an SSH connection"
        );
      }
      await this.reconcileTarget(trustedResourceKey.targetId);
      if (!this.connectedTargets.has(trustedResourceKey.targetId)) {
        throw new Error(
          "retained-session termination requires an SSH connection"
        );
      }
      let entry = inventory.get(trustedResourceKey);
      if (!entry) return;
      if (entry.ownership !== "retained") {
        throw new Error("retained-session termination target is unavailable");
      }
      if (existingOperationId && !entry.termination) {
        const failure = entry.lastTerminationFailure;
        throw new Error(
          failure?.operationId === existingOperationId
            ? failure.message
            : "retained-session termination is no longer current"
        );
      }
      if (!entry.termination) {
        const payload = retainedTerminationPayload(entry.resourceKey);
        entry = inventory.admitRetainedTermination(entry.resourceKey, {
          operationId: makeId("retained-termination"),
          canonicalPayloadHash: sha256(
            canonicalizeRemoteOperationPayload(payload)
          ),
          expectedWorkspaceRevision: retainedWorkspaceRevision(entry),
          expectedRemoteResourceRevision: entry.remoteResourceRevision,
          nextRemoteResourceRevision: incrementUint64(
            entry.remoteResourceRevision
          ),
          admittedAt: new Date().toISOString(),
          priorReason:
            entry.reason === undefined || entry.reason === "termination-pending"
              ? "unowned-observation"
              : entry.reason
        });
      }
      if (!entry.termination) {
        throw new Error(
          "retained-session termination admission was not stored"
        );
      }
      const outcome = await this.executeRetainedTermination(entry);
      if (outcome.status === "succeeded") {
        await this.tryReconcile(trustedResourceKey.targetId);
      } else if (outcome.status === "failed") {
        throw new Error(outcome.message);
      }
    });
  }

  async reconcileTarget(targetId: Id): Promise<void> {
    if (!this.connectedTargets.has(targetId)) {
      this.markObservationUnknown(targetId);
      return;
    }
    let observed: RemoteObservedState;
    try {
      observed = decodeObservedState(
        await this.options.host.observe(
          targetId,
          this.options.desktopInstallationId
        ),
        this.targetPersistenceLevels.get(targetId)
      );
    } catch (error) {
      this.markObservationUnknown(targetId);
      throw error;
    }
    // Consume receipts from a prior observation before admitting any new
    // receipt. This lets an upgraded store recover even when its old receipt
    // directory is already at the hard bound.
    this.pruneCheckpointedOperationProjections();
    this.compactCheckpointedOperations(true);
    this.reconciler.observe(observed);
    this.compactCheckpointedOperations();
  }

  getRemoteTerminal(surfaceId: Id, sessionId: Id) {
    const state = this.options.getState();
    const surface = state.surfaces[surfaceId];
    const session = state.sessions[sessionId];
    const pane = surface ? state.panes[surface.paneId] : undefined;
    const workspace = pane ? state.workspaces[pane.workspaceId] : undefined;
    if (
      !surface ||
      !session ||
      !workspace ||
      terminalSessionForSurface(state, surfaceId)?.id !== sessionId ||
      session.surfaceId !== surfaceId ||
      workspace.location.target.kind !== "ssh" ||
      !this.connectedTargets.has(workspace.location.target.targetId) ||
      session.runtimeStatus.processState !== "running" ||
      !session.remoteRuntime
    ) {
      return null;
    }
    const targetId = workspace.location.target.targetId;
    const connection = this.connections.get(targetId);
    let binding: RemoteTargetBinding | undefined;
    try {
      const candidate = this.options.getTargetBinding(targetId);
      binding = candidate ? validateRemoteTargetBinding(candidate) : undefined;
    } catch {
      return null;
    }
    if (
      !binding ||
      binding.id !== targetId ||
      !connection ||
      binding.locator.effectiveConnectionPolicyHash !==
        connection.effectiveConnectionPolicyHash
    ) {
      return null;
    }
    return {
      host: this.options.host,
      resourceKey: {
        desktopInstallationId: this.options.desktopInstallationId,
        targetId,
        workspaceId: workspace.id,
        sessionId
      },
      keeperGeneration: session.remoteRuntime.keeperGeneration
    };
  }

  async sendSurfaceText(
    surfaceId: Id,
    text: string,
    operationId: Id = makeId("remote-terminal-input")
  ): Promise<RemoteTerminalInputAcknowledgement> {
    const initial = this.requireRemoteTerminalControl(surfaceId);
    return this.enqueueTarget(initial.resourceKey.targetId, async () => {
      const terminal = this.requireRemoteTerminalControl(surfaceId);
      if (!sameRemoteResource(initial.resourceKey, terminal.resourceKey)) {
        throw new Error(
          "remote terminal input target changed before admission"
        );
      }
      if (terminal.keeperGeneration !== initial.keeperGeneration) {
        throw new Error(
          "remote terminal input generation changed before admission"
        );
      }
      return this.terminalControlProvider(
        terminal.resourceKey.targetId
      ).sendText({
        resourceKey: terminal.resourceKey,
        expectedKeeperGeneration: terminal.keeperGeneration,
        operationId,
        text
      });
    });
  }

  sendSurfaceKey(
    surfaceId: Id,
    input: TerminalKeyInput,
    operationId: Id = makeId("remote-terminal-input")
  ): Promise<RemoteTerminalInputAcknowledgement> {
    return this.sendSurfaceText(
      surfaceId,
      encodeTerminalKeyInput(input),
      operationId
    );
  }

  async captureSurface(
    surfaceId: Id,
    options: {
      lineLimit?: number;
      maxBytes?: number;
      captureId?: Id;
    } = {}
  ): Promise<RemoteSurfaceCaptureResult> {
    const initial = this.requireRemoteTerminalControl(surfaceId);
    const lineLimit = options.lineLimit ?? 200;
    const maxBytes = options.maxBytes ?? 1024 * 1024;
    if (
      !Number.isSafeInteger(lineLimit) ||
      lineLimit < 1 ||
      lineLimit > 65_536
    ) {
      throw new Error("remote surface capture line limit is invalid");
    }
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 1024 * 1024
    ) {
      throw new Error("remote surface capture byte limit is invalid");
    }
    const captureId = options.captureId ?? makeId("remote-surface-capture");
    return this.enqueueTarget(initial.resourceKey.targetId, async () => {
      const terminal = this.requireRemoteTerminalControl(surfaceId);
      if (!sameRemoteResource(initial.resourceKey, terminal.resourceKey)) {
        throw new Error(
          "remote surface capture target changed before admission"
        );
      }
      if (terminal.keeperGeneration !== initial.keeperGeneration) {
        throw new Error(
          "remote surface capture generation changed before admission"
        );
      }
      return this.terminalControlProvider(
        terminal.resourceKey.targetId
      ).capture({
        resourceKey: terminal.resourceKey,
        expectedKeeperGeneration: terminal.keeperGeneration,
        captureId,
        lineLimit,
        maxBytes
      });
    });
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.eventReplayTimer) clearInterval(this.eventReplayTimer);
    if (this.runtimeReconnectTimer) clearTimeout(this.runtimeReconnectTimer);
    this.runtimeReconnectTimer = undefined;
    this.connections.clear();
    this.connectedTargets.clear();
    this.targetPersistenceLevels.clear();
    this.options.host.off("cursor", this.onCursor);
    this.options.host.off("runtime-lost", this.onRuntimeLost);
    this.options.host.off("target-lost", this.onTargetLost);
    await Promise.allSettled([...this.targetQueues.values()]);
    this.connections.clear();
    this.connectedTargets.clear();
    this.targetPersistenceLevels.clear();
    await this.options.host.stop();
  }

  private async connectTargetNow(
    connection: RemoteHostTargetConnectOptions
  ): Promise<Extract<RemoteBridgeResponseBody, { type: "hello" }>> {
    if (this.stopping) {
      throw new Error("remote lifecycle is stopping");
    }
    const binding = this.requireBinding(connection.targetId);
    if (
      connection.desktopInstallationId !== this.options.desktopInstallationId ||
      connection.effectiveConnectionPolicyHash !==
        binding.locator.effectiveConnectionPolicyHash
    ) {
      throw new Error(
        "remote target connection policy differs from its verified binding"
      );
    }
    const connectionAttemptId = makeId("ssh-reconnect-attempt");
    const verificationId = makeId("ssh-reconnect-verification");
    let verification: RemoteHostTargetVerification | undefined;
    try {
      // Automatic recovery intentionally omits askpass. It may use an already
      // available agent, but a transport crash must never create a prompt loop.
      verification = await this.options.host.verifyTarget({
        verificationId,
        connectionAttemptId,
        effectiveConnectionPolicyHash: connection.effectiveConnectionPolicyHash,
        sshPath: connection.sshPath,
        configPath: connection.configPath,
        host: connection.host,
        ...(connection.controlRoot === undefined
          ? {}
          : { controlRoot: connection.controlRoot }),
        rootOverrides: structuredClone(connection.roots),
        ...(connection.bootstrapShellOverride === undefined
          ? {}
          : {
              bootstrapShellOverride: connection.bootstrapShellOverride
            })
      });
      if (!sameVerifiedAuthority(binding, verification)) {
        this.markTargetMismatch(connection.targetId);
        throw new Error(
          "remote authority does not match the verified target during reconnect"
        );
      }
      const reverifiedBinding = advanceBindingVerification(binding);
      const token = randomBytes(32).toString("hex");
      const nextConnection = structuredClone(connection);
      delete nextConnection.askpassPath;
      nextConnection.connectionAttemptId = connectionAttemptId;
      nextConnection.roots = structuredClone(verification.roots);
      nextConnection.token = token;
      const promoted = await this.options.host.promoteVerifiedTarget({
        verificationId,
        desktopInstallationId: connection.desktopInstallationId,
        targetId: connection.targetId,
        effectiveConnectionPolicyHash: connection.effectiveConnectionPolicyHash,
        retentionPolicy: structuredClone(connection.retentionPolicy),
        token
      });
      verification = undefined;
      const hello = decodeHello(promoted);
      return await this.acceptConnectedTarget(
        nextConnection,
        reverifiedBinding,
        hello
      );
    } catch (error) {
      if (verification) {
        await this.options.host
          .discardTargetVerification(verification.verificationId)
          .catch(() => undefined);
      }
      throw error;
    }
  }

  private async acceptConnectedTarget(
    connection: RemoteHostTargetConnectOptions,
    binding: RemoteTargetBinding,
    hello: Extract<RemoteBridgeResponseBody, { type: "hello" }>
  ): Promise<Extract<RemoteBridgeResponseBody, { type: "hello" }>> {
    let observedBinding: RemoteTargetBinding;
    try {
      assertVerifiedAuthority(binding, hello);
      selectVerifiedRemoteRuntimeArtifact(hello);
    } catch (error) {
      this.connectedTargets.delete(connection.targetId);
      this.markTargetMismatch(connection.targetId);
      await this.options.host
        .disconnectTarget(connection.targetId)
        .catch(() => undefined);
      throw error;
    }
    if (!hello.capabilities.includes(SESSION_LAUNCH_INPUT_INLINE_CAPABILITY)) {
      this.connectedTargets.delete(connection.targetId);
      this.markObservationUnknown(connection.targetId);
      await this.options.host
        .disconnectTarget(connection.targetId)
        .catch(() => undefined);
      throw new RemoteHostManagerError(
        "upgrade-required",
        "The remote kmux runtime must be upgraded before SSH sessions can be created safely.",
        false
      );
    }
    try {
      observedBinding = observedBindingFromHello(binding, hello);
      this.options.replaceTargetBinding(observedBinding);
    } catch (error) {
      this.connectedTargets.delete(connection.targetId);
      this.markObservationUnknown(connection.targetId);
      await this.options.host
        .disconnectTarget(connection.targetId)
        .catch(() => undefined);
      throw error;
    }
    this.targetPersistenceLevels.set(
      connection.targetId,
      hello.persistenceLevel
    );
    this.connections.set(connection.targetId, structuredClone(connection));
    this.connectedTargets.add(connection.targetId);
    try {
      if (
        this.sshWorkspaceTransactionRuntime &&
        this.sshWorkspaceTransactionOptions
      ) {
        const recovered =
          await this.sshWorkspaceTransactionRuntime.recoverTarget(
            connection.targetId
          );
        for (const record of recovered) {
          if (record.state === "cleanup-complete") {
            this.warnForConversionInitialInputOutcome(record);
            this.sshWorkspaceTransactionRuntime.compactCompleted(
              record.transactionId
            );
          }
        }
        const protectedTransactionIds = this.sshWorkspaceTransactionOptions.wal
          .loadAll()
          .filter(
            (record) =>
              record.workspaceResourceKey.targetId === connection.targetId &&
              record.state !== "cleanup-complete"
          )
          .map((record) => record.transactionId)
          .sort();
        await this.options.host.reclaimProvisionals(connection.targetId, {
          desktopInstallationId: this.options.desktopInstallationId,
          targetId: connection.targetId,
          protectedTransactionIds,
          now: new Date().toISOString()
        });
      }
      await this.reconcileTarget(connection.targetId);
      if (this.options.retainedInventory) {
        await this.retryRetainedTerminations(connection.targetId);
      }
      await this.retryPendingForTarget(connection.targetId);
      await this.drainRemoteEvents(connection.targetId);
      this.consecutiveRuntimeLosses = 0;
    } catch (error) {
      this.connectedTargets.delete(connection.targetId);
      this.connections.delete(connection.targetId);
      this.targetPersistenceLevels.delete(connection.targetId);
      this.markObservationUnknown(connection.targetId);
      await this.options.host
        .disconnectTarget(connection.targetId)
        .catch(() => undefined);
      throw error;
    }
    try {
      this.options.onTargetConnected?.(connection.targetId);
    } catch (error) {
      this.report(error);
    }
    return hello;
  }

  private requireBinding(targetId: Id): RemoteTargetBinding {
    const candidate = this.options.getTargetBinding(targetId);
    const binding = candidate
      ? validateRemoteTargetBinding(candidate)
      : undefined;
    if (!binding || binding.id !== targetId) {
      throw new Error("remote target binding is unavailable or mismatched");
    }
    return binding;
  }

  private scheduleRemoteEventReplay(targetId: Id): void {
    if (
      this.stopping ||
      this.eventReplayScheduled.has(targetId) ||
      !this.connectedTargets.has(targetId)
    ) {
      return;
    }
    this.eventReplayScheduled.add(targetId);
    void this.enqueueTarget(targetId, () => this.drainRemoteEvents(targetId))
      .catch((error: unknown) => this.report(error))
      .finally(() => this.eventReplayScheduled.delete(targetId));
  }

  private async drainRemoteEvents(targetId: Id): Promise<void> {
    const store = this.options.eventReceiptStore;
    const dispatch = this.options.dispatchAppAction;
    const persist = this.options.persistDurableProductSnapshot;
    if (!store || !dispatch || !persist) return;
    if (!this.connectedTargets.has(targetId)) return;

    let receipt = store.load(this.options.desktopInstallationId, targetId);
    const productReceipt =
      this.options.getState().remoteRecovery.eventReceipts[targetId];
    const productThrough = productReceipt?.throughSequence ?? uint64(0n);
    if (productThrough < receipt.appliedThrough) {
      throw new RemoteEventCheckpointConflictError(
        targetId,
        productThrough,
        receipt.appliedThrough,
        "product-cursor-mismatch"
      );
    }
    if (receipt.pending) {
      const projected = await this.applyStagedRemoteEventAfterReconcile(
        receipt.pending,
        dispatch,
        persist
      );
      if (!projected) return;
      receipt = store.complete(receipt.pending);
    }
    const recoveredProductReceipt =
      this.options.getState().remoteRecovery.eventReceipts[targetId];
    const recoveredProductThrough =
      recoveredProductReceipt?.throughSequence ?? uint64(0n);
    if (recoveredProductThrough !== receipt.appliedThrough) {
      throw new RemoteEventCheckpointConflictError(
        targetId,
        recoveredProductThrough,
        receipt.appliedThrough,
        "product-cursor-mismatch"
      );
    }

    for (let pageIndex = 0; pageIndex < 32; pageIndex += 1) {
      const page = await this.options.host.replayEvents(
        targetId,
        this.options.desktopInstallationId,
        receipt.appliedThrough
      );
      if (page.targetId !== targetId) {
        throw new Error("remote event replay returned another target");
      }
      if (page.acknowledgedThrough > receipt.appliedThrough) {
        throw new Error(
          "remote event spool acknowledgement is ahead of the desktop receipt"
        );
      }
      let priorSequence = receipt.appliedThrough;
      for (const event of page.events) {
        const sequence = parseUint64Decimal(event.sequence);
        if (
          event.resourceKey.desktopInstallationId !==
            this.options.desktopInstallationId ||
          event.resourceKey.targetId !== targetId ||
          sequence !== incrementUint64(priorSequence)
        ) {
          throw new Error("remote event replay order or scope is invalid");
        }
        store.stage(event);
        const projected = await this.applyStagedRemoteEventAfterReconcile(
          event,
          dispatch,
          persist
        );
        if (!projected) return;
        receipt = store.complete(event);
        priorSequence = sequence;
      }
      if (receipt.appliedThrough > page.acknowledgedThrough) {
        const acknowledged = await this.options.host.acknowledgeEvents(
          targetId,
          this.options.desktopInstallationId,
          receipt.appliedThrough
        );
        if (acknowledged < receipt.appliedThrough) {
          throw new Error(
            "remote event acknowledgement did not reach the cursor"
          );
        }
      }
      if (!page.hasMore) return;
      if (page.events.length === 0) {
        throw new Error(
          "remote event replay reported more data without progress"
        );
      }
    }
  }

  private async applyStagedRemoteEventAfterReconcile(
    event: RemoteSpoolEventDto,
    dispatch: (action: AppAction) => void,
    persist: (state: AppState) => Promise<string> | string | void
  ): Promise<boolean> {
    if (await this.applyStagedRemoteEvent(event, dispatch, persist)) {
      return true;
    }
    await this.reconcileTarget(event.resourceKey.targetId);
    return this.applyStagedRemoteEvent(event, dispatch, persist, true);
  }

  private async applyStagedRemoteEvent(
    event: RemoteSpoolEventDto,
    dispatch: (action: AppAction) => void,
    persist: (state: AppState) => Promise<string> | string | void,
    projectionReconciled = false
  ): Promise<boolean> {
    const sequence = parseUint64Decimal(event.sequence);
    const normalized = normalizeRemoteSpoolEvent(
      this.options.getState(),
      event,
      {
        projectionReconciled,
        getSurfaceVendor: this.options.getSurfaceVendor,
        isSurfaceVisibleToUser: this.options.isSurfaceVisibleToUser
      }
    );
    if (normalized.disposition === "pending") {
      dispatch({
        type: "remote.event.apply",
        targetId: event.resourceKey.targetId,
        sequence,
        eventId: event.eventId,
        disposition: "pending",
        reason: normalized.reason
      });
      return false;
    }
    dispatch(
      normalized.disposition === "applied"
        ? {
            type: "remote.event.apply",
            targetId: event.resourceKey.targetId,
            sequence,
            eventId: event.eventId,
            disposition: "applied",
            productAction: normalized.productAction
          }
        : {
            type: "remote.event.apply",
            targetId: event.resourceKey.targetId,
            sequence,
            eventId: event.eventId,
            disposition: normalized.disposition,
            reason: normalized.reason
          }
    );
    await persist(this.options.getState());
    const receipt =
      this.options.getState().remoteRecovery.eventReceipts[
        event.resourceKey.targetId
      ];
    if (!receipt || receipt.throughSequence < sequence) {
      const durableReceipt = this.options.eventReceiptStore?.load(
        this.options.desktopInstallationId,
        event.resourceKey.targetId
      );
      throw new RemoteEventCheckpointConflictError(
        event.resourceKey.targetId,
        receipt?.throughSequence ?? uint64(0n),
        durableReceipt?.appliedThrough ?? uint64(0n),
        "product-cursor-mismatch"
      );
    }
    return true;
  }

  private requireRemoteTerminalControl(surfaceId: Id) {
    const state = this.options.getState();
    const surface = state.surfaces[surfaceId];
    if (!surface) {
      throw new Error("remote surface is unavailable");
    }
    const session = terminalSessionForSurface(state, surfaceId);
    const terminal = session
      ? this.getRemoteTerminal(surfaceId, session.id)
      : null;
    if (!terminal) {
      throw new Error(
        "remote surface is not connected to its current running keeper"
      );
    }
    return terminal;
  }

  private terminalControlProvider(targetId: Id) {
    return createBoundRemoteTerminalControlProvider({
      desktopInstallationId: this.options.desktopInstallationId,
      targetId,
      host: this.options.host,
      isConnected: () => this.connectedTargets.has(targetId)
    });
  }

  private requireRetainedInventory(): RetainedSessionInventoryStore {
    if (!this.options.retainedInventory) {
      throw new Error("retained-session inventory is not configured");
    }
    return this.options.retainedInventory;
  }

  private executeOperation(
    operationId: Id
  ): Promise<RemoteOperationExecutionOutcome> {
    const operation = this.options.operationStore.get(operationId);
    if (!operation) {
      return Promise.reject(
        new Error(`remote operation ${operationId} is not admitted`)
      );
    }
    const targetId = operation.intent.resourceKey.targetId;
    return this.coordinator
      .execute(
        operationId,
        async (current) => {
          if (!this.connectedTargets.has(targetId)) {
            return { status: "pending", reason: "offline" };
          }
          const outcome = await this.options.host.executeOperation(
            targetId,
            current.intent,
            current.payload
          );
          return mapRuntimeOutcome(operationId, outcome, current.payload);
        },
        {
          afterResult: async () => {
            const current = this.options.operationStore.get(operationId);
            if (current) this.warnForInitialInputOutcome(current);
            await this.tryReconcile(targetId);
          }
        }
      )
      .then((outcome) => {
        const current = this.options.operationStore.get(operationId);
        if (current) this.warnForInitialInputOutcome(current, outcome);
        return outcome;
      });
  }

  private async retryPendingForTarget(targetId: Id): Promise<void> {
    const pending = this.reconciler
      .pendingOperations(targetId)
      .sort(compareRemoteOperationRetryOrder);
    const blockedWorkspaces = new Set<Id>();
    for (const operation of pending) {
      const workspaceId = operation.resourceKey.workspaceId;
      if (blockedWorkspaces.has(workspaceId)) continue;
      const outcome = await this.executeOperation(operation.operationId);
      if (outcome.status === "pending") {
        blockedWorkspaces.add(workspaceId);
      }
    }
    await this.tryReconcile(targetId);
  }

  private async retryRetainedTerminations(targetId: Id): Promise<void> {
    const pending = this.requireRetainedInventory()
      .listRetained()
      .filter(
        (entry) =>
          entry.resourceKey.targetId === targetId &&
          entry.termination !== undefined &&
          entry.termination.resultDigest === undefined
      )
      .sort(
        (left, right) =>
          left.termination!.admittedAt.localeCompare(
            right.termination!.admittedAt
          ) ||
          left.termination!.operationId.localeCompare(
            right.termination!.operationId
          )
      );
    for (const entry of pending) {
      const outcome = await this.executeRetainedTermination(entry);
      if (outcome.status === "pending" && outcome.reason === "offline") break;
    }
  }

  private async executeRetainedTermination(
    candidate: RetainedSessionInventoryEntry
  ): Promise<RemoteOperationExecutionOutcome> {
    const inventory = this.requireRetainedInventory();
    const current = inventory.get(candidate.resourceKey);
    const termination = current?.termination;
    if (!current || current.ownership !== "retained" || !termination) {
      throw new Error("retained-session termination admission disappeared");
    }
    if (termination.resultDigest) {
      return {
        status: "succeeded",
        remoteResourceRevision: termination.nextRemoteResourceRevision,
        resultDigest: termination.resultDigest
      };
    }
    if (!this.connectedTargets.has(current.resourceKey.targetId)) {
      return { status: "pending", reason: "offline" };
    }
    const payload = retainedTerminationPayload(current.resourceKey);
    const intent: RemoteOperationIntent = {
      operationId: termination.operationId,
      kind: "session.terminate",
      resourceKey: structuredClone(current.resourceKey),
      expectedWorkspaceRevision: termination.expectedWorkspaceRevision,
      expectedRemoteResourceRevision:
        termination.expectedRemoteResourceRevision,
      nextRemoteResourceRevision: termination.nextRemoteResourceRevision,
      canonicalPayloadHash: termination.canonicalPayloadHash,
      createdAt: termination.admittedAt
    };
    let runtimeOutcome: RemoteRuntimeOperationOutcome;
    try {
      runtimeOutcome = await this.options.host.executeOperation(
        current.resourceKey.targetId,
        intent,
        payload
      );
    } catch {
      return { status: "pending", reason: "ambiguous" };
    }
    const outcome = mapRuntimeOutcome(
      termination.operationId,
      runtimeOutcome,
      payload
    );
    if (outcome.status === "succeeded") {
      inventory.recordTerminationResult(
        current.resourceKey,
        termination.operationId,
        outcome.resultDigest
      );
    } else {
      inventory.recordTerminationFailure(current.resourceKey, {
        operationId: termination.operationId,
        resultDigest: outcome.resultDigest,
        code: outcome.code,
        message: outcome.message,
        completedAt: outcome.completedAt ?? new Date().toISOString()
      });
    }
    return outcome;
  }

  private async tryReconcile(targetId: Id): Promise<void> {
    try {
      await this.reconcileTarget(targetId);
    } catch (error) {
      this.report(error);
    }
  }

  private warnForInitialInputOutcome(
    operation: DurableRemoteOperationRecord,
    executionOutcome?: RemoteOperationExecutionOutcome
  ): void {
    if (
      operation.payload.kind !== "session.create" &&
      operation.payload.kind !== "session.restart"
    ) {
      return;
    }
    if (operation.payload.launch.initialInput === undefined) return;
    const initialInputOutcome =
      executionOutcome?.status === "succeeded"
        ? (executionOutcome.initialInputOutcome ?? "outcome-unknown")
        : operation.result?.authoritative.outcome === "succeeded"
          ? (operation.result.authoritative.initialInputOutcome ??
            "outcome-unknown")
          : undefined;
    if (initialInputOutcome !== "outcome-unknown") return;
    this.warnInitialInputOutcomeOnce({
      key: operation.intent.operationId,
      kind: operation.payload.kind,
      workspaceId: operation.intent.resourceKey.workspaceId,
      sessionId: operation.payload.sessionId,
      surfaceId: operation.payload.surfaceId,
      initialInputOutcome
    });
  }

  private warnForConversionInitialInputOutcome(
    record: ConversionWalRecord
  ): void {
    if (
      record.state === "preparing" ||
      record.initialInputOutcome !== "outcome-unknown"
    ) {
      return;
    }
    const session =
      this.options.getState().sessions[record.sessionResourceKey.sessionId];
    this.warnInitialInputOutcomeOnce({
      key: record.transactionId,
      kind: "conversion.prepare",
      workspaceId: record.workspaceResourceKey.workspaceId,
      sessionId: record.sessionResourceKey.sessionId,
      surfaceId: session?.surfaceId,
      initialInputOutcome: record.initialInputOutcome
    });
  }

  private warnInitialInputOutcomeOnce(input: {
    key: Id;
    kind: "session.create" | "session.restart" | "conversion.prepare";
    workspaceId: Id;
    sessionId: Id;
    surfaceId?: Id;
    initialInputOutcome: RemoteInitialInputOutcome;
  }): void {
    if (this.warnedInitialInputOperations.has(input.key)) return;
    this.warnedInitialInputOperations.add(input.key);
    const state = this.options.getState();
    const surface = input.surfaceId
      ? state.surfaces[input.surfaceId]
      : undefined;
    const pane = surface ? state.panes[surface.paneId] : undefined;
    if (
      surface &&
      pane?.workspaceId === input.workspaceId &&
      state.workspaces[input.workspaceId]
    ) {
      this.options.dispatchAppAction?.({
        type: "notification.create",
        workspaceId: input.workspaceId,
        paneId: pane.id,
        surfaceId: surface.id,
        title: "Session command may need attention",
        message: INITIAL_INPUT_OUTCOME_UNKNOWN_MESSAGE,
        source: "system",
        kind: "generic"
      });
    }
    logDiagnostics("main.remote.initial-input", {
      operationId: input.key,
      operationKind: input.kind,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      ...(input.surfaceId === undefined ? {} : { surfaceId: input.surfaceId }),
      outcome: input.initialInputOutcome
    });
  }

  private markObservationUnknown(targetId: Id): void {
    try {
      this.reconciler.observe({
        targetId,
        targetStatus: "unknown",
        inventoryComplete: false,
        keepers: []
      });
    } catch (error) {
      this.report(error);
    }
  }

  private markTargetMismatch(targetId: Id): void {
    try {
      this.reconciler.observe({
        targetId,
        targetStatus: "mismatch",
        inventoryComplete: false,
        keepers: []
      });
    } catch (error) {
      this.report(error);
    }
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

  private report(error: unknown): void {
    this.options.reportError?.(
      error instanceof Error ? error : new Error(String(error))
    );
  }

  private compactCheckpointedOperations(successfulOnly = false): void {
    if (!this.options.persistDurableProductSnapshot) return;
    const terminal = this.options.operationStore
      .loadAll()
      .filter(
        (operation) =>
          operation.result !== undefined &&
          ((!successfulOnly &&
            operation.result.authoritative.outcome === "failed") ||
            this.options.operationStore.getResourceReceipt(
              operation.intent.resourceKey
            ) !== null)
      );
    if (terminal.length > 0) {
      const state = this.options.getState();
      this.options.persistDurableProductSnapshot(state);
      const validationState = cloneState(state);
      for (const operation of terminal) {
        applyMainRemoteOperationCheckpointFact(validationState, {
          type: "remote-operation.checkpointed",
          operationId: operation.intent.operationId,
          resultDigest: operation.result!.authoritative.resultDigest
        });
      }
      const compactedIds = new Set(
        this.options.operationStore.compactAfterDurableSnapshot(
          terminal.map((operation) => operation.intent.operationId),
          state
        )
      );
      for (const operation of terminal) {
        if (!compactedIds.has(operation.intent.operationId)) continue;
        this.options.dispatchFact({
          type: "remote-operation.checkpointed",
          operationId: operation.intent.operationId,
          resultDigest: operation.result!.authoritative.resultDigest
        });
      }
      if (compactedIds.size > 0) {
        this.options.persistDurableProductSnapshot(this.options.getState());
      }
    }
    this.removeUnneededResourceReceipts();
  }

  private pruneCheckpointedOperationProjections(): void {
    const persist = this.options.persistDurableProductSnapshot;
    if (!persist) return;
    const durableOperationIds = new Set(
      this.options.operationStore
        .loadAll()
        .map((operation) => operation.intent.operationId)
    );
    let pruned = false;
    for (const projection of Object.values(
      this.options.getState().remoteRecovery.operations
    )) {
      if (
        durableOperationIds.has(projection.operationId) ||
        (projection.state !== "succeeded" && projection.state !== "failed") ||
        projection.resultDigest === undefined
      ) {
        continue;
      }
      this.options.dispatchFact({
        type: "remote-operation.checkpointed",
        operationId: projection.operationId,
        resultDigest: projection.resultDigest
      });
      pruned = true;
    }
    if (pruned) persist(this.options.getState());
    this.removeUnneededResourceReceipts();
  }

  private removeUnneededResourceReceipts(): void {
    const required = new Set(
      this.options.operationStore
        .loadAll()
        .filter(
          (operation) => operation.result?.authoritative.outcome === "succeeded"
        )
        .map((operation) =>
          remoteResourceIdentity(operation.intent.resourceKey)
        )
    );
    this.options.operationStore.removeResourceReceipts(
      this.options.operationStore
        .listResourceReceipts()
        .filter(
          (receipt) =>
            !required.has(remoteResourceIdentity(receipt.resourceKey))
        )
        .map((receipt) => receipt.resourceKey)
    );
  }
}

function requireRemotePaneContext(state: AppState, paneId: Id) {
  const pane = state.panes[paneId];
  const workspace = pane ? state.workspaces[pane.workspaceId] : undefined;
  if (!pane || !workspace || workspace.location.target.kind !== "ssh") {
    throw new Error(
      "remote lifecycle pane does not belong to an SSH workspace"
    );
  }
  return { pane, workspace };
}

function requireRemoteSurfaceContext(state: AppState, surfaceId: Id) {
  const surface = state.surfaces[surfaceId];
  const session = surface
    ? terminalSessionForSurface(state, surface.id)
    : undefined;
  const context = surface
    ? requireRemotePaneContext(state, surface.paneId)
    : undefined;
  if (!surface || !session || !context || session.surfaceId !== surface.id) {
    throw new Error(
      "remote lifecycle surface does not belong to an SSH workspace"
    );
  }
  return { ...context, surface, session };
}

type RemoteEventNormalization =
  | { disposition: "applied"; productAction: RemoteEventProductAction }
  | {
      disposition: "suppressed" | "pending" | "rejected";
      reason: string;
    };

function normalizeRemoteSpoolEvent(
  state: AppState,
  event: RemoteSpoolEventDto,
  options: {
    projectionReconciled?: boolean;
    getSurfaceVendor?: (surfaceId: Id) => UsageVendor;
    isSurfaceVisibleToUser?: (surfaceId: Id) => boolean;
  } = {}
): RemoteEventNormalization {
  const workspace = state.workspaces[event.resourceKey.workspaceId];
  const session = state.sessions[event.resourceKey.sessionId];
  const hasPendingProjection = Object.values(
    state.remoteRecovery.operations
  ).some(
    (operation) =>
      operation.resourceKey.desktopInstallationId ===
        event.resourceKey.desktopInstallationId &&
      operation.resourceKey.targetId === event.resourceKey.targetId &&
      operation.resourceKey.workspaceId === event.resourceKey.workspaceId &&
      operation.resourceKey.sessionId === event.resourceKey.sessionId &&
      (operation.state === "pending" ||
        operation.state === "termination-pending")
  );
  if (!workspace || !session) {
    return hasPendingProjection
      ? { disposition: "pending", reason: "product-projection-pending" }
      : { disposition: "rejected", reason: "remote-session-scope-unknown" };
  }
  if (
    workspace.location.target.kind !== "ssh" ||
    workspace.location.target.targetId !== event.resourceKey.targetId
  ) {
    return { disposition: "rejected", reason: "remote-target-scope-mismatch" };
  }
  const surface = state.surfaces[session.surfaceId];
  const pane = surface ? state.panes[surface.paneId] : undefined;
  if (
    !surface ||
    !pane ||
    pane.workspaceId !== workspace.id ||
    terminalSessionForSurface(state, surface.id)?.id !== session.id ||
    session.surfaceId !== surface.id
  ) {
    return hasPendingProjection
      ? { disposition: "pending", reason: "surface-projection-pending" }
      : {
          disposition: "rejected",
          reason: "surface-projection-unresolved"
        };
  }
  if (!session.remoteRuntime) {
    return options.projectionReconciled && !hasPendingProjection
      ? {
          disposition: "rejected",
          reason: "keeper-projection-unresolved"
        }
      : { disposition: "pending", reason: "keeper-projection-pending" };
  }
  if (session.remoteRuntime.keeperGeneration !== event.keeperGeneration) {
    return hasPendingProjection
      ? { disposition: "pending", reason: "keeper-generation-pending" }
      : { disposition: "suppressed", reason: "historical-keeper-generation" };
  }
  const payload = plainRecord(event.payload);
  const eventDetails = {
    remoteEventId: event.eventId,
    remoteEventSequence: event.sequence,
    remoteTargetId: event.resourceKey.targetId,
    keeperGeneration: event.keeperGeneration,
    source: "remote-hook"
  };

  if (event.kind === "agent-hook") {
    const separator = event.name.indexOf(".");
    const agent = separator > 0 ? event.name.slice(0, separator) : "unknown";
    const hookEvent =
      separator > 0 ? event.name.slice(separator + 1) : event.name;
    const environment = {
      KMUX_WORKSPACE_ID: workspace.id,
      KMUX_SURFACE_ID: surface.id,
      KMUX_SESSION_ID: session.id
    };
    const normalized = normalizeAgentHookInvocation(
      agent,
      hookEvent,
      payload,
      environment
    );
    if (normalized) {
      return {
        disposition: "applied",
        productAction: {
          type: "agent.event",
          workspaceId: workspace.id,
          paneId: pane.id,
          surfaceId: surface.id,
          sessionId: session.id,
          ...(normalized.vendorSessionId === undefined
            ? {}
            : { vendorSessionId: normalized.vendorSessionId }),
          agent: normalized.agent,
          event: normalized.event,
          title: normalized.title,
          message: normalized.message,
          details: { ...(normalized.details ?? {}), ...eventDetails }
        }
      };
    }
    const notification = normalizeHookNotificationInvocation(
      agent,
      hookEvent,
      payload,
      environment
    );
    if (notification) {
      return {
        disposition: "applied",
        productAction: {
          type: "notification.create",
          workspaceId: workspace.id,
          paneId: pane.id,
          surfaceId: surface.id,
          title: notification.title,
          message: notification.message,
          source: notification.source,
          agent: notification.agent
        }
      };
    }
    return { disposition: "suppressed", reason: "unsupported-agent-hook" };
  }

  // Match the local terminal contract: BEL is recorded as an acknowledged
  // terminal side effect but does not create a notification-center item.
  if (event.kind === "notification" && event.name === "terminal.bell") {
    return { disposition: "suppressed", reason: "terminal-bell" };
  }

  if (event.kind === "osc-notification") {
    const title = boundedRemoteEventText(payload.title) ?? surface.title;
    const message =
      boundedRemoteEventText(payload.message) ??
      boundedRemoteEventText(payload.body) ??
      boundedRemoteEventText(payload.text) ??
      title;
    const vendor = options.getSurfaceVendor?.(surface.id) ?? "unknown";
    const terminalDecision = classifyAgentTerminalNotification(
      vendor,
      title,
      message
    );
    if (terminalDecision.disposition === "needs_input") {
      const protocol =
        typeof payload.protocol === "number" &&
        Number.isInteger(payload.protocol)
          ? payload.protocol
          : undefined;
      return {
        disposition: "applied",
        productAction: {
          type: "agent.event",
          workspaceId: workspace.id,
          paneId: pane.id,
          surfaceId: surface.id,
          sessionId: session.id,
          agent: "codex",
          event: "needs_input",
          title: "Codex needs input",
          message,
          details: {
            ...eventDetails,
            uiOnly: true,
            ...(options.isSurfaceVisibleToUser?.(surface.id)
              ? { visibleToUser: true }
              : {}),
            ...(terminalDecision.inferredFromUnknownVendor
              ? { inferredFromUnknownVendor: true }
              : {}),
            source: "terminal",
            ...(protocol === undefined ? {} : { protocol }),
            terminalTitle: title
          }
        }
      };
    }
    if (terminalDecision.disposition === "suppressed") {
      return {
        disposition: "suppressed",
        reason: terminalDecision.reason
      };
    }
    if (options.isSurfaceVisibleToUser?.(surface.id)) {
      return {
        disposition: "suppressed",
        reason: "visible-terminal-notification"
      };
    }
    return {
      disposition: "applied",
      productAction: {
        type: "notification.create",
        workspaceId: workspace.id,
        paneId: pane.id,
        surfaceId: surface.id,
        title,
        message,
        source: "terminal",
        kind: "generic"
      }
    };
  }

  const title = boundedRemoteEventText(payload.title) ?? event.name;
  const message =
    boundedRemoteEventText(payload.message) ??
    boundedRemoteEventText(payload.body) ??
    boundedRemoteEventText(payload.text) ??
    title;
  const agent = boundedRemoteEventText(payload.agent, 128);
  const kind =
    payload.kind === "needs_input" || payload.kind === "turn_complete"
      ? payload.kind
      : "generic";
  return {
    disposition: "applied",
    productAction: {
      type: "notification.create",
      workspaceId: workspace.id,
      paneId: pane.id,
      surfaceId: surface.id,
      title,
      message,
      source: "agent",
      kind,
      ...(agent === undefined ? {} : { agent })
    }
  };
}

function plainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function boundedRemoteEventText(
  value: unknown,
  maximum = 4 * 1024
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maximum) : undefined;
}

function countWorkspacePanes(
  workspace: AppState["workspaces"][string]
): number {
  return Object.values(workspace.nodeMap).filter((node) => node.kind === "leaf")
    .length;
}

function encodeStoredLaunch(
  launch: AppState["sessions"][string]["launch"]
): Extract<RemoteOperationPayloadDto, { kind: "session.restart" }>["launch"] {
  return {
    cwd: encodeLocatedPathDto(launch.cwd).path,
    ...(launch.shell === undefined ? {} : { shell: launch.shell }),
    ...(launch.args === undefined ? {} : { args: [...launch.args] }),
    ...(launch.env === undefined ? {} : { env: { ...launch.env } }),
    ...(launch.title === undefined ? {} : { title: launch.title }),
    ...(launch.initialInput === undefined
      ? {}
      : { initialInput: launch.initialInput })
  };
}

function normalizeInitialInput(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function latestProjectedSessionRevision(
  state: AppState,
  workspaceId: Id,
  sessionId: Id
) {
  const session = state.sessions[sessionId];
  let revision = session?.remoteRuntime?.remoteResourceRevision ?? uint64(0n);
  for (const operation of Object.values(state.remoteRecovery.operations)) {
    if (
      operation.resourceKey.workspaceId !== workspaceId ||
      operation.resourceKey.sessionId !== sessionId ||
      operation.state === "failed"
    ) {
      continue;
    }
    if (operation.nextRemoteResourceRevision > revision) {
      revision = operation.nextRemoteResourceRevision;
    }
  }
  return revision;
}

function remoteResourceIdentity(resourceKey: RemoteResourceKey): string {
  return [
    resourceKey.desktopInstallationId,
    resourceKey.targetId,
    resourceKey.workspaceId,
    resourceKey.sessionId ?? ""
  ].join("\0");
}

export function compareRemoteOperationRetryOrder(
  left: RemoteOperationProjection,
  right: RemoteOperationProjection
): number {
  if (sameRemoteResource(left.resourceKey, right.resourceKey)) {
    const revisionOrder =
      left.expectedRemoteResourceRevision < right.expectedRemoteResourceRevision
        ? -1
        : left.expectedRemoteResourceRevision >
            right.expectedRemoteResourceRevision
          ? 1
          : 0;
    if (revisionOrder !== 0) return revisionOrder;
  }
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    left.operationId.localeCompare(right.operationId)
  );
}

function sameRemoteResource(
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

function decodeHello(
  value: unknown
): Extract<RemoteBridgeResponseBody, { type: "hello" }> {
  const body = decodeValidatedResponseBody("main-hello-validation", value);
  if (body.type !== "hello") {
    throw new TypeError("remote-host returned a non-hello handshake");
  }
  return body;
}

function decodeObservedState(
  value: unknown,
  persistenceLevel: RemotePersistenceLevel | undefined
): RemoteObservedState {
  const body = decodeValidatedResponseBody(
    "main-observation-validation",
    value
  );
  if (body.type !== "observed") {
    throw new TypeError("remote-host returned a non-observation response");
  }
  if (persistenceLevel === undefined) {
    throw new TypeError("remote persistence capability is unavailable");
  }
  return {
    targetId: body.targetId,
    targetStatus: "ready",
    inventoryComplete: true,
    bridgeGeneration: body.bridgeGeneration,
    persistenceLevel,
    workspaces: (body.workspaces ?? []).map((workspace) => ({
      resourceKey: {
        desktopInstallationId: workspace.resourceKey.desktopInstallationId,
        targetId: workspace.resourceKey.targetId,
        workspaceId: workspace.resourceKey.workspaceId
      },
      state: workspace.state,
      remoteResourceRevision: parseUint64Decimal(
        workspace.remoteResourceRevision
      ),
      createOperationId: workspace.createOperationId,
      canonicalCreatePayloadHash: workspace.canonicalCreatePayloadHash,
      lastOperationId: workspace.lastOperationId,
      lastOperationPayloadHash: workspace.lastOperationPayloadHash,
      lastResultDigest: workspace.lastResultDigest
    })),
    keepers: body.keepers.map((keeper) => ({
      resourceKey: {
        desktopInstallationId: keeper.resourceKey.desktopInstallationId,
        targetId: keeper.resourceKey.targetId,
        workspaceId: keeper.resourceKey.workspaceId,
        sessionId: keeper.resourceKey.sessionId
      },
      generation: keeper.keeperGeneration,
      ...(keeper.descriptorState === undefined
        ? {}
        : { descriptorState: keeper.descriptorState }),
      processState: keeper.processState,
      remoteResourceRevision: parseUint64Decimal(keeper.remoteResourceRevision),
      persistenceLevel,
      storageStatus: {
        state: keeper.storageStatus.state,
        journalAdmitted: parseUint64Decimal(
          keeper.storageStatus.journalAdmitted
        ),
        journalSynced: parseUint64Decimal(keeper.storageStatus.journalSynced),
        emergencyBytes: keeper.storageStatus.emergencyBytes,
        ...(keeper.storageStatus.lastSyncDurationMs === undefined
          ? {}
          : {
              lastSyncDurationMs: keeper.storageStatus.lastSyncDurationMs
            })
      },
      checkpointAvailable: keeper.checkpointAvailable,
      retainedRangeTruncated: keeper.retainedRangeTruncated,
      ...(keeper.exitCode === undefined ? {} : { exitCode: keeper.exitCode }),
      descriptor: {
        createOperationId: keeper.createOperationId,
        canonicalCreatePayloadHash: keeper.canonicalCreatePayloadHash,
        lastOperationId: keeper.lastOperationId,
        lastOperationPayloadHash: keeper.lastOperationPayloadHash,
        lastResultDigest: keeper.lastResultDigest,
        launch: structuredClone(keeper.launch),
        lifecycleState: keeper.lifecycleState,
        ...(keeper.conversionTransactionId === undefined
          ? {}
          : { conversionTransactionId: keeper.conversionTransactionId }),
        ...(keeper.remoteSnapshotHash === undefined
          ? {}
          : { remoteSnapshotHash: keeper.remoteSnapshotHash }),
        ...(keeper.provisionalCreatedAt === undefined
          ? {}
          : { provisionalCreatedAt: keeper.provisionalCreatedAt }),
        everGrantedWriterLease: keeper.everGrantedWriterLease
      }
    })),
    lastObservedAt: body.observedAt
  };
}

function decodeValidatedResponseBody(
  requestId: Id,
  value: unknown
): RemoteBridgeResponseBody {
  const envelope = decodeRemoteBridgeResponseEnvelope(
    encodeRemoteControlJson({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      requestId,
      status: "ok",
      body: value
    })
  );
  if (envelope.status !== "ok") {
    throw new TypeError("remote-host response validation failed");
  }
  return envelope.body;
}

function assertVerifiedAuthority(
  binding: RemoteTargetBinding,
  hello: Extract<RemoteBridgeResponseBody, { type: "hello" }>
): void {
  const expected = binding.authority;
  const actual = hello.authority;
  if (
    actual.remoteInstallationId !== expected.remoteInstallationId ||
    actual.executionNodeId !== expected.executionNodeId ||
    actual.authenticatedPrincipal.uid !== expected.authenticatedPrincipal.uid ||
    actual.authenticatedPrincipal.accountName !==
      expected.authenticatedPrincipal.accountName
  ) {
    throw new Error("remote authority does not match the verified target");
  }
}

function sameVerifiedAuthority(
  binding: RemoteTargetBinding,
  verification: RemoteHostTargetVerification
): boolean {
  const expected = binding.authority;
  const actual = verification.doctor;
  return (
    actual.remoteInstallationId === expected.remoteInstallationId &&
    actual.executionNodeId === expected.executionNodeId &&
    actual.authenticatedPrincipal.uid === expected.authenticatedPrincipal.uid &&
    actual.authenticatedPrincipal.accountName ===
      expected.authenticatedPrincipal.accountName
  );
}

function observedBindingFromHello(
  binding: RemoteTargetBinding,
  hello: Extract<RemoteBridgeResponseBody, { type: "hello" }>
): RemoteTargetBinding {
  return validateRemoteTargetBinding({
    ...structuredClone(binding),
    observation: {
      platform: hello.platform,
      arch: hello.arch,
      abi: hello.abi,
      runtimeVersion: hello.runtimeVersion,
      capabilities: [...hello.capabilities],
      persistenceLevel: hello.persistenceLevel
    }
  });
}

function advanceBindingVerification(
  binding: RemoteTargetBinding
): RemoteTargetBinding {
  const previous = Date.parse(binding.locator.lastVerifiedAt);
  const next = new Date(Math.max(Date.now(), previous + 1)).toISOString();
  return validateRemoteTargetBinding({
    ...structuredClone(binding),
    locator: {
      ...structuredClone(binding.locator),
      lastVerifiedAt: next
    }
  });
}

export function selectVerifiedRemoteRuntimeArtifact(
  hello: Extract<RemoteBridgeResponseBody, { type: "hello" }>
): "darwin-arm64" | "darwin-x64" | "linux-arm64-musl" | "linux-x64-musl" {
  const tuple = `${hello.platform}/${hello.arch}/${hello.abi}`;
  switch (tuple) {
    case "macos/aarch64/native":
    case "darwin/aarch64/native":
      return "darwin-arm64";
    case "macos/x86_64/native":
    case "darwin/x86_64/native":
      return "darwin-x64";
    case "linux/aarch64/musl":
      return "linux-arm64-musl";
    case "linux/x86_64/musl":
      return "linux-x64-musl";
    default:
      throw new Error(`unsupported remote runtime ${tuple}`);
  }
}

function mapRuntimeOutcome(
  operationId: Id,
  outcome: RemoteRuntimeOperationOutcome,
  payload: RemoteOperationPayloadDto
): Exclude<RemoteOperationExecutionOutcome, { status: "pending" }> {
  if (outcome.operationId !== operationId) {
    throw new Error("remote operation result identity does not match");
  }
  if (outcome.status === "succeeded") {
    const initialInputRequested =
      (payload.kind === "session.create" ||
        payload.kind === "session.restart") &&
      payload.launch.initialInput !== undefined;
    const initialInputOutcome =
      outcome.initialInputOutcome ??
      (initialInputRequested ? "outcome-unknown" : undefined);
    return {
      status: "succeeded",
      remoteResourceRevision: outcome.remoteResourceRevision,
      resultDigest: outcome.resultDigest,
      ...(outcome.keeperGeneration === undefined
        ? {}
        : { keeperGeneration: outcome.keeperGeneration }),
      ...(initialInputOutcome === undefined ? {} : { initialInputOutcome })
    };
  }
  return {
    status: "failed",
    resultDigest: outcome.resultDigest,
    code: outcome.code,
    message: outcome.message
  };
}

function retainedTerminationPayload(
  resourceKey: RemoteResourceKey & { sessionId: Id }
): Extract<RemoteOperationPayloadDto, { kind: "session.terminate" }> {
  return { kind: "session.terminate", sessionId: resourceKey.sessionId };
}

function retainedWorkspaceRevision(
  entry: RetainedSessionInventoryEntry
): string {
  return sha256(
    [
      "retained-workspace-revision-v1",
      entry.resourceKey.desktopInstallationId,
      entry.resourceKey.targetId,
      entry.resourceKey.workspaceId,
      entry.resourceKey.sessionId,
      entry.keeperGeneration,
      entry.remoteResourceRevision.toString(10)
    ].join("\0")
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
