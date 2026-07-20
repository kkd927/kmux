import {
  formatUint64Decimal,
  incrementUint64,
  parseUint64Decimal,
  type Id,
  type Uint64,
  type WorkspaceWorktreeMetadata
} from "@kmux/proto";

import type { RemoteResourceKey } from "./domain";

export type RemoteOperationKind =
  | "workspace.create"
  | "session.create"
  | "session.restart"
  | "session.adopt"
  | "session.terminate"
  | "workspace.terminate"
  | "worktree.create"
  | "worktree.remove"
  | "forward.ensure"
  | "forward.remove"
  | "launch-input";

export interface RemoteOperationIntent {
  operationId: Id;
  kind: RemoteOperationKind;
  resourceKey: RemoteResourceKey;
  expectedWorkspaceRevision: string;
  expectedRemoteResourceRevision: Uint64;
  nextRemoteResourceRevision: Uint64;
  conversionTransactionId?: Id;
  createOperationId?: Id;
  canonicalPayloadHash: string;
  createdAt: string;
}

export type RemoteOperationIntentDto = Omit<
  RemoteOperationIntent,
  "expectedRemoteResourceRevision" | "nextRemoteResourceRevision"
> & {
  expectedRemoteResourceRevision: string;
  nextRemoteResourceRevision: string;
};

export interface RemoteSessionLaunchPayloadDto {
  cwd: string;
  shell?: string;
  args?: string[];
  env?: Record<string, string>;
  title?: string;
}

export type RemoteOperationPayloadDto =
  | {
      kind: "workspace.create";
      workspaceId: Id;
      name?: string;
      defaultCwd: string;
    }
  | {
      kind: "session.create";
      sessionId: Id;
      surfaceId: Id;
      paneId: Id;
      direction?: "up" | "down" | "left" | "right";
      launch: RemoteSessionLaunchPayloadDto;
    }
  | {
      kind: "session.restart";
      sessionId: Id;
      surfaceId: Id;
      launch: RemoteSessionLaunchPayloadDto;
    }
  | {
      kind: "session.adopt";
      sessionId: Id;
      surfaceId: Id;
      paneId: Id;
      launch: RemoteSessionLaunchPayloadDto;
    }
  | { kind: "session.terminate"; sessionId: Id }
  | { kind: "workspace.terminate"; workspaceId: Id }
  | {
      kind: "worktree.create";
      workspaceId: Id;
      cwd: string;
      path: string;
      baseRef: string;
      branch: string;
    }
  | {
      kind: "worktree.remove";
      workspaceId: Id;
      cwd: string;
      path: string;
      force: boolean;
      expectedBranch: string;
      expectedCommonGitDir: string;
    }
  | {
      kind: "forward.ensure";
      forwardId: Id;
      remoteHost: string;
      remotePort: number;
      localBindHost: "127.0.0.1" | "::1";
      localPort?: number;
    }
  | { kind: "forward.remove"; forwardId: Id }
  | { kind: "launch-input"; sessionId: Id; input: string };

/** External command shape; Main converts it into durable authority facts. */
export interface RemoteOperationAdmissionCommand {
  type: "remote-operation.command";
  workspaceId: Id;
  payload: RemoteOperationPayloadDto;
  expectedRemoteResourceRevision: Uint64;
}

export type RemoteOperationExecutionOutcome =
  | {
      status: "succeeded";
      remoteResourceRevision: Uint64;
      resultDigest: string;
      keeperGeneration?: Id;
      completedAt?: string;
    }
  | {
      status: "failed";
      resultDigest: string;
      code: string;
      message: string;
      completedAt?: string;
    }
  | { status: "pending"; reason: "offline" | "timeout" | "ambiguous" };

export interface RemoteOperationCommandResult {
  operationId: Id;
  outcome: RemoteOperationExecutionOutcome;
}

export type RemoteOperationProjectionState =
  | "pending"
  | "termination-pending"
  | "succeeded"
  | "failed";

type RemoteSessionCreatePayload = Extract<
  RemoteOperationPayloadDto,
  { kind: "session.create" }
>;
type RemoteSessionAdoptPayload = Extract<
  RemoteOperationPayloadDto,
  { kind: "session.adopt" }
>;
type RemoteSessionOwnershipPayload =
  | RemoteSessionCreatePayload
  | RemoteSessionAdoptPayload;

interface RemoteSessionProductIdentities {
  authToken: Id;
  projectedPaneId: Id;
  previousActivePaneId: Id;
  previousActiveSurfaceId: Id;
  initialInput?: string;
  splitLeafNodeId?: Id;
  splitNodeId?: Id;
}

