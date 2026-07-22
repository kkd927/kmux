import type { Id, Uint64 } from "@kmux/proto";

const MAX_PATH_BYTES = 32 * 1024;
const MAX_ACCOUNT_NAME_BYTES = 4 * 1024;
const MAX_CAPABILITIES = 256;
const MAX_CAPABILITY_BYTES = 256;
const MAX_POSIX_UID = 0xffff_ffff;
const remotePathBindingToken: unique symbol = Symbol("remotePathBindingToken");

const localPathValues = new WeakMap<LocalPath, string>();
const remotePathValues = new WeakMap<
  RemotePath,
  { rawValue: string; targetId?: Id }
>();

/**
 * An opaque path owned by the desktop host. The raw value is deliberately not
 * a property, so structured clone and accidental object spreading cannot turn
 * it back into a string accepted by Node or Electron filesystem APIs.
 */
export class LocalPath {
  declare private readonly localPathBrand: never;

  private constructor(rawValue: string) {
    localPathValues.set(this, rawValue);
    Object.freeze(this);
  }

  static decode(value: unknown): LocalPath {
    return new LocalPath(validatePathString(value, "local path"));
  }
}

/** An opaque POSIX path owned by one resolved SSH target provider. */
export class RemotePath {
  declare private readonly remotePathBrand: never;

  private constructor(rawValue: string, targetId?: Id) {
    remotePathValues.set(this, {
      rawValue,
      ...(targetId === undefined ? {} : { targetId })
    });
    Object.freeze(this);
  }

  static decode(value: unknown): RemotePath {
    return new RemotePath(validatePathString(value, "remote path"));
  }

  static bind(
    targetId: Id,
    path: RemotePath,
    token: typeof remotePathBindingToken
  ): RemotePath {
    if (token !== remotePathBindingToken) {
      throw new TypeError(
        "remote paths may only be bound by a located-path codec"
      );
    }
    const validatedTargetId = validateId(targetId);
    const binding = remotePathValues.get(path);
    if (!binding) {
      throw new TypeError("path was not produced by the RemotePath codec");
    }
    if (
      binding.targetId !== undefined &&
      binding.targetId !== validatedTargetId
    ) {
      throw new TypeError("remote path is already bound to another target");
    }
    return binding.targetId === validatedTargetId
      ? path
      : new RemotePath(binding.rawValue, validatedTargetId);
  }
}

export type WorkspaceTarget =
  | { readonly kind: "local" }
  | { readonly kind: "ssh"; readonly targetId: Id };

export type LocatedPath =
  | { readonly kind: "local"; readonly path: LocalPath }
  | {
      readonly kind: "ssh";
      readonly targetId: Id;
      readonly path: RemotePath;
    };

export type WorkspaceLocation =
  | {
      readonly target: { readonly kind: "local" };
      readonly defaultCwd: LocalPath;
    }
  | {
      readonly target: { readonly kind: "ssh"; readonly targetId: Id };
      readonly defaultCwd: RemotePath;
    };

export interface LocatedPathDto {
  kind: "local" | "ssh";
  targetId?: Id;
  path: string;
}

export interface WorkspaceLocationDto {
  target: WorkspaceTarget;
  defaultCwd: string;
}

export interface SessionLaunchConfig<TPath extends LocalPath | RemotePath> {
  cwd: TPath;
  shell?: string;
  args?: string[];
  initialInput?: string;
  env?: Record<string, string>;
  title?: string;
}

export interface StoredSessionLaunchConfig {
  cwd: LocatedPath;
  shell?: string;
  args?: string[];
  initialInput?: string;
  env?: Record<string, string>;
  title?: string;
}

export interface SessionRuntimeStatus {
  processState: "pending" | "running" | "exited";
  observationState: "unknown" | "observed";
  attachmentState: "detached" | "connecting" | "attached" | "failed";
}

export interface RemoteSessionRuntimeState {
  keeperGeneration: Id;
  remoteResourceRevision: Uint64;
  lastAcknowledgedMutationSequence?: Uint64;
  storageStatus?: RemoteSessionStorageStatus;
}

