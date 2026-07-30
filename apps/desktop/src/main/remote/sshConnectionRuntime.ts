import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  validateRemoteTargetBinding,
  type RemoteTargetBinding
} from "@kmux/core";
import {
  makeId,
  type Id,
  type RemoteBridgeResponseBody,
  type SshConnectionsSnapshot,
  type SshProfileDraftDto,
  type SshProfileDto,
  type SshProfileVm,
  type SshVerifiedTargetVm
} from "@kmux/proto";

import type {
  RemoteHostManager,
  RemoteHostTargetConnectOptions,
  RemoteHostTargetVerification
} from "../remoteHost";
import type {
  RemoteGenerationGcReport,
  RemoteGenerationResetReport
} from "../../remote-host/remoteRuntimeBootstrap";
import {
  decodeRemoteRetentionPolicy,
  DEFAULT_REMOTE_RETENTION_POLICY
} from "../../shared/remoteHostProtocol";
import type { RemoteTargetBindingStore } from "./remoteTargetBindingStore";
import type { RemoteLifecycleRuntime } from "./remoteLifecycleRuntime";
import type {
  ResolvedSshProfileConnection,
  SshProfileConnectionResolver
} from "./sshProfileConnection";
import { readObservedSshHostKeyFingerprint } from "./sshProfileConnection";
import type { SshProfileStore } from "./sshProfileStore";
import type { SshAskpassBroker, SshAskpassContext } from "./sshAskpassBroker";

const MACOS_LOCAL_NETWORK_GUIDANCE =
  "If this SSH host is on your local network, macOS may be blocking kmux's Local Network access. Allow kmux in System Settings > Privacy & Security > Local Network, then retry.";
const NO_ROUTE_TO_HOST_PATTERN = /\b(?:No route to host|EHOSTUNREACH)\b/iu;
const MAX_PRESENTED_SSH_ERROR_BYTES = 1_024;

export type SshTargetRestorePurpose =
  | "startup-restore"
  | "manual-reconnect"
  | "runtime-reconnect";

export interface SshTargetRestoreRequest {
  authentication: "interactive" | "non-interactive";
  purpose: SshTargetRestorePurpose;
  signal?: AbortSignal;
}

export class SshAuthenticationCancelledError extends Error {
  constructor() {
    super("SSH authentication was cancelled");
    this.name = "SshAuthenticationCancelledError";
  }
}

export class SshConnectionAttemptSupersededError extends Error {
  constructor() {
    super("SSH connection attempt was superseded by newer connection state");
    this.name = "SshConnectionAttemptSupersededError";
  }
}

export interface ConnectedSshProfile {
  profile: SshProfileDto;
  binding: RemoteTargetBinding;
  connection: RemoteHostTargetConnectOptions;
  verification: RemoteHostTargetVerification;
  hello: Extract<RemoteBridgeResponseBody, { type: "hello" }>;
}

export interface SshConnectionRuntime {
  getSnapshot(): Promise<SshConnectionsSnapshot>;
  resolveProfile(profileId: Id): Promise<SshProfileVm | null>;
  saveProfile(
    profileId: Id | undefined,
    draft: SshProfileDraftDto
  ): SshProfileDto;
  duplicateProfile(profileId: Id): SshProfileDto;
  deleteProfile(profileId: Id): void;
  connectProfile(
    profileId: Id,
    request?: { signal?: AbortSignal; explicitRebind?: boolean }
  ): Promise<ConnectedSshProfile>;
  restoreTarget(
    targetId: Id,
    request: SshTargetRestoreRequest
  ): Promise<ConnectedSshProfile>;
  rebindProfile(
    profileId: Id,
    request?: { signal?: AbortSignal }
  ): Promise<ConnectedSshProfile>;
  cleanRemoteRuntime(profileId: Id): Promise<RemoteGenerationGcReport>;
  resetRemoteRuntime(profileId: Id): Promise<RemoteGenerationResetReport>;
}