export type RemoteWorktreeProductMetadata =
  | {
      kind: "worktree.create";
      worktree: WorkspaceWorktreeMetadata;
    }
  | {
      kind: "worktree.remove";
      expectedWorktree: WorkspaceWorktreeMetadata;
    };

export type RemotePendingProductProjection =
  | (RemoteSessionOwnershipPayload & {
      /**
       * Exact, durable product identities used while remote session ownership
       * is pending. These values are intentionally absent from the remote wire
       * payload: the bridge owns the keeper, while Main owns layout identity.
       */
      product: RemoteSessionProductIdentities;
    })
  | (Extract<RemoteOperationPayloadDto, { kind: "worktree.create" }> & {
      product: Extract<
        RemoteWorktreeProductMetadata,
        { kind: "worktree.create" }
      >;
    })
  | (Extract<RemoteOperationPayloadDto, { kind: "worktree.remove" }> & {
      product: Extract<
        RemoteWorktreeProductMetadata,
        { kind: "worktree.remove" }
      >;
    })
  | Exclude<
      Extract<
        RemoteOperationPayloadDto,
        {
          kind:
            | "workspace.create"
            | "session.create"
            | "session.restart"
            | "session.adopt"
            | "session.terminate"
            | "workspace.terminate";
        }
      >,
      RemoteSessionOwnershipPayload
    >;

export interface RemoteOperationProjection {
  operationId: Id;
  kind: RemoteOperationKind;
  resourceKey: RemoteResourceKey;
  expectedWorkspaceRevision: string;
  expectedRemoteResourceRevision: Uint64;
  nextRemoteResourceRevision: Uint64;
  canonicalPayloadHash: string;
  pendingProduct?: RemotePendingProductProjection;
  state: RemoteOperationProjectionState;
  createdAt: string;
  completedAt?: string;
  resultDigest?: string;
  keeperGeneration?: Id;
  failure?: {
    code: string;
    message: string;
  };
}

export type RemoteOperationProjectionDto = Omit<
  RemoteOperationProjection,
  "expectedRemoteResourceRevision" | "nextRemoteResourceRevision"
> & {
  expectedRemoteResourceRevision: string;
  nextRemoteResourceRevision: string;
};

const MAX_ID_BYTES = 256;
const MAX_PATH_BYTES = 32 * 1024;
const MAX_NAME_BYTES = 4 * 1024;
const MAX_ARGUMENT_BYTES = 32 * 1024;
const MAX_ARGUMENTS = 256;
const MAX_ENVIRONMENT_ENTRIES = 256;
const MAX_ENVIRONMENT_KEY_BYTES = 1024;
const MAX_ENVIRONMENT_VALUE_BYTES = 32 * 1024;
const MAX_LAUNCH_INPUT_BYTES = 64 * 1024;
const MAX_HOST_BYTES = 4 * 1024;
const textEncoder = new TextEncoder();

