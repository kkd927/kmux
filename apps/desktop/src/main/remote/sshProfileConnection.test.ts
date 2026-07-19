import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createSshProfileConnectionResolver,
  readObservedSshHostKeyFingerprint
} from "./sshProfileConnection";

describe("SSH profile connection resolver", () => {
  it("materializes a private wrapper config and hashes OpenSSH's effective policy", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-ssh-profile-resolver-"));
    try {
      const resolveEffective = vi.fn(async (options: { configPath: string }) => {
        const config = readFileSync(options.configPath, "utf8");
        expect(config).toContain("Host dev-gpu");
        expect(config).toContain("ForwardAgent no");
        expect(config).toContain("KnownHostsCommand /bin/sh");
        expect(config).toContain('"%f" "%I"');
        expect(config).toContain(`Include "${sandbox}/.ssh/config"`);
        return {
          hostName: "gpu.internal",
          user: "dev",
          port: 2222,
          identityFiles: ["/keys/dev_ed25519"],
          proxyJump: "bastion",
          canonicalLines: ["hostname gpu.internal"],
          policyHash: "a".repeat(64)
        };
      });
      const resolver = createSshProfileConnectionResolver({
        homeDir: sandbox,
        configRoot: join(sandbox, "generated"),
        resolveEffective
      });

      const resolved = await resolver.resolve({
        id: "profile_1",
        name: "GPU",
        sshConfigHost: "dev-gpu",
        defaultRemoteCwd: "/srv/project",
        statePathOverride: "/var/lib/kmux/state",
        createdAt: "2026-07-19T00:00:00.000Z",
        updatedAt: "2026-07-19T00:00:00.000Z"
      });

      expect(resolved).toMatchObject({
        host: "dev-gpu",
        effective: {
          hostName: "gpu.internal",
          user: "dev",
          port: 2222,
          policyHash: "a".repeat(64)
        },
        rootOverrides: { stateRoot: "/var/lib/kmux/state" }
      });
      expect(resolveEffective).toHaveBeenCalledOnce();
      execFileSync("/bin/sh", [
        join(sandbox, "generated", "host-key-observer.sh"),
        resolved.hostKeyObservationPath,
        "SHA256:AbCdEf0123+/=_-",
        "HOSTNAME"
      ]);
      expect(
        readObservedSshHostKeyFingerprint(resolved.hostKeyObservationPath)
      ).toBe("SHA256:AbCdEf0123+/=_-");
      writeFileSync(resolved.hostKeyObservationPath, "unverified-candidate\n");
      expect(
        readObservedSshHostKeyFingerprint(resolved.hostKeyObservationPath)
      ).toBeUndefined();
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("uses an internal alias for an explicit host and preserves explicit profile overrides", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-ssh-profile-resolver-"));
    try {
      let generated = "";
      const resolver = createSshProfileConnectionResolver({
        homeDir: sandbox,
        configRoot: join(sandbox, "generated"),
        resolveEffective: async (options) => {
          generated = readFileSync(options.configPath, "utf8");
          expect(options.host).toMatch(/^kmux-profile-/u);
          return {
            hostName: "2001:db8::1",
            user: "alice",
            port: 2200,
            identityFiles: ["/keys/alice"],
            canonicalLines: [],
            policyHash: "b".repeat(64)
          };
        }
      });

      await resolver.resolve({
        id: "profile_2",
        name: "Explicit",
        host: "[2001:db8::1]",
        user: "alice",
        port: 2200,
        identityFile: "/keys/alice",
        forwardAgent: true,
        createdAt: "2026-07-19T00:00:00.000Z",
        updatedAt: "2026-07-19T00:00:00.000Z"
      });

      expect(generated).toContain('HostName "[2001:db8::1]"');
      expect(generated).toContain('User "alice"');
      expect(generated).toContain("Port 2200");
      expect(generated).toContain("ForwardAgent yes");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