export interface RemoteSessionStorageStatus {
  state: "normal" | "degraded" | "backpressured";
  journalAdmitted: Uint64;
  journalSynced: Uint64;
  emergencyBytes: number;
  lastSyncDurationMs?: number;
}

export interface LocatedWorkspaceGitRepositoryMetadata {
  root: LocatedPath;
  gitDir: LocatedPath;
  commonGitDir: LocatedPath;
  linkedWorktree: boolean;
}

export interface LocatedWorkspaceWorktreeMetadata {
  name: string;
  path: LocatedPath;
  repoRoot: LocatedPath;
  commonGitDir: LocatedPath;
  baseRef: string;
  branch: string;
  createdByKmux: boolean;
  launchSurfaceCreated?: boolean;
}

export interface LocatedWorkspaceDetectedWorktreeMetadata {
  path: LocatedPath;
  repoRoot: LocatedPath;
  commonGitDir: LocatedPath;
  baseRef: string;
  branch: string;
  detectedAt: string;
}

export interface RemoteAuthenticatedPrincipal {
  uid: number;
  accountName: string;
}

export interface RemoteAuthorityIdentity {
  remoteInstallationId: Id;
  executionNodeId: Id;
  authenticatedPrincipal: RemoteAuthenticatedPrincipal;
}

export interface RemoteTargetLocator {
  profileId: Id;
  effectiveConnectionPolicyHash: string;
  lastVerifiedAt: string;
}

export interface RemoteTargetObservation {
  platform: string;
  arch: string;
  abi: string;
  runtimeVersion: string;
  capabilities: string[];
  persistenceLevel: RemotePersistenceLevel;
}

export type RemotePersistenceLevel =
  | "ssh-disconnect"
  | "user-logout"
  | "host-reboot";

export interface RemoteTargetBinding {
  id: Id;
  authority: RemoteAuthorityIdentity;
  locator: RemoteTargetLocator;
  observation?: RemoteTargetObservation;
  sshHostKeyFingerprint?: string;
  firstVerifiedAt: string;
}

export interface SshProfile {
  id: Id;
  name: string;
  sshConfigHost?: string;
  host?: string;
  user?: string;
  port?: number;
  identityFile?: LocalPath;
  defaultRemoteCwd?: RemotePath;
  shellOverride?: string;
  bootstrapShellOverride?: string;
  installPathOverride?: RemotePath;
  authorityPathOverride?: RemotePath;
  statePathOverride?: RemotePath;
  runtimePathOverride?: RemotePath;
  sessionRetentionQuotaMiB?: number;
  targetRetentionQuotaMiB?: number;
  env?: Record<string, string>;
  forwardAgent?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteResourceKey {
  desktopInstallationId: Id;
  targetId: Id;
  workspaceId: Id;
  sessionId?: Id;
}

export interface AgentSessionRef {
  vendor: string;
  id: string;
  targetId: Id;
  cwd: LocatedPath;
  /** Existing index key retained as locator metadata, never as identity. */
  externalKey?: string;
}

export function decodeLocalPath(value: unknown): LocalPath {
  return LocalPath.decode(value);
}

export function decodeRemotePath(value: unknown): RemotePath {
  return RemotePath.decode(value);
}

export function localLocatedPath(
  path: LocalPath
): Extract<LocatedPath, { kind: "local" }> {
  if (!(path instanceof LocalPath)) {
    throw new TypeError("local located path requires a LocalPath value");
  }
  return Object.freeze({ kind: "local", path });
}

export function remoteLocatedPath(
  targetId: Id,
  path: RemotePath
): Extract<LocatedPath, { kind: "ssh" }> {
  const validatedTargetId = validateId(targetId);
  return Object.freeze({
    kind: "ssh",
    targetId: validatedTargetId,
    path: RemotePath.bind(validatedTargetId, path, remotePathBindingToken)
  });
}

export function locatedPathForTarget(
  target: WorkspaceTarget,
  encodedPath: unknown
): LocatedPath {
  return target.kind === "local"
    ? localLocatedPath(decodeLocalPath(encodedPath))
    : remoteLocatedPath(target.targetId, decodeRemotePath(encodedPath));
}

export function workspaceLocation(
  target: WorkspaceTarget,
  encodedDefaultCwd: unknown
): WorkspaceLocation {
  return target.kind === "local"
    ? Object.freeze({
        target: Object.freeze({ kind: "local" as const }),
        defaultCwd: decodeLocalPath(encodedDefaultCwd)
      })
    : Object.freeze({
        target: Object.freeze({
          kind: "ssh" as const,
          targetId: validateId(target.targetId)
        }),
        defaultCwd: RemotePath.bind(
          validateId(target.targetId),
          decodeRemotePath(encodedDefaultCwd),
          remotePathBindingToken
        )
      });
}

export function locatedPathFromWorkspaceLocation(
  location: WorkspaceLocation
): LocatedPath {
  if (location.target.kind === "local") {
    const local = location as Extract<
      WorkspaceLocation,
      { target: { kind: "local" } }
    >;
    return localLocatedPath(local.defaultCwd);
  }
  const remote = location as Extract<
    WorkspaceLocation,
    { target: { kind: "ssh" } }
  >;
  return remoteLocatedPath(remote.target.targetId, remote.defaultCwd);
}

export function targetOfLocatedPath(path: LocatedPath): WorkspaceTarget {
  pathRawValueForLocatedPath(path);
  if (path.kind === "local") {
    return Object.freeze({ kind: "local" as const });
  }
  return Object.freeze({
    kind: "ssh" as const,
    targetId: validateId(path.targetId)
  });
}

export function sameWorkspaceTarget(
  left: WorkspaceTarget,
  right: WorkspaceTarget
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "local" ||
      (right.kind === "ssh" && left.targetId === right.targetId))
  );
}