export function decodeRemoteOperationPayload(
  value: unknown
): RemoteOperationPayloadDto {
  const record = requireRecord(value, "remote operation payload");
  const kind = requireString(record.kind, "payload kind", 64);

  switch (kind) {
    case "workspace.create":
      assertExactKeys(record, ["kind", "workspaceId", "name", "defaultCwd"]);
      return {
        kind,
        workspaceId: requireId(record.workspaceId, "workspaceId"),
        ...(record.name === undefined
          ? {}
          : { name: requireString(record.name, "name", MAX_NAME_BYTES) }),
        defaultCwd: requirePath(record.defaultCwd, "defaultCwd")
      };
    case "session.create":
      assertExactKeys(record, [
        "kind",
        "sessionId",
        "surfaceId",
        "paneId",
        "direction",
        "launch"
      ]);
      return {
        kind,
        sessionId: requireId(record.sessionId, "sessionId"),
        surfaceId: requireId(record.surfaceId, "surfaceId"),
        paneId: requireId(record.paneId, "paneId"),
        ...(record.direction === undefined
          ? {}
          : { direction: requireDirection(record.direction) }),
        launch: decodeRemoteSessionLaunchPayload(record.launch)
      };
    case "session.restart":
      assertExactKeys(record, ["kind", "sessionId", "surfaceId", "launch"]);
      return {
        kind,
        sessionId: requireId(record.sessionId, "sessionId"),
        surfaceId: requireId(record.surfaceId, "surfaceId"),
        launch: decodeRemoteSessionLaunchPayload(record.launch)
      };
    case "session.adopt":
      assertExactKeys(record, [
        "kind",
        "sessionId",
        "surfaceId",
        "paneId",
        "launch"
      ]);
      return {
        kind,
        sessionId: requireId(record.sessionId, "sessionId"),
        surfaceId: requireId(record.surfaceId, "surfaceId"),
        paneId: requireId(record.paneId, "paneId"),
        launch: decodeRemoteSessionLaunchPayload(record.launch)
      };
    case "session.terminate":
      assertExactKeys(record, ["kind", "sessionId"]);
      return {
        kind,
        sessionId: requireId(record.sessionId, "sessionId")
      };
    case "workspace.terminate":
      assertExactKeys(record, ["kind", "workspaceId"]);
      return {
        kind,
        workspaceId: requireId(record.workspaceId, "workspaceId")
      };
    case "worktree.create":
      assertExactKeys(record, [
        "kind",
        "workspaceId",
        "cwd",
        "path",
        "baseRef",
        "branch"
      ]);
      return {
        kind,
        workspaceId: requireId(record.workspaceId, "workspaceId"),
        cwd: requirePath(record.cwd, "cwd"),
        path: requirePath(record.path, "path"),
        baseRef: requireString(record.baseRef, "baseRef", MAX_ARGUMENT_BYTES),
        branch: requireString(record.branch, "branch", MAX_ARGUMENT_BYTES)
      };
    case "worktree.remove":
      assertExactKeys(record, [
        "kind",
        "workspaceId",
        "cwd",
        "path",
        "force",
        "expectedBranch",
        "expectedCommonGitDir"
      ]);
      if (typeof record.force !== "boolean") {
        throw new TypeError("force must be a boolean");
      }
      return {
        kind,
        workspaceId: requireId(record.workspaceId, "workspaceId"),
        cwd: requirePath(record.cwd, "cwd"),
        path: requirePath(record.path, "path"),
        force: record.force,
        expectedBranch: requireString(
          record.expectedBranch,
          "expectedBranch",
          MAX_ARGUMENT_BYTES
        ),
        expectedCommonGitDir: requirePath(
          record.expectedCommonGitDir,
          "expectedCommonGitDir"
        )
      };
    case "forward.ensure": {
      assertExactKeys(record, [
        "kind",
        "forwardId",
        "remoteHost",
        "remotePort",
        "localBindHost",
        "localPort"
      ]);
      const localBindHost = record.localBindHost;
      if (localBindHost !== "127.0.0.1" && localBindHost !== "::1") {
        throw new TypeError("localBindHost must be a loopback address");
      }
      return {
        kind,
        forwardId: requireId(record.forwardId, "forwardId"),
        remoteHost: requireString(
          record.remoteHost,
          "remoteHost",
          MAX_HOST_BYTES
        ),
        remotePort: requirePort(record.remotePort, "remotePort"),
        localBindHost,
        ...(record.localPort === undefined
          ? {}
          : { localPort: requirePort(record.localPort, "localPort") })
      };
    }
    case "forward.remove":
      assertExactKeys(record, ["kind", "forwardId"]);
      return {
        kind,
        forwardId: requireId(record.forwardId, "forwardId")
      };
    case "launch-input":
      assertExactKeys(record, ["kind", "sessionId", "input"]);
      return {
        kind,
        sessionId: requireId(record.sessionId, "sessionId"),
        input: requireString(
          record.input,
          "input",
          MAX_LAUNCH_INPUT_BYTES,
          true
        )
      };
    default:
      throw new TypeError(`unsupported remote operation kind: ${kind}`);
  }
}

export function canonicalizeRemoteOperationPayload(
  payload: RemoteOperationPayloadDto
): string {
  const validated = decodeRemoteOperationPayload(payload);
  return canonicalJson(validated);
}

export function encodeRemoteOperationProjectionDto(
  projection: RemoteOperationProjection
): RemoteOperationProjectionDto {
  return {
    ...projection,
    ...(projection.pendingProduct === undefined
      ? {}
      : { pendingProduct: structuredClone(projection.pendingProduct) }),
    expectedRemoteResourceRevision: formatUint64Decimal(
      projection.expectedRemoteResourceRevision
    ),
    nextRemoteResourceRevision: formatUint64Decimal(
      projection.nextRemoteResourceRevision
    )
  };
}

export function encodeRemoteOperationIntentDto(
  intent: RemoteOperationIntent
): RemoteOperationIntentDto {
  return {
    ...intent,
    resourceKey: structuredClone(intent.resourceKey),
    expectedRemoteResourceRevision: formatUint64Decimal(
      intent.expectedRemoteResourceRevision
    ),
    nextRemoteResourceRevision: formatUint64Decimal(
      intent.nextRemoteResourceRevision
    )
  };
}