export function createSshConnectionRuntime(options: {
  desktopInstallationId: Id;
  profiles: SshProfileStore;
  bindings: RemoteTargetBindingStore;
  resolver: SshProfileConnectionResolver;
  host: RemoteHostManager;
  lifecycle: RemoteLifecycleRuntime;
  platform?: NodeJS.Platform;
  controlRoot?: string;
  askpassPath?: string;
  askpassBroker?: SshAskpassBroker;
  isTargetReferenced: (targetId: Id) => boolean;
  now?: () => string;
  makeTargetId?: () => Id;
  makeConnectionAttemptId?: () => Id;
  makeVerificationId?: () => Id;
  makeToken?: () => string;
}): SshConnectionRuntime {
  const platform = options.platform ?? process.platform;
  const now = options.now ?? (() => new Date().toISOString());
  const makeTargetId = options.makeTargetId ?? (() => makeId("remote-target"));
  const makeConnectionAttemptId =
    options.makeConnectionAttemptId ?? (() => makeId("ssh-attempt"));
  const makeVerificationId =
    options.makeVerificationId ?? (() => makeId("ssh-verification"));
  const makeToken =
    options.makeToken ?? (() => randomBytes(32).toString("hex"));
  const effectiveCache = new Map<
    Id,
    {
      profile: SshProfileDto;
      effective: ResolvedSshProfileConnection["effective"];
    }
  >();
  const effectiveResolutionTokens = new Map<Id, symbol>();
  const profileResolutions = new Map<
    Id,
    {
      profile: SshProfileDto;
      promise: Promise<SshProfileVm | null>;
    }
  >();
  // Authority verification may run concurrently, but choosing the immutable
  // target ID and persisting the promoted binding is one Main-owned
  // transaction. Without this boundary, two aliases that verify as the same
  // authority can both observe an empty binding store, mint different target
  // IDs, and make one promotion fail instead of converging on the first.
  let targetAssignmentTail: Promise<void> = Promise.resolve();
  const serializeTargetAssignment = async <T>(
    task: () => Promise<T>
  ): Promise<T> => {
    const predecessor = targetAssignmentTail;
    let release!: () => void;
    targetAssignmentTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await task();
    } finally {
      release();
    }
  };
  let updatedAt = now();

  const touch = (): void => {
    updatedAt = now();
  };

  const isStoredProfileCurrent = (profile: SshProfileDto): boolean => {
    const current = options.profiles.get(profile.id);
    return Boolean(current && isDeepStrictEqual(current, profile));
  };

  const assertStoredProfileCurrent = (profile: SshProfileDto): void => {
    if (!isStoredProfileCurrent(profile)) {
      throw new SshConnectionAttemptSupersededError();
    }
  };

  const isRestoreSnapshotCurrent = (
    binding: RemoteTargetBinding,
    profile: SshProfileDto
  ): boolean => {
    const currentBinding = options.bindings.get(binding.id);
    return (
      isStoredProfileCurrent(profile) &&
      Boolean(currentBinding && isDeepStrictEqual(currentBinding, binding))
    );
  };

  const assertRestoreSnapshotCurrent = (
    binding: RemoteTargetBinding,
    profile: SshProfileDto
  ): void => {
    if (!isRestoreSnapshotCurrent(binding, profile)) {
      throw new SshConnectionAttemptSupersededError();
    }
  };

  const profileVm = (profile: SshProfileDto): SshProfileVm => {
    const cached = effectiveCache.get(profile.id);
    const effective =
      cached && isDeepStrictEqual(cached.profile, profile)
        ? cached.effective
        : undefined;
    if (cached && effective === undefined) effectiveCache.delete(profile.id);
    return buildProfileVm(
      profile,
      effective,
      newestProfileBinding(options.bindings.list(), profile.id),
      options.profiles.getError(profile.id)
    );
  };

  const beginEffectiveResolution = (profileId: Id): symbol => {
    const token = Symbol(profileId);
    effectiveResolutionTokens.set(profileId, token);
    return token;
  };

  const invalidateEffectiveResolution = (profileId: Id): void => {
    beginEffectiveResolution(profileId);
    effectiveCache.delete(profileId);
  };

  const cacheEffective = (
    profile: SshProfileDto,
    effective: ResolvedSshProfileConnection["effective"],
    token: symbol
  ): boolean => {
    const current = options.profiles.get(profile.id);
    if (
      effectiveResolutionTokens.get(profile.id) !== token ||
      !current ||
      !isDeepStrictEqual(current, profile)
    ) {
      return false;
    }
    effectiveCache.set(profile.id, {
      profile: structuredClone(current),
      effective: structuredClone(effective)
    });
    return true;
  };

  const snapshot = (): SshConnectionsSnapshot => ({
    profiles: options.profiles.list().map(profileVm),
    updatedAt
  });

  return Object.freeze({
    async getSnapshot(): Promise<SshConnectionsSnapshot> {
      return snapshot();
    },

    async resolveProfile(profileId: Id): Promise<SshProfileVm | null> {
      const profile = options.profiles.get(profileId);
      if (!profile) return null;

      const cached = effectiveCache.get(profileId);
      if (cached && !isDeepStrictEqual(cached.profile, profile)) {
        effectiveCache.delete(profileId);
      }

      const pending = profileResolutions.get(profileId);
      if (pending && isDeepStrictEqual(pending.profile, profile)) {
        return pending.promise;
      }

      const requestedProfile = structuredClone(profile);
      const token = beginEffectiveResolution(profileId);
      const promise = (async (): Promise<SshProfileVm | null> => {
        try {
          const resolved = await options.resolver.resolve(
            requestedProfile,
            makeConnectionAttemptId()
          );
          if (!cacheEffective(requestedProfile, resolved.effective, token)) {
            return null;
          }
          const current = options.profiles.get(profileId);
          if (!current) return null;
          return profileVm(current);
        } catch {
          const current = options.profiles.get(profileId);
          if (
            effectiveResolutionTokens.get(profileId) !== token ||
            !current ||
            !isDeepStrictEqual(current, requestedProfile)
          ) {
            return null;
          }
          effectiveCache.delete(profileId);
          return profileVm(current);
        }
      })();
      profileResolutions.set(profileId, {
        profile: requestedProfile,
        promise
      });
      void promise.then(
        () => {
          if (profileResolutions.get(profileId)?.promise === promise) {
            profileResolutions.delete(profileId);
          }
        },
        () => {
          if (profileResolutions.get(profileId)?.promise === promise) {
            profileResolutions.delete(profileId);
          }
        }
      );
      return promise;
    },

    saveProfile(
      profileId: Id | undefined,
      draft: SshProfileDraftDto
    ): SshProfileDto {
      const saved = options.profiles.save(profileId, draft);
      invalidateEffectiveResolution(saved.id);
      touch();
      return saved;
    },

    duplicateProfile(profileId: Id): SshProfileDto {
      const duplicate = options.profiles.duplicate(profileId);
      touch();
      return duplicate;
    },

    deleteProfile(profileId: Id): void {
      const bindings = options.bindings
        .list()
        .filter((binding) => binding.locator.profileId === profileId);
      if (bindings.some((binding) => options.isTargetReferenced(binding.id))) {
        throw new Error(
          "SSH profile is referenced by a workspace or retained remote session"
        );
      }
      for (const binding of bindings) options.bindings.remove(binding.id);
      options.profiles.remove(profileId);
      invalidateEffectiveResolution(profileId);
      touch();
    },

    async connectProfile(
      profileId: Id,
      internal: { signal?: AbortSignal; explicitRebind?: boolean } = {}
    ): Promise<ConnectedSshProfile> {
      const profile = options.profiles.get(profileId);
      if (!profile) throw new Error("SSH profile does not exist");
      let verification: RemoteHostTargetVerification | undefined;
      let askpassContext: SshAskpassContext | undefined;
      const cancelAskpass = (): void => {
        void askpassContext?.dispose();
      };
      try {
        if (internal.signal?.aborted) {
          throw new Error("SSH authentication was cancelled");
        }
        const connectionAttemptId = makeConnectionAttemptId();
        const effectiveResolutionToken = beginEffectiveResolution(profile.id);
        const resolved = await options.resolver.resolve(
          profile,
          connectionAttemptId
        );
        cacheEffective(profile, resolved.effective, effectiveResolutionToken);
        assertStoredProfileCurrent(profile);
        const verificationId = makeVerificationId();
        askpassContext = await options.askpassBroker?.createContext(
          profile,
          "explicit-connect"
        );
        assertStoredProfileCurrent(profile);
        internal.signal?.addEventListener("abort", cancelAskpass, {
          once: true
        });
        verification = await options.host.verifyTarget({
          verificationId,
          connectionAttemptId,
          effectiveConnectionPolicyHash: resolved.effective.policyHash,
          sshPath: resolved.sshPath,
          configPath: resolved.configPath,
          host: resolved.host,
          ...(options.controlRoot === undefined
            ? {}
            : { controlRoot: options.controlRoot }),
          ...(askpassContext?.askpassPath === undefined &&
          options.askpassPath === undefined
            ? {}
            : {
                askpassPath: askpassContext?.askpassPath ?? options.askpassPath!
              }),
          rootOverrides: structuredClone(resolved.rootOverrides),
          ...(profile.bootstrapShellOverride === undefined
            ? {}
            : { bootstrapShellOverride: profile.bootstrapShellOverride })
        });
        if (internal.signal?.aborted) {
          throw new Error("SSH authentication was cancelled");
        }
        const verified = verification;
        const promoted = await serializeTargetAssignment(async () => {
          if (internal.signal?.aborted) {
            throw new Error("SSH authentication was cancelled");
          }
          const bindings = options.bindings.list();
          const matchingAuthority = bindings.find((binding) =>
            sameDoctorAuthority(binding, verified)
          );
          const profileBindings = bindings.filter(
            (binding) => binding.locator.profileId === profile.id
          );
          if (
            profileBindings.length > 0 &&
            !matchingAuthority &&
            internal.explicitRebind !== true
          ) {
            throw new Error(
              "SSH profile now resolves to a different remote authority; explicit rebind is required"
            );
          }
          const sshHostKeyFingerprint = readObservedSshHostKeyFingerprint(
            resolved.hostKeyObservationPath
          );
          const timestamp = nextVerificationTimestamp(now(), [
            ...profileBindings,
            ...(matchingAuthority === undefined ? [] : [matchingAuthority])
          ]);
          const candidate = validateRemoteTargetBinding({
            id: matchingAuthority?.id ?? makeTargetId(),
            authority: {
              remoteInstallationId: verified.doctor.remoteInstallationId,
              executionNodeId: verified.doctor.executionNodeId,
              authenticatedPrincipal: structuredClone(
                verified.doctor.authenticatedPrincipal
              )
            },
            locator: {
              profileId: profile.id,
              effectiveConnectionPolicyHash: resolved.effective.policyHash,
              lastVerifiedAt: timestamp
            },
            ...(sshHostKeyFingerprint === undefined
              ? {}
              : { sshHostKeyFingerprint }),
            firstVerifiedAt: matchingAuthority?.firstVerifiedAt ?? timestamp
          });
          if (
            matchingAuthority &&
            matchingAuthority.locator.effectiveConnectionPolicyHash !==
              resolved.effective.policyHash &&
            options.lifecycle.isTargetConnected(matchingAuthority.id)
          ) {
            await options.lifecycle.disconnectTarget(matchingAuthority.id);
          }
          const token = makeToken();
          if (!/^[a-f0-9]{64}$/u.test(token)) {
            throw new Error(
              "remote connection token generator returned invalid data"
            );
          }
          const retentionPolicy = decodeRemoteRetentionPolicy({
            sessionQuotaMiB:
              profile.sessionRetentionQuotaMiB ??
              DEFAULT_REMOTE_RETENTION_POLICY.sessionQuotaMiB,
            targetQuotaMiB:
              profile.targetRetentionQuotaMiB ??
              DEFAULT_REMOTE_RETENTION_POLICY.targetQuotaMiB
          });
          const connection: RemoteHostTargetConnectOptions = {
            desktopInstallationId: options.desktopInstallationId,
            targetId: candidate.id,
            connectionAttemptId,
            effectiveConnectionPolicyHash: resolved.effective.policyHash,
            sshPath: resolved.sshPath,
            configPath: resolved.configPath,
            host: resolved.host,
            ...(options.controlRoot === undefined
              ? {}
              : { controlRoot: options.controlRoot }),
            roots: structuredClone(verified.roots),
            retentionPolicy,
            token,
            ...(profile.bootstrapShellOverride === undefined
              ? {}
              : { bootstrapShellOverride: profile.bootstrapShellOverride })
          };
          const hello = await options.lifecycle.promoteVerifiedTarget({
            verificationId: verified.verificationId,
            binding: candidate,
            connection,
            token,
            retentionPolicy,
            assertPromotionCurrent: () =>
              assertStoredProfileCurrent(profile)
          });
          const binding = options.bindings.get(candidate.id);
          if (!binding) {
            throw new Error("verified remote target binding was not persisted");
          }
          return { binding, connection, hello };
        });
        options.profiles.clearError(profile.id);
        touch();
        internal.signal?.removeEventListener("abort", cancelAskpass);
        await askpassContext?.dispose();
        return {
          profile,
          binding: promoted.binding,
          connection: promoted.connection,
          verification: verified,
          hello: promoted.hello
        };
      } catch (error) {
        internal.signal?.removeEventListener("abort", cancelAskpass);
        await askpassContext?.dispose().catch(() => undefined);
        if (verification) {
          await options.host
            .discardTargetVerification(verification.verificationId)
            .catch(() => undefined);
        }
        if (
          error instanceof SshConnectionAttemptSupersededError ||
          !isStoredProfileCurrent(profile)
        ) {
          throw new SshConnectionAttemptSupersededError();
        }
        const failure = presentSshConnectionFailure(error, platform);
        options.profiles.recordError(profile.id, failure);
        touch();
        throw failure;
      }
    },

    async restoreTarget(
      targetId: Id,
      request: SshTargetRestoreRequest
    ): Promise<ConnectedSshProfile> {
      const existing = options.bindings.get(targetId);
      if (!existing || existing.id !== targetId) {
        throw new Error("restored SSH target binding does not exist");
      }
      const binding = validateRemoteTargetBinding(existing);
      const profile = options.profiles.get(binding.locator.profileId);
      if (!profile) {
        throw new Error("restored SSH target locator profile does not exist");
      }
      let verification: RemoteHostTargetVerification | undefined;
      let askpassContext: SshAskpassContext | undefined;
      const cancelAskpass = (): void => {
        void askpassContext?.dispose();
      };
      try {
        if (request.signal?.aborted) {
          throw new SshAuthenticationCancelledError();
        }
        let askpassPurpose: "startup-restore" | "manual-reconnect" | undefined;
        if (request.authentication === "interactive") {
          if (request.purpose === "runtime-reconnect") {
            throw new Error(
              "runtime SSH recovery cannot request interactive authentication"
            );
          }
          askpassPurpose = request.purpose;
        }
        const connectionAttemptId = makeConnectionAttemptId();
        const effectiveResolutionToken = beginEffectiveResolution(profile.id);
        const resolved = await options.resolver.resolve(
          profile,
          connectionAttemptId
        );
        cacheEffective(profile, resolved.effective, effectiveResolutionToken);
        assertRestoreSnapshotCurrent(binding, profile);
        if (
          resolved.effective.policyHash !==
          binding.locator.effectiveConnectionPolicyHash
        ) {
          throw new Error(
            "restored SSH profile policy changed; explicit verification or rebind is required"
          );
        }
        const verificationId = makeVerificationId();
        if (request.authentication === "interactive") {
          if (!options.askpassBroker || !askpassPurpose) {
            throw new Error("SSH askpass broker is unavailable");
          }
          askpassContext = await options.askpassBroker.createContext(
            profile,
            askpassPurpose
          );
          assertRestoreSnapshotCurrent(binding, profile);
          request.signal?.addEventListener("abort", cancelAskpass, {
            once: true
          });
        }
        verification = await options.host.verifyTarget({
          verificationId,
          connectionAttemptId,
          effectiveConnectionPolicyHash: resolved.effective.policyHash,
          sshPath: resolved.sshPath,
          configPath: resolved.configPath,
          host: resolved.host,
          ...(options.controlRoot === undefined
            ? {}
            : { controlRoot: options.controlRoot }),
          ...(askpassContext?.askpassPath === undefined
            ? {}
            : { askpassPath: askpassContext.askpassPath }),
          rootOverrides: structuredClone(resolved.rootOverrides),
          ...(profile.bootstrapShellOverride === undefined
            ? {}
            : { bootstrapShellOverride: profile.bootstrapShellOverride })
        });
        if (request.signal?.aborted || askpassContext?.wasCancelled()) {
          throw new SshAuthenticationCancelledError();
        }
        if (
          verification.effectiveConnectionPolicyHash !==
            binding.locator.effectiveConnectionPolicyHash ||
          !sameDoctorAuthority(binding, verification)
        ) {
          throw new Error(
            "restored SSH target no longer matches its verified authority"
          );
        }
        const observedFingerprint = readObservedSshHostKeyFingerprint(
          resolved.hostKeyObservationPath
        );
        const timestamp = nextVerificationTimestamp(now(), [binding]);
        const candidate = validateRemoteTargetBinding({
          ...structuredClone(binding),
          locator: {
            ...structuredClone(binding.locator),
            lastVerifiedAt: timestamp
          },
          ...(observedFingerprint === undefined
            ? {}
            : { sshHostKeyFingerprint: observedFingerprint })
        });
        const token = makeToken();
        if (!/^[a-f0-9]{64}$/u.test(token)) {
          throw new Error(
            "remote connection token generator returned invalid data"
          );
        }
        const retentionPolicy = decodeRemoteRetentionPolicy({
          sessionQuotaMiB:
            profile.sessionRetentionQuotaMiB ??
            DEFAULT_REMOTE_RETENTION_POLICY.sessionQuotaMiB,
          targetQuotaMiB:
            profile.targetRetentionQuotaMiB ??
            DEFAULT_REMOTE_RETENTION_POLICY.targetQuotaMiB
        });
        const connection: RemoteHostTargetConnectOptions = {
          desktopInstallationId: options.desktopInstallationId,
          targetId: binding.id,
          connectionAttemptId,
          effectiveConnectionPolicyHash:
            binding.locator.effectiveConnectionPolicyHash,
          sshPath: resolved.sshPath,
          configPath: resolved.configPath,
          host: resolved.host,
          ...(options.controlRoot === undefined
            ? {}
            : { controlRoot: options.controlRoot }),
          roots: structuredClone(verification.roots),
          retentionPolicy,
          token,
          ...(profile.bootstrapShellOverride === undefined
            ? {}
            : { bootstrapShellOverride: profile.bootstrapShellOverride })
        };
        const hello = await options.lifecycle.promoteVerifiedTarget({
          verificationId: verification.verificationId,
          binding: candidate,
          connection,
          token,
          retentionPolicy,
          assertPromotionCurrent: () =>
            assertRestoreSnapshotCurrent(binding, profile)
        });
        const restoredBinding = options.bindings.get(binding.id);
        if (!restoredBinding) {
          throw new Error("restored remote target binding was not persisted");
        }
        options.profiles.clearError(profile.id);
        touch();
        request.signal?.removeEventListener("abort", cancelAskpass);
        await askpassContext?.dispose();
        return {
          profile,
          binding: restoredBinding,
          connection,
          verification,
          hello
        };
      } catch (error) {
        request.signal?.removeEventListener("abort", cancelAskpass);
        const authenticationCancelled =
          request.signal?.aborted || askpassContext?.wasCancelled();
        await askpassContext?.dispose().catch(() => undefined);
        if (verification) {
          await options.host
            .discardTargetVerification(verification.verificationId)
            .catch(() => undefined);
        }
        if (
          error instanceof SshConnectionAttemptSupersededError ||
          !isRestoreSnapshotCurrent(binding, profile)
        ) {
          throw new SshConnectionAttemptSupersededError();
        }
        const failure = presentSshConnectionFailure(
          authenticationCancelled
            ? new SshAuthenticationCancelledError()
            : error,
          platform
        );
        options.profiles.recordError(profile.id, failure);
        touch();
        throw failure;
      }
    },

    async rebindProfile(
      profileId: Id,
      request: { signal?: AbortSignal } = {}
    ): Promise<ConnectedSshProfile> {
      const profileBindings = options.bindings
        .list()
        .filter((binding) => binding.locator.profileId === profileId);
      if (profileBindings.length === 0) {
        throw new Error("SSH profile has no existing target binding to rebind");
      }
      return await this.connectProfile(profileId, {
        ...request,
        explicitRebind: true
      });
    },

    async cleanRemoteRuntime(profileId: Id): Promise<RemoteGenerationGcReport> {
      try {
        const binding = newestProfileBinding(
          options.bindings.list(),
          profileId
        );
        if (!binding) {
          throw new Error(
            "SSH profile has no verified target runtime to clean"
          );
        }
        if (!options.lifecycle.isTargetConnected(binding.id)) {
          const connected = await this.connectProfile(profileId);
          if (connected.binding.id !== binding.id) {
            throw new Error(
              "SSH runtime clean resolved another target binding"
            );
          }
        }
        const report = await options.lifecycle.cleanTargetRuntime(binding.id);
        options.profiles.clearError(profileId);
        touch();
        return report;
      } catch (error) {
        const failure = presentSshConnectionFailure(error, platform);
        options.profiles.recordError(profileId, failure);
        touch();
        throw failure;
      }
    },

    async resetRemoteRuntime(
      profileId: Id
    ): Promise<RemoteGenerationResetReport> {
      try {
        const assertTargetUnreferenced = (targetId: Id): void => {
          if (options.isTargetReferenced(targetId)) {
            throw new Error(
              "SSH runtime reset requires all workspaces and retained sessions on the target to be removed first"
            );
          }
        };
        const binding = newestProfileBinding(
          options.bindings.list(),
          profileId
        );
        if (!binding) {
          throw new Error(
            "SSH profile has no verified target runtime to reset"
          );
        }
        assertTargetUnreferenced(binding.id);
        if (!options.lifecycle.isTargetConnected(binding.id)) {
          const connected = await this.connectProfile(profileId);
          if (connected.binding.id !== binding.id) {
            throw new Error(
              "SSH runtime reset resolved another target binding"
            );
          }
        }
        const report = await options.lifecycle.resetTargetRuntime(
          binding.id,
          () => assertTargetUnreferenced(binding.id)
        );
        const current = options.bindings.get(binding.id);
        if (current) {
          const { observation: _observation, ...withoutObservation } = current;
          options.bindings.replace(
            validateRemoteTargetBinding(withoutObservation)
          );
        }
        options.profiles.clearError(profileId);
        touch();
        return report;
      } catch (error) {
        const failure = presentSshConnectionFailure(error, platform);
        options.profiles.recordError(profileId, failure);
        touch();
        throw failure;
      }
    }
  });
}

