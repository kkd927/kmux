import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createSshProfileStore, decodeSshProfileDraft } from "./sshProfileStore";

describe("SSH profile store", () => {
  it("durably round-trips bounded locator settings without storing secrets", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-ssh-profiles-"));
    const path = join(sandbox, "profiles.json");
    try {
      const store = createSshProfileStore(path, {
        now: () => "2026-07-19T00:00:00.000Z",
        makeProfileId: () => "profile_1"
      });
      const saved = store.save(undefined, {
        name: "dev-gpu",
        sshConfigHost: "dev-gpu",
        defaultRemoteCwd: "/srv/project",
        bootstrapShellOverride: "/bin/sh",
        installPathOverride: "/var/tmp/kmux-install",
        sessionRetentionQuotaMiB: 512,
        targetRetentionQuotaMiB: 4096,
        env: { LANG: "C.UTF-8" },
        forwardAgent: false
      });

      expect(saved).toMatchObject({
        id: "profile_1",
        name: "dev-gpu",
        sshConfigHost: "dev-gpu",
        createdAt: "2026-07-19T00:00:00.000Z"
      });
      expect(lstatSync(path).mode & 0o077).toBe(0);
      expect(createSshProfileStore(path).list()).toEqual([saved]);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("keeps duplicate and connection-error lifecycle bounded and profile-scoped", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-ssh-profiles-"));
    const path = join(sandbox, "profiles.json");
    let id = 0;
    try {
      const store = createSshProfileStore(path, {
        now: () => "2026-07-19T00:00:00.000Z",
        makeProfileId: () => `profile_${++id}`
      });
      const source = store.save(undefined, {
        name: "staging",
        host: "staging.example.com"
      });
      const copy = store.duplicate(source.id);
      store.recordError(source.id, new Error("host key verification failed"));

      expect(copy.name).toBe("staging copy");
      expect(store.getError(source.id)).toEqual({
        at: "2026-07-19T00:00:00.000Z",
        message: "host key verification failed"
      });
      store.clearError(source.id);
      expect(store.getError(source.id)).toBeUndefined();
      store.remove(source.id);
      expect(store.list().map((profile) => profile.id)).toEqual([copy.id]);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous locators, unsafe paths, environment keys, and quota bounds", () => {
    expect(() =>
      decodeSshProfileDraft({ name: "missing locator" })
    ).toThrow(/exactly one/u);
    expect(() =>
      decodeSshProfileDraft({
        name: "ambiguous",
        sshConfigHost: "alias",
        host: "host"
      })
    ).toThrow(/exactly one/u);
    expect(() =>
      decodeSshProfileDraft({
        name: "relative",
        host: "host",
        defaultRemoteCwd: "relative/path"
      })
    ).toThrow(/absolute/u);
    expect(() =>
      decodeSshProfileDraft({
        name: "environment",
        host: "host",
        env: { "BAD=KEY": "value" }
      })
    ).toThrow(/environment key/u);
    expect(() =>
      decodeSshProfileDraft({
        name: "quota",
        host: "host",
        sessionRetentionQuotaMiB: 1024,
        targetRetentionQuotaMiB: 512
      })
    ).toThrow(/cover/u);
  });
});