export function decodeRemoteOperationIntentDto(
  value: unknown
): RemoteOperationIntent {
  const record = requireRecord(value, "remote operation intent");
  assertExactKeys(record, [
    "operationId",
    "kind",
    "resourceKey",
    "expectedWorkspaceRevision",
    "expectedRemoteResourceRevision",
    "nextRemoteResourceRevision",
    "conversionTransactionId",
    "createOperationId",
    "canonicalPayloadHash",
    "createdAt"
  ]);
  const kind = requireString(record.kind, "operation kind", 64);
  if (!isRemoteOperationKind(kind)) {
    throw new TypeError(`unsupported remote operation kind: ${kind}`);
  }
  const resourceKeyRecord = requireRecord(record.resourceKey, "resourceKey");
  assertExactKeys(resourceKeyRecord, [
    "desktopInstallationId",
    "targetId",
    "workspaceId",
    "sessionId"
  ]);
  const intent: RemoteOperationIntent = {
    operationId: requireId(record.operationId, "operationId"),
    kind,
    resourceKey: {
      desktopInstallationId: requireId(
        resourceKeyRecord.desktopInstallationId,
        "desktopInstallationId"
      ),
      targetId: requireId(resourceKeyRecord.targetId, "targetId"),
      workspaceId: requireId(resourceKeyRecord.workspaceId, "workspaceId"),
      ...(resourceKeyRecord.sessionId === undefined
        ? {}
        : { sessionId: requireId(resourceKeyRecord.sessionId, "sessionId") })
    },
    expectedWorkspaceRevision: requireHash(
      record.expectedWorkspaceRevision,
      "expectedWorkspaceRevision"
    ),
    expectedRemoteResourceRevision: parseUint64Decimal(
      record.expectedRemoteResourceRevision
    ),
    nextRemoteResourceRevision: parseUint64Decimal(
      record.nextRemoteResourceRevision
    ),
    ...(record.conversionTransactionId === undefined
      ? {}
      : {
          conversionTransactionId: requireId(
            record.conversionTransactionId,
            "conversionTransactionId"
          )
        }),
    ...(record.createOperationId === undefined
      ? {}
      : {
          createOperationId: requireId(
            record.createOperationId,
            "createOperationId"
          )
        }),
    canonicalPayloadHash: requireHash(
      record.canonicalPayloadHash,
      "canonicalPayloadHash"
    ),
    createdAt: requireIsoTimestamp(record.createdAt, "createdAt")
  };
  assertOperationResourceScope(intent.kind, intent.resourceKey);
  if (
    intent.nextRemoteResourceRevision !==
    incrementUint64(intent.expectedRemoteResourceRevision)
  ) {
    throw new TypeError(
      "remote operation revisions must advance by exactly one"
    );
  }
  if (
    (intent.kind === "workspace.create" || intent.kind === "session.create") &&
    intent.createOperationId !== intent.operationId
  ) {
    throw new TypeError("create operations must retain their operation ID");
  }
  return intent;
}

export function decodeRemoteOperationProjectionDto(
  value: unknown
): RemoteOperationProjection {
  const record = requireRecord(value, "remote operation projection");
  assertExactKeys(record, [
    "operationId",
    "kind",
    "resourceKey",
    "expectedWorkspaceRevision",
    "expectedRemoteResourceRevision",
    "nextRemoteResourceRevision",
    "canonicalPayloadHash",
    "pendingProduct",
    "state",
    "createdAt",
    "completedAt",
    "resultDigest",
    "keeperGeneration",
    "failure"
  ]);
  const resourceKeyRecord = requireRecord(record.resourceKey, "resourceKey");
  assertExactKeys(resourceKeyRecord, [
    "desktopInstallationId",
    "targetId",
    "workspaceId",
    "sessionId"
  ]);
  const resourceKey: RemoteResourceKey = {
    desktopInstallationId: requireId(
      resourceKeyRecord.desktopInstallationId,
      "desktopInstallationId"
    ),
    targetId: requireId(resourceKeyRecord.targetId, "targetId"),
    workspaceId: requireId(resourceKeyRecord.workspaceId, "workspaceId"),
    ...(resourceKeyRecord.sessionId === undefined
      ? {}
      : { sessionId: requireId(resourceKeyRecord.sessionId, "sessionId") })
  };
  const state = record.state;
  if (
    state !== "pending" &&
    state !== "termination-pending" &&
    state !== "succeeded" &&
    state !== "failed"
  ) {
    throw new TypeError("remote operation projection state is invalid");
  }
  const kind = requireString(record.kind, "operation kind", 64);
  if (!isRemoteOperationKind(kind)) {
    throw new TypeError(`unsupported remote operation kind: ${kind}`);
  }
  const failure =
    record.failure === undefined
      ? undefined
      : decodeRemoteOperationFailure(record.failure);
  const pendingProduct = decodePendingProductProjection(
    record.pendingProduct,
    kind
  );
  const projection: RemoteOperationProjection = {
    operationId: requireId(record.operationId, "operationId"),
    kind,
    resourceKey,
    expectedWorkspaceRevision: requireHash(
      record.expectedWorkspaceRevision,
      "expectedWorkspaceRevision"
    ),
    expectedRemoteResourceRevision: parseUint64Decimal(
      record.expectedRemoteResourceRevision
    ),
    nextRemoteResourceRevision: parseUint64Decimal(
      record.nextRemoteResourceRevision
    ),
    canonicalPayloadHash: requireHash(
      record.canonicalPayloadHash,
      "canonicalPayloadHash"
    ),
    ...(pendingProduct === undefined ? {} : { pendingProduct }),
    state,
    createdAt: requireIsoTimestamp(record.createdAt, "createdAt"),
    ...(record.completedAt === undefined
      ? {}
      : {
          completedAt: requireIsoTimestamp(record.completedAt, "completedAt")
        }),
    ...(record.resultDigest === undefined
      ? {}
      : { resultDigest: requireHash(record.resultDigest, "resultDigest") }),
    ...(record.keeperGeneration === undefined
      ? {}
      : {
          keeperGeneration: requireId(
            record.keeperGeneration,
            "keeperGeneration"
          )
        }),
    ...(failure ? { failure } : {})
  };
  assertOperationResourceScope(projection.kind, projection.resourceKey);
  if (
    projection.nextRemoteResourceRevision !==
    incrementUint64(projection.expectedRemoteResourceRevision)
  ) {
    throw new TypeError(
      "remote operation revisions must advance by exactly one"
    );
  }
  assertProjectionStateConsistency(projection);
  return projection;
}

