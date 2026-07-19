import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createOpenSshEnvironment,
  OpenSshProcessError,
  resolveEffectiveSshConfig,
  runOpenSshCommand,
  validateHostAlias
} from "./openSshProcess";

const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(
    sandboxes
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("system OpenSSH process boundary", () => {
  it("resolves and hashes the system ssh effective configuration", async () => {
    const sandbox = await createSandbox();
    const configPath = join(sandbox, "ssh_config");
    await writeFile(
      configPath,
      [
        "Host fixture",
        "  HostName 127.0.0.1",
        "  User fixture-user",
        "  Port 22022",
        `  IdentityFile ${join(sandbox, "identity")}`,
        "  ProxyJump bastion",
        ""
      ].join("\n")
    );

    const first = await resolveEffectiveSshConfig({
      sshPath: "/usr/bin/ssh",
      configPath,
      host: "fixture"
    });
    const second = await resolveEffectiveSshConfig({
      sshPath: "/usr/bin/ssh",
      configPath,
      host: "fixture"
    });

    expect(first).toMatchObject({
      hostName: "127.0.0.1",
      user: "fixture-user",
      port: 22022,
      proxyJump: "bastion"
    });
    expect(first.identityFiles).toContain(join(sandbox, "identity"));
    expect(first.policyHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.policyHash).toBe(first.policyHash);
  });

  it("bounds subprocess output and never invokes a shell implicitly", async () => {
    await expect(
      runOpenSshCommand("/bin/sh", ["-c", "printf 123456789"], {
        maxOutputBytes: 8
      })
    ).rejects.toMatchObject({ code: "output-limit" });
    const result = await runOpenSshCommand("/usr/bin/printf", ["%s", "$(id)"], {
      maxOutputBytes: 64
    });
    expect(result.stdout).toBe("$(id)");
    await expect(
      runOpenSshCommand("/usr/bin/printf", ["ignored"], {
        input: "12345",
        maxInputBytes: 4
      })
    ).rejects.toMatchObject({ code: "invalid-launch" });
    await expect(
      runOpenSshCommand("/usr/bin/printf", ["ignored"], {
        maxOutputBytes: 16 * 1024 * 1024 + 1
      })
    ).rejects.toMatchObject({ code: "invalid-launch" });
  });

  it("waits for a terminated child to close before returning a limit failure", async () => {
    const sandbox = await createSandbox();
    const closedMarker = join(sandbox, "closed");

    await expect(
      runOpenSshCommand(
        "/bin/sh",
        [
          "-c",
          "trap 'printf closed > \"$1\"; exit 0' TERM; printf 123456789; while :; do :; done",
          "kmux-open-ssh-test",
          closedMarker
        ],
        { maxOutputBytes: 8 }
      )
    ).rejects.toMatchObject({ code: "output-limit" });

    await expect(readFile(closedMarker, "utf8")).resolves.toBe("closed");
  });

  it("builds force-only askpass environment without storing a credential", () => {
    const env = createOpenSshEnvironment({
      baseEnv: { PATH: "/usr/bin" },
      askpassPath: "/tmp/kmux-askpass"
    });
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      SSH_ASKPASS: "/tmp/kmux-askpass",
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: "kmux-askpass:0"
    });
    expect(JSON.stringify(env)).not.toContain("password");

    const withoutAskpass = createOpenSshEnvironment({
      baseEnv: {
        PATH: "/usr/bin",
        SSH_ASKPASS: "/tmp/ambient-helper",
        SSH_ASKPASS_REQUIRE: "prefer"
      }
    });
    expect(withoutAskpass.SSH_ASKPASS).toBeUndefined();
    expect(withoutAskpass.SSH_ASKPASS_REQUIRE).toBe("never");
  });

  it("rejects option-like and control-character host aliases", () => {
    for (const host of ["", "-oProxyCommand=evil", "host\nother", "host\0x"]) {
      expect(() => validateHostAlias(host)).toThrow(OpenSshProcessError);
    }
  });
});

async function createSandbox(): Promise<string> {
  const sandbox = await mkdtemp(join(tmpdir(), "kmux-openssh-unit-"));
  sandboxes.push(sandbox);
  return sandbox;
}
