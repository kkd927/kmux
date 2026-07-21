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
  type RemotePersistenceLevel,
  type RemoteSpoolEventDto,
  type RetainedRemoteSessionsSnapshot,
  type TerminalKeyInput
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
import type {
  ConversionCleanupAcknowledgement,
  ConversionLocalCleanupTarget,
  ConversionWalStore
} from "./conversionWal";
import type {
  RetainedSessionInventoryEntry,
  RetainedSessionInventoryStore
} from "./retainedSessionInventory";
import type { RemoteEventReceiptStore } from "./remoteEventReceiptStore";
import { createBoundRemoteTerminalControlProvider } from "./remoteTerminalControlProvider";
import { createRemoteHostConversionGateway } from "./remoteConversionGateway";
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
  createTransactionalWorkspaceConversionRuntime,
  decodeStartWorkspaceConversionRequest,
  type StartWorkspaceConversionRequest
} from "./transactionalWorkspaceConversion";

export interface CreateRemoteLifecycleRuntimeOptions {
  desktopInstallationId: Id;
  operationStore: DurableRemoteOperationStore;
  host: RemoteHostManager;
  hostEnv?: NodeJS.ProcessEnv;
  getState: () => AppState;
  getTargetBinding: (targetId: Id) => RemoteTargetBinding | undefined;
  replaceTargetBinding: (binding: RemoteTargetBinding) => void;
  dispatchFact: (fact: MainFact) => void;
  dispatchAppAction?: (action: AppAction) => void;
  eventReceiptStore?: RemoteEventReceiptStore;
  reportError?: (error: Error) => void;
  retainedInventory?: RetainedSessionInventoryStore;
  closeWorkspaceProduct?: (workspaceId: Id) => void;
  persistDurableProductSnapshot?: (state: AppState) => void;
  conversion?: {
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

/**
 * Main-owned remote control-plane composition. It is deliberately absent from
 * terminal byte handling: its only terminal responsibility is returning an
 * exact, already-authorized MessagePort bind capability to the common attach
 * controller.
 */
export class RemoteLifecycleRuntime {
  private readonly coordinator;
  private readonly reconciler;
  private readonly conversionRuntime;
  private readonly connections = new Map<Id, RemoteHostTargetConnectOptions>();
  private readonly connectedTargets = new Set<Id>();
  private readonly targetPersistenceLevels = new Map<
    Id,
    RemotePersistenceLevel
  >();
  private readonly targetQueues = new Map<Id, Promise<unknown>>();
  private readonly eventReplayScheduled = new Set<Id>();
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
        void this.enqueueTarget(connection.targetId, async () => {
          try {
            await this.connectTargetNow(connection);
          } catch (error) {
            this.report(error);
          }
        });
      }
    }, delayMs);
    this.runtimeReconnectTimer.unref();
  };

  private readonly onTargetLost = (event: RemoteHostTargetLostEvent): void => {
    if (this.stopping) return;
    const connection = this.connections.get(event.targetId);
    if (!connection) return;
    this.connectedTargets.delete(event.targetId);
    this.markObservationUnknown(event.targetId);
    void this.enqueueTarget(event.targetId, async () => {
      if (
        this.stopping ||
        this.connections.get(event.targetId) !== connection
      ) {
        return;
      }
      try {
        await this.connectTargetNow(structuredClone(connection));
      } catch (error) {
        this.report(error);
      }
    });
  };

  constructor(private readonly options: CreateRemoteLifecycleRuntimeOptions) {
    this.coordinator = createRemoteOperationCoordinator({
      desktopInstallationId: options.desktopInstallationId,
      store: options.operationStore,
      getState: options.getState,
      getTargetBinding: options.getTargetBinding,
      dispatchFact: (fact) => options.dispatchFact(fact)
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
    this.conversionRuntime = options.conversion
      ? createTransactionalWorkspaceConversionRuntime({
          desktopInstallationId: options.desktopInstallationId,
          wal: options.conversion.wal,
          remote: createRemoteHostConversionGateway(options.host),
          getState: options.getState,
          getTargetBinding: options.getTargetBinding,
          getLocalRuntimeEpoch: options.conversion.getLocalRuntimeEpoch,
          forceDesktopSnapshot: options.conversion.forceDesktopSnapshot,
          installDesktopState: options.conversion.installDesktopState,
          terminateLocalSession: options.conversion.terminateLocalSession
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
    this.coordinator.recover();
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
      this.options.host.start(this.options.hostEnv);
      if (!this.options.host.isRunning()) {
        throw new Error("remote-host failed to start");
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
      if (this.options.host.isRunning()) {
        await this.options.host.disconnectTarget(targetId);
      }
    });
  }

  async cleanTargetRuntime(targetId: Id) {
    return await this.enqueueTarget(targetId, async () => {
      if (
        !this.connectedTargets.has(targetId) ||
        !this.options.host.isRunning()
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
        !this.options.host.isRunning()
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
    product: RemoteOperationProductMetadata = {}
  ): Promise<RemoteOperationCommandResult> {
    const operation = this.coordinator.admit(command, product);
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
        ...(title === undefined ? {} : { title })
      }
    };
    const create = await this.executeCommand(
      {
        type: "remote-operation.command",
        workspaceId: workspace.id,
        payload,
        expectedRemoteResourceRevision: uint64(0n)
      },
      initialInput === undefined ? {} : { initialInput }
    );
    await this.admitLaunchInputAfter(
      workspace.id,
      sessionId,
      initialInput,
      create,
      uint64(1n)
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
    const initialInput = normalizeInitialInput(session.launch.initialInput);
    const restart = await this.executeCommand({
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
    await this.admitLaunchInputAfter(
      workspace.id,
      session.id,
      initialInput,
      restart,
      incrementUint64(expectedRevision)
    );
  }

  private async admitLaunchInputAfter(
    workspaceId: Id,
    sessionId: Id,
    initialInput: string | undefined,
    predecessor: RemoteOperationCommandResult,
    pendingRevision: ReturnType<typeof uint64>
  ): Promise<void> {
    if (initialInput === undefined || predecessor.outcome.status === "failed") {
      return;
    }
    await this.executeCommand({
      type: "remote-operation.command",
      workspaceId,
      expectedRemoteResourceRevision:
        predecessor.outcome.status === "succeeded"
          ? predecessor.outcome.remoteResourceRevision
          : pendingRevision,
      payload: { kind: "launch-input", sessionId, input: initialInput }
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
      Object.values(state.remoteOperations).some(
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

  async startWorkspaceConversion(request: StartWorkspaceConversionRequest) {
    const validated = decodeStartWorkspaceConversionRequest(request);
    if (
      !this.conversionRuntime ||
      !this.connectedTargets.has(validated.targetId)
    ) {
      throw new Error(
        "workspace conversion requires a connected conversion runtime"
      );
    }
    const record = await this.conversionRuntime.start(validated);
    if (record.state === "cleanup-complete") {
      await this.tryReconcile(validated.targetId);
      this.conversionRuntime.compactCompleted(record.transactionId);
    }
    return record;
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
        canTerminate:
          entry.processState === "running" && entry.termination === undefined
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
  ): Promise<RemoteOperationCommandResult> {
    if (
      resourceKey.desktopInstallationId !== this.options.desktopInstallationId
    ) {
      throw new Error(
        "retained-session termination belongs to another desktop installation"
      );
    }
    this.requireBinding(resourceKey.targetId);
    const inventory = this.requireRetainedInventory();
    let entry = inventory.get(resourceKey);
    if (!entry || entry.ownership !== "retained") {
      throw new Error("retained-session termination target is unavailable");
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
    const admission = entry.termination;
    if (!admission) {
      throw new Error("retained-session termination admission was not stored");
    }
    const operationId = admission.operationId;
    const outcome = await this.enqueueTarget(resourceKey.targetId, () =>
      this.executeRetainedTermination(entry)
    );
    if (outcome.status === "succeeded") {
      await this.tryReconcile(resourceKey.targetId);
    }
    return { operationId, outcome };
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
    this.options.host.start(this.options.hostEnv);
    if (!this.options.host.isRunning()) {
      throw new Error("remote-host failed to start");
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
      observedBinding = observedBindingFromHello(binding, hello);
    } catch (error) {
      this.connectedTargets.delete(connection.targetId);
      this.markTargetMismatch(connection.targetId);
      await this.options.host
        .disconnectTarget(connection.targetId)
        .catch(() => undefined);
      throw error;
    }
    try {
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
      if (this.conversionRuntime && this.options.conversion) {
        const recovered = await this.conversionRuntime.recoverTarget(
          connection.targetId
        );
        for (const record of recovered) {
          if (record.state === "cleanup-complete") {
            this.conversionRuntime.compactCompleted(record.transactionId);
          }
        }
        const protectedTransactionIds = this.options.conversion.wal
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
      this.options.getState().remoteEventReceipts[targetId];
    const productThrough = productReceipt?.throughSequence ?? uint64(0n);
    if (productThrough < receipt.appliedThrough) {
      throw new Error(
        "remote event receipt advanced beyond the durable product snapshot"
      );
    }
    if (receipt.pending) {
      await this.applyStagedRemoteEvent(receipt.pending, dispatch, persist);
      receipt = store.complete(receipt.pending);
    }
    const recoveredProductReceipt =
      this.options.getState().remoteEventReceipts[targetId];
    const recoveredProductThrough =
      recoveredProductReceipt?.throughSequence ?? uint64(0n);
    if (recoveredProductThrough !== receipt.appliedThrough) {
      throw new Error(
        "remote event product receipt does not match its durable cursor"
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
        await this.applyStagedRemoteEvent(event, dispatch, persist);
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

  private async applyStagedRemoteEvent(
    event: RemoteSpoolEventDto,
    dispatch: (action: AppAction) => void,
    persist: (state: AppState) => Promise<string> | string | void
  ): Promise<void> {
    const sequence = parseUint64Decimal(event.sequence);
    const productAction = normalizeRemoteSpoolEvent(
      this.options.getState(),
      event
    );
    dispatch({
      type: "remote.event.apply",
      targetId: event.resourceKey.targetId,
      sequence,
      eventId: event.eventId,
      ...(productAction === undefined ? {} : { productAction })
    });
    await persist(this.options.getState());
    const receipt =
      this.options.getState().remoteEventReceipts[event.resourceKey.targetId];
    if (!receipt || receipt.throughSequence < sequence) {
      throw new Error("remote event product receipt was not durably projected");
    }
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
    return this.coordinator.execute(
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
        return mapRuntimeOutcome(operationId, outcome);
      },
      {
        afterResult: () => this.tryReconcile(targetId)
      }
    );
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
    const outcome = mapRuntimeOutcome(termination.operationId, runtimeOutcome);
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
      this.options.getState().remoteOperations
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

function normalizeRemoteSpoolEvent(
  state: AppState,
  event: RemoteSpoolEventDto
): RemoteEventProductAction | undefined {
  const workspace = state.workspaces[event.resourceKey.workspaceId];
  const surface = state.surfaces[event.surfaceId];
  const pane = surface ? state.panes[surface.paneId] : undefined;
  const session = state.sessions[event.resourceKey.sessionId];
  if (
    !workspace ||
    !surface ||
    !pane ||
    !session ||
    pane.workspaceId !== workspace.id ||
    terminalSessionForSurface(state, surface.id)?.id !== session.id ||
    session.surfaceId !== surface.id ||
    workspace.location.target.kind !== "ssh" ||
    workspace.location.target.targetId !== event.resourceKey.targetId ||
    session.remoteRuntime?.keeperGeneration !== event.keeperGeneration
  ) {
    return undefined;
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
      KMUX_PANE_ID: pane.id,
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
        type: "agent.event",
        workspaceId: workspace.id,
        paneId: pane.id,
        surfaceId: surface.id,
        sessionId: session.id,
        agent: normalized.agent,
        event: normalized.event,
        title: normalized.title,
        message: normalized.message,
        details: { ...(normalized.details ?? {}), ...eventDetails }
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
        type: "notification.create",
        workspaceId: workspace.id,
        paneId: pane.id,
        surfaceId: surface.id,
        title: notification.title,
        message: notification.message,
        source: notification.source,
        agent: notification.agent
      };
    }
    return undefined;
  }

  // Match the local terminal contract: BEL is recorded as an acknowledged
  // terminal side effect but does not create a notification-center item.
  if (event.kind === "notification" && event.name === "terminal.bell") {
    return undefined;
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
    type: "notification.create",
    workspaceId: workspace.id,
    paneId: pane.id,
    surfaceId: surface.id,
    title,
    message,
    source: event.kind === "osc-notification" ? "terminal" : "agent",
    kind,
    ...(agent === undefined ? {} : { agent })
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
    ...(launch.title === undefined ? {} : { title: launch.title })
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
  for (const operation of Object.values(state.remoteOperations)) {
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
  outcome: RemoteRuntimeOperationOutcome
): Exclude<RemoteOperationExecutionOutcome, { status: "pending" }> {
  if (outcome.operationId !== operationId) {
    throw new Error("remote operation result identity does not match");
  }
  return outcome.status === "succeeded"
    ? {
        status: "succeeded",
        remoteResourceRevision: outcome.remoteResourceRevision,
        resultDigest: outcome.resultDigest,
        ...(outcome.keeperGeneration === undefined
          ? {}
          : { keeperGeneration: outcome.keeperGeneration })
      }
    : {
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