export function createRemotePendingProductProjection(
  payload: RemoteOperationPayloadDto,
  sessionProduct?: RemoteSessionProductIdentities,
  worktreeProduct?: RemoteWorktreeProductMetadata
): RemotePendingProductProjection | undefined {
  switch (payload.kind) {
    case "workspace.create":
    case "session.restart":
    case "session.terminate":
    case "workspace.terminate":
      return structuredClone(payload);
    case "session.create":
    case "session.adopt":
      if (!sessionProduct) {
        throw new TypeError(
          `${payload.kind} pending projection requires durable product identities`
        );
      }
      assertSessionProduct(payload, sessionProduct);
      return {
        ...structuredClone(payload),
        product: structuredClone(sessionProduct)
      };
    case "worktree.create": {
      if (worktreeProduct?.kind !== payload.kind) {
        throw new TypeError(
          "worktree create pending projection requires exact product metadata"
        );
      }
      const product = decodeWorktreeProduct(worktreeProduct);
      if (product.kind !== "worktree.create") {
        throw new TypeError("worktree create product kind is invalid");
      }
      assertWorktreeProduct(payload, product);
      return {
        ...structuredClone(payload),
        product
      };
    }
    case "worktree.remove": {
      if (worktreeProduct?.kind !== payload.kind) {
        throw new TypeError(
          "worktree remove pending projection requires exact product metadata"
        );
      }
      const product = decodeWorktreeProduct(worktreeProduct);
      if (product.kind !== "worktree.remove") {
        throw new TypeError("worktree remove product kind is invalid");
      }
      assertWorktreeProduct(payload, product);
      return {
        ...structuredClone(payload),
        product
      };
    }
    case "forward.ensure":
    case "forward.remove":
    case "launch-input":
      return undefined;
  }
}

export function payloadFromRemotePendingProductProjection(
  projection: RemotePendingProductProjection
): Extract<
  RemoteOperationPayloadDto,
  { kind: RemotePendingProductProjection["kind"] }
> {
  if (!("product" in projection)) {
    return structuredClone(projection) as Extract<
      RemoteOperationPayloadDto,
      { kind: RemotePendingProductProjection["kind"] }
    >;
  }
  const { product: _product, ...payload } = projection;
  return structuredClone(payload) as Extract<
    RemoteOperationPayloadDto,
    { kind: RemotePendingProductProjection["kind"] }
  >;
}

