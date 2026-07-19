import { createHash } from "node:crypto";

import {
  canonicalizeRemoteOperationPayload,
  cloneState,
  decodeRemoteOperationPayload,
  decodeRemotePath,
  validateRemoteTargetBinding,
  type AppState,
  type RemoteOperationAdmissionCommand,
  type RemoteOperationExecutionOutcome as CoreRemoteOperationExecutionOutcome,
  type RemoteOperationIntent,
  type RemoteOperationPayloadDto,
  type RemoteResourceKey,
  type RemoteTargetBinding,
  type RemoteWorktreeProductMetadata
} from "@kmux/core";
import {
  applyMainRemoteOperationFact,
  computeWorkspaceRevision,
  createRemoteOperationPendingFact,
  MainFactConflictError,
  type MainRemoteOperationFact
} from "@kmux/core/main";
import { incrementUint64, makeId, uint64, type Id } from "@kmux/proto";

import type {
  AuthoritativeRemoteOperationResult,
  DurableRemoteOperationRecord,
  DurableRemoteOperationStore
} from "./durableRemoteOperationStore";

export type { RemoteOperationAdmissionCommand } from "@kmux/core";

export type RemoteOperationExecutionOutcome =
  CoreRemoteOperationExecutionOutcome;

export interface RemoteOperationProductMetadata {
  initialInput?: string;
  worktree?: RemoteWorktreeProductMetadata;
}

export interface RemoteOperationCoordinator {
  admit(
    command: RemoteOperationAdmissionCommand,
    product?: RemoteOperationProductMetadata
  ): DurableRemoteOperationRecord;
  execute(
    operationId: Id,
    executor: (
      operation: DurableRemoteOperationRecord
    ) => Promise<RemoteOperationExecutionOutcome>
  ): Promise<RemoteOperationExecutionOutcome>;
  recordAuthoritativeResult(
    operationId: Id,
    outcome: Exclude<RemoteOperationExecutionOutcome, { status: "pending" }>
  ): DurableRemoteOperationRecord;
  recover(): DurableRemoteOperationRecord[];
}

export interface CreateRemoteOperationCoordinatorOptions {
  desktopInstallationId: Id;
  store: DurableRemoteOperationStore;
  getState: () => AppState;
  getTargetBinding: (targetId: Id) => RemoteTargetBinding | undefined;
  dispatchFact: (fact: MainRemoteOperationFact) => void;
  makeOperationId?: () => Id;
  now?: () => string;
}