function presentSshConnectionFailure(
  error: unknown,
  platform: NodeJS.Platform
): Error {
  const failure = error instanceof Error ? error : new Error(String(error));
  let message = normalizeSshErrorMessage(failure.message);
  if (
    platform === "darwin" &&
    NO_ROUTE_TO_HOST_PATTERN.test(message) &&
    !message.includes(MACOS_LOCAL_NETWORK_GUIDANCE)
  ) {
    message = `${message}. ${MACOS_LOCAL_NETWORK_GUIDANCE}`;
  }
  message = truncateUtf8(message, MAX_PRESENTED_SSH_ERROR_BYTES);
  if (failure instanceof SshAuthenticationCancelledError) {
    return new SshAuthenticationCancelledError();
  }
  return new Error(message, {
    cause: failure
  });
}

export function normalizeSshErrorMessage(message: string): string {
  return message.replace(/\s+/gu, " ").trim() || "SSH connection failed";
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "…";
  const contentLimit = maxBytes - Buffer.byteLength(suffix, "utf8");
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const nextBytes = Buffer.byteLength(character, "utf8");
    if (bytes + nextBytes > contentLimit) break;
    result += character;
    bytes += nextBytes;
  }
  return `${result}${suffix}`;
}

function newestProfileBinding(
  bindings: readonly RemoteTargetBinding[],
  profileId: Id
): RemoteTargetBinding | undefined {
  return bindings
    .filter((binding) => binding.locator.profileId === profileId)
    .sort((left, right) =>
      right.locator.lastVerifiedAt.localeCompare(left.locator.lastVerifiedAt)
    )[0];
}