function decodePendingProductProjection(
  value: unknown,
  operationKind: RemoteOperationKind
): RemotePendingProductProjection | undefined {
  if (value === undefined) return undefined;
  if (operationKind === "session.create" || operationKind === "session.adopt") {
    const record = requireRecord(value, `${operationKind} pending projection`);
    assertExactKeys(
      record,
      operationKind === "session.create"
        ? [
            "kind",
            "sessionId",
            "surfaceId",
            "paneId",
            "direction",
            "launch",
            "product"
          ]
        : ["kind", "sessionId", "surfaceId", "paneId", "launch", "product"]
    );
    const payload = decodeRemoteOperationPayload({
      kind: record.kind,
      sessionId: record.sessionId,
      surfaceId: record.surfaceId,
      paneId: record.paneId,
      ...(operationKind !== "session.create" || record.direction === undefined
        ? {}
        : { direction: record.direction }),
      launch: record.launch
    });
    if (payload.kind !== operationKind) {
      throw new TypeError(
        `${operationKind} pending projection kind is invalid`
      );
    }
    const product = decodeSessionProduct(record.product);
    return createRemotePendingProductProjection(payload, product);
  }
  if (
    operationKind === "worktree.create" ||
    operationKind === "worktree.remove"
  ) {
    const record = requireRecord(value, `${operationKind} pending projection`);
    assertExactKeys(
      record,
      operationKind === "worktree.create"
        ? ["kind", "workspaceId", "cwd", "path", "baseRef", "branch", "product"]
        : [
            "kind",
            "workspaceId",
            "cwd",
            "path",
            "force",
            "expectedBranch",
            "expectedCommonGitDir",
            "product"
          ]
    );
    const { product: rawProduct, ...rawPayload } = record;
    const payload = decodeRemoteOperationPayload(rawPayload);
    if (payload.kind !== operationKind) {
      throw new TypeError(
        `${operationKind} pending projection kind is invalid`
      );
    }
    const product = decodeWorktreeProduct(rawProduct);
    return createRemotePendingProductProjection(payload, undefined, product);
  }
  const payload = decodeRemoteOperationPayload(value);
  const projection = createRemotePendingProductProjection(payload);
  if (!projection || projection.kind !== operationKind) {
    throw new TypeError(
      "remote pending product projection does not match its operation"
    );
  }
  return projection;
}

function decodeWorktreeProduct(value: unknown): RemoteWorktreeProductMetadata {
  const record = requireRecord(value, "worktree product projection");
  const kind = requireString(record.kind, "worktree product kind", 64);
  if (kind === "worktree.create") {
    assertExactKeys(record, ["kind", "worktree"]);
    return { kind, worktree: decodeWorkspaceWorktree(record.worktree) };
  }
  if (kind === "worktree.remove") {
    assertExactKeys(record, ["kind", "expectedWorktree"]);
    return {
      kind,
      expectedWorktree: decodeWorkspaceWorktree(record.expectedWorktree)
    };
  }
  throw new TypeError("worktree product kind is invalid");
}

function decodeWorkspaceWorktree(value: unknown): WorkspaceWorktreeMetadata {
  const record = requireRecord(value, "workspace worktree product");
  assertExactKeys(record, [
    "name",
    "path",
    "repoRoot",
    "commonGitDir",
    "baseRef",
    "branch",
    "createdByKmux",
    "launchSurfaceCreated"
  ]);
  if (typeof record.createdByKmux !== "boolean") {
    throw new TypeError("workspace worktree createdByKmux must be boolean");
  }
  if (
    record.launchSurfaceCreated !== undefined &&
    typeof record.launchSurfaceCreated !== "boolean"
  ) {
    throw new TypeError(
      "workspace worktree launchSurfaceCreated must be boolean"
    );
  }
  return {
    name: requireString(record.name, "worktree.name", MAX_NAME_BYTES),
    path: requirePath(record.path, "worktree.path"),
    repoRoot: requirePath(record.repoRoot, "worktree.repoRoot"),
    commonGitDir: requirePath(record.commonGitDir, "worktree.commonGitDir"),
    baseRef: requireString(
      record.baseRef,
      "worktree.baseRef",
      MAX_ARGUMENT_BYTES
    ),
    branch: requireString(record.branch, "worktree.branch", MAX_ARGUMENT_BYTES),
    createdByKmux: record.createdByKmux,
    ...(record.launchSurfaceCreated === undefined
      ? {}
      : { launchSurfaceCreated: record.launchSurfaceCreated })
  };
}

function assertWorktreeProduct(
  payload: Extract<
    RemoteOperationPayloadDto,
    { kind: "worktree.create" | "worktree.remove" }
  >,
  product: RemoteWorktreeProductMetadata
): void {
  if (payload.kind !== product.kind) {
    throw new TypeError("worktree payload and product kinds differ");
  }
  const worktree =
    product.kind === "worktree.create"
      ? product.worktree
      : product.expectedWorktree;
  if (worktree.path !== payload.path) {
    throw new TypeError(
      "worktree product path differs from its remote payload"
    );
  }
  if (
    payload.kind === "worktree.create" &&
    product.kind === "worktree.create" &&
    (worktree.baseRef !== payload.baseRef || worktree.branch !== payload.branch)
  ) {
    throw new TypeError(
      "worktree create product branch/base differs from its remote payload"
    );
  }
  if (
    payload.kind === "worktree.remove" &&
    product.kind === "worktree.remove" &&
    (worktree.branch !== payload.expectedBranch ||
      worktree.commonGitDir !== payload.expectedCommonGitDir)
  ) {
    throw new TypeError(
      "worktree remove product identity differs from its remote payload"
    );
  }
}

