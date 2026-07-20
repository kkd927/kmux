import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { listOpenSshAliases } from "./openSshAliasCatalog";

describe("OpenSSH alias catalog", () => {
  it("collects literal Host aliases through bounded recursive Includes", async () => {
    const home = mkdtempSync(join(tmpdir(), "kmux-ssh-aliases-"));
    try {
      const ssh = join(home, ".ssh");
      mkdirSync(join(ssh, "conf.d"), { recursive: true });
      writeFileSync(
        join(ssh, "config"),
        [
          "Host dev-gpu *.wild !blocked",
          "  HostName dev.internal",
          "Include conf.d/*.conf",
          "Include $KMUX_EXTRA_CONFIG"
        ].join("\n")
      );
      writeFileSync(
        join(ssh, "conf.d", "10-staging.conf"),
        "Host staging ec2-agent-box\nInclude ../config\n"
      );
      writeFileSync(join(ssh, "extra.conf"), 'Host "quoted-alias"\n');

      expect(
        await listOpenSshAliases({
          homeDir: home,
          env: { KMUX_EXTRA_CONFIG: "extra.conf" }
        })
      ).toEqual(["dev-gpu", "ec2-agent-box", "quoted-alias", "staging"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns an empty catalog when the user config does not exist", async () => {
    const home = mkdtempSync(join(tmpdir(), "kmux-ssh-aliases-"));
    try {
      await expect(listOpenSshAliases({ homeDir: home })).resolves.toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("stops a lazy Include expansion at its global match bound", async () => {
    const home = mkdtempSync(join(tmpdir(), "kmux-ssh-aliases-"));
    try {
      const ssh = join(home, ".ssh");
      const includeRoot = join(ssh, "many");
      mkdirSync(includeRoot, { recursive: true });
      writeFileSync(join(ssh, "config"), "Include many/*\n");
      for (let index = 0; index < 257; index += 1) {
        mkdirSync(join(includeRoot, `entry-${index}`));
      }

      await expect(listOpenSshAliases({ homeDir: home })).rejects.toThrow(
        /too many matches/u
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