export function createRemoteOperationCoordinator(
  options: CreateRemoteOperationCoordinatorOptions
): RemoteOperationCoordinator {
  const operationIdFactory =
    options.makeOperationId ?? (() => makeId("remote-operation"));
  const now = options.now ?? (() => new Date().toISOString());
  const queues = new Map<string, Promise<unknown>>();

  const requireVerifiedBinding = (targetId: Id): RemoteTargetBinding => {
    const candidateBinding = options.getTargetBinding(targetId);
    const binding = candidateBinding
      ? validateRemoteTargetBinding(candidateBinding)
      : undefined;
    if (!binding || binding.id !== targetId) {
      throw new Error("remote target binding is unavailable or mismatched");
    }
    return binding;
  };

  const recordAuthoritativeResult = (
    operationId: Id,
    outcome: Exclude<RemoteOperationExecutionOutcome, { status: "pending" }>
  ): DurableRemoteOperationRecord => {
    const operation = options.store.get(operationId);
    if (!operation) {
      throw new Error(`remote operation ${operationId} is not admitted`);
    }
    assertDesktopInstallationScope(operation, options.desktopInstallationId);
    const completedAt = outcome.completedAt ?? now();
    const result = toAuthoritativeResult(operationId, outcome, completedAt);
    const fact = toResultFact(result);
    // Reject a malformed or stale authoritative outcome before making it part
    // of the durable recovery log. The real dispatch remains after fsync so a
    // process crash cannot expose a terminal projection without its record.
    applyMainRemoteOperationFact(cloneState(options.getState()), fact);
    const persisted = options.store.recordResult(operationId, result, fact);
    options.dispatchFact(fact);
    return persisted;
  };

  return Object.freeze({
    admit(
      command: RemoteOperationAdmissionCommand,
      product: RemoteOperationProductMetadata = {}
    ): DurableRemoteOperationRecord {
      const validated = decodeRemoteOperationAdmissionCommand(command);
      const state = options.getState();
      const { workspace, targetId } = authorizeCommand(state, validated);
      requireVerifiedBinding(targetId);
      const operationId = operationIdFactory();
      const resourceKey: RemoteResourceKey = {
        desktopInstallationId: options.desktopInstallationId,
        targetId,
        workspaceId: workspace.id,
        ...("sessionId" in validated.payload
          ? { sessionId: validated.payload.sessionId }
          : {})
      };
      const canonicalPayload = canonicalizeRemoteOperationPayload(
        validated.payload
      );
      const createdAt = now();
      const intent: RemoteOperationIntent = {
        operationId,
        kind: validated.payload.kind,
        resourceKey,
        expectedWorkspaceRevision: computeWorkspaceRevision(
          state,
          workspace.id
        ),
        expectedRemoteResourceRevision:
          validated.expectedRemoteResourceRevision,
        nextRemoteResourceRevision: incrementUint64(
          validated.expectedRemoteResourceRevision
        ),
        ...(validated.payload.kind === "workspace.create" ||
        validated.payload.kind === "session.create"
          ? { createOperationId: operationId }
          : {}),
        canonicalPayloadHash: sha256(canonicalPayload),
        createdAt
      };
      const pendingFact = createRemoteOperationPendingFact(
        state,
        intent,
        validated.payload,
        product.initialInput,
        product.worktree
      );
      applyMainRemoteOperationFact(cloneState(state), pendingFact);
      const persisted = options.store.admit({
        intent,
        payload: validated.payload,
        pendingFact,
        outbox: { admittedAt: createdAt }
      });
      // Store admission is the acknowledgement boundary for pending UI state.
      options.dispatchFact(pendingFact);
      return persisted;
    },

    execute(
      operationId: Id,
      executor: (
        operation: DurableRemoteOperationRecord
      ) => Promise<RemoteOperationExecutionOutcome>
    ): Promise<RemoteOperationExecutionOutcome> {
      const operation = options.store.get(operationId);
      if (!operation) {
        return Promise.reject(
          new Error(`remote operation ${operationId} is not admitted`)
        );
      }
      const queueKey = serializeResourceKey(operation.intent.resourceKey);
      return enqueue(queues, queueKey, async () => {
        const current = options.store.get(operationId);
        if (!current) {
          throw new Error(`remote operation ${operationId} disappeared`);
        }
        assertDesktopInstallationScope(current, options.desktopInstallationId);
        if (current.result) {
          options.dispatchFact(current.result.fact);
          return fromAuthoritativeResult(current.result.authoritative);
        }
        requireVerifiedBinding(current.intent.resourceKey.targetId);
        let outcome: RemoteOperationExecutionOutcome;
        try {
          outcome = await executor(current);
        } catch {
          return { status: "pending", reason: "ambiguous" };
        }
        if (outcome.status === "pending") {
          return outcome;
        }
        recordAuthoritativeResult(operationId, outcome);
        return outcome;
      });
    },

    recordAuthoritativeResult,

    recover(): DurableRemoteOperationRecord[] {
      const operations = options.store.loadAll();
      for (const operation of operations) {
        assertDesktopInstallationScope(
          operation,
          options.desktopInstallationId
        );
      }
      replayPersistedFacts(operations, options.dispatchFact);
      return operations;
    }
  });
}

function assertDesktopInstallationScope(
  operation: DurableRemoteOperationRecord,
  desktopInstallationId: Id
): void {
  if (
    operation.intent.resourceKey.desktopInstallationId !== desktopInstallationId
  ) {
    throw new Error(
      "durable remote operation belongs to another desktop installation"
    );
  }
}