function decodeSessionProduct(value: unknown): RemoteSessionProductIdentities {
  const record = requireRecord(value, "session product projection");
  assertExactKeys(record, [
    "authToken",
    "projectedPaneId",
    "previousActivePaneId",
    "previousActiveSurfaceId",
    "initialInput",
    "splitLeafNodeId",
    "splitNodeId"
  ]);
  return {
    authToken: requireId(record.authToken, "authToken"),
    projectedPaneId: requireId(record.projectedPaneId, "projectedPaneId"),
    previousActivePaneId: requireId(
      record.previousActivePaneId,
      "previousActivePaneId"
    ),
    previousActiveSurfaceId: requireId(
      record.previousActiveSurfaceId,
      "previousActiveSurfaceId"
    ),
    ...(record.initialInput === undefined
      ? {}
      : {
          initialInput: requireString(
            record.initialInput,
            "initialInput",
            MAX_LAUNCH_INPUT_BYTES,
            true
          )
        }),
    ...(record.splitLeafNodeId === undefined
      ? {}
      : {
          splitLeafNodeId: requireId(record.splitLeafNodeId, "splitLeafNodeId")
        }),
    ...(record.splitNodeId === undefined
      ? {}
      : { splitNodeId: requireId(record.splitNodeId, "splitNodeId") })
  };
}

function assertSessionProduct(
  payload: RemoteSessionOwnershipPayload,
  product: RemoteSessionProductIdentities
): void {
  const validated = decodeSessionProduct(product);
  const hasSplitIds =
    validated.splitLeafNodeId !== undefined ||
    validated.splitNodeId !== undefined;
  const direction =
    payload.kind === "session.create" ? payload.direction : undefined;
  if (direction === undefined) {
    if (hasSplitIds || validated.projectedPaneId !== payload.paneId) {
      throw new TypeError(
        "non-split session ownership cannot contain split identities"
      );
    }
    return;
  }
  if (
    validated.projectedPaneId === payload.paneId ||
    validated.splitLeafNodeId === undefined ||
    validated.splitNodeId === undefined ||
    validated.splitLeafNodeId === validated.splitNodeId
  ) {
    throw new TypeError(
      "split create product projection requires distinct pane and node identities"
    );
  }
}

function assertOperationResourceScope(
  kind: RemoteOperationKind,
  resourceKey: RemoteResourceKey
): void {
  const sessionScoped =
    kind === "session.create" ||
    kind === "session.restart" ||
    kind === "session.adopt" ||
    kind === "session.terminate" ||
    kind === "launch-input";
  if (sessionScoped !== (resourceKey.sessionId !== undefined)) {
    throw new TypeError("remote operation resource key has the wrong scope");
  }
}

function assertProjectionStateConsistency(
  projection: RemoteOperationProjection
): void {
  const termination =
    projection.kind === "session.terminate" ||
    projection.kind === "workspace.terminate";
  if (
    (projection.state === "termination-pending") !== termination &&
    (projection.state === "pending" ||
      projection.state === "termination-pending")
  ) {
    throw new TypeError(
      "remote operation pending state does not match its kind"
    );
  }
  if (
    projection.state === "pending" ||
    projection.state === "termination-pending"
  ) {
    if (
      projection.completedAt !== undefined ||
      projection.resultDigest !== undefined ||
      projection.keeperGeneration !== undefined ||
      projection.failure !== undefined
    ) {
      throw new TypeError("a pending remote operation cannot contain a result");
    }
    return;
  }
  if (
    projection.completedAt === undefined ||
    projection.resultDigest === undefined
  ) {
    throw new TypeError("a terminal remote operation requires result metadata");
  }
  if ((projection.state === "failed") !== (projection.failure !== undefined)) {
    throw new TypeError("remote operation failure metadata is inconsistent");
  }
  if (
    projection.state === "failed" &&
    projection.keeperGeneration !== undefined
  ) {
    throw new TypeError(
      "a failed remote operation cannot contain a keeper generation"
    );
  }
}

