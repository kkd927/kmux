import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import type { SshProfileDto } from "@kmux/proto";

import type { RemoteHostManager } from "../remoteHost";
import type { RemoteLifecycleRuntime } from "./remoteLifecycleRuntime";
import { createRemoteTargetBindingStore } from "./remoteTargetBindingStore";
import {
  createSshConnectionRuntime,
  SshConnectionAttemptSupersededError
} from "./sshConnectionRuntime";
import type { SshProfileConnectionResolver } from "./sshProfileConnection";
import { createSshProfileStore } from "./sshProfileStore";

const NOW = "2026-07-19T00:00:00.000Z";
const POLICY = "a".repeat(64);

describe("SSH connection runtime", () => {
  it("returns the local profile snapshot without invoking effective resolution", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-ssh-connection-"));
    try {
      const profiles = createSshProfileStore(join(sandbox, "profiles.json"), {
        now: () => NOW,
        makeProfileId: () => "profile_local"
      });
      profiles.save(undefined, {
        name: "local-listing",
        host: "127.0.0.1"
      });
      const resolve = vi.fn();
      const runtime = createSshConnectionRuntime({
        desktopInstallationId: "desktop_1",
        profiles,
        bindings: createRemoteTargetBindingStore(
          join(sandbox, "bindings.json")
        ),
        resolver: { resolve },
        host: new FakeHost() as unknown as RemoteHostManager,
        lifecycle: new FakeLifecycle(
          createRemoteTargetBindingStore(join(sandbox, "lifecycle.json"))
        ) as unknown as RemoteLifecycleRuntime,
        isTargetReferenced: () => false,
        now: () => NOW
      });

      await expect(runtime.getSnapshot()).resolves.toMatchObject({
        profiles: [
          {
            id: "profile_local",
            name: "local-listing",
            host: "127.0.0.1"
          }
        ]
      });
      expect(resolve).not.toHaveBeenCalled();
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("deduplicates concurrent resolution of the same stored profile definition", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-ssh-connection-"));
    try {
      const profiles = createSshProfileStore(join(sandbox, "profiles.json"), {
        now: () => NOW,
        makeProfileId: () => "profile_dedupe"
      });
      const profile = profiles.save(undefined, {
        name: "deduped",
        sshConfigHost: "deduped"
      });
      const pending = deferred<ReturnType<typeof resolvedConnection>>();
      const resolve = vi.fn(async () => pending.promise);
      const bindings = createRemoteTargetBindingStore(
        join(sandbox, "bindings.json")
      );
      const runtime = createSshConnectionRuntime({
        desktopInstallationId: "desktop_1",
        profiles,
        bindings,
        resolver: { resolve },
        host: new FakeHost() as unknown as RemoteHostManager,
        lifecycle: new FakeLifecycle(
          bindings
        ) as unknown as RemoteLifecycleRuntime,
        isTargetReferenced: () => false,
        now: () => NOW
      });

      const first = runtime.resolveProfile(profile.id);
      const second = runtime.resolveProfile(profile.id);
      expect(resolve).toHaveBeenCalledOnce();
      pending.resolve(resolvedConnection(profile));

      await expect(first).resolves.toMatchObject({
        id: profile.id,
        effectiveConnection: { hostName: "dev.internal" }
      });
      await expect(second).resolves.toMatchObject({
        id: profile.id,
        effectiveConnection: { hostName: "dev.internal" }
      });
      expect(resolve).toHaveBeenCalledOnce();
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("refreshes a completed profile resolution instead of reusing its display cache", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-ssh-connection-"));
    try {
      let resolution = 0;
      const resolve = vi.fn(async (profile: SshProfileDto) => {
        resolution += 1;
        return resolvedConnection(
          profile,
          resolution === 1 ? "old.internal" : "new.internal"
        );
      });
      const { profile, runtime } = createResolutionFixture(sandbox, resolve);

      await expect(runtime.resolveProfile(profile.id)).resolves.toMatchObject({
        effectiveConnection: { hostName: "old.internal" }
      });
      await expect(runtime.resolveProfile(profile.id)).resolves.toMatchObject({
        effectiveConnection: { hostName: "new.internal" }
      });

      expect(resolve).toHaveBeenCalledTimes(2);
      await expect(runtime.getSnapshot()).resolves.toMatchObject({
        profiles: [
          {
            id: profile.id,
            effectiveConnection: { hostName: "new.internal" }
          }
        ]
      });
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("does not let an older background success overwrite a newer connection resolution", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-ssh-connection-"));
    try {
      const background = deferred<ReturnType<typeof resolvedConnection>>();
      const resolve = vi
        .fn()
        .mockImplementationOnce(async () => background.promise)
        .mockImplementationOnce(async (profile: SshProfileDto) =>
          resolvedConnection(profile, "connected.internal")
        );
      const { profile, runtime } = createResolutionFixture(sandbox, resolve);

      const staleResolution = runtime.resolveProfile(profile.id);
      await runtime.connectProfile(profile.id);
      await expect(runtime.getSnapshot()).resolves.toMatchObject({
        profiles: [
          {
            id: profile.id,
            effectiveConnection: { hostName: "connected.internal" }
          }
        ]
      });

      background.resolve(resolvedConnection(profile, "stale.internal"));
      await expect(staleResolution).resolves.toBeNull();
      await expect(runtime.getSnapshot()).resolves.toMatchObject({
        profiles: [
          {
            id: profile.id,
            effectiveConnection: { hostName: "connected.internal" }
          }
        ]
      });
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("does not let an older background failure clear a newer connection resolution", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-ssh-connection-"));
    try {
      const background = deferred<ReturnType<typeof resolvedConnection>>();
      const resolve = vi
        .fn()
        .mockImplementationOnce(async () => background.promise)
        .mockImplementationOnce(async (profile: SshProfileDto) =>
          resolvedConnection(profile, "connected.internal")
        );
      const { profile, runtime } = createResolutionFixture(sandbox, resolve);

      const staleResolution = runtime.resolveProfile(profile.id);
      await runtime.connectProfile(profile.id);
      background.reject(new Error("stale background failure"));

      await expect(staleResolution).resolves.toBeNull();
      await expect(runtime.getSnapshot()).resolves.toMatchObject({
        profiles: [
          {
            id: profile.id,
            effectiveConnection: { hostName: "connected.internal" }
          }
        ]
      });
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("discards resolution results after the stored profile is changed or deleted", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-ssh-connection-"));
    try {
      const profiles = createSshProfileStore(join(sandbox, "profiles.json"), {
        now: () => NOW,
        makeProfileId: () => "profile_stale"
      });
      const profile = profiles.save(undefined, {
        name: "before",
        host: "before.example.com"
      });
      const firstPending = deferred<ReturnType<typeof resolvedConnection>>();
      const secondPending = deferred<ReturnType<typeof resolvedConnection>>();
      const resolve = vi
        .fn()
        .mockImplementationOnce(async () => firstPending.promise)
        .mockImplementationOnce(async () => secondPending.promise);
      const bindings = createRemoteTargetBindingStore(
        join(sandbox, "bindings.json")
      );
      const runtime = createSshConnectionRuntime({
        desktopInstallationId: "desktop_1",
        profiles,
        bindings,
        resolver: { resolve },
        host: new FakeHost() as unknown as RemoteHostManager,
        lifecycle: new FakeLifecycle(
          bindings
        ) as unknown as RemoteLifecycleRuntime,
        isTargetReferenced: () => false,
        now: () => NOW
      });

      const staleAfterSave = runtime.resolveProfile(profile.id);
      runtime.saveProfile(profile.id, {
        name: "after",
        host: "after.example.com"
      });
      firstPending.resolve(resolvedConnection(profile));
      await expect(staleAfterSave).resolves.toBeNull();
      expect(
        (await runtime.getSnapshot()).profiles[0]?.effectiveConnection
      ).toBeUndefined();

      const current = profiles.get(profile.id)!;
      const staleAfterDelete = runtime.resolveProfile(profile.id);
      runtime.deleteProfile(profile.id);
      secondPending.resolve(resolvedConnection(current));
      await expect(staleAfterDelete).resolves.toBeNull();
      await expect(runtime.getSnapshot()).resolves.toMatchObject({
        profiles: []
      });
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("keeps the last explicit connection error when background resolution fails", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-ssh-connection-"));
    try {
      const profiles = createSshProfileStore(join(sandbox, "profiles.json"), {
        now: () => NOW,
        makeProfileId: () => "profile_failure"
      });
      const profile = profiles.save(undefined, {
        name: "failure",
        host: "failure.example.com"
      });
      profiles.recordError(profile.id, new Error("explicit connection failed"));
      const bindings = createRemoteTargetBindingStore(
        join(sandbox, "bindings.json")
      );
      const runtime = createSshConnectionRuntime({
        desktopInstallationId: "desktop_1",
        profiles,
        bindings,
        resolver: {
          async resolve() {
            throw new Error("background route failed");
          }
        },
        host: new FakeHost() as unknown as RemoteHostManager,
        lifecycle: new FakeLifecycle(
          bindings
        ) as unknown as RemoteLifecycleRuntime,
        isTargetReferenced: () => false,
        now: () => NOW
      });

      await expect(runtime.resolveProfile(profile.id)).resolves.toMatchObject({
        id: profile.id,
        lastError: { message: "explicit connection failed" }
      });
      expect(
        (await runtime.getSnapshot()).profiles[0]?.effectiveConnection
      ).toBeUndefined();
      expect(
        (await runtime.getSnapshot()).profiles[0]?.lastError?.message
      ).toBe("explicit connection failed");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("persists an immutable authority binding only after provisional promotion", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-ssh-connection-"));
    try {
      const profiles = createSshProfileStore(join(sandbox, "profiles.json"), {
        now: () => NOW,
        makeProfileId: () => "profile_1"
      });
      const profile = profiles.save(undefined, {
        name: "dev-gpu",
        sshConfigHost: "dev-gpu",
        defaultRemoteCwd: "/srv/project"
      });
      const bindings = createRemoteTargetBindingStore(
        join(sandbox, "bindings.json")
      );
      const host = new FakeHost();
      const lifecycle = new FakeLifecycle(bindings);
      const hostKeyObservationPath = join(sandbox, "host-key-fingerprint");
      writeFileSync(hostKeyObservationPath, "SHA256:VerifiedHostKey0123+/=\n", {
        mode: 0o600
      });
      const runtime = createSshConnectionRuntime({
        desktopInstallationId: "desktop_1",
        profiles,
        bindings,
        resolver: resolver(profile.id, hostKeyObservationPath, "attempt_1"),
        host: host as unknown as RemoteHostManager,
        lifecycle: lifecycle as unknown as RemoteLifecycleRuntime,
        isTargetReferenced: () => false,
        now: () => NOW,
        makeTargetId: () => "target_1",
        makeConnectionAttemptId: () => "attempt_1",
        makeVerificationId: () => "verification_1",
        makeToken: () => "b".repeat(64)
      });

      const connecting = runtime.connectProfile(profile.id);
      await host.verified;
      expect(bindings.list()).toEqual([]);
      const connected = await connecting;

      expect(connected.binding).toMatchObject({
        id: "target_1",
        authority: {
          remoteInstallationId: "11111111-1111-4111-8111-111111111111",
          executionNodeId: "22222222-2222-4222-8222-222222222222",
          authenticatedPrincipal: { uid: 1000, accountName: "kmux" }
        },
        locator: {
          profileId: "profile_1",
          effectiveConnectionPolicyHash: POLICY
        },
        sshHostKeyFingerprint: "SHA256:VerifiedHostKey0123+/="
      });
      expect(lifecycle.promotions).toHaveLength(1);
      expect(lifecycle.promotions[0]).toMatchObject({
        connection: { desktopInstallationId: "desktop_1" }
      });
      expect((await runtime.getSnapshot()).profiles[0]).toMatchObject({
        effectiveConnection: { hostName: "dev.internal", user: "kmux" },
        verifiedTarget: {
          targetId: "target_1",
          sshHostKeyFingerprint: "SHA256:VerifiedHostKey0123+/=",
          runtimeVersion: "0.1.0",
          persistenceLevel: "ssh-disconnect"
        }
      });
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "guides macOS LAN failures",
      platform: "darwin" as const,
      message:
        "OpenSSH master exited before readiness: ssh: connect to host 192.168.45.117 port 22: No route to host",
      expectedMessage:
        "OpenSSH master exited before readiness: ssh: connect to host 192.168.45.117 port 22: No route to host",
      expectsLocalNetworkGuidance: true
    },
    {
      name: "preserves Linux route failures",
      platform: "linux" as const,
      message:
        "OpenSSH master exited before readiness: ssh: connect to host 192.168.45.117 port 22: No route to host",
      expectedMessage:
        "OpenSSH master exited before readiness: ssh: connect to host 192.168.45.117 port 22: No route to host",
      expectsLocalNetworkGuidance: false
    },
    {
      name: "preserves macOS authentication failures",
      platform: "darwin" as const,
      message: "Permission denied\n(publickey).",
      expectedMessage: "Permission denied (publickey).",
      expectsLocalNetworkGuidance: false
    }
  ])(
    "$name",
    async ({
      platform,
      message,
      expectedMessage,
      expectsLocalNetworkGuidance
    }) => {
      const sandbox = mkdtempSync(join(tmpdir(), "kmux-ssh-connection-"));
      try {
        const profiles = createSshProfileStore(join(sandbox, "profiles.json"), {
          now: () => NOW,
          makeProfileId: () => "profile_1"
        });
        const profile = profiles.save(undefined, {
          name: "private-lan",
          host: "192.168.45.117"
        });
        const bindings = createRemoteTargetBindingStore(
          join(sandbox, "bindings.json")
        );
        const runtime = createSshConnectionRuntime({
          desktopInstallationId: "desktop_1",
          profiles,
          bindings,
          resolver: resolver(profile.id),
          host: new FakeHost(
            undefined,
            new Error(message)
          ) as unknown as RemoteHostManager,
          lifecycle: new FakeLifecycle(
            bindings
          ) as unknown as RemoteLifecycleRuntime,
          platform,
          isTargetReferenced: () => false,
          now: () => NOW
        });

        await expect(runtime.connectProfile(profile.id)).rejects.toThrow(
          expectedMessage
        );

        const storedMessage = (await runtime.getSnapshot()).profiles[0]
          ?.lastError?.message;
        if (expectsLocalNetworkGuidance) {
          expect(storedMessage).toContain(expectedMessage);
          expect(storedMessage).toContain(
            "System Settings > Privacy & Security > Local Network"
          );
        } else {
          expect(storedMessage).toBe(expectedMessage);
        }
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    }
  );

  it("serializes concurrent aliases so one verified authority gets one target ID", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-ssh-connection-"));
    try {
      let profileIndex = 0;
      const profiles = createSshProfileStore(join(sandbox, "profiles.json"), {
        now: () => NOW,
        makeProfileId: () => `profile_${++profileIndex}`
      });
      const first = profiles.save(undefined, {
        name: "first-alias",
        sshConfigHost: "first-alias"
      });
      const second = profiles.save(undefined, {
        name: "second-alias",
        sshConfigHost: "second-alias"
      });
      const bindings = createRemoteTargetBindingStore(
        join(sandbox, "bindings.json")
      );
      const lifecycle = new FakeLifecycle(bindings, true);
      let attemptIndex = 0;
      let verificationIndex = 0;
      let targetIndex = 0;
      const runtime = createSshConnectionRuntime({
        desktopInstallationId: "desktop_1",
        profiles,
        bindings,
        resolver: {
          async resolve(profile) {
            return {
              profile,
              sshPath: "/usr/bin/ssh",
              configPath: `/tmp/${profile.id}.conf`,
              hostKeyObservationPath: `/tmp/missing-${profile.id}`,
              host: profile.sshConfigHost!,
              effective: {
                hostName: "shared.internal",
                user: "kmux",
                port: 22,
                identityFiles: [],
                policyHash: POLICY
              },
              rootOverrides: {}
            };
          }
        },
        host: new FakeHost() as unknown as RemoteHostManager,
        lifecycle: lifecycle as unknown as RemoteLifecycleRuntime,
        isTargetReferenced: () => false,
        now: () => NOW,
        makeConnectionAttemptId: () => `attempt_${++attemptIndex}`,
        makeVerificationId: () => `verification_${++verificationIndex}`,
        makeTargetId: () => `target_${++targetIndex}`,
        makeToken: () => "e".repeat(64)
      });

      const [firstConnection, secondConnection] = await Promise.all([
        runtime.connectProfile(first.id),
        runtime.connectProfile(second.id)
      ]);

      expect(firstConnection.binding.id).toBe("target_1");
      expect(secondConnection.binding.id).toBe("target_1");
      expect(bindings.list()).toHaveLength(1);
      expect(
        Date.parse(bindings.list()[0]!.locator.lastVerifiedAt)
      ).toBeGreaterThan(Date.parse(bindings.list()[0]!.firstVerifiedAt));
      expect(targetIndex).toBe(1);
      expect(lifecycle.maximumActivePromotions).toBe(1);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("fails closed when a mutable profile route reaches another authority", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-ssh-connection-"));
    try {
      const profiles = createSshProfileStore(join(sandbox, "profiles.json"), {
        now: () => NOW,
        makeProfileId: () => "profile_1"
      });
      const profile = profiles.save(undefined, {
        name: "staging",
        host: "staging.example.com"
      });
      const bindings = createRemoteTargetBindingStore(
        join(sandbox, "bindings.json")
      );
      bindings.replace(binding("target_old", profile.id));
      const host = new FakeHost({
        remoteInstallationId: "33333333-3333-4333-8333-333333333333"
      });
      const lifecycle = new FakeLifecycle(bindings);
      const runtime = createSshConnectionRuntime({
        desktopInstallationId: "desktop_1",
        profiles,
        bindings,
        resolver: resolver(profile.id),
        host: host as unknown as RemoteHostManager,
        lifecycle: lifecycle as unknown as RemoteLifecycleRuntime,
        isTargetReferenced: () => true,
        now: () => NOW,
        makeVerificationId: () => "verification_1"
      });

      await expect(runtime.connectProfile(profile.id)).rejects.toThrow(
        /different remote authority/u
      );
      expect(host.discarded).toEqual(["verification_1"]);
      expect(lifecycle.promotions).toEqual([]);
      expect(bindings.list()).toHaveLength(1);
      expect(
        (await runtime.getSnapshot()).profiles[0]?.lastError?.message
      ).toMatch(/different remote authority/u);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("creates a new immutable target only through explicit rebind", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-ssh-connection-"));
    try {
      const profiles = createSshProfileStore(join(sandbox, "profiles.json"), {
        now: () => NOW,
        makeProfileId: () => "profile_1"
      });
      const profile = profiles.save(undefined, {
        name: "moved-alias",
        sshConfigHost: "moved-alias"
      });
      const bindings = createRemoteTargetBindingStore(
        join(sandbox, "bindings.json")
      );
      bindings.replace(binding("target_old", profile.id));
      const lifecycle = new FakeLifecycle(bindings);
      const runtime = createSshConnectionRuntime({
        desktopInstallationId: "desktop_1",
        profiles,
        bindings,
        resolver: resolver(profile.id),
        host: new FakeHost({
          remoteInstallationId: "33333333-3333-4333-8333-333333333333"
        }) as unknown as RemoteHostManager,
        lifecycle: lifecycle as unknown as RemoteLifecycleRuntime,
        isTargetReferenced: (targetId) => targetId === "target_old",
        now: () => NOW,
        makeTargetId: () => "target_new",
        makeConnectionAttemptId: () => "attempt_rebind",
        makeVerificationId: () => "verification_rebind",
        makeToken: () => "d".repeat(64)
      });

      await expect(runtime.connectProfile(profile.id)).rejects.toThrow(
        /explicit rebind is required/u
      );
      await expect(runtime.rebindProfile(profile.id)).resolves.toMatchObject({
        binding: {
          id: "target_new",
          authority: {
            remoteInstallationId: "33333333-3333-4333-8333-333333333333"
          }
        }
      });

      expect(bindings.get("target_old")).toMatchObject({
        id: "target_old",
        authority: {
          remoteInstallationId: "11111111-1111-4111-8111-111111111111"
        }
      });
      expect(bindings.get("target_new")).toMatchObject({
        id: "target_new",
        authority: {
          remoteInstallationId: "33333333-3333-4333-8333-333333333333"
        }
      });
      expect(bindings.list()).toHaveLength(2);
      expect(
        (await runtime.getSnapshot()).profiles[0]?.verifiedTarget?.targetId
      ).toBe("target_new");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("prevents deletion while a target binding remains product-referenced", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-ssh-connection-"));
    try {
      const profiles = createSshProfileStore(join(sandbox, "profiles.json"), {
        now: () => NOW,
        makeProfileId: () => "profile_1"
      });
      const profile = profiles.save(undefined, {
        name: "prod",
        host: "prod.example.com"
      });
      const bindings = createRemoteTargetBindingStore(
        join(sandbox, "bindings.json")
      );
      bindings.replace(binding("target_1", profile.id));
      const runtime = createSshConnectionRuntime({
        desktopInstallationId: "desktop_1",
        profiles,
        bindings,
        resolver: resolver(profile.id),
        host: new FakeHost() as unknown as RemoteHostManager,
        lifecycle: new FakeLifecycle(
          bindings
        ) as unknown as RemoteLifecycleRuntime,
        isTargetReferenced: (targetId) => targetId === "target_1",
        now: () => NOW
      });

      expect(() => runtime.deleteProfile(profile.id)).toThrow(/referenced/u);
      expect(profiles.get(profile.id)).toBeDefined();
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("uses askpass only for interactive restore while preserving the exact persisted target", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-ssh-connection-"));
    try {
      const profiles = createSshProfileStore(join(sandbox, "profiles.json"), {
        now: () => NOW,
        makeProfileId: () => "profile_1"
      });
      const profile = profiles.save(undefined, {
        name: "restored-prod",
        host: "prod.example.com"
      });
      const bindings = createRemoteTargetBindingStore(
        join(sandbox, "bindings.json")
      );
      bindings.replace(binding("target_restore", profile.id));
      const host = new FakeHost();
      const lifecycle = new FakeLifecycle(bindings);
      const dispose = vi.fn();
      const createContext = vi.fn(async () => ({
        askpassPath: "/tmp/kmux-askpass",
        wasCancelled: () => false,
        dispose
      }));
      const runtime = createSshConnectionRuntime({
        desktopInstallationId: "desktop_1",
        profiles,
        bindings,
        resolver: resolver(profile.id),
        host: host as unknown as RemoteHostManager,
        lifecycle: lifecycle as unknown as RemoteLifecycleRuntime,
        askpassBroker: {
          start: vi.fn(),
          stop: vi.fn(),
          createContext,
          claimPresenter: vi.fn(),
          releasePresenter: vi.fn(),
          respond: vi.fn()
        },
        isTargetReferenced: () => true,
        now: () => NOW,
        makeConnectionAttemptId: () => "restore_attempt_1",
        makeVerificationId: () => "restore_verification_1",
        makeToken: () => "d".repeat(64)
      });

      const restored = await runtime.restoreTarget("target_restore", {
        authentication: "non-interactive",
        purpose: "runtime-reconnect"
      });

      expect(createContext).not.toHaveBeenCalled();
      expect(host.verifyRequests).toEqual([
        expect.objectContaining({
          verificationId: "restore_verification_1",
          connectionAttemptId: "restore_attempt_1"
        })
      ]);
      expect(host.verifyRequests[0]).not.toHaveProperty("askpassPath");
      expect(lifecycle.promotions).toHaveLength(1);
      expect(lifecycle.promotions[0]).toMatchObject({
        binding: { id: "target_restore" },
        connection: {
          desktopInstallationId: "desktop_1",
          targetId: "target_restore",
          connectionAttemptId: "restore_attempt_1",
          effectiveConnectionPolicyHash: POLICY
        }
      });
      expect(restored.binding.id).toBe("target_restore");

      await runtime.restoreTarget("target_restore", {
        authentication: "interactive",
        purpose: "startup-restore"
      });
      expect(createContext).toHaveBeenCalledWith(profile, "startup-restore");
      expect(host.verifyRequests[1]).toEqual(
        expect.objectContaining({ askpassPath: "/tmp/kmux-askpass" })
      );
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("leaves a restored binding intact when authority re-verification mismatches", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-ssh-connection-"));
    try {
      const profiles = createSshProfileStore(join(sandbox, "profiles.json"), {
        now: () => NOW,
        makeProfileId: () => "profile_1"
      });
      const profile = profiles.save(undefined, {
        name: "moved-alias",
        sshConfigHost: "moved-alias"
      });
      const bindings = createRemoteTargetBindingStore(
        join(sandbox, "bindings.json")
      );
      const original = binding("target_restore", profile.id);
      bindings.replace(original);
      const host = new FakeHost({
        remoteInstallationId: "33333333-3333-4333-8333-333333333333"
      });
      const lifecycle = new FakeLifecycle(bindings);
      const runtime = createSshConnectionRuntime({
        desktopInstallationId: "desktop_1",
        profiles,
        bindings,
        resolver: resolver(profile.id),
        host: host as unknown as RemoteHostManager,
        lifecycle: lifecycle as unknown as RemoteLifecycleRuntime,
        isTargetReferenced: () => true,
        now: () => NOW,
        makeVerificationId: () => "restore_verification_1"
      });

      await expect(
        runtime.restoreTarget("target_restore", {
          authentication: "non-interactive",
          purpose: "runtime-reconnect"
        })
      ).rejects.toThrow(/no longer matches its verified authority/u);
      expect(lifecycle.promotions).toEqual([]);
      expect(host.discarded).toEqual(["restore_verification_1"]);
      expect(bindings.get("target_restore")).toEqual(original);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("does not let an older restore replace a newer explicit connection", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-ssh-connection-"));
    try {
      const profiles = createSshProfileStore(join(sandbox, "profiles.json"), {
        now: () => NOW,
        makeProfileId: () => "profile_1"
      });
      const profile = profiles.save(undefined, {
        name: "shared-target",
        host: "shared.example.com"
      });
      const bindings = createRemoteTargetBindingStore(
        join(sandbox, "bindings.json")
      );
      bindings.replace(binding("target_shared", profile.id));
      const staleResolution =
        deferred<ReturnType<typeof resolvedConnection>>();
      const resolve = vi
        .fn()
        .mockImplementationOnce(async () => staleResolution.promise)
        .mockImplementationOnce(async (currentProfile: SshProfileDto) =>
          resolvedConnection(currentProfile)
        );
      const host = new FakeHost();
      const lifecycle = new FakeLifecycle(bindings);
      let attemptIndex = 0;
      let verificationIndex = 0;
      const runtime = createSshConnectionRuntime({
        desktopInstallationId: "desktop_1",
        profiles,
        bindings,
        resolver: { resolve },
        host: host as unknown as RemoteHostManager,
        lifecycle: lifecycle as unknown as RemoteLifecycleRuntime,
        isTargetReferenced: () => true,
        now: () => NOW,
        makeConnectionAttemptId: () => `attempt_${++attemptIndex}`,
        makeVerificationId: () => `verification_${++verificationIndex}`,
        makeToken: () => "d".repeat(64)
      });

      const staleRestore = runtime.restoreTarget("target_shared", {
        authentication: "non-interactive",
        purpose: "runtime-reconnect"
      });
      const connected = await runtime.connectProfile(profile.id);
      const latestBinding = bindings.get("target_shared");

      staleResolution.resolve(resolvedConnection(profile));

      await expect(staleRestore).rejects.toBeInstanceOf(
        SshConnectionAttemptSupersededError
      );
      expect(connected.binding.id).toBe("target_shared");
      expect(bindings.get("target_shared")).toEqual(latestBinding);
      expect(lifecycle.promotions).toHaveLength(1);
      expect(host.verifyRequests).toHaveLength(1);
      expect(host.discarded).toEqual([]);
      expect(
        (await runtime.getSnapshot()).profiles[0]?.lastError
      ).toBeUndefined();
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("routes explicit runtime maintenance to the verified connected target and clears stale observation after reset", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-ssh-connection-"));
    try {
      const profiles = createSshProfileStore(join(sandbox, "profiles.json"), {
        now: () => NOW,
        makeProfileId: () => "profile_1"
      });
      const profile = profiles.save(undefined, {
        name: "maintenance",
        host: "maintenance.example.com"
      });
      const bindings = createRemoteTargetBindingStore(
        join(sandbox, "bindings.json")
      );
      bindings.replace(observedBinding("target_1", profile.id));
      const lifecycle = new FakeLifecycle(bindings);
      lifecycle.connected = true;
      const runtime = createSshConnectionRuntime({
        desktopInstallationId: "desktop_1",
        profiles,
        bindings,
        resolver: resolver(profile.id),
        host: new FakeHost() as unknown as RemoteHostManager,
        lifecycle: lifecycle as unknown as RemoteLifecycleRuntime,
        isTargetReferenced: () => false,
        now: () => NOW
      });

      await expect(runtime.cleanRemoteRuntime(profile.id)).resolves.toEqual({
        inspected: 2,
        removed: [`1+${"a".repeat(64)}`],
        live: [`1+${"c".repeat(64)}`],
        incompleteOrCorrupt: []
      });
      expect(lifecycle.cleanCalls).toEqual(["target_1"]);
      expect(bindings.get("target_1")?.observation).toBeDefined();

      await expect(runtime.resetRemoteRuntime(profile.id)).resolves.toEqual({
        generation: `1+${"c".repeat(64)}`,
        status: "reset"
      });
      expect(lifecycle.resetCalls).toEqual(["target_1"]);
      expect(bindings.get("target_1")).toMatchObject({ id: "target_1" });
      expect(bindings.get("target_1")?.observation).toBeUndefined();
      expect(
        (await runtime.getSnapshot()).profiles[0]?.lastError
      ).toBeUndefined();
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("refuses runtime reset before connecting when the target is still product-referenced", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-ssh-connection-"));
    try {
      const profiles = createSshProfileStore(join(sandbox, "profiles.json"), {
        now: () => NOW,
        makeProfileId: () => "profile_1"
      });
      const profile = profiles.save(undefined, {
        name: "referenced",
        host: "referenced.example.com"
      });
      const bindings = createRemoteTargetBindingStore(
        join(sandbox, "bindings.json")
      );
      bindings.replace(observedBinding("target_1", profile.id));
      const lifecycle = new FakeLifecycle(bindings);
      const host = new FakeHost();
      const runtime = createSshConnectionRuntime({
        desktopInstallationId: "desktop_1",
        profiles,
        bindings,
        resolver: resolver(profile.id),
        host: host as unknown as RemoteHostManager,
        lifecycle: lifecycle as unknown as RemoteLifecycleRuntime,
        isTargetReferenced: (targetId) => targetId === "target_1",
        now: () => NOW
      });

      await expect(runtime.resetRemoteRuntime(profile.id)).rejects.toThrow(
        /workspaces and retained sessions/u
      );
      expect(host.verifyRequests).toEqual([]);
      expect(lifecycle.resetCalls).toEqual([]);
      expect(bindings.get("target_1")?.observation).toBeDefined();
      expect(
        (await runtime.getSnapshot()).profiles[0]?.lastError?.message
      ).toMatch(/workspaces and retained sessions/u);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("rechecks target references inside the reset queue after reconnect", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-ssh-connection-"));
    try {
      const profiles = createSshProfileStore(join(sandbox, "profiles.json"), {
        now: () => NOW,
        makeProfileId: () => "profile_1"
      });
      const profile = profiles.save(undefined, {
        name: "late-reference",
        host: "late-reference.example.com"
      });
      const bindings = createRemoteTargetBindingStore(
        join(sandbox, "bindings.json")
      );
      bindings.replace(observedBinding("target_1", profile.id));
      const lifecycle = new FakeLifecycle(bindings);
      const host = new FakeHost();
      let referenceChecks = 0;
      const runtime = createSshConnectionRuntime({
        desktopInstallationId: "desktop_1",
        profiles,
        bindings,
        resolver: resolver(profile.id),
        host: host as unknown as RemoteHostManager,
        lifecycle: lifecycle as unknown as RemoteLifecycleRuntime,
        isTargetReferenced: () => {
          referenceChecks += 1;
          return referenceChecks > 1;
        },
        now: () => NOW,
        makeVerificationId: () => "late_reference_verification"
      });

      await expect(runtime.resetRemoteRuntime(profile.id)).rejects.toThrow(
        /workspaces and retained sessions/u
      );
      expect(host.verifyRequests).toHaveLength(1);
      expect(lifecycle.resetCalls).toEqual([]);
      expect(bindings.get("target_1")?.observation).toBeDefined();
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

class FakeHost {
  discarded: string[] = [];
  verifyRequests: Array<Record<string, unknown>> = [];
  verified: Promise<void>;
  private resolveVerified!: () => void;

  constructor(
    private readonly authority: {
      remoteInstallationId: string;
    } = {
      remoteInstallationId: "11111111-1111-4111-8111-111111111111"
    },
    private readonly verificationError?: Error
  ) {
    this.verified = new Promise<void>((resolve) => {
      this.resolveVerified = resolve;
    });
  }

  async verifyTarget(options: { verificationId: string }) {
    this.verifyRequests.push(structuredClone(options));
    this.resolveVerified();
    if (this.verificationError) {
      throw this.verificationError;
    }
    return {
      verificationId: options.verificationId,
      effectiveConnectionPolicyHash: POLICY,
      generation: `1+${"c".repeat(64)}`,
      runtimePath: `/home/kmux/.kmux/bin/1+${"c".repeat(64)}/kmuxd`,
      remoteHome: "/home/kmux",
      roots: {
        installRoot: "/home/kmux/.kmux",
        authorityRoot: "/home/kmux/.kmux/state/authority",
        stateRoot: "/home/kmux/.kmux/state",
        runtimeRoot: "/tmp/kmux-1000"
      },
      doctor: {
        remoteInstallationId: this.authority.remoteInstallationId,
        executionNodeId: "22222222-2222-4222-8222-222222222222",
        authenticatedPrincipal: { uid: 1000, accountName: "kmux" },
        platform: "linux",
        arch: "x86_64",
        abi: "musl",
        installRoot: "/home/kmux/.kmux",
        authorityRoot: "/home/kmux/.kmux/state/authority",
        stateRoot: "/home/kmux/.kmux/state",
        runtimeRoot: "/tmp/kmux-1000"
      }
    };
  }

  discardTargetVerification(verificationId: string): Promise<void> {
    this.discarded.push(verificationId);
    return Promise.resolve();
  }
}

class FakeLifecycle {
  promotions: unknown[] = [];
  cleanCalls: string[] = [];
  resetCalls: string[] = [];
  connected = false;
  maximumActivePromotions = 0;
  private activePromotions = 0;

  constructor(
    private readonly bindings: ReturnType<
      typeof createRemoteTargetBindingStore
    >,
    private readonly delayPromotion = false
  ) {}

  isTargetConnected(): boolean {
    return this.connected;
  }

  disconnectTarget(): Promise<void> {
    return Promise.resolve();
  }

  cleanTargetRuntime(targetId: string) {
    this.cleanCalls.push(targetId);
    return Promise.resolve({
      inspected: 2,
      removed: [`1+${"a".repeat(64)}`],
      live: [`1+${"c".repeat(64)}`],
      incompleteOrCorrupt: []
    });
  }

  resetTargetRuntime(targetId: string, assertTargetUnreferenced?: () => void) {
    assertTargetUnreferenced?.();
    this.resetCalls.push(targetId);
    this.connected = false;
    return Promise.resolve({
      generation: `1+${"c".repeat(64)}`,
      status: "reset" as const
    });
  }

  async promoteVerifiedTarget(options: {
    binding: ReturnType<typeof binding>;
    assertPromotionCurrent?: () => void;
  }) {
    this.activePromotions += 1;
    this.maximumActivePromotions = Math.max(
      this.maximumActivePromotions,
      this.activePromotions
    );
    try {
      if (this.delayPromotion) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      options.assertPromotionCurrent?.();
      this.promotions.push(options);
      this.bindings.replace({
        ...options.binding,
        observation: {
          platform: "linux",
          arch: "x86_64",
          abi: "musl",
          runtimeVersion: "0.1.0",
          capabilities: ["terminal-v1"],
          persistenceLevel: "ssh-disconnect"
        }
      });
      return {
        type: "hello" as const,
        protocolVersion: 1,
        runtimeVersion: "0.1.0",
        bridgeGeneration: "bridge_1",
        capabilities: ["terminal-v1"],
        authority: options.binding.authority,
        platform: "linux",
        arch: "x86_64",
        abi: "musl",
        persistenceLevel: "ssh-disconnect" as const
      };
    } finally {
      this.activePromotions -= 1;
    }
  }
}

function resolver(
  profileId: string,
  hostKeyObservationPath = `/tmp/kmux-missing-host-key-${profileId}`,
  expectedConnectionAttemptId?: string
): SshProfileConnectionResolver {
  return {
    async resolve(profile, connectionAttemptId) {
      expect(profile.id).toBe(profileId);
      if (expectedConnectionAttemptId !== undefined) {
        expect(connectionAttemptId).toBe(expectedConnectionAttemptId);
      }
      return {
        profile,
        sshPath: "/usr/bin/ssh",
        configPath: "/tmp/ssh_config",
        hostKeyObservationPath,
        host: profile.sshConfigHost ?? "internal-profile",
        effective: {
          hostName: "dev.internal",
          user: "kmux",
          port: 22,
          identityFiles: ["/keys/test"],
          policyHash: POLICY
        },
        rootOverrides: {}
      };
    }
  };
}

function createResolutionFixture(
  sandbox: string,
  resolve: SshProfileConnectionResolver["resolve"]
) {
  const profiles = createSshProfileStore(join(sandbox, "profiles.json"), {
    now: () => NOW,
    makeProfileId: () => "profile_resolution"
  });
  const profile = profiles.save(undefined, {
    name: "resolution",
    sshConfigHost: "resolution"
  });
  const bindings = createRemoteTargetBindingStore(
    join(sandbox, "bindings.json")
  );
  const runtime = createSshConnectionRuntime({
    desktopInstallationId: "desktop_1",
    profiles,
    bindings,
    resolver: { resolve },
    host: new FakeHost() as unknown as RemoteHostManager,
    lifecycle: new FakeLifecycle(bindings) as unknown as RemoteLifecycleRuntime,
    isTargetReferenced: () => false,
    now: () => NOW,
    makeTargetId: () => "target_resolution",
    makeVerificationId: () => "verification_resolution",
    makeToken: () => "a".repeat(64)
  });
  return { profile, runtime };
}

function resolvedConnection(profile: SshProfileDto, hostName = "dev.internal") {
  return {
    profile,
    sshPath: "/usr/bin/ssh",
    configPath: "/tmp/ssh_config",
    hostKeyObservationPath: `/tmp/kmux-missing-host-key-${profile.id}`,
    host: profile.sshConfigHost ?? profile.host ?? "internal-profile",
    effective: {
      hostName,
      user: "kmux",
      port: 22,
      identityFiles: ["/keys/test"],
      policyHash: POLICY
    },
    rootOverrides: {}
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function binding(targetId: string, profileId: string) {
  return {
    id: targetId,
    authority: {
      remoteInstallationId: "11111111-1111-4111-8111-111111111111",
      executionNodeId: "22222222-2222-4222-8222-222222222222",
      authenticatedPrincipal: { uid: 1000, accountName: "kmux" }
    },
    locator: {
      profileId,
      effectiveConnectionPolicyHash: POLICY,
      lastVerifiedAt: NOW
    },
    firstVerifiedAt: NOW
  };
}

function observedBinding(targetId: string, profileId: string) {
  return {
    ...binding(targetId, profileId),
    observation: {
      platform: "linux",
      arch: "x86_64",
      abi: "musl",
      runtimeVersion: "0.1.0",
      capabilities: ["terminal-v1"],
      persistenceLevel: "ssh-disconnect" as const
    }
  };
}
