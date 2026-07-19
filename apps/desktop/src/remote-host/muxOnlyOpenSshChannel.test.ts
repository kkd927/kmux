import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:net";

import {
  assertPrivateControlSocket,
  buildMuxOnlyLaunch,
  spawnMuxOnlyChannel
} from "./muxOnlyOpenSshChannel";

const servers: Server[] = [];
const sandboxes: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(
    sandboxes
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("mux-only OpenSSH channel launcher", () => {
  it("puts a fail-closed ProxyCommand guard on every channel family", async () => {
    const fixture = await createControlSocket();
    const base = {
      sshPath: "/usr/bin/ssh",
      sftpPath: "/usr/bin/sftp",
      configPath: join(fixture.sandbox, "ssh_config"),
      controlPath: fixture.controlPath,
      host: "fixture",
      masterGeneration: "generation-1"
    } as const;
    const launches = await Promise.all([
      buildMuxOnlyLaunch({
        ...base,
        kind: "control",
        remoteCommand: "kmuxd bridge"
      }),
      buildMuxOnlyLaunch({
        ...base,
        kind: "metadata",
        remoteCommand: "kmuxd bridge"
      }),
      buildMuxOnlyLaunch({
        ...base,
        kind: "terminal",
        remoteCommand: "kmuxd bridge"
      }),
      buildMuxOnlyLaunch({ ...base, kind: "sftp" }),
      buildMuxOnlyLaunch({
        ...base,
        kind: "local-forward",
        localBindHost: "127.0.0.1",
        localPort: 43100,
        remoteHost: "127.0.0.1",
        remotePort: 43200
      }),
      buildMuxOnlyLaunch({
        ...base,
        kind: "dynamic-forward",
        localBindHost: "127.0.0.1",
        localPort: 43300
      })
    ]);

    for (const launch of launches) {
      expect(launch.args).toContain("ProxyCommand=exec '/usr/bin/false'");
      expect(launch.args).toContain("BatchMode=yes");
      expect(launch.args).toContain("NumberOfPasswordPrompts=0");
      expect(launch.args).not.toContain("ControlMaster=auto");
      expect(launch.env.SSH_ASKPASS).toBeUndefined();
    }
    expect(
      launches.find((launch) => launch.kind === "terminal")?.args
    ).toContain("-T");
  });

  it("rejects missing, public, and non-socket ControlPath state", async () => {
    const fixture = await createControlSocket();
    await chmod(fixture.controlPath, 0o666);
    await expect(
      assertPrivateControlSocket(fixture.controlPath)
    ).rejects.toThrow(/socket is not private/u);
    await chmod(fixture.controlPath, 0o600);
    await chmod(fixture.sandbox, 0o755);
    await expect(
      assertPrivateControlSocket(fixture.controlPath)
    ).rejects.toThrow(/private/u);
    await chmod(fixture.sandbox, 0o700);
    await new Promise<void>(
      (resolve) => servers[0]?.close(() => resolve()) ?? resolve()
    );
    servers.splice(0);
    await rm(fixture.controlPath, { force: true });
    await expect(
      assertPrivateControlSocket(fixture.controlPath)
    ).rejects.toThrow(/unavailable/u);
  });

  it("rejects zero as a forwarding port", async () => {
    const fixture = await createControlSocket();
    await expect(
      buildMuxOnlyLaunch({
        kind: "dynamic-forward",
        sshPath: "/usr/bin/ssh",
        configPath: join(fixture.sandbox, "ssh_config"),
        controlPath: fixture.controlPath,
        host: "fixture",
        masterGeneration: "generation-1",
        localBindHost: "127.0.0.1",
        localPort: 0
      })
    ).rejects.toThrow(/forward host\/port is invalid/u);

    await expect(
      buildMuxOnlyLaunch({
        kind: "local-forward",
        sshPath: "/usr/bin/ssh",
        configPath: join(fixture.sandbox, "ssh_config"),
        controlPath: fixture.controlPath,
        host: "fixture",
        masterGeneration: "generation-1",
        localBindHost: "127.0.0.1",
        localPort: 43100,
        remoteHost: "127.0.0.1:4444",
        remotePort: 43200
      })
    ).rejects.toThrow(/forward host\/port is invalid/u);

    await expect(
      buildMuxOnlyLaunch({
        kind: "dynamic-forward",
        sshPath: "/usr/bin/ssh",
        configPath: join(fixture.sandbox, "ssh_config"),
        controlPath: fixture.controlPath,
        host: "fixture",
        masterGeneration: "generation-1",
        localBindHost: "0.0.0.0",
        localPort: 43300
      })
    ).rejects.toThrow(/explicit loopback/u);

    const ipv6 = await buildMuxOnlyLaunch({
      kind: "dynamic-forward",
      sshPath: "/usr/bin/ssh",
      configPath: join(fixture.sandbox, "ssh_config"),
      controlPath: fixture.controlPath,
      host: "fixture",
      masterGeneration: "generation-1",
      localBindHost: "::1",
      localPort: 43300
    });
    expect(ipv6.args).toContain("[::1]:43300");
  });

  it("fences a channel when its master generation changes before or during spawn", async () => {
    const fixture = await createControlSocket();
    const executable = join(fixture.sandbox, "fake-ssh");
    await writeFile(
      executable,
      "#!/bin/sh\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n",
      { mode: 0o700 }
    );
    const request = {
      kind: "control",
      sshPath: executable,
      configPath: join(fixture.sandbox, "ssh_config"),
      controlPath: fixture.controlPath,
      host: "fixture",
      masterGeneration: "generation-1",
      remoteCommand: "ignored"
    } as const;

    await expect(
      spawnMuxOnlyChannel(request, { isCurrentGeneration: () => false })
    ).rejects.toThrow(/changed before channel launch/u);

    let generationChecks = 0;
    await expect(
      spawnMuxOnlyChannel(request, {
        isCurrentGeneration: () => {
          generationChecks += 1;
          return generationChecks === 1;
        }
      })
    ).rejects.toThrow(/changed during channel launch/u);
    expect(generationChecks).toBe(2);
  });
});

async function createControlSocket(): Promise<{
  sandbox: string;
  controlPath: string;
}> {
  const sandbox = await mkdtemp(join(tmpdir(), "kmux-mux-unit-"));
  sandboxes.push(sandbox);
  await chmod(sandbox, 0o700);
  const controlPath = join(sandbox, "master.sock");
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(controlPath, resolve);
  });
  await chmod(controlPath, 0o600);
  return { sandbox, controlPath };
}