function replayPersistedFacts(
  operations: DurableRemoteOperationRecord[],
  dispatchFact: (fact: MainRemoteOperationFact) => void
): void {
  let remaining = operations.flatMap((operation) => [
    operation.pendingFact,
    ...(operation.result ? [operation.result.fact] : [])
  ]);
  while (remaining.length > 0) {
    const deferred: MainRemoteOperationFact[] = [];
    let applied = 0;
    for (const fact of remaining) {
      try {
        dispatchFact(fact);
        applied += 1;
      } catch (error) {
        if (
          error instanceof MainFactConflictError &&
          (error.code === "workspace-revision-conflict" ||
            error.code === "operation-missing")
        ) {
          deferred.push(fact);
          continue;
        }
        throw error;
      }
    }
    if (applied === 0) {
      throw new Error(
        `durable remote operation facts have unresolved dependencies: ${deferred
          .map((fact) =>
            fact.type === "remote-operation.pending"
              ? fact.projection.operationId
              : fact.operationId
          )
          .join(", ")}`
      );
    }
    remaining = deferred;
  }
}

export function decodeRemoteOperationAdmissionCommand(
  value: unknown
): RemoteOperationAdmissionCommand {
  const record = requireRecord(value, "remote operation command");
  assertExactKeys(record, [
    "type",
    "workspaceId",
    "payload",
    "expectedRemoteResourceRevision"
  ]);
  if (record.type !== "remote-operation.command") {
    throw new TypeError("remote operation command type is not allowlisted");
  }
  const workspaceId = requireId(record.workspaceId, "workspaceId");
  if (typeof record.expectedRemoteResourceRevision !== "bigint") {
    throw new TypeError(
      "expectedRemoteResourceRevision must be an in-memory bigint"
    );
  }
  return {
    type: record.type,
    workspaceId,
    payload: decodeRemoteOperationPayload(record.payload),
    expectedRemoteResourceRevision: uint64(
      record.expectedRemoteResourceRevision
    )
  };
}

function authorizeCommand(
  state: AppState,
  command: RemoteOperationAdmissionCommand
): {
  workspace: AppState["workspaces"][string];
  targetId: Id;
} {
  const workspace = state.workspaces[command.workspaceId];
  if (!workspace) {
    throw new Error("remote operation workspace does not exist");
  }
  if (workspace.location.target.kind !== "ssh") {
    throw new Error("remote operation requires an SSH workspace");
  }
  const payload = command.payload;
  if ("workspaceId" in payload && payload.workspaceId !== workspace.id) {
    throw new Error("remote operation workspace scope does not match");
  }
  authorizePayloadOwnership(state, workspace.id, payload);
  authorizeRemotePaths(payload);
  return { workspace, targetId: workspace.location.target.targetId };
}

function authorizePayloadOwnership(
  state: AppState,
  workspaceId: Id,
  payload: RemoteOperationPayloadDto
): void {
  switch (payload.kind) {
    case "session.create": {
      const pane = state.panes[payload.paneId];
      if (!pane || pane.workspaceId !== workspaceId) {
        throw new Error("session create pane does not belong to the workspace");
      }
      if (
        state.sessions[payload.sessionId] ||
        state.surfaces[payload.surfaceId]
      ) {
        throw new Error("session create identities are already in use");
      }
      return;
    }
    case "session.restart": {
      const session = requireWorkspaceSession(
        state,
        workspaceId,
        payload.sessionId
      );
      if (session.surfaceId !== payload.surfaceId) {
        throw new Error("session restart surface does not match");
      }
      return;
    }
    case "session.adopt": {
      const pane = state.panes[payload.paneId];
      if (!pane || pane.workspaceId !== workspaceId) {
        throw new Error("session adopt pane does not belong to the workspace");
      }
      if (
        state.sessions[payload.sessionId] ||
        state.surfaces[payload.surfaceId]
      ) {
        throw new Error("session adopt identities are already in use");
      }
      return;
    }
    case "session.terminate":
    case "launch-input":
      requireWorkspaceSession(state, workspaceId, payload.sessionId);
      return;
    case "workspace.create":
    case "workspace.terminate":
    case "worktree.create":
    case "worktree.remove":
    case "forward.ensure":
    case "forward.remove":
      return;
  }
}

