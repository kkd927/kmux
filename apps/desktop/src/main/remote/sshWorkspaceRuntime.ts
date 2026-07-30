import { randomUUID } from "node:crypto";

import type { AppState } from "@kmux/core";
import type {
  SshWorkspaceCancelRequest,
  SshWorkspaceCommitRequest,
  SshWorkspaceOpenResult,
  SshWorkspacePrepareRequest,
  SshWorkspacePrepareResult
} from "@kmux/proto";

import type {
  ConnectedSshProfile,
  SshConnectionRuntime
} from "./sshConnectionRuntime";
import type { SshWorkspaceCreationRuntime } from "./sshWorkspaceCreationRuntime";

export interface SshWorkspaceRuntime {
  prepare(
    request: SshWorkspacePrepareRequest
  ): Promise<SshWorkspacePrepareResult>;
  commit(request: SshWorkspaceCommitRequest): Promise<SshWorkspaceOpenResult>;
  cancel(request: SshWorkspaceCancelRequest): void;
}

export function createSshWorkspaceRuntime(options: {
  connections: SshConnectionRuntime;
  creator: SshWorkspaceCreationRuntime;
  getState: () => AppState;
  now?: () => number;
  makePreparationId?: () => string;
  preparationTtlMs?: number;
  maxPreparations?: number;
}): SshWorkspaceRuntime {
  const now = options.now ?? Date.now;
  const makePreparationId =
    options.makePreparationId ?? (() => `ssh_preparation_${randomUUID()}`);
  const preparationTtlMs = requirePositiveInteger(
    options.preparationTtlMs ?? 5 * 60_000,
    "SSH workspace preparation TTL"
  );
  const maxPreparations = requirePositiveInteger(
    options.maxPreparations ?? 64,
    "SSH workspace preparation limit"
  );
  const preparations = new Map<string, Preparation>();
  const preparationByRequestId = new Map<string, Preparation>();

  const removePreparation = (preparation: Preparation): void => {
    if (preparations.get(preparation.preparationId) === preparation) {
      preparations.delete(preparation.preparationId);
    }
    if (
      preparationByRequestId.get(preparation.request.requestId) === preparation
    ) {
      preparationByRequestId.delete(preparation.request.requestId);
    }
  };

  const expirePreparations = (): void => {
    const currentTime = now();
    for (const preparation of preparations.values()) {
      if (currentTime - preparation.createdAt >= preparationTtlMs) {
        preparation.cancelled = true;
        preparation.abortController.abort();
        removePreparation(preparation);
      }
    }
  };

  return Object.freeze({
    async prepare(
      value: SshWorkspacePrepareRequest
    ): Promise<SshWorkspacePrepareResult> {
      const request = decodeSshWorkspacePrepareRequest(value);
      expirePreparations();
      if (preparationByRequestId.has(request.requestId)) {
        throw new Error("SSH workspace request is already being prepared");
      }
      if (preparations.size >= maxPreparations) {
        throw new Error("too many SSH workspace preparations are active");
      }
      requireTransactionDestination(options.getState(), request);

      const preparationId = createUniquePreparationId(
        makePreparationId,
        preparations
      );
      const preparation: Preparation = {
        preparationId,
        request,
        createdAt: now(),
        cancelled: false,
        abortController: new AbortController()
      };
      preparations.set(preparationId, preparation);
      preparationByRequestId.set(request.requestId, preparation);

      try {
        const connected = await options.connections.connectProfile(
          request.profileId,
          { signal: preparation.abortController.signal }
        );
        if (
          preparation.cancelled ||
          preparations.get(preparationId) !== preparation
        ) {
          throw new Error("SSH workspace preparation was cancelled");
        }
        if (now() - preparation.createdAt >= preparationTtlMs) {
          throw new Error("SSH workspace preparation expired");
        }
        // Authentication/bootstrap can outlive the renderer snapshot that
        // authorized it. Recheck Main-owned state before making the verified
        // preparation available for commit.
        requireTransactionDestination(options.getState(), request);
        preparation.connected = connected;
        return { preparationId };
      } catch (error) {
        const cancelled = preparation.cancelled;
        removePreparation(preparation);
        if (cancelled) {
          throw new Error("SSH workspace preparation was cancelled");
        }
        throw error;
      }
    },

    async commit(
      value: SshWorkspaceCommitRequest
    ): Promise<SshWorkspaceOpenResult> {
      const request = decodeSshWorkspaceCommitRequest(value);
      expirePreparations();
      const preparation = preparations.get(request.preparationId);
      if (!preparation || preparation.cancelled) {
        throw new Error("SSH workspace preparation is unavailable or expired");
      }
      if (!preparation.connected) {
        throw new Error("SSH workspace preparation is not ready");
      }

      // Consume the opaque capability before the first durable mutation so a
      // renderer cannot race two commits for one preparation.
      removePreparation(preparation);
      const connected = preparation.connected;
      const openRequest = preparation.request;
      requireTransactionDestination(options.getState(), openRequest);
      const result = await options.creator.create({
        ...(openRequest.kind === "convert-existing"
          ? {
              kind: openRequest.kind,
              sourceWorkspaceId: openRequest.sourceWorkspaceId
            }
          : {
              kind: openRequest.kind,
              destinationWindowId: openRequest.destinationWindowId
            }),
        target: {
          profile: structuredClone(connected.profile),
          binding: structuredClone(connected.binding),
          remoteHome: connected.verification.remoteHome
        }
      });
      return {
        workspaceId: result.workspaceId,
        targetId: result.targetId,
        continuation:
          openRequest.kind === "convert-existing" ? "convert" : "create"
      };
    },

    cancel(value: SshWorkspaceCancelRequest): void {
      const request = decodeSshWorkspaceCancelRequest(value);
      expirePreparations();
      const preparation = preparationByRequestId.get(request.requestId);
      if (!preparation) return;
      preparation.cancelled = true;
      preparation.abortController.abort();
      removePreparation(preparation);
    }
  });
}