function decodeRemoteSessionLaunchPayload(
  value: unknown
): RemoteSessionLaunchPayloadDto {
  const record = requireRecord(value, "session launch payload");
  assertExactKeys(record, ["cwd", "shell", "args", "env", "title"]);
  return {
    cwd: requirePath(record.cwd, "launch.cwd"),
    ...(record.shell === undefined
      ? {}
      : {
          shell: requireString(record.shell, "launch.shell", MAX_ARGUMENT_BYTES)
        }),
    ...(record.args === undefined
      ? {}
      : { args: requireStringArray(record.args, "launch.args") }),
    ...(record.env === undefined
      ? {}
      : { env: requireEnvironment(record.env) }),
    ...(record.title === undefined
      ? {}
      : {
          title: requireString(record.title, "launch.title", MAX_NAME_BYTES)
        })
  };
}

function requireEnvironment(value: unknown): Record<string, string> {
  const record = requireRecord(value, "launch.env");
  const entries = Object.entries(record);
  if (entries.length > MAX_ENVIRONMENT_ENTRIES) {
    throw new RangeError("launch.env contains too many entries");
  }
  return Object.fromEntries(
    entries
      .map(([key, entryValue]) => {
        const validatedKey = requireString(
          key,
          "environment key",
          MAX_ENVIRONMENT_KEY_BYTES
        );
        if (validatedKey.includes("\0") || validatedKey.includes("=")) {
          throw new TypeError("environment key contains an invalid character");
        }
        const validatedValue = requireString(
          entryValue,
          `environment value for ${key}`,
          MAX_ENVIRONMENT_VALUE_BYTES,
          true
        );
        if (validatedValue.includes("\0")) {
          throw new TypeError("environment value contains NUL");
        }
        return [validatedKey, validatedValue] as const;
      })
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function decodeRemoteOperationFailure(value: unknown): {
  code: string;
  message: string;
} {
  const record = requireRecord(value, "remote operation failure");
  assertExactKeys(record, ["code", "message"]);
  return {
    code: requireString(record.code, "failure.code", 256),
    message: requireString(record.message, "failure.message", 4 * 1024)
  };
}

function isRemoteOperationKind(value: string): value is RemoteOperationKind {
  return (
    value === "workspace.create" ||
    value === "session.create" ||
    value === "session.restart" ||
    value === "session.adopt" ||
    value === "session.terminate" ||
    value === "workspace.terminate" ||
    value === "worktree.create" ||
    value === "worktree.remove" ||
    value === "forward.ensure" ||
    value === "forward.remove" ||
    value === "launch-input"
  );
}

function requireHash(value: unknown, field: string): string {
  const hash = requireString(value, field, 64);
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new TypeError(`${field} must be a SHA-256 digest`);
  }
  return hash;
}

function requireIsoTimestamp(value: unknown, field: string): string {
  const timestamp = requireString(value, field, 64);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  return timestamp;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_ARGUMENTS) {
    throw new TypeError(`${field} must be a bounded string array`);
  }
  return value.map((entry, index) => {
    const result = requireString(
      entry,
      `${field}[${index}]`,
      MAX_ARGUMENT_BYTES,
      true
    );
    if (result.includes("\0")) {
      throw new TypeError(`${field}[${index}] contains NUL`);
    }
    return result;
  });
}

function requireDirection(value: unknown): "up" | "down" | "left" | "right" {
  if (
    value !== "up" &&
    value !== "down" &&
    value !== "left" &&
    value !== "right"
  ) {
    throw new TypeError("direction is invalid");
  }
  return value;
}

function requirePort(value: unknown, field: string): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 65535
  ) {
    throw new TypeError(`${field} must be an integer port`);
  }
  return value as number;
}

function requirePath(value: unknown, field: string): string {
  const path = requireString(value, field, MAX_PATH_BYTES);
  if (path.includes("\0")) {
    throw new TypeError(`${field} cannot contain NUL`);
  }
  return path;
}

function requireId(value: unknown, field: string): Id {
  const id = requireString(value, field, MAX_ID_BYTES);
  if (/\p{Cc}/u.test(id)) {
    throw new TypeError(`${field} contains control characters`);
  }
  return id;
}

function requireString(
  value: unknown,
  field: string,
  maxBytes: number,
  allowEmpty = false
): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new TypeError(
      `${field} must be ${allowEmpty ? "a" : "a non-empty"} string`
    );
  }
  if (textEncoder.encode(value).byteLength > maxBytes) {
    throw new RangeError(`${field} exceeds its byte limit`);
  }
  return value;
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
  const unexpected = Object.keys(record).find((key) => !allowedKeys.has(key));
  if (unexpected) {
    throw new TypeError(`unexpected remote operation field: ${unexpected}`);
  }
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
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("canonical JSON accepts only safe integers");
    }
    return String(value);
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
  throw new TypeError("value cannot be represented as canonical JSON");
}