export function sameLocatedPath(
  left: LocatedPath,
  right: LocatedPath
): boolean {
  if (
    !sameWorkspaceTarget(targetOfLocatedPath(left), targetOfLocatedPath(right))
  ) {
    return false;
  }
  return pathRawValueForLocatedPath(left) === pathRawValueForLocatedPath(right);
}

export function assertLocatedPathTarget(
  target: WorkspaceTarget,
  path: LocatedPath
): void {
  if (!sameWorkspaceTarget(target, targetOfLocatedPath(path))) {
    throw new Error("located path does not belong to the resolved target");
  }
  pathRawValueForLocatedPath(path);
}

export function decodeLocatedPathDto(value: unknown): LocatedPath {
  const record = requireRecordWithAllowedKeys(
    value,
    ["kind", "targetId", "path"],
    "located path"
  );
  if (record.kind === "local") {
    requireRecordWithAllowedKeys(
      record,
      ["kind", "path"],
      "local located path"
    );
    return localLocatedPath(decodeLocalPath(record.path));
  }
  if (record.kind === "ssh") {
    requireRecordWithAllowedKeys(
      record,
      ["kind", "targetId", "path"],
      "SSH located path"
    );
    return remoteLocatedPath(
      validateId(record.targetId),
      decodeRemotePath(record.path)
    );
  }
  throw new TypeError("located path kind must be local or ssh");
}

export function decodeWorkspaceLocationDto(value: unknown): WorkspaceLocation {
  const record = requireRecordWithAllowedKeys(
    value,
    ["target", "defaultCwd"],
    "workspace location"
  );
  const target = decodeWorkspaceTarget(record.target);
  return workspaceLocation(target, record.defaultCwd);
}

export function decodeWorkspaceTarget(value: unknown): WorkspaceTarget {
  const record = requireRecordWithAllowedKeys(
    value,
    ["kind", "targetId"],
    "workspace target"
  );
  if (record.kind === "local") {
    requireRecordWithAllowedKeys(record, ["kind"], "local workspace target");
    return Object.freeze({ kind: "local" as const });
  }
  if (record.kind === "ssh") {
    requireRecordWithAllowedKeys(
      record,
      ["kind", "targetId"],
      "SSH workspace target"
    );
    return Object.freeze({
      kind: "ssh" as const,
      targetId: validateId(record.targetId)
    });
  }
  throw new TypeError("workspace target kind must be local or ssh");
}