export function decodeSshWorkspacePrepareRequest(
  value: unknown
): SshWorkspacePrepareRequest {
  const record = requireRecord(value, "SSH workspace request");
  if (record.kind === "convert-existing") {
    assertExactKeys(record, [
      "kind",
      "requestId",
      "sourceWorkspaceId",
      "profileId"
    ]);
    return {
      kind: record.kind,
      requestId: requireId(record.requestId, "requestId"),
      sourceWorkspaceId: requireId(
        record.sourceWorkspaceId,
        "sourceWorkspaceId"
      ),
      profileId: requireId(record.profileId, "profileId")
    };
  }
  if (record.kind !== "create-new") {
    throw new TypeError("SSH workspace transaction kind is invalid");
  }
  assertExactKeys(record, [
    "kind",
    "requestId",
    "destinationWindowId",
    "profileId"
  ]);
  return {
    kind: record.kind,
    requestId: requireId(record.requestId, "requestId"),
    destinationWindowId: requireId(
      record.destinationWindowId,
      "destinationWindowId"
    ),
    profileId: requireId(record.profileId, "profileId")
  };
}

export function decodeSshWorkspaceCommitRequest(
  value: unknown
): SshWorkspaceCommitRequest {
  const record = requireRecord(value, "SSH workspace commit request");
  assertExactKeys(record, ["preparationId"]);
  return {
    preparationId: requireId(record.preparationId, "preparationId")
  };
}

export function decodeSshWorkspaceCancelRequest(
  value: unknown
): SshWorkspaceCancelRequest {
  const record = requireRecord(value, "SSH workspace cancel request");
  assertExactKeys(record, ["requestId"]);
  return { requestId: requireId(record.requestId, "requestId") };
}

interface Preparation {
  preparationId: string;
  request: SshWorkspacePrepareRequest;
  createdAt: number;
  cancelled: boolean;
  abortController: AbortController;
  connected?: ConnectedSshProfile;
}

function createUniquePreparationId(
  makePreparationId: () => string,
  preparations: ReadonlyMap<string, Preparation>
): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = requireId(makePreparationId(), "preparationId");
    if (!preparations.has(candidate)) return candidate;
  }
  throw new Error("failed to allocate an SSH workspace preparation ID");
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

function requireTransactionDestination(
  state: AppState,
  request: SshWorkspacePrepareRequest
): void {
  if (request.kind === "create-new") {
    if (!state.windows[request.destinationWindowId]) {
      throw new Error("SSH workspace destination window no longer exists");
    }
    return;
  }
  const workspace = state.workspaces[request.sourceWorkspaceId];
  if (!workspace) throw new Error("SSH workspace source no longer exists");
  if (workspace.location.target.kind !== "local") {
    throw new Error("SSH workspace source must be local");
  }
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
      `unexpected SSH workspace request field: ${unexpected}`
    );
  }
}

function requireId(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 256 ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}