function buildProfileVm(
  profile: SshProfileDto,
  effective: ResolvedSshProfileConnection["effective"] | undefined,
  binding: RemoteTargetBinding | undefined,
  lastError: { at: string; message: string } | undefined
): SshProfileVm {
  return {
    ...structuredClone(profile),
    ...(effective === undefined
      ? {}
      : { effectiveConnection: structuredClone(effective) }),
    ...(binding === undefined ? {} : { verifiedTarget: bindingToVm(binding) }),
    ...(lastError === undefined
      ? {}
      : { lastError: structuredClone(lastError) })
  };
}

function bindingToVm(binding: RemoteTargetBinding): SshVerifiedTargetVm {
  return {
    targetId: binding.id,
    remoteInstallationId: binding.authority.remoteInstallationId,
    executionNodeId: binding.authority.executionNodeId,
    authenticatedPrincipal: structuredClone(
      binding.authority.authenticatedPrincipal
    ),
    ...(binding.observation === undefined
      ? {}
      : {
          platform: binding.observation.platform,
          arch: binding.observation.arch,
          abi: binding.observation.abi,
          runtimeVersion: binding.observation.runtimeVersion,
          capabilities: [...binding.observation.capabilities],
          persistenceLevel: binding.observation.persistenceLevel
        }),
    ...(binding.sshHostKeyFingerprint === undefined
      ? {}
      : { sshHostKeyFingerprint: binding.sshHostKeyFingerprint }),
    lastVerifiedAt: binding.locator.lastVerifiedAt
  };
}

function sameDoctorAuthority(
  binding: RemoteTargetBinding,
  verification: RemoteHostTargetVerification
): boolean {
  const expected = binding.authority;
  const actual = verification.doctor;
  return (
    expected.remoteInstallationId === actual.remoteInstallationId &&
    expected.executionNodeId === actual.executionNodeId &&
    expected.authenticatedPrincipal.uid === actual.authenticatedPrincipal.uid &&
    expected.authenticatedPrincipal.accountName ===
      actual.authenticatedPrincipal.accountName
  );
}

function canonicalTimestamp(value: string): string {
  if (new Date(value).toISOString() !== value) {
    throw new Error("SSH connection clock returned a non-canonical timestamp");
  }
  return value;
}

function nextVerificationTimestamp(
  clockValue: string,
  existing: readonly RemoteTargetBinding[]
): string {
  const timestamp = canonicalTimestamp(clockValue);
  const latest = existing.reduce(
    (maximum, binding) =>
      Math.max(maximum, Date.parse(binding.locator.lastVerifiedAt)),
    Number.NEGATIVE_INFINITY
  );
  return Date.parse(timestamp) > latest
    ? timestamp
    : new Date(latest + 1).toISOString();
}