export function validateRemoteTargetBinding(
  value: unknown
): RemoteTargetBinding {
  const binding = requireRecordWithAllowedKeys(
    value,
    [
      "id",
      "authority",
      "locator",
      "observation",
      "sshHostKeyFingerprint",
      "firstVerifiedAt"
    ],
    "remote target binding"
  );
  const authority = requireRecordWithAllowedKeys(
    binding.authority,
    ["remoteInstallationId", "executionNodeId", "authenticatedPrincipal"],
    "remote target authority"
  );
  const principal = requireRecordWithAllowedKeys(
    authority.authenticatedPrincipal,
    ["uid", "accountName"],
    "authenticated principal"
  );
  if (
    typeof principal.uid !== "number" ||
    !Number.isSafeInteger(principal.uid) ||
    principal.uid < 0 ||
    principal.uid > MAX_POSIX_UID
  ) {
    throw new TypeError("authenticated principal uid must be unsigned");
  }
  const accountName = validateBoundedString(
    principal.accountName,
    "authenticated principal accountName",
    MAX_ACCOUNT_NAME_BYTES,
    true
  );
  if (/\p{Cc}/u.test(accountName)) {
    throw new TypeError("authenticated principal accountName is invalid");
  }
  const locator = requireRecordWithAllowedKeys(
    binding.locator,
    ["profileId", "effectiveConnectionPolicyHash", "lastVerifiedAt"],
    "remote target locator"
  );
  const policyHash = validateBoundedString(
    locator.effectiveConnectionPolicyHash,
    "effective connection policy hash",
    64
  );
  if (!/^[a-f0-9]{64}$/.test(policyHash)) {
    throw new TypeError(
      "effective connection policy hash must be a SHA-256 digest"
    );
  }
  const observation =
    binding.observation === undefined
      ? undefined
      : validateRemoteTargetObservation(binding.observation);
  const fingerprint =
    binding.sshHostKeyFingerprint === undefined
      ? undefined
      : validateBoundedString(
          binding.sshHostKeyFingerprint,
          "SSH host-key fingerprint",
          512
        );
  return Object.freeze({
    id: validateId(binding.id),
    authority: Object.freeze({
      remoteInstallationId: validateId(authority.remoteInstallationId),
      executionNodeId: validateId(authority.executionNodeId),
      authenticatedPrincipal: Object.freeze({
        uid: principal.uid,
        accountName
      })
    }),
    locator: Object.freeze({
      profileId: validateId(locator.profileId),
      effectiveConnectionPolicyHash: policyHash,
      lastVerifiedAt: validateIsoTimestamp(
        locator.lastVerifiedAt,
        "lastVerifiedAt"
      )
    }),
    ...(observation ? { observation } : {}),
    ...(fingerprint ? { sshHostKeyFingerprint: fingerprint } : {}),
    firstVerifiedAt: validateIsoTimestamp(
      binding.firstVerifiedAt,
      "firstVerifiedAt"
    )
  });
}

function validateRemoteTargetObservation(
  value: unknown
): RemoteTargetObservation {
  const observation = requireRecordWithAllowedKeys(
    value,
    [
      "platform",
      "arch",
      "abi",
      "runtimeVersion",
      "capabilities",
      "persistenceLevel"
    ],
    "remote target observation"
  );
  if (
    !Array.isArray(observation.capabilities) ||
    observation.capabilities.length > MAX_CAPABILITIES
  ) {
    throw new TypeError("target capabilities must be a bounded array");
  }
  const capabilities = observation.capabilities.map((capability) =>
    validateBoundedString(capability, "target capability", MAX_CAPABILITY_BYTES)
  );
  if (new Set(capabilities).size !== capabilities.length) {
    throw new TypeError("target capabilities must not contain duplicates");
  }
  Object.freeze(capabilities);
  // Version-1 target bindings predate explicit persistence reporting. Their
  // only proven contract was SSH-disconnect survival, so migrate that exact
  // conservative level instead of rejecting otherwise valid durable state.
  const persistenceLevel = observation.persistenceLevel ?? "ssh-disconnect";
  if (
    persistenceLevel !== "ssh-disconnect" &&
    persistenceLevel !== "user-logout" &&
    persistenceLevel !== "host-reboot"
  ) {
    throw new TypeError("target persistence level is invalid");
  }
  return Object.freeze({
    platform: validateBoundedString(
      observation.platform,
      "target platform",
      256
    ),
    arch: validateBoundedString(observation.arch, "target architecture", 256),
    abi: validateBoundedString(observation.abi, "target ABI", 256),
    runtimeVersion: validateBoundedString(
      observation.runtimeVersion,
      "target runtime version",
      256
    ),
    capabilities,
    persistenceLevel
  });
}