function authorizeRemotePaths(payload: RemoteOperationPayloadDto): void {
  switch (payload.kind) {
    case "workspace.create":
      decodeRemotePath(payload.defaultCwd);
      return;
    case "session.create":
    case "session.restart":
    case "session.adopt":
      decodeRemotePath(payload.launch.cwd);
      return;
    case "worktree.create":
    case "worktree.remove":
      decodeRemotePath(payload.cwd);
      decodeRemotePath(payload.path);
      return;
    case "session.terminate":
    case "workspace.terminate":
    case "forward.ensure":
    case "forward.remove":
    case "launch-input":
      return;
  }
}

function requireWorkspaceSession(
  state: AppState,
  workspaceId: Id,
  sessionId: Id
): AppState["sessions"][string] {
  const session = state.sessions[sessionId];
  const surface = session ? state.surfaces[session.surfaceId] : undefined;
  const pane = surface ? state.panes[surface.paneId] : undefined;
  if (!session || !surface || !pane || pane.workspaceId !== workspaceId) {
    throw new Error("session does not belong to the remote workspace");
  }
  return session;
}

function toAuthoritativeResult(
  operationId: Id,
  outcome: Exclude<RemoteOperationExecutionOutcome, { status: "pending" }>,
  completedAt: string
): AuthoritativeRemoteOperationResult {
  if (outcome.status === "succeeded") {
    return {
      outcome: "succeeded",
      operationId,
      remoteResourceRevision: outcome.remoteResourceRevision,
      resultDigest: outcome.resultDigest,
      ...(outcome.keeperGeneration === undefined
        ? {}
        : { keeperGeneration: outcome.keeperGeneration }),
      completedAt
    };
  }
  return {
    outcome: "failed",
    operationId,
    resultDigest: outcome.resultDigest,
    code: outcome.code,
    message: outcome.message,
    completedAt
  };
}

function toResultFact(
  result: AuthoritativeRemoteOperationResult
): Exclude<MainRemoteOperationFact, { type: "remote-operation.pending" }> {
  return result.outcome === "succeeded"
    ? {
        type: "remote-operation.succeeded",
        operationId: result.operationId,
        remoteResourceRevision: result.remoteResourceRevision,
        resultDigest: result.resultDigest,
        ...(result.keeperGeneration === undefined
          ? {}
          : { keeperGeneration: result.keeperGeneration }),
        completedAt: result.completedAt
      }
    : {
        type: "remote-operation.failed",
        operationId: result.operationId,
        resultDigest: result.resultDigest,
        code: result.code,
        message: result.message,
        completedAt: result.completedAt
      };
}

function fromAuthoritativeResult(
  result: AuthoritativeRemoteOperationResult
): Exclude<RemoteOperationExecutionOutcome, { status: "pending" }> {
  return result.outcome === "succeeded"
    ? {
        status: "succeeded",
        remoteResourceRevision: result.remoteResourceRevision,
        resultDigest: result.resultDigest,
        ...(result.keeperGeneration === undefined
          ? {}
          : { keeperGeneration: result.keeperGeneration }),
        completedAt: result.completedAt
      }
    : {
        status: "failed",
        resultDigest: result.resultDigest,
        code: result.code,
        message: result.message,
        completedAt: result.completedAt
      };
}

function serializeResourceKey(resourceKey: RemoteResourceKey): string {
  return [
    resourceKey.desktopInstallationId,
    resourceKey.targetId,
    resourceKey.workspaceId
  ].join("\0");
}

function enqueue<T>(
  queues: Map<string, Promise<unknown>>,
  key: string,
  task: () => Promise<T>
): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  queues.set(key, next);
  const cleanup = (): void => {
    if (queues.get(key) === next) {
      queues.delete(key);
    }
  };
  void next.then(cleanup, cleanup);
  return next;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[]
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unexpected) {
    throw new TypeError(
      `unexpected remote operation command field: ${unexpected}`
    );
  }
}

function requireId(value: unknown, field: string): Id {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 256 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}