/** Internal raw access. This symbol is intentionally not re-exported by core. */
export function pathRawValueForInternalAccess(
  path: LocalPath | RemotePath,
  expectedRemoteTargetId?: Id
): string {
  if (path instanceof LocalPath) {
    const value = localPathValues.get(path);
    if (value === undefined) {
      throw new TypeError("path was not produced by a validating kmux codec");
    }
    if (expectedRemoteTargetId !== undefined) {
      throw new TypeError("a LocalPath cannot be unwrapped for an SSH target");
    }
    return value;
  }
  const binding =
    path instanceof RemotePath ? remotePathValues.get(path) : undefined;
  if (!binding) {
    throw new TypeError("path was not produced by a validating kmux codec");
  }
  if (
    expectedRemoteTargetId !== undefined &&
    binding.targetId !== validateId(expectedRemoteTargetId)
  ) {
    throw new TypeError("remote path does not belong to the bound SSH target");
  }
  return binding.rawValue;
}

export function encodeLocatedPathDto(path: LocatedPath): LocatedPathDto {
  return path.kind === "local"
    ? { kind: "local", path: pathRawValueForLocatedPath(path) }
    : {
        kind: "ssh",
        targetId: validateId(path.targetId),
        path: pathRawValueForLocatedPath(path)
      };
}

export function encodeWorkspaceLocationDto(
  location: WorkspaceLocation
): WorkspaceLocationDto {
  return location.target.kind === "local"
    ? {
        target: { kind: "local" },
        defaultCwd: pathRawValueForWorkspaceLocation(location)
      }
    : {
        target: {
          kind: "ssh",
          targetId: validateId(location.target.targetId)
        },
        defaultCwd: pathRawValueForWorkspaceLocation(location)
      };
}

function pathRawValueForLocatedPath(path: LocatedPath): string {
  if (path.kind === "local") {
    if (!(path.path instanceof LocalPath)) {
      throw new TypeError("local located path requires a LocalPath value");
    }
    return pathRawValueForInternalAccess(path.path);
  }
  if (path.kind !== "ssh" || !(path.path instanceof RemotePath)) {
    throw new TypeError("SSH located path requires a RemotePath value");
  }
  return pathRawValueForInternalAccess(path.path, validateId(path.targetId));
}

function pathRawValueForWorkspaceLocation(location: WorkspaceLocation): string {
  if (location.target.kind === "local") {
    if (!(location.defaultCwd instanceof LocalPath)) {
      throw new TypeError(
        "local workspace location requires a LocalPath value"
      );
    }
    return pathRawValueForInternalAccess(location.defaultCwd);
  }
  if (!(location.defaultCwd instanceof RemotePath)) {
    throw new TypeError("SSH workspace location requires a RemotePath value");
  }
  return pathRawValueForInternalAccess(
    location.defaultCwd,
    validateId(location.target.targetId)
  );
}

function validatePathString(value: unknown, label: string): string {
  return validateBoundedString(value, label, MAX_PATH_BYTES, true);
}

function validateBoundedString(
  value: unknown,
  label: string,
  maxBytes: number,
  rejectNul = false
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (rejectNul && value.includes("\0")) {
    throw new TypeError(`${label} must not contain NUL`);
  }
  if (new TextEncoder().encode(value).byteLength > maxBytes) {
    throw new TypeError(`${label} exceeds ${maxBytes} bytes`);
  }
  return value;
}

function validateId(value: unknown): Id {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new TypeError("id must be a non-empty bounded string");
  }
  return value;
}

function validateIsoTimestamp(value: unknown, field: string): string {
  const timestamp = validateBoundedString(value, field, 64);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  return timestamp;
}

function requireRecordWithAllowedKeys(
  value: unknown,
  allowed: readonly string[],
  field: string
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unexpected) {
    throw new TypeError(`${field} contains unexpected field ${unexpected}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
