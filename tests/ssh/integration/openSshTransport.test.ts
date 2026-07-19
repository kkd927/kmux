import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import type {
  ITerminalInitOnlyOptions,
  ITerminalOptions,
  Terminal as HeadlessTerminal
} from "@xterm/headless";
import * as Headless from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";

import {
  canonicalizeRemoteOperationPayload,
  createInitialState,
  locatedPathForTarget,
  workspaceLocation,
  type AppState,
  type RemoteOperationPayloadDto,
  type RemoteResourceKey,
  type RemoteTargetBinding
} from "@kmux/core";
import { applyMainRemoteOperationFact } from "@kmux/core/main";
import { uint64 } from "@kmux/proto";

import {
  buildMuxOnlyLaunch,
  spawnMuxOnlyChannel,
  type MuxOnlyChannelRequest
} from "../../../apps/desktop/src/remote-host/muxOnlyOpenSshChannel";
import {
  createOpenSshEnvironment,
  OpenSshProcessError,
  resolveEffectiveSshConfig,
  runOpenSshCommand
} from "../../../apps/desktop/src/remote-host/openSshProcess";
import {
  SshTransportPool,
  type AssignedSshMaster
} from "../../../apps/desktop/src/remote-host/sshTransportPool";
import { prepareRemoteRuntime } from "../../../apps/desktop/src/remote-host/remoteRuntimeBootstrap";
import {
  createRemoteRuntimeToken,
  LinuxX64RemoteRuntime,
  type RemoteRuntimeOperationOutcome,
  type RemoteTerminalAttachment,
  type RemoteTerminalMutation
} from "../../../apps/desktop/src/remote-host/linuxX64RemoteRuntime";
import {
  createDurableRemoteOperationStore,
  type DurableRemoteOperationRecord,
  type DurableRemoteOperationStore
} from "../../../apps/desktop/src/main/remote/durableRemoteOperationStore";
import {
  createRemoteOperationCoordinator,
  type RemoteOperationExecutionOutcome
} from "../../../apps/desktop/src/main/remote/remoteOperationCoordinator";
import {
  createSshProfileConnectionResolver,
  readObservedSshHostKeyFingerprint
} from "../../../apps/desktop/src/main/remote/sshProfileConnection";
import { SshConnectionAudit } from "../harness/connectionAudit";
import { createSshTestIdentity } from "../harness/identity";
import {
  readSshImageManifest,
  startSshBastion,
  startSshTarget,
  type StartedSshTarget
} from "../harness/sshTarget";

let target: StartedSshTarget;
const linuxRuntimeArtifactPath = fileURLToPath(
  new URL("../../../remote/kmuxd/dist/linux-x64-musl/kmuxd", import.meta.url)
);
const linuxRuntimeManifestPath = fileURLToPath(
  new URL(
    "../../../remote/kmuxd/dist/linux-x64-musl/manifest.json",
    import.meta.url
  )
);
const remoteRuntimeArtifactRoot = fileURLToPath(
  new URL("../../../remote/kmuxd/dist", import.meta.url)
);
const HeadlessTerminalCtor = (
  Headless as unknown as {
    Terminal: new (
      options?: ITerminalOptions & ITerminalInitOnlyOptions
    ) => HeadlessTerminal;
  }
).Terminal;

beforeAll(async () => {
  target = await startSshTarget();
});

afterAll(async () => {
  await target?.stop();
});

describe("real system OpenSSH transport spike", () => {
  it("uses digest-pinned, repository-owned sshd and toxiproxy fixtures", async () => {
    expect(await readSshImageManifest()).toMatchObject({
      schemaVersion: 1,
      baseImage: expect.stringMatching(/@sha256:[a-f0-9]{64}$/u),
      toxiproxyImage: expect.stringMatching(/@sha256:[a-f0-9]{64}$/u),
      runtimeBuilderImage: expect.stringMatching(/@sha256:[a-f0-9]{64}$/u),
      runtimeArtifact: "linux-x64-musl",
      repositoryCommit: "8408912c3abac9be93ece7e8f360dac4eadf4507",
      pid1: "tini",
      sftp: "internal-sftp"
    });
    expect(target.expectedHostKeyFingerprint).toMatch(/^SHA256:/u);
    expect(target.auditBaseline.acceptedTcpConnections).toBeGreaterThanOrEqual(
      1
    );
  });

  it("proves effective config, askpass, and OpenSSH host-key observation", async () => {
    const clientIdentity = await runOpenSshCommand(target.sshPath, ["-V"], {
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024
    });
    expect(`${clientIdentity.stdout}${clientIdentity.stderr}`).toMatch(
      /OpenSSH_/u
    );

    const effective = await resolveEffectiveSshConfig({
      sshPath: target.sshPath,
      configPath: target.sshConfigPath,
      host: target.hostAlias
    });
    expect(effective).toMatchObject({
      hostName: target.proxyHost,
      user: "kmux",
      port: target.proxyPort
    });
    expect(effective.policyHash).toMatch(/^[a-f0-9]{64}$/u);

    const productHome = join(target.sandboxPath, "product-profile-home");
    await mkdir(join(productHome, ".ssh"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(productHome, ".ssh", "config"),
      [
        "Host *",
        `  UserKnownHostsFile ${target.knownHostsPath}`,
        `  GlobalKnownHostsFile ${target.globalKnownHostsPath}`,
        "  StrictHostKeyChecking yes",
        "  BatchMode yes",
        ""
      ].join("\n"),
      { mode: 0o600 }
    );
    const productProfile = await createSshProfileConnectionResolver({
      homeDir: productHome,
      configRoot: join(productHome, "generated"),
      sshPath: target.sshPath,
      resolveEffective: resolveEffectiveSshConfig
    }).resolve({
      id: "profile_product_observer",
      name: "Product observer",
      host: target.proxyHost,
      user: "kmux",
      port: target.proxyPort,
      identityFile: target.identity.privateKeyPath,
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z"
    });
    const productPool = new SshTransportPool();
    try {
      await productPool.connectProvisional({
        connectionAttemptId: "product-observer-attempt",
        effectiveConnectionPolicyHash: productProfile.effective.policyHash,
        sshPath: productProfile.sshPath,
        configPath: productProfile.configPath,
        host: productProfile.host,
        controlRoot: target.controlDirectoryPath
      });
      expect(
        readObservedSshHostKeyFingerprint(productProfile.hostKeyObservationPath)
      ).toBe(target.expectedHostKeyFingerprint);
    } finally {
      await productPool.close();
    }

    const observationPath = join(target.sandboxPath, "observed-fingerprint");
    const observerPath = join(target.sandboxPath, "known-hosts-observer");
    await writeFile(
      observerPath,
      [
        "#!/bin/sh",
        "set -eu",
        'printf \'%s\\n\' "$1" > "$KMUX_TEST_FINGERPRINT_FILE"',
        'cat "$KMUX_TEST_KNOWN_HOSTS_FILE"',
        ""
      ].join("\n"),
      { mode: 0o700 }
    );
    await chmod(observerPath, 0o700);
    const observed = await runOpenSshCommand(
      target.sshPath,
      [
        "-F",
        target.sshConfigPath,
        "-o",
        `KnownHostsCommand=${observerPath} %f`,
        "--",
        target.hostAlias,
        "printf observed"
      ],
      {
        env: {
          ...process.env,
          KMUX_TEST_FINGERPRINT_FILE: observationPath,
          KMUX_TEST_KNOWN_HOSTS_FILE: target.knownHostsPath
        }
      }
    );
    expect(observed.stdout).toBe("observed");
    expect((await readFile(observationPath, "utf8")).trim()).toBe(
      target.expectedHostKeyFingerprint
    );

    const askpassLogPath = join(target.sandboxPath, "askpass.log");
    const askpassPath = join(target.sandboxPath, "askpass");
    await writeFile(
      askpassPath,
      [
        "#!/bin/sh",
        "set -eu",
        'printf \'%s\\n\' "$1" >> "$KMUX_TEST_ASKPASS_LOG"',
        "printf '%s\\n' \"$KMUX_TEST_ASKPASS_RESPONSE\"",
        ""
      ].join("\n"),
      { mode: 0o700 }
    );
    const passwordConfigPath = join(target.sandboxPath, "password_ssh_config");
    await writeFile(
      passwordConfigPath,
      [
        `Host ${target.hostAlias}`,
        `  HostName ${target.proxyHost}`,
        `  Port ${target.proxyPort}`,
        "  User kmux",
        `  UserKnownHostsFile ${target.knownHostsPath}`,
        `  GlobalKnownHostsFile ${target.globalKnownHostsPath}`,
        "  StrictHostKeyChecking yes",
        "  PreferredAuthentications password",
        "  PubkeyAuthentication no",
        "  KbdInteractiveAuthentication no",
        "  BatchMode no",
        "  NumberOfPasswordPrompts 1",
        ""
      ].join("\n"),
      { mode: 0o600 }
    );
    const passwordResult = await runOpenSshCommand(
      target.sshPath,
      ["-F", passwordConfigPath, "--", target.hostAlias, "printf askpass-ok"],
      {
        env: createOpenSshEnvironment({
          baseEnv: {
            ...process.env,
            KMUX_TEST_ASKPASS_LOG: askpassLogPath,
            KMUX_TEST_ASKPASS_RESPONSE: "kmux-password"
          },
          askpassPath
        })
      }
    );
    expect(passwordResult.stdout).toBe("askpass-ok");
    expect(await readFile(askpassLogPath, "utf8")).toMatch(/password/iu);

    const protectedIdentity = await createSshTestIdentity({
      sandboxPath: target.sandboxPath,
      name: "phase8-protected-identity",
      sshKeygenPath: "/usr/bin/ssh-keygen",
      passphrase: "phase8-key-passphrase"
    });
    const authorizeProtected = await target.target.exec([
      "sh",
      "-c",
      'printf "%s\\n" "$1" >> /etc/ssh/authorized_keys/kmux',
      "sh",
      protectedIdentity.publicKey
    ]);
    expect(authorizeProtected.exitCode).toBe(0);
    const protectedConfigPath = join(
      target.sandboxPath,
      "protected_key_ssh_config"
    );
    await writeFile(
      protectedConfigPath,
      [
        `Host ${target.hostAlias}`,
        `  HostName ${target.proxyHost}`,
        `  Port ${target.proxyPort}`,
        "  User kmux",
        `  IdentityFile ${protectedIdentity.privateKeyPath}`,
        "  IdentitiesOnly yes",
        `  UserKnownHostsFile ${target.knownHostsPath}`,
        `  GlobalKnownHostsFile ${target.globalKnownHostsPath}`,
        "  StrictHostKeyChecking yes",
        "  PreferredAuthentications publickey",
        "  PasswordAuthentication no",
        "  KbdInteractiveAuthentication no",
        "  BatchMode no",
        ""
      ].join("\n"),
      { mode: 0o600 }
    );
    const protectedResult = await runOpenSshCommand(
      target.sshPath,
      [
        "-F",
        protectedConfigPath,
        "--",
        target.hostAlias,
        "printf protected-key-ok"
      ],
      {
        env: createOpenSshEnvironment({
          baseEnv: {
            ...process.env,
            KMUX_TEST_ASKPASS_LOG: askpassLogPath,
            KMUX_TEST_ASKPASS_RESPONSE: "phase8-key-passphrase"
          },
          askpassPath
        })
      }
    );
    expect(protectedResult.stdout).toBe("protected-key-ok");
    expect(await readFile(askpassLogPath, "utf8")).toMatch(/passphrase/iu);

    const cancelAskpassPath = join(target.sandboxPath, "cancel-askpass");
    await writeFile(cancelAskpassPath, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    await expect(
      runOpenSshCommand(
        target.sshPath,
        [
          "-F",
          protectedConfigPath,
          "--",
          target.hostAlias,
          "printf must-not-authenticate"
        ],
        {
          env: createOpenSshEnvironment({
            baseEnv: process.env,
            askpassPath: cancelAskpassPath
          }),
          timeoutMs: 10_000
        }
      )
    ).rejects.toMatchObject({ code: "non-zero-exit" });

    const agentResult = await runOpenSshCommand("/usr/bin/ssh-agent", ["-s"], {
      timeoutMs: 10_000
    });
    const agentSocket = /SSH_AUTH_SOCK=([^;\n]+)/u.exec(
      agentResult.stdout
    )?.[1];
    const agentPid = /SSH_AGENT_PID=([0-9]+)/u.exec(agentResult.stdout)?.[1];
    expect(agentSocket).toBeTruthy();
    expect(agentPid).toBeTruthy();
    const agentEnv = {
      ...process.env,
      SSH_AUTH_SOCK: agentSocket,
      SSH_AGENT_PID: agentPid
    };
    try {
      await runOpenSshCommand(
        "/usr/bin/ssh-add",
        [target.identity.privateKeyPath],
        { env: agentEnv, timeoutMs: 10_000 }
      );
      const agentConfigPath = join(target.sandboxPath, "phase8-agent-config");
      await writeFile(
        agentConfigPath,
        [
          `Host ${target.hostAlias}`,
          `  HostName ${target.proxyHost}`,
          `  Port ${target.proxyPort}`,
          "  User kmux",
          `  IdentityAgent ${agentSocket}`,
          "  IdentitiesOnly no",
          "  ForwardAgent yes",
          `  UserKnownHostsFile ${target.knownHostsPath}`,
          `  GlobalKnownHostsFile ${target.globalKnownHostsPath}`,
          "  StrictHostKeyChecking yes",
          "  BatchMode yes",
          ""
        ].join("\n"),
        { mode: 0o600 }
      );
      await expect(
        runOpenSshCommand(
          target.sshPath,
          [
            "-F",
            agentConfigPath,
            "--",
            target.hostAlias,
            'test -S "$SSH_AUTH_SOCK" && printf agent-forward-ok'
          ],
          { env: agentEnv }
        )
      ).resolves.toMatchObject({ stdout: "agent-forward-ok" });
    } finally {
      await runOpenSshCommand("/usr/bin/ssh-agent", ["-k"], {
        env: agentEnv,
        timeoutMs: 10_000
      }).catch(() => undefined);
    }

    const certificateAuthority = await createSshTestIdentity({
      sandboxPath: target.sandboxPath,
      name: "phase8-user-ca",
      sshKeygenPath: "/usr/bin/ssh-keygen"
    });
    const certificateIdentity = await createSshTestIdentity({
      sandboxPath: target.sandboxPath,
      name: "phase8-certificate-identity",
      sshKeygenPath: "/usr/bin/ssh-keygen"
    });
    await runOpenSshCommand(
      "/usr/bin/ssh-keygen",
      [
        "-q",
        "-s",
        certificateAuthority.privateKeyPath,
        "-I",
        `kmux-phase8-${randomBytes(4).toString("hex")}`,
        "-n",
        "kmux",
        "-V",
        "+1h",
        certificateIdentity.publicKeyPath
      ],
      { timeoutMs: 10_000 }
    );
    const authorizeCertificate = await target.target.exec([
      "sh",
      "-c",
      'printf "cert-authority %s\\n" "$1" >> /etc/ssh/authorized_keys/kmux',
      "sh",
      certificateAuthority.publicKey
    ]);
    expect(authorizeCertificate.exitCode).toBe(0);
    const certificateConfigPath = join(
      target.sandboxPath,
      "phase8-certificate-config"
    );
    await writeFile(
      certificateConfigPath,
      [
        `Host ${target.hostAlias}`,
        `  HostName ${target.proxyHost}`,
        `  Port ${target.proxyPort}`,
        "  User kmux",
        `  IdentityFile ${certificateIdentity.privateKeyPath}`,
        `  CertificateFile ${certificateIdentity.privateKeyPath}-cert.pub`,
        "  IdentitiesOnly yes",
        `  UserKnownHostsFile ${target.knownHostsPath}`,
        `  GlobalKnownHostsFile ${target.globalKnownHostsPath}`,
        "  StrictHostKeyChecking yes",
        "  BatchMode yes",
        ""
      ].join("\n"),
      { mode: 0o600 }
    );
    await expect(
      runOpenSshCommand(target.sshPath, [
        "-F",
        certificateConfigPath,
        "--",
        target.hostAlias,
        "printf certificate-ok"
      ])
    ).resolves.toMatchObject({ stdout: "certificate-ok" });
  });

  it("honors Include and Match while failing changed host keys closed until explicit recovery", async () => {
    const includePath = join(target.sandboxPath, "phase8-included.conf");
    const configPath = join(target.sandboxPath, "phase8-include.conf");
    await writeFile(
      includePath,
      [
        `Host ${target.hostAlias}`,
        `  HostName ${target.proxyHost}`,
        `  Port ${target.proxyPort}`,
        "  User kmux",
        `  IdentityFile ${target.identity.privateKeyPath}`,
        "  IdentitiesOnly yes",
        `  UserKnownHostsFile ${target.knownHostsPath}`,
        `  GlobalKnownHostsFile ${target.globalKnownHostsPath}`,
        "  StrictHostKeyChecking yes",
        "  BatchMode yes",
        ""
      ].join("\n"),
      { mode: 0o600 }
    );
    await writeFile(
      configPath,
      [
        `Include ${includePath}`,
        `Match host ${target.hostAlias}`,
        "  ForwardAgent no",
        ""
      ].join("\n"),
      { mode: 0o600 }
    );
    const included = await resolveEffectiveSshConfig({
      sshPath: target.sshPath,
      configPath,
      host: target.hostAlias
    });
    expect(included).toMatchObject({
      hostName: target.proxyHost,
      user: "kmux",
      port: target.proxyPort
    });
    await expect(
      runOpenSshCommand(target.sshPath, [
        "-F",
        configPath,
        "--",
        target.hostAlias,
        "printf include-match-ok"
      ])
    ).resolves.toMatchObject({ stdout: "include-match-ok" });

    const firstUseKnownHosts = join(
      target.sandboxPath,
      "phase8-first-use-known-hosts"
    );
    const firstUseConfig = join(target.sandboxPath, "phase8-first-use-config");
    await writeFile(firstUseKnownHosts, "", { mode: 0o600 });
    await writeFile(
      firstUseConfig,
      [
        `Host ${target.hostAlias}`,
        `  HostName ${target.proxyHost}`,
        `  Port ${target.proxyPort}`,
        "  User kmux",
        `  IdentityFile ${target.identity.privateKeyPath}`,
        "  IdentitiesOnly yes",
        `  UserKnownHostsFile ${firstUseKnownHosts}`,
        `  GlobalKnownHostsFile ${target.globalKnownHostsPath}`,
        "  StrictHostKeyChecking accept-new",
        "  HashKnownHosts no",
        "  BatchMode yes",
        ""
      ].join("\n"),
      { mode: 0o600 }
    );
    await expect(
      runOpenSshCommand(target.sshPath, [
        "-F",
        firstUseConfig,
        "--",
        target.hostAlias,
        "printf first-use"
      ])
    ).resolves.toMatchObject({ stdout: "first-use" });
    expect(await readFile(firstUseKnownHosts, "utf8")).toMatch(/ssh-ed25519/u);

    const correctKnownHosts = await readFile(target.knownHostsPath, "utf8");
    const hostToken = correctKnownHosts.trim().split(/\s+/u)[0];
    const [, userPublicKey] = target.identity.publicKey.split(/\s+/u);
    try {
      await writeFile(
        target.knownHostsPath,
        `${hostToken} ssh-ed25519 ${userPublicKey}\n`,
        { mode: 0o600 }
      );
      await expect(
        runOpenSshCommand(target.sshPath, [
          "-F",
          configPath,
          "--",
          target.hostAlias,
          "printf must-not-run"
        ])
      ).rejects.toMatchObject({
        code: "non-zero-exit",
        stderr: expect.stringMatching(/host key verification failed/iu)
      });
    } finally {
      await writeFile(target.knownHostsPath, correctKnownHosts, {
        mode: 0o600
      });
    }
    await expect(
      runOpenSshCommand(target.sshPath, [
        "-F",
        configPath,
        "--",
        target.hostAlias,
        "printf recovered"
      ])
    ).resolves.toMatchObject({ stdout: "recovered" });

    const bastion = await startSshBastion(target);
    const routingConfigPath = join(target.sandboxPath, "phase8-routing-config");
    try {
      const baseTargetFields = [
        `  HostName ${bastion.destinationNetworkHost}`,
        "  User kmux",
        "  Port 22",
        `  IdentityFile ${target.identity.privateKeyPath}`,
        "  IdentitiesOnly yes",
        `  UserKnownHostsFile ${bastion.knownHostsPath}`,
        `  GlobalKnownHostsFile ${target.globalKnownHostsPath}`,
        "  StrictHostKeyChecking yes",
        "  BatchMode yes",
        "  PasswordAuthentication no",
        "  KbdInteractiveAuthentication no",
        "  LogLevel ERROR"
      ];
      const proxyCommand = `${target.sshPath} -F ${routingConfigPath} -W %h:%p ${bastion.hostAlias}`;
      await writeFile(
        routingConfigPath,
        [
          `Host ${bastion.hostAlias}`,
          `  HostName ${bastion.host}`,
          `  Port ${bastion.port}`,
          "  User kmux",
          `  IdentityFile ${target.identity.privateKeyPath}`,
          "  IdentitiesOnly yes",
          `  UserKnownHostsFile ${bastion.knownHostsPath}`,
          `  GlobalKnownHostsFile ${target.globalKnownHostsPath}`,
          "  StrictHostKeyChecking yes",
          "  BatchMode yes",
          "  ControlMaster no",
          "  ControlPersist no",
          "  LogLevel ERROR",
          "Host jump-probe",
          ...baseTargetFields,
          `  ProxyJump ${bastion.hostAlias}`,
          "Host command-probe",
          ...baseTargetFields,
          `  ProxyCommand ${proxyCommand}`,
          ""
        ].join("\n"),
        { mode: 0o600 }
      );
      await expect(
        resolveEffectiveSshConfig({
          sshPath: target.sshPath,
          configPath: routingConfigPath,
          host: "jump-probe"
        })
      ).resolves.toMatchObject({ proxyJump: bastion.hostAlias });
      await expect(
        resolveEffectiveSshConfig({
          sshPath: target.sshPath,
          configPath: routingConfigPath,
          host: "command-probe"
        })
      ).resolves.toMatchObject({ proxyCommand });

      for (const route of ["jump-probe", "command-probe"] as const) {
        const pool = new SshTransportPool();
        const targetBefore = await target.audit.snapshot();
        const bastionBefore = await bastion.audit.snapshot();
        try {
          const effective = await resolveEffectiveSshConfig({
            sshPath: target.sshPath,
            configPath: routingConfigPath,
            host: route
          });
          const connectionAttemptId = `${route}-attempt`;
          await pool.connectProvisional({
            connectionAttemptId,
            effectiveConnectionPolicyHash: effective.policyHash,
            sshPath: target.sshPath,
            configPath: routingConfigPath,
            host: route,
            controlRoot: target.controlDirectoryPath
          });
          const assigned = await pool.promote({
            connectionAttemptId,
            targetId: `${route}-verified-target`,
            effectiveConnectionPolicyHash: effective.policyHash
          });
          const targetAfterMaster = await target.audit.snapshot();
          const bastionAfterMaster = await bastion.audit.snapshot();
          expect(
            SshConnectionAudit.delta(targetBefore, targetAfterMaster)
          ).toMatchObject({
            acceptedTcpConnections: 1,
            authenticationAttempts: 1,
            acceptedAuthentications: 1
          });
          expect(
            SshConnectionAudit.delta(bastionBefore, bastionAfterMaster)
          ).toMatchObject({
            acceptedTcpConnections: 1,
            authenticationAttempts: 1,
            acceptedAuthentications: 1
          });

          const feature = await runBoundedChannel(pool, assigned, {
            kind: "control",
            remoteCommand: `printf ${route}-ok`,
            sshPath: target.sshPath,
            sftpPath: target.sftpPath,
            configPath: routingConfigPath,
            controlPath: assigned.master.controlPath,
            host: route,
            masterGeneration: assigned.generation
          });
          expect(feature.stdout).toBe(`${route}-ok`);
          expect(
            SshConnectionAudit.delta(
              targetAfterMaster,
              await target.audit.snapshot()
            )
          ).toMatchObject({
            acceptedTcpConnections: 0,
            authenticationAttempts: 0,
            acceptedAuthentications: 0
          });
          expect(
            SshConnectionAudit.delta(
              bastionAfterMaster,
              await bastion.audit.snapshot()
            )
          ).toMatchObject({
            acceptedTcpConnections: 0,
            authenticationAttempts: 0,
            acceptedAuthentications: 0
          });
        } finally {
          await pool.close();
        }
        await eventually(
          async () =>
            (await target.audit.snapshot()).liveTcpConnections === 0 &&
            (await bastion.audit.snapshot()).liveTcpConnections === 0
        );
      }
    } finally {
      await bastion.stop();
    }
  });

  it("moves quoted binary paths through mux-only SFTP with exact read-back identity", async () => {
    const suffix = randomBytes(6).toString("hex");
    const transferRoot = await mkdtemp(
      join(target.sandboxPath, "phase7-sftp-transfers-")
    );
    const sourcePath = join(transferRoot, "source payload.bin");
    const sourceBytes = Buffer.concat([
      Buffer.from("kmux phase7 sftp\0", "utf8"),
      randomBytes(64 * 1024)
    ]);
    const sha256 = createHash("sha256").update(sourceBytes).digest("hex");
    await writeFile(sourcePath, sourceBytes, { mode: 0o600 });
    const sftpFailureMarker = join(transferRoot, "fail-sftp");
    const sftpWrapper = join(transferRoot, "sftp-wrapper");
    await writeFile(
      sftpWrapper,
      [
        "#!/bin/sh",
        "set -eu",
        `if [ -e ${quotePosixWord(sftpFailureMarker)} ]; then exit 73; fi`,
        `exec ${quotePosixWord(target.sftpPath)} "$@"`,
        ""
      ].join("\n"),
      { mode: 0o700 }
    );
    await chmod(sftpWrapper, 0o700);
    const remotePath = `/home/kmux/kmux phase7 '[${suffix}]*?' payload.bin`;
    const phase7Roots = doctorPaths(`/home/kmux/.kmux-phase7-sftp-${suffix}`);
    const fixtureRepository = "/opt/kmux-fixtures/repository";
    const worktreePath = `${phase7Roots.stateRoot}/worktrees/repository/phase7-${suffix}`;
    const worktreeBranch = `kmux/phase7-${suffix}`;
    const pool = new SshTransportPool();
    const collisionServer = createServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      collisionServer.once("error", rejectListen);
      collisionServer.listen(0, "127.0.0.1", () => resolveListen());
    });
    const collisionAddress = collisionServer.address();
    if (!collisionAddress || typeof collisionAddress === "string") {
      throw new Error("failed to occupy the requested forward port");
    }
    const collidingLocalPort = collisionAddress.port;
    let runtime: LinuxX64RemoteRuntime | undefined;
    let attachment: RemoteTerminalAttachment | undefined;
    try {
      const assigned = await connectAssignedMaster(
        pool,
        `phase7-sftp-${suffix}`
      );
      const afterMaster = await target.audit.snapshot();
      runtime = new LinuxX64RemoteRuntime({
        pool,
        assigned,
        runtimePath: target.remoteRuntimePath,
        transferRoot,
        sftpPath: sftpWrapper,
        roots: phase7Roots,
        token: createRemoteRuntimeToken()
      });
      const hello = await runtime.connect();

      await expect(runtime.fileExists(remotePath)).resolves.toBe(false);
      await expect(
        runtime.uploadFile({
          transferId: `upload_${suffix}`,
          localPath: sourcePath,
          remotePath,
          maxBytes: sourceBytes.byteLength,
          sha256
        })
      ).resolves.toEqual({
        transferId: `upload_${suffix}`,
        remotePath,
        byteLength: sourceBytes.byteLength,
        sha256
      });
      await expect(runtime.fileExists(remotePath)).resolves.toBe(true);
      const downloaded = await runtime.downloadFile({
        transferId: `download_${suffix}`,
        remotePath,
        maxBytes: sourceBytes.byteLength
      });
      expect(downloaded).toMatchObject({
        transferId: `download_${suffix}`,
        remotePath,
        byteLength: sourceBytes.byteLength,
        sha256
      });
      expect(downloaded.localPath).toMatch(/\.bin$/u);
      expect(await readFile(downloaded.localPath)).toEqual(sourceBytes);
      await runtime.releaseFile(downloaded.localPath);

      const historyDirectory = `/home/kmux/.codex/sessions/phase7-${suffix}`;
      const historyRemotePath = `${historyDirectory}/rollout-${suffix}.jsonl`;
      const historyLocalPath = join(transferRoot, "remote-history.jsonl");
      await writeFile(
        historyLocalPath,
        [
          JSON.stringify({
            type: "session_meta",
            payload: {
              id: `history-${suffix}`,
              cwd: "/home/kmux/remote-history-repo"
            }
          }),
          JSON.stringify({
            type: "event_msg",
            timestamp: "2026-07-18T00:00:01.000Z",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: {
                  input_tokens: 100,
                  cached_input_tokens: 20,
                  output_tokens: 10,
                  reasoning_output_tokens: 2
                }
              }
            }
          }),
          ""
        ].join("\n"),
        { mode: 0o600 }
      );
      await target.target.exec([
        "install",
        "-d",
        "-o",
        "kmux",
        "-g",
        "kmux",
        "-m",
        "700",
        "/home/kmux/.codex",
        "/home/kmux/.codex/sessions",
        historyDirectory
      ]);
      const historyBytes = await readFile(historyLocalPath);
      await runtime.uploadFile({
        transferId: `history_upload_${suffix}`,
        localPath: historyLocalPath,
        remotePath: historyRemotePath,
        maxBytes: historyBytes.byteLength,
        sha256: createHash("sha256").update(historyBytes).digest("hex")
      });
      await expect(
        runtime.scanHistory({
          desktopInstallationId: `desktop_phase7_sftp_${suffix}`,
          targetId: assigned.targetId,
          maxRecords: 100
        })
      ).resolves.toMatchObject({
        targetId: assigned.targetId,
        principal: { uid: 1000, accountName: "kmux" },
        records: [
          expect.objectContaining({
            vendor: "codex",
            sessionId: `history-${suffix}`,
            cwd: "/home/kmux/remote-history-repo"
          })
        ]
      });
      await expect(
        runtime.scanUsage({
          desktopInstallationId: `desktop_phase7_sftp_${suffix}`,
          targetId: assigned.targetId,
          startAtUnixMs: 0,
          maxRecords: 64
        })
      ).resolves.toMatchObject({
        targetId: assigned.targetId,
        principal: { uid: 1000, accountName: "kmux" },
        records: [
          expect.objectContaining({
            vendor: "codex",
            sessionId: `history-${suffix}`,
            cwd: "/home/kmux/remote-history-repo",
            inputTokens: "80",
            cacheReadTokens: "20",
            outputTokens: "8",
            thinkingTokens: "2",
            totalTokens: "110"
          })
        ]
      });

      const desktopInstallationId = `desktop_phase7_sftp_${suffix}`;
      const workspaceId = `workspace_phase7_sftp_${suffix}`;
      const sessionId = `session_phase7_sftp_${suffix}`;
      const surfaceId = `surface_phase7_sftp_${suffix}`;
      const state = remoteCoordinatorState(
        assigned.targetId,
        workspaceId,
        "/home/kmux"
      );
      const coordinator = createIntegrationCoordinator({
        state,
        store: createDurableRemoteOperationStore(
          join(target.sandboxPath, `phase7-sftp-operations-${suffix}`)
        ),
        binding: bindingFromHello(assigned, hello),
        desktopInstallationId,
        operationIds: [
          `workspace_create_phase7_${suffix}`,
          `worktree_create_phase7_${suffix}`,
          `worktree_dirty_remove_phase7_${suffix}`,
          `worktree_force_remove_phase7_${suffix}`,
          `create_phase7_sftp_${suffix}`,
          `forward_create_phase7_${suffix}`,
          `forward_remap_phase7_${suffix}`,
          `forward_remove_phase7_${suffix}`
        ]
      });
      const workspaceCreate = coordinator.admit({
        type: "remote-operation.command",
        workspaceId,
        expectedRemoteResourceRevision: uint64(0n),
        payload: {
          kind: "workspace.create",
          workspaceId,
          defaultCwd: "/home/kmux"
        }
      });
      const workspaceCreated = await coordinator.execute(
        workspaceCreate.intent.operationId,
        runtimeExecutor(runtime)
      );
      if (workspaceCreated.status !== "succeeded") {
        throw new Error("workspace creation did not commit");
      }
      await expect(
        runtime.inspectGit({
          desktopInstallationId,
          targetId: assigned.targetId,
          cwd: fixtureRepository,
          dirtyLimit: 8
        })
      ).resolves.toMatchObject({
        repository: {
          root: fixtureRepository,
          linkedWorktree: false
        },
        branch: "main"
      });
      const worktreeProduct = {
        name: `phase7-${suffix}`,
        path: worktreePath,
        repoRoot: fixtureRepository,
        commonGitDir: `${fixtureRepository}/.git`,
        baseRef: "main",
        branch: worktreeBranch,
        createdByKmux: true
      };
      const worktreeCreate = coordinator.admit(
        {
          type: "remote-operation.command",
          workspaceId,
          expectedRemoteResourceRevision:
            workspaceCreated.remoteResourceRevision,
          payload: {
            kind: "worktree.create",
            workspaceId,
            cwd: fixtureRepository,
            path: worktreePath,
            baseRef: "main",
            branch: worktreeBranch
          }
        },
        {
          worktree: { kind: "worktree.create", worktree: worktreeProduct }
        }
      );
      const worktreeCreated = await coordinator.execute(
        worktreeCreate.intent.operationId,
        runtimeExecutor(runtime)
      );
      if (worktreeCreated.status !== "succeeded") {
        throw new Error("worktree creation did not commit");
      }
      await expect(
        runtime.inspectGit({
          desktopInstallationId,
          targetId: assigned.targetId,
          cwd: worktreePath,
          dirtyLimit: 8
        })
      ).resolves.toMatchObject({
        repository: { root: worktreePath, linkedWorktree: true },
        branch: worktreeBranch
      });
      await runtime.uploadFile({
        transferId: `worktree_dirty_${suffix}`,
        localPath: sourcePath,
        remotePath: `${worktreePath}/dirty.bin`,
        maxBytes: sourceBytes.byteLength,
        sha256
      });
      const dirtyRemove = coordinator.admit(
        {
          type: "remote-operation.command",
          workspaceId,
          expectedRemoteResourceRevision:
            worktreeCreated.remoteResourceRevision,
          payload: {
            kind: "worktree.remove",
            workspaceId,
            cwd: fixtureRepository,
            path: worktreePath,
            force: false,
            expectedBranch: worktreeProduct.branch,
            expectedCommonGitDir: worktreeProduct.commonGitDir
          }
        },
        {
          worktree: {
            kind: "worktree.remove",
            expectedWorktree: worktreeProduct
          }
        }
      );
      await expect(
        coordinator.execute(
          dirtyRemove.intent.operationId,
          runtimeExecutor(runtime)
        )
      ).resolves.toMatchObject({
        status: "failed",
        code: "worktree-dirty"
      });
      await expect(runtime.fileExists(worktreePath)).resolves.toBe(true);
      const forceRemove = coordinator.admit(
        {
          type: "remote-operation.command",
          workspaceId,
          expectedRemoteResourceRevision:
            worktreeCreated.remoteResourceRevision,
          payload: {
            kind: "worktree.remove",
            workspaceId,
            cwd: fixtureRepository,
            path: worktreePath,
            force: true,
            expectedBranch: worktreeProduct.branch,
            expectedCommonGitDir: worktreeProduct.commonGitDir
          }
        },
        {
          worktree: {
            kind: "worktree.remove",
            expectedWorktree: worktreeProduct
          }
        }
      );
      const worktreeRemoved = await coordinator.execute(
        forceRemove.intent.operationId,
        runtimeExecutor(runtime)
      );
      if (worktreeRemoved.status !== "succeeded") {
        throw new Error("forced worktree removal did not commit");
      }
      await expect(runtime.fileExists(worktreePath)).resolves.toBe(false);
      const create = coordinator.admit({
        type: "remote-operation.command",
        workspaceId,
        expectedRemoteResourceRevision: uint64(0n),
        payload: {
          kind: "session.create",
          sessionId,
          surfaceId,
          paneId: state.workspaces[workspaceId].activePaneId,
          launch: { cwd: "/home/kmux", shell: "/bin/sh" }
        }
      });
      const created = await coordinator.execute(
        create.intent.operationId,
        runtimeExecutor(runtime)
      );
      attachment = await runtime.attach({
        resourceKey: {
          desktopInstallationId,
          targetId: assigned.targetId,
          workspaceId,
          sessionId
        },
        expectedKeeperGeneration: requireKeeperGeneration(created),
        access: "write"
      });
      await attachment.checkpoint;

      const forwardId = `forward_phase7_${suffix}`;
      const forwardCreate = coordinator.admit({
        type: "remote-operation.command",
        workspaceId,
        expectedRemoteResourceRevision: worktreeRemoved.remoteResourceRevision,
        payload: {
          kind: "forward.ensure",
          forwardId,
          remoteHost: "127.0.0.1",
          remotePort: 18_080,
          localBindHost: "127.0.0.1",
          localPort: collidingLocalPort
        }
      });
      const forwardCreated = await coordinator.execute(
        forwardCreate.intent.operationId,
        runtimeExecutor(runtime)
      );
      if (forwardCreated.status !== "succeeded") {
        throw new Error(
          `forward creation did not commit: ${JSON.stringify(forwardCreated)}`
        );
      }
      let mappings = await runtime.reconcileForwards({
        desktopInstallationId,
        targetId: assigned.targetId
      });
      const collisionMapping = mappings.find(
        (mapping) => mapping.forwardId === forwardId
      );
      if (!collisionMapping) throw new Error("forward mapping is missing");
      expect(collisionMapping.localPort).not.toBe(collidingLocalPort);

      const forwardRemap = coordinator.admit({
        type: "remote-operation.command",
        workspaceId,
        expectedRemoteResourceRevision: forwardCreated.remoteResourceRevision,
        payload: {
          kind: "forward.ensure",
          forwardId,
          remoteHost: "127.0.0.1",
          remotePort: 18_080,
          localBindHost: "127.0.0.1",
          localPort: collisionMapping.localPort
        }
      });
      const forwardRemapped = await coordinator.execute(
        forwardRemap.intent.operationId,
        runtimeExecutor(runtime)
      );
      if (forwardRemapped.status !== "succeeded") {
        throw new Error("forward collision remap did not commit");
      }
      mappings = await runtime.reconcileForwards({
        desktopInstallationId,
        targetId: assigned.targetId
      });
      expect(mappings).toContainEqual(
        expect.objectContaining({
          forwardId,
          localPort: collisionMapping.localPort,
          status: "active"
        })
      );
      expect(
        await echoThroughSocket(collisionMapping.localPort, "phase7-forward")
      ).toBe("phase7-forward");

      await expect(
        runtime.executeOperation(forwardCreate.intent, forwardCreate.payload)
      ).resolves.toMatchObject({
        status: "failed",
        code: "operation-stale"
      });
      await expect(
        runtime.executeOperation(forwardRemap.intent, forwardRemap.payload)
      ).resolves.toMatchObject({
        status: "succeeded",
        remoteResourceRevision: forwardRemapped.remoteResourceRevision,
        resultDigest: forwardRemapped.resultDigest
      });

      const forwardRemove = coordinator.admit({
        type: "remote-operation.command",
        workspaceId,
        expectedRemoteResourceRevision: forwardRemapped.remoteResourceRevision,
        payload: { kind: "forward.remove", forwardId }
      });
      await coordinator.execute(
        forwardRemove.intent.operationId,
        runtimeExecutor(runtime)
      );
      await expect(
        runtime.reconcileForwards({
          desktopInstallationId,
          targetId: assigned.targetId
        })
      ).resolves.not.toContainEqual(expect.objectContaining({ forwardId }));

      await writeFile(sftpFailureMarker, "fail", { mode: 0o600 });
      await expect(runtime.fileExists(remotePath)).rejects.toMatchObject({
        code: "unavailable",
        retryable: true
      });
      const terminalMarker = `terminal-survived-sftp-${suffix}`;
      await attachment.sendInput(
        uint64(1n),
        new TextEncoder().encode(`printf '${terminalMarker}\\n'\n`)
      );
      await collectTerminalUntil(attachment, terminalMarker);

      const remoteServicePort =
        30_000 + (Number.parseInt(suffix.slice(0, 4), 16) % 20_000);
      await attachment.sendInput(
        uint64(2n),
        new TextEncoder().encode(
          `exec socat TCP-LISTEN:${remoteServicePort},bind=127.0.0.1,reuseaddr,fork EXEC:/bin/cat\n`
        )
      );
      await waitForInspectedPort(
        runtime,
        {
          desktopInstallationId,
          targetId: assigned.targetId,
          workspaceId,
          sessionId
        },
        remoteServicePort
      );
      await attachment.sendInput(uint64(3n), Uint8Array.of(3));

      const featureDelta = SshConnectionAudit.delta(
        afterMaster,
        await target.audit.snapshot()
      );
      expect(featureDelta.acceptedTcpConnections).toBe(0);
      expect(featureDelta.authenticationAttempts).toBe(0);
    } finally {
      await attachment?.detach().catch(() => undefined);
      await runtime?.close().catch(() => undefined);
      await pool.close();
      await target.target
        .exec([
          "sh",
          "-lc",
          `su -s /bin/sh -c ${quotePosixWord(
            `git -C ${quotePosixWord(fixtureRepository)} worktree remove --force -- ${quotePosixWord(worktreePath)} >/dev/null 2>&1 || true; git -C ${quotePosixWord(fixtureRepository)} branch -D ${quotePosixWord(worktreeBranch)} >/dev/null 2>&1 || true`
          )} kmux; rm -f -- ${quotePosixWord(remotePath)}; rm -rf -- ${quotePosixWord(
            `/home/kmux/.codex/sessions/phase7-${suffix}`
          )}`
        ])
        .catch(() => undefined);
      await new Promise<void>((resolveClose) =>
        collisionServer.close(() => resolveClose())
      );
      await rm(transferRoot, { recursive: true, force: true });
    }
  });

  it("runs exec, PTY, SFTP, and forwarding through one assigned master", async () => {
    const pool = new SshTransportPool();
    const beforeMaster = await target.audit.snapshot();
    const assigned = await connectAssignedMaster(pool, "all-channels");
    const afterMaster = await target.audit.snapshot();
    const masterDelta = SshConnectionAudit.delta(beforeMaster, afterMaster);
    expect(masterDelta.acceptedTcpConnections).toBe(1);
    expect(masterDelta.authenticationAttempts).toBe(1);
    expect(masterDelta.acceptedAuthentications).toBe(1);

    const control = await runBoundedChannel(
      pool,
      assigned,
      channelRequest(assigned, {
        kind: "control",
        remoteCommand: "printf control-ok"
      })
    );
    expect(control.stdout).toBe("control-ok");

    const metadata = await runBoundedChannel(
      pool,
      assigned,
      channelRequest(assigned, {
        kind: "metadata",
        remoteCommand: "printf metadata-ok"
      })
    );
    expect(metadata.stdout).toBe("metadata-ok");

    const terminal = await runBoundedChannel(
      pool,
      assigned,
      channelRequest(assigned, {
        kind: "terminal",
        remoteCommand: "printf terminal-ok"
      })
    );
    expect(terminal.stdout).toContain("terminal-ok");

    const sftp = await runBoundedChannel(
      pool,
      assigned,
      channelRequest(assigned, { kind: "sftp" }),
      "pwd\nquit\n"
    );
    expect(`${sftp.stdout}\n${sftp.stderr}`).toContain(
      "Remote working directory"
    );

    const localPort = await reserveLocalPort();
    const localForward = await spawnMuxOnlyChannel(
      channelRequest(assigned, {
        kind: "local-forward",
        localBindHost: "127.0.0.1",
        localPort,
        remoteHost: "127.0.0.1",
        remotePort: 18080
      }),
      {
        isCurrentGeneration: (generation) =>
          pool.isCurrentGeneration(assigned.targetId, generation)
      }
    );
    try {
      await waitForPort(localPort);
      expect(await echoThroughSocket(localPort, "forward-ok")).toBe(
        "forward-ok"
      );
    } finally {
      await terminateChild(localForward);
    }

    const socksPort = await reserveLocalPort();
    const dynamicForward = await spawnMuxOnlyChannel(
      channelRequest(assigned, {
        kind: "dynamic-forward",
        localBindHost: "127.0.0.1",
        localPort: socksPort
      }),
      {
        isCurrentGeneration: (generation) =>
          pool.isCurrentGeneration(assigned.targetId, generation)
      }
    );
    try {
      await waitForPort(socksPort);
      expect(await echoThroughSocks(socksPort, "socks-ok")).toBe("socks-ok");
    } finally {
      await terminateChild(dynamicForward);
    }

    const afterFeatures = await target.audit.snapshot();
    const featureDelta = SshConnectionAudit.delta(afterMaster, afterFeatures);
    expect(featureDelta.acceptedTcpConnections).toBe(0);
    expect(featureDelta.authenticationAttempts).toBe(0);
    expect(featureDelta.acceptedAuthentications).toBe(0);
    expect(afterFeatures.liveTcpConnections).toBe(1);
    await pool.close();
  });

  it("converges racing provisional aliases before using the assigned target", async () => {
    const effective = await resolveEffectiveSshConfig({
      sshPath: target.sshPath,
      configPath: target.sshConfigPath,
      host: target.hostAlias
    });
    const pool = new SshTransportPool();
    const beforeRaces = await target.audit.snapshot();
    const [first, second] = await Promise.all([
      pool.connectProvisional(masterRequest("race-a", effective.policyHash)),
      pool.connectProvisional(masterRequest("race-b", effective.policyHash))
    ]);
    expect(first.generation).not.toBe(second.generation);
    const raceDelta = SshConnectionAudit.delta(
      beforeRaces,
      await target.audit.snapshot()
    );
    expect(raceDelta.acceptedTcpConnections).toBe(2);
    expect(raceDelta.authenticationAttempts).toBe(2);
    expect(raceDelta.acceptedAuthentications).toBe(2);
    const [winner, converged] = await Promise.all([
      pool.promote({
        connectionAttemptId: "race-a",
        targetId: "verified-target-race",
        effectiveConnectionPolicyHash: effective.policyHash
      }),
      pool.promote({
        connectionAttemptId: "race-b",
        targetId: "verified-target-race",
        effectiveConnectionPolicyHash: effective.policyHash
      })
    ]);
    expect(converged.generation).toBe(winner.generation);
    await eventually(
      async () => (await target.audit.snapshot()).liveTcpConnections === 1
    );
    await winner.master.check();
    await expect(
      (first.generation === winner.generation ? second : first).check()
    ).rejects.toThrow();
    await pool.close();
  });

  it("closes an established master after its remote-host owner is killed even if the profile config was removed", async () => {
    const effective = await resolveEffectiveSshConfig({
      sshPath: target.sshPath,
      configPath: target.sshConfigPath,
      host: target.hostAlias
    });
    const configPath = join(
      target.sandboxPath,
      `crash-owner-${randomBytes(6).toString("hex")}.ssh_config`
    );
    await writeFile(configPath, await readFile(target.sshConfigPath), {
      mode: 0o600
    });
    const request = {
      connectionAttemptId: `crash-owner-${randomBytes(6).toString("hex")}`,
      effectiveConnectionPolicyHash: effective.policyHash,
      sshPath: target.sshPath,
      configPath,
      host: target.hostAlias,
      controlRoot: target.controlDirectoryPath
    };
    const ownerScript = String.raw`
      const { startOpenSshControlMaster } = await import(
        "./apps/desktop/src/remote-host/sshTransportPool.ts"
      );
      const master = await startOpenSshControlMaster(
        JSON.parse(process.env.KMUX_CRASH_MASTER_REQUEST)
      );
      process.stdout.write("READY " + master.controlPath + "\n");
      setInterval(() => undefined, 1000);
    `;
    const before = await target.audit.snapshot();
    const owner = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", ownerScript],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          KMUX_CRASH_MASTER_REQUEST: JSON.stringify(request)
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let controlPath: string | undefined;
    try {
      const ready = await readChildOutputLine(owner);
      const match = /^READY (\S+)$/u.exec(ready);
      if (!match) throw new Error(`unexpected owner output: ${ready}`);
      controlPath = match[1];
      await eventually(async () => {
        const current = await target.audit.snapshot();
        return current.liveTcpConnections === before.liveTcpConnections + 1;
      });
      const established = SshConnectionAudit.delta(
        before,
        await target.audit.snapshot()
      );
      expect(established.acceptedTcpConnections).toBe(1);
      expect(established.authenticationAttempts).toBe(1);
      expect(established.acceptedAuthentications).toBe(1);

      // The crash cleanup must use the already-established ControlPath, not a
      // mutable profile file that may no longer exist.
      await rm(configPath, { force: true });
      const ownerClosed = new Promise<void>((resolveClose) =>
        owner.once("close", () => resolveClose())
      );
      expect(owner.kill("SIGKILL")).toBe(true);
      await ownerClosed;
      await eventually(async () => {
        const current = await target.audit.snapshot();
        return current.liveTcpConnections === before.liveTcpConnections;
      });
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) {
        await terminateChild(owner);
      }
      if (controlPath) {
        await runOpenSshCommand(
          target.sshPath,
          [
            "-F",
            "/dev/null",
            "-S",
            controlPath,
            "-O",
            "exit",
            "--",
            "127.0.0.1"
          ],
          { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 }
        ).catch(() => undefined);
      }
      await rm(configPath, { force: true });
    }
  });

  it("fails every prepared channel family closed when the master disappears", async () => {
    const requests = [
      { kind: "control", remoteCommand: "printf control" },
      { kind: "metadata", remoteCommand: "printf metadata" },
      { kind: "terminal", remoteCommand: "printf terminal" },
      { kind: "sftp" },
      {
        kind: "local-forward",
        localBindHost: "127.0.0.1",
        localPort: await reserveLocalPort(),
        remoteHost: "127.0.0.1",
        remotePort: 18080
      },
      {
        kind: "dynamic-forward",
        localBindHost: "127.0.0.1",
        localPort: await reserveLocalPort()
      }
    ] as const;

    for (const [index, request] of requests.entries()) {
      const pool = new SshTransportPool();
      const assigned = await connectAssignedMaster(pool, `closed-${index}`);
      const launch = await buildMuxOnlyLaunch(
        channelRequest(
          assigned,
          request as Parameters<typeof channelRequest>[1]
        )
      );
      await pool.disconnectTarget(assigned.targetId);
      const before = await target.audit.snapshot();
      await expect(
        runOpenSshCommand(launch.executable, launch.args, {
          env: launch.env,
          input: launch.kind === "sftp" ? "quit\n" : undefined,
          timeoutMs: 5_000
        })
      ).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const delta = SshConnectionAudit.delta(
        before,
        await target.audit.snapshot()
      );
      expect(delta.acceptedTcpConnections).toBe(0);
      expect(delta.authenticationAttempts).toBe(0);
      await pool.close();
    }
  });

  it("keeps the target alive while toxiproxy severs the SSH route", async () => {
    const pool = new SshTransportPool();
    const targetLosses: unknown[] = [];
    pool.onTargetLost((event) => targetLosses.push(event));
    const assigned = await connectAssignedMaster(pool, "proxy-loss");
    await target.faults.disconnect();
    try {
      await eventually(() => Promise.resolve(!assigned.master.isRunning()));
      await eventually(() => Promise.resolve(targetLosses.length === 1));
      expect(targetLosses[0]).toMatchObject({
        targetId: assigned.targetId,
        masterGeneration: assigned.generation,
        code: "master-closed"
      });
      expect(pool.getAssigned(assigned.targetId)).toBeUndefined();
      const targetStatus = await target.target.exec(["sh", "-c", "kill -0 1"]);
      expect(targetStatus.exitCode).toBe(0);
    } finally {
      await target.faults.reconnect();
      await pool.close();
    }
  });

  it("exposes a real target whose SFTP subsystem can be disabled", async () => {
    const withoutSftp = await startSshTarget({ sftpEnabled: false });
    try {
      const effective = await resolveEffectiveSshConfig({
        sshPath: withoutSftp.sshPath,
        configPath: withoutSftp.sshConfigPath,
        host: withoutSftp.hostAlias
      });
      const pool = new SshTransportPool();
      const master = await pool.connectProvisional({
        connectionAttemptId: "sftp-disabled",
        effectiveConnectionPolicyHash: effective.policyHash,
        sshPath: withoutSftp.sshPath,
        configPath: withoutSftp.sshConfigPath,
        host: withoutSftp.hostAlias,
        controlRoot: withoutSftp.controlDirectoryPath
      });
      const assigned = await pool.promote({
        connectionAttemptId: "sftp-disabled",
        targetId: "sftp-disabled-target",
        effectiveConnectionPolicyHash: effective.policyHash
      });
      expect(assigned.generation).toBe(master.generation);
      const launch = await buildMuxOnlyLaunch({
        kind: "sftp",
        sshPath: withoutSftp.sshPath,
        sftpPath: withoutSftp.sftpPath,
        configPath: withoutSftp.sshConfigPath,
        controlPath: assigned.master.controlPath,
        host: withoutSftp.hostAlias,
        masterGeneration: assigned.generation
      });
      await expect(
        runOpenSshCommand(launch.executable, launch.args, {
          env: launch.env,
          input: "pwd\nquit\n"
        })
      ).rejects.toThrow();
      const roots = doctorPaths(
        `/home/kmux/.kmux-sftp-disabled-${randomBytes(6).toString("hex")}`
      );
      await expect(
        prepareRemoteRuntime({
          pool,
          assigned,
          artifactRoot: remoteRuntimeArtifactRoot,
          transferRoot: join(withoutSftp.sandboxPath, "bootstrap-transfers"),
          sftpPath: withoutSftp.sftpPath,
          roots
        })
      ).rejects.toMatchObject({ code: "sftp-required" });
      const untouchedAuthority = await withoutSftp.target.exec([
        "test",
        "!",
        "-e",
        roots.authorityRoot
      ]);
      expect(untouchedAuthority.exitCode).toBe(0);
      await pool.close();
    } finally {
      await withoutSftp.stop();
    }
  });

  it("converges bootstrap, collects idle generations, and reinstalls an explicitly reset current generation", async () => {
    const pool = new SshTransportPool();
    const assigned = await connectAssignedMaster(pool, "content-bootstrap");
    const suffix = randomBytes(6).toString("hex");
    const root = `/home/kmux/.kmux-content-bootstrap-${suffix}`;
    const roots = doctorPaths(root);
    const options = {
      pool,
      assigned,
      artifactRoot: remoteRuntimeArtifactRoot,
      transferRoot: join(target.sandboxPath, `bootstrap-transfers-${suffix}`),
      sftpPath: target.sftpPath,
      roots
    };
    let runtime: LinuxX64RemoteRuntime | undefined;
    let oldRuntime: LinuxX64RemoteRuntime | undefined;
    const runtimeToken = createRemoteRuntimeToken();
    try {
      const [first, second] = await Promise.all([
        prepareRemoteRuntime(options),
        prepareRemoteRuntime(options)
      ]);
      expect(first.runtimePath).toBe(second.runtimePath);
      expect(first.generation).toBe(second.generation);
      expect(first.runtimePath).toBe(
        `${roots.installRoot}/bin/${first.generation}/kmuxd`
      );
      expect(first.doctor).toMatchObject({
        installRoot: roots.installRoot,
        authorityRoot: roots.authorityRoot,
        stateRoot: roots.stateRoot,
        runtimeRoot: roots.runtimeRoot,
        platform: "linux",
        arch: "x86_64",
        abi: "musl"
      });
      const inventory = await target.target.exec([
        "sh",
        "-c",
        `find ${roots.installRoot}/bin -mindepth 1 -maxdepth 1 -type d | wc -l`
      ]);
      expect(inventory.exitCode).toBe(0);
      expect(inventory.stdout.trim()).toBe("1");
      const sentinel = await target.target.exec([
        "test",
        "-f",
        `${first.runtimePath.slice(0, -"kmuxd".length)}install-complete`
      ]);
      expect(sentinel.exitCode).toBe(0);
      runtime = new LinuxX64RemoteRuntime({
        pool,
        assigned,
        runtimePath: first.runtimePath,
        roots,
        token: runtimeToken,
        transferRoot: options.transferRoot,
        sftpPath: target.sftpPath,
        bootstrapShellPolicy: first.shellPolicy
      });
      await expect(runtime.connect()).resolves.toMatchObject({
        type: "hello",
        authority: {
          remoteInstallationId: first.doctor.remoteInstallationId,
          executionNodeId: first.doctor.executionNodeId
        }
      });
      await expect(first.runGenerationGc()).resolves.toMatchObject({
        removed: [],
        incompleteOrCorrupt: []
      });
      const old = await stageCompleteGenerationFixture(
        pool,
        assigned,
        roots.installRoot,
        suffix
      );
      oldRuntime = new LinuxX64RemoteRuntime({
        pool,
        assigned,
        runtimePath: old.runtimePath,
        roots,
        token: runtimeToken,
        transferRoot: options.transferRoot,
        sftpPath: target.sftpPath,
        bootstrapShellPolicy: first.shellPolicy
      });
      await oldRuntime.connect();
      await expect(first.runGenerationGc()).resolves.toMatchObject({
        removed: [],
        live: expect.arrayContaining([old.generation])
      });
      await oldRuntime.close();
      oldRuntime = undefined;
      await expect(first.runGenerationGc()).resolves.toMatchObject({
        removed: [old.generation]
      });
      const removed = await target.target.exec([
        "test",
        "!",
        "-e",
        old.runtimePath
      ]);
      expect(removed.exitCode).toBe(0);

      await expect(first.resetCurrentGeneration()).rejects.toThrow();
      const liveGenerationPreserved = await target.target.exec([
        "test",
        "-x",
        first.runtimePath
      ]);
      expect(liveGenerationPreserved.exitCode).toBe(0);

      await runtime.close();
      runtime = undefined;
      await expect(first.resetCurrentGeneration()).resolves.toEqual({
        generation: first.generation,
        status: "reset"
      });
      const resetRemovedCurrent = await target.target.exec([
        "test",
        "!",
        "-e",
        first.runtimePath
      ]);
      expect(resetRemovedCurrent.exitCode).toBe(0);

      const reinstalled = await prepareRemoteRuntime(options);
      expect(reinstalled.generation).toBe(first.generation);
      expect(reinstalled.runtimePath).toBe(first.runtimePath);
      const resetReinstalledCurrent = await target.target.exec([
        "test",
        "-x",
        reinstalled.runtimePath
      ]);
      expect(resetReinstalledCurrent.exitCode).toBe(0);
    } finally {
      await oldRuntime?.close().catch(() => undefined);
      await runtime?.close().catch(() => undefined);
      await pool.close();
      await target.target.exec(["rm", "-rf", root]);
    }
  });

  it("reuses a verified installed generation after the SFTP subsystem becomes unavailable", async () => {
    const installedTarget = await startSshTarget();
    const suffix = randomBytes(6).toString("hex");
    const root = `/home/kmux/.kmux-installed-without-sftp-${suffix}`;
    const roots = doctorPaths(root);
    const firstPool = new SshTransportPool();
    const secondPool = new SshTransportPool();
    try {
      const firstAssigned = await connectAssignedMasterFor(
        installedTarget,
        firstPool,
        `installed-sftp-first-${suffix}`
      );
      const first = await prepareRemoteRuntime({
        pool: firstPool,
        assigned: firstAssigned,
        artifactRoot: remoteRuntimeArtifactRoot,
        transferRoot: join(installedTarget.sandboxPath, "bootstrap-transfers"),
        sftpPath: installedTarget.sftpPath,
        roots
      });
      await firstPool.close();
      const disabled = await installedTarget.target.exec([
        "sh",
        "-c",
        "sed -i 's#Subsystem sftp internal-sftp#Subsystem sftp /bin/false#' /run/kmux-ssh/sshd_config && kill -HUP \"$(cat /run/kmux-ssh/sshd.pid)\""
      ]);
      expect(disabled.exitCode).toBe(0);
      const secondAssigned = await connectAssignedMasterFor(
        installedTarget,
        secondPool,
        `installed-sftp-second-${suffix}`
      );
      const disabledLaunch = await buildMuxOnlyLaunch(
        channelRequestFor(
          installedTarget,
          installedTarget.sshConfigPath,
          secondAssigned,
          { kind: "sftp" }
        )
      );
      await expect(
        runOpenSshCommand(disabledLaunch.executable, disabledLaunch.args, {
          env: disabledLaunch.env,
          input: "pwd\nquit\n"
        })
      ).rejects.toThrow();
      const reused = await prepareRemoteRuntime({
        pool: secondPool,
        assigned: secondAssigned,
        artifactRoot: remoteRuntimeArtifactRoot,
        transferRoot: join(installedTarget.sandboxPath, "bootstrap-transfers"),
        sftpPath: installedTarget.sftpPath,
        roots
      });
      expect(reused.runtimePath).toBe(first.runtimePath);
      expect(reused.generation).toBe(first.generation);
      expect(reused.doctor.remoteInstallationId).toBe(
        first.doctor.remoteInstallationId
      );
    } finally {
      await firstPool.close().catch(() => undefined);
      await secondPool.close().catch(() => undefined);
      await installedTarget.target.exec(["rm", "-rf", root]);
      await installedTarget.stop();
    }
  });

  it("uploads, hashes, and runs the built kmuxd PTY spike with xterm.js-compatible state", async () => {
    const pool = new SshTransportPool();
    const assigned = await connectAssignedMaster(pool, "runtime-spike");
    const remoteRoot = "/home/kmux/.kmux-phase1";
    const remoteUpload = `${remoteRoot}/kmuxd.upload`;
    const remoteRuntime = `${remoteRoot}/kmuxd`;
    const remoteJournal = `${remoteRoot}/journal.bin`;
    const remoteCheckpoint = `${remoteRoot}/checkpoint.vt`;
    const localCheckpoint = join(target.sandboxPath, "checkpoint.vt");
    try {
      await runBoundedChannel(
        pool,
        assigned,
        channelRequest(assigned, {
          kind: "control",
          remoteCommand: `install -d -m 700 ${remoteRoot} && rm -f ${remoteUpload} ${remoteRuntime} ${remoteJournal} ${remoteCheckpoint}`
        })
      );
      await runBoundedChannel(
        pool,
        assigned,
        channelRequest(assigned, { kind: "sftp" }),
        `put ${quoteSftpPath(linuxRuntimeArtifactPath)} ${quoteSftpPath(remoteUpload)}\nquit\n`
      );
      const localArtifact = await readFile(linuxRuntimeArtifactPath);
      const localSha256 = createHash("sha256")
        .update(localArtifact)
        .digest("hex");
      const installed = await runBoundedChannel(
        pool,
        assigned,
        channelRequest(assigned, {
          kind: "control",
          remoteCommand: `test "$(sha256sum ${remoteUpload} | cut -d ' ' -f 1)" = "${localSha256}" && chmod 700 ${remoteUpload} && mv ${remoteUpload} ${remoteRuntime} && ${remoteRuntime} bridge --capabilities`
        })
      );
      expect(JSON.parse(installed.stdout)).toMatchObject({
        processRole: "bridge",
        available: true,
        terminalStreamOwnership: "keeper-direct",
        protocol: { keeperLocalProtocolMajor: expect.any(Number) }
      });

      const spike = await runBoundedChannel(
        pool,
        assigned,
        channelRequest(assigned, {
          kind: "control",
          remoteCommand: `${remoteRuntime} keeper pty-spike --journal-path ${remoteJournal} --checkpoint-path ${remoteCheckpoint} --cols 100 --rows 30 --executable /bin/sh -- -c $'sleep 0.1; printf \\'alpha\\r\\n\\033[32mbeta\\033[0m\\033[10;20Hcursor\\a\\''`
        })
      );
      const report = JSON.parse(spike.stdout) as {
        childPid: number;
        childSessionId: number;
        output: string;
        outputTruncated: boolean;
        journalAdmitted: number;
        journalSynced: number;
        checkpointFormat: string;
        checkpointSha256: string;
        checkpointBytes: number;
        cols: number;
        rows: number;
      };
      expect(report).toMatchObject({
        outputTruncated: false,
        checkpointFormat: "xterm-vt/1",
        cols: 100,
        rows: 30
      });
      expect(report.journalAdmitted).toBeGreaterThanOrEqual(3);
      expect(report.journalSynced).toBe(report.journalAdmitted);
      expect(report.childSessionId).toBe(report.childPid);

      await runBoundedChannel(
        pool,
        assigned,
        channelRequest(assigned, { kind: "sftp" }),
        `get ${quoteSftpPath(remoteCheckpoint)} ${quoteSftpPath(localCheckpoint)}\nquit\n`
      );
      const checkpoint = await readFile(localCheckpoint);
      expect(checkpoint).toHaveLength(report.checkpointBytes);
      expect(createHash("sha256").update(checkpoint).digest("hex")).toBe(
        report.checkpointSha256
      );

      const live = createHeadlessTerminal(100, 30);
      const restored = createHeadlessTerminal(100, 30);
      try {
        await writeTerminal(live.terminal, Buffer.from(report.output, "utf8"));
        await writeTerminal(restored.terminal, checkpoint);
        expect(snapshotTerminal(restored.terminal)).toEqual(
          snapshotTerminal(live.terminal)
        );
        expect(restored.serialize.serialize({ scrollback: 0 })).toBe(
          live.serialize.serialize({ scrollback: 0 })
        );
      } finally {
        live.terminal.dispose();
        restored.terminal.dispose();
      }
    } finally {
      await pool.close();
    }
  });

  it("isolates an aborted keeper while another real PTY remains interactive", async () => {
    const suffix = randomBytes(6).toString("hex");
    const desktopInstallationId = `desktop_isolation_${suffix}`;
    const workspaceId = `workspace_isolation_${suffix}`;
    const failedSessionId = `session_failed_${suffix}`;
    const failedSurfaceId = `surface_failed_${suffix}`;
    const survivorSessionId = `session_survivor_${suffix}`;
    const survivorSurfaceId = `surface_survivor_${suffix}`;
    const roots = doctorPaths(`/home/kmux/.kmux-isolation-${suffix}`);
    const pool = new SshTransportPool();
    let runtime: LinuxX64RemoteRuntime | undefined;
    let survivorAttachment: RemoteTerminalAttachment | undefined;
    const processDescriptors: RemoteSessionProcessDescriptor[] = [];
    try {
      const assigned = await connectAssignedMaster(pool, `isolation-${suffix}`);
      runtime = new LinuxX64RemoteRuntime({
        pool,
        assigned,
        runtimePath: target.remoteRuntimePath,
        transferRoot: join(target.sandboxPath, `isolation-transfers-${suffix}`),
        roots,
        token: createRemoteRuntimeToken()
      });
      const hello = await runtime.connect();
      const binding = bindingFromHello(assigned, hello);
      const state = remoteCoordinatorState(
        assigned.targetId,
        workspaceId,
        "/home/kmux"
      );
      const paneId = state.workspaces[workspaceId].activePaneId;
      const coordinator = createIntegrationCoordinator({
        state,
        store: createDurableRemoteOperationStore(
          join(target.sandboxPath, `isolation-operations-${suffix}`)
        ),
        binding,
        desktopInstallationId,
        operationIds: [
          `isolation_failed_create_${suffix}`,
          `isolation_survivor_create_${suffix}`,
          `isolation_survivor_terminate_${suffix}`
        ]
      });
      const launch = {
        cwd: "/home/kmux",
        shell: "/bin/sh",
        args: ["-c", "stty -echo; exec /bin/sh"]
      };
      const failedCreate = coordinator.admit({
        type: "remote-operation.command",
        workspaceId,
        expectedRemoteResourceRevision: uint64(0n),
        payload: {
          kind: "session.create",
          sessionId: failedSessionId,
          surfaceId: failedSurfaceId,
          paneId,
          launch
        }
      });
      const failedGeneration = requireKeeperGeneration(
        await coordinator.execute(
          failedCreate.intent.operationId,
          runtimeExecutor(runtime)
        )
      );
      const survivorCreate = coordinator.admit({
        type: "remote-operation.command",
        workspaceId,
        expectedRemoteResourceRevision: uint64(0n),
        payload: {
          kind: "session.create",
          sessionId: survivorSessionId,
          surfaceId: survivorSurfaceId,
          paneId,
          direction: "right",
          launch
        }
      });
      const survivorGeneration = requireKeeperGeneration(
        await coordinator.execute(
          survivorCreate.intent.operationId,
          runtimeExecutor(runtime)
        )
      );

      const failedProcess = await readRemoteSessionProcessDescriptor(
        target,
        roots.stateRoot,
        failedGeneration
      );
      const survivorProcess = await readRemoteSessionProcessDescriptor(
        target,
        roots.stateRoot,
        survivorGeneration
      );
      processDescriptors.push(failedProcess, survivorProcess);
      survivorAttachment = await runtime.attach({
        resourceKey: {
          desktopInstallationId,
          targetId: assigned.targetId,
          workspaceId,
          sessionId: survivorSessionId
        },
        expectedKeeperGeneration: survivorGeneration,
        access: "write"
      });
      await survivorAttachment.checkpoint;
      const beforeMarker = `survivor-before-${suffix}`;
      await survivorAttachment.sendInput(
        uint64(1n),
        new TextEncoder().encode(`printf '${beforeMarker}\\n'\n`)
      );
      await collectTerminalUntil(survivorAttachment, beforeMarker);

      const aborted = await target.target.exec([
        "kill",
        "-ABRT",
        String(failedProcess.keeperPid)
      ]);
      expect(aborted.exitCode).toBe(0);
      await eventually(
        async () =>
          !(await remoteProcessIsRunning(target, failedProcess.keeperPid)),
        5_000
      );
      try {
        await eventually(
          async () =>
            !(await remoteProcessIsRunning(target, failedProcess.childPid)),
          5_000
        );
      } catch (error) {
        const processState = await remoteProcessDiagnostic(
          target,
          failedProcess.childPid
        );
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; failed PTY child: ${processState}`
        );
      }
      expect(
        await remoteProcessIsRunning(target, survivorProcess.keeperPid)
      ).toBe(true);
      expect(
        await remoteProcessIsRunning(target, survivorProcess.childPid)
      ).toBe(true);

      const afterMarker = `survivor-after-${suffix}`;
      await survivorAttachment.sendInput(
        uint64(2n),
        new TextEncoder().encode(`printf '${afterMarker}\\n'\n`)
      );
      expect(
        (await collectTerminalUntil(survivorAttachment, afterMarker)).text
      ).toContain(afterMarker);
      const observed = await runtime.observe({
        desktopInstallationId,
        targetId: assigned.targetId
      });
      expect(observed.keepers).toContainEqual(
        expect.objectContaining({
          keeperGeneration: survivorGeneration,
          processState: "running"
        })
      );

      await survivorAttachment.detach();
      survivorAttachment = undefined;
      const terminate = coordinator.admit({
        type: "remote-operation.command",
        workspaceId,
        expectedRemoteResourceRevision: uint64(1n),
        payload: { kind: "session.terminate", sessionId: survivorSessionId }
      });
      await expect(
        coordinator.execute(
          terminate.intent.operationId,
          runtimeExecutor(runtime)
        )
      ).resolves.toMatchObject({
        status: "succeeded",
        remoteResourceRevision: 2n
      });
    } finally {
      await survivorAttachment?.detach().catch(() => undefined);
      await runtime?.close().catch(() => undefined);
      await pool.close().catch(() => undefined);
      for (const descriptor of processDescriptors) {
        await stopRemoteSessionProcesses(target, descriptor).catch(
          () => undefined
        );
      }
      await target.target
        .exec([
          "sh",
          "-lc",
          `rm -rf ${[
            roots.installRoot,
            roots.authorityRoot,
            roots.stateRoot,
            roots.runtimeRoot
          ]
            .map(quotePosixWord)
            .join(" ")}`
        ])
        .catch(() => undefined);
    }
  }, 45_000);

  it("fails closed on read-only and noexec install roots before authority mutation", async () => {
    const pathTarget = await startSshTarget({ pathFixtures: true });
    const pool = new SshTransportPool();
    try {
      const assigned = await connectAssignedMasterFor(
        pathTarget,
        pool,
        `phase8-path-${randomBytes(4).toString("hex")}`
      );
      const fixtures = pathTarget.pathFixturePaths;
      expect(fixtures).toBeDefined();
      const noexecBase = "/var/lib/kmux-local/kmux/phase8-noexec";
      await expect(
        runDoctor(pathTarget, pool, assigned, pathTarget.sshConfigPath, {
          installRoot: fixtures!.noexecInstallRoot,
          authorityRoot: `${noexecBase}/authority`,
          stateRoot: `${noexecBase}/state`,
          runtimeRoot: "/run/kmux-users/kmux/phase8-noexec"
        })
      ).rejects.toThrow(/not executable|permission denied/iu);
      const noexecAuthority = await pathTarget.target.exec([
        "test",
        "!",
        "-e",
        `${noexecBase}/authority/installation.json`
      ]);
      expect(noexecAuthority.exitCode).toBe(0);

      const readonlyBase = "/var/lib/kmux-local/kmux/phase8-readonly";
      await expect(
        runDoctor(pathTarget, pool, assigned, pathTarget.sshConfigPath, {
          installRoot: fixtures!.readonlyInstallRoot,
          authorityRoot: `${readonlyBase}/authority`,
          stateRoot: `${readonlyBase}/state`,
          runtimeRoot: "/run/kmux-users/kmux/phase8-readonly"
        })
      ).rejects.toThrow(
        /read-only|permission denied|operation not permitted/iu
      );
      const readonlyAuthority = await pathTarget.target.exec([
        "test",
        "!",
        "-e",
        `${readonlyBase}/authority/installation.json`
      ]);
      expect(readonlyAuthority.exitCode).toBe(0);

      const override = await runDoctor(
        pathTarget,
        pool,
        assigned,
        pathTarget.sshConfigPath,
        doctorPaths("/var/lib/kmux-local/kmux/phase8-verified-override")
      );
      expect(override.authenticatedPrincipal).toEqual({
        uid: 1000,
        accountName: "kmux"
      });
    } finally {
      await pool.close();
      await pathTarget.stop();
    }
  });

  it("backpressures a real PTY on full storage and resumes without unrecorded output", async () => {
    const storageTarget = await startSshTarget({ storageFixtureMiB: 32 });
    const pool = new SshTransportPool();
    let runtime: LinuxX64RemoteRuntime | undefined;
    let attachment: RemoteTerminalAttachment | undefined;
    let outputPromise:
      | Promise<{
          outputBytes: number;
          lastSequence: ReturnType<typeof uint64>;
          markerFound: boolean;
          closed: boolean;
        }>
      | undefined;
    const suffix = randomBytes(6).toString("hex");
    const desktopInstallationId = `desktop_storage_${suffix}`;
    const workspaceId = `workspace_storage_${suffix}`;
    const sessionId = `session_storage_${suffix}`;
    const surfaceId = `surface_storage_${suffix}`;
    const fixtureRoot = storageTarget.storageFixturePath;
    if (!fixtureRoot) throw new Error("storage fixture mount is unavailable");
    const roots = doctorPaths(`/home/kmux/.kmux-storage-case-${suffix}`);
    roots.stateRoot = `${fixtureRoot}/state-${suffix}`;
    const fillerPath = `${fixtureRoot}/filler-${suffix}`;
    try {
      const assigned = await connectAssignedMasterFor(
        storageTarget,
        pool,
        `storage-${suffix}`
      );
      runtime = new LinuxX64RemoteRuntime({
        pool,
        assigned,
        runtimePath: storageTarget.remoteRuntimePath,
        transferRoot: join(
          storageTarget.sandboxPath,
          `storage-transfers-${suffix}`
        ),
        roots,
        retentionPolicy: {
          sessionQuotaMiB: 64,
          targetQuotaMiB: 256
        },
        token: createRemoteRuntimeToken()
      });
      const hello = await runtime.connect();
      const binding = bindingFromHello(assigned, hello);
      const state = remoteCoordinatorState(
        assigned.targetId,
        workspaceId,
        "/home/kmux"
      );
      const paneId = state.workspaces[workspaceId].activePaneId;
      const coordinator = createIntegrationCoordinator({
        state,
        store: createDurableRemoteOperationStore(
          join(storageTarget.sandboxPath, `storage-operations-${suffix}`)
        ),
        binding,
        desktopInstallationId,
        operationIds: [
          `storage_create_${suffix}`,
          `storage_terminate_${suffix}`
        ]
      });
      const create = coordinator.admit({
        type: "remote-operation.command",
        workspaceId,
        expectedRemoteResourceRevision: uint64(0n),
        payload: {
          kind: "session.create",
          sessionId,
          surfaceId,
          paneId,
          launch: {
            cwd: "/home/kmux",
            shell: "/bin/sh",
            args: ["-c", "stty -echo; exec /bin/sh"]
          }
        }
      });
      const created = await coordinator.execute(
        create.intent.operationId,
        runtimeExecutor(runtime)
      );
      const keeperGeneration = requireKeeperGeneration(created);
      const resourceKey = {
        desktopInstallationId,
        targetId: assigned.targetId,
        workspaceId,
        sessionId
      };
      attachment = await runtime.attach({
        resourceKey,
        expectedKeeperGeneration: keeperGeneration,
        access: "write"
      });
      await attachment.checkpoint;
      const readyMarker = `storage-ready-${suffix}`;
      await attachment.sendInput(
        uint64(1n),
        new TextEncoder().encode(`printf '${readyMarker}\\n'\n`)
      );
      const ready = await collectTerminalUntil(attachment, readyMarker);

      const filled = await storageTarget.target.exec([
        "sh",
        "-lc",
        `available=$(df -Pk ${quotePosixWord(fixtureRoot)} | awk 'NR == 2 { print $4 }'); count=$((available - 512)); test "$count" -gt 0; dd if=/dev/zero of=${quotePosixWord(fillerPath)} bs=1024 count="$count" status=none`
      ]);
      expect(filled.exitCode).toBe(0);

      const completedMarker = `storage-completed-${suffix}`;
      outputPromise = collectContiguousTerminalUntil(
        attachment,
        ready.lastSequence,
        completedMarker,
        30_000
      );
      await attachment.sendInput(
        uint64(2n),
        new TextEncoder().encode(
          `head -c 6291456 /dev/zero | tr '\\000' x; printf '\\n${completedMarker}\\n'\n`
        )
      );

      let pressured:
        | Awaited<
            ReturnType<LinuxX64RemoteRuntime["observe"]>
          >["keepers"][number]
        | undefined;
      await eventually(async () => {
        pressured = (
          await runtime!.observe({
            desktopInstallationId,
            targetId: assigned.targetId
          })
        ).keepers.find(
          (keeper) => keeper.keeperGeneration === keeperGeneration
        );
        return pressured?.storageStatus.state === "backpressured";
      }, 15_000);
      expect(pressured).toBeDefined();
      expect(pressured!.storageStatus.emergencyBytes).toBeGreaterThan(0);
      expect(pressured!.storageStatus.emergencyBytes).toBeLessThanOrEqual(
        4 * 1024 * 1024
      );
      const stoppedAdmission = pressured!.storageStatus.journalAdmitted;
      const stoppedEmergency = pressured!.storageStatus.emergencyBytes;
      await new Promise((resolve) => setTimeout(resolve, 250));
      const stillStopped = (
        await runtime.observe({
          desktopInstallationId,
          targetId: assigned.targetId
        })
      ).keepers.find((keeper) => keeper.keeperGeneration === keeperGeneration);
      expect(stillStopped?.storageStatus).toMatchObject({
        state: "backpressured",
        journalAdmitted: stoppedAdmission,
        emergencyBytes: stoppedEmergency
      });

      const freed = await storageTarget.target.exec([
        "sh",
        "-lc",
        `rm -f ${quotePosixWord(fillerPath)}`
      ]);
      expect(freed.exitCode).toBe(0);
      const firstReplay = await outputPromise;
      outputPromise = undefined;

      let recovered:
        | Awaited<
            ReturnType<LinuxX64RemoteRuntime["observe"]>
          >["keepers"][number]
        | undefined;
      await eventually(async () => {
        recovered = (
          await runtime!.observe({
            desktopInstallationId,
            targetId: assigned.targetId
          })
        ).keepers.find(
          (keeper) => keeper.keeperGeneration === keeperGeneration
        );
        return (
          recovered?.storageStatus.state === "normal" &&
          recovered.storageStatus.emergencyBytes === 0
        );
      }, 15_000);
      expect(BigInt(recovered!.storageStatus.journalAdmitted)).toBeGreaterThan(
        BigInt(stoppedAdmission)
      );

      const completed = await collectTerminalAcrossReattachments({
        runtime,
        attachment,
        resourceKey,
        keeperGeneration,
        marker: completedMarker,
        initial: firstReplay,
        timeoutMs: 30_000
      });
      attachment = completed.attachment;
      expect(completed.markerFound).toBe(true);
      if (completed.lastCheckpointSequence !== undefined) {
        expect(completed.lastCheckpointSequence).toBeGreaterThan(
          BigInt(stoppedAdmission)
        );
      } else {
        expect(completed.outputBytes).toBeGreaterThanOrEqual(6 * 1024 * 1024);
      }
      await eventually(async () => {
        const durable = (
          await runtime!.observe({
            desktopInstallationId,
            targetId: assigned.targetId
          })
        ).keepers.find(
          (keeper) => keeper.keeperGeneration === keeperGeneration
        );
        return (
          durable?.storageStatus.state === "normal" &&
          durable.storageStatus.emergencyBytes === 0 &&
          durable.storageStatus.journalSynced ===
            durable.storageStatus.journalAdmitted
        );
      });

      await attachment.detach();
      attachment = undefined;
      const terminate = coordinator.admit({
        type: "remote-operation.command",
        workspaceId,
        expectedRemoteResourceRevision: uint64(1n),
        payload: { kind: "session.terminate", sessionId }
      });
      await expect(
        coordinator.execute(
          terminate.intent.operationId,
          runtimeExecutor(runtime)
        )
      ).resolves.toMatchObject({
        status: "succeeded",
        remoteResourceRevision: 2n
      });
    } finally {
      await storageTarget.target
        .exec(["sh", "-lc", `rm -f ${quotePosixWord(fillerPath)}`])
        .catch(() => undefined);
      await outputPromise?.catch(() => undefined);
      await attachment?.detach().catch(() => undefined);
      await runtime?.close().catch(() => undefined);
      await pool.close().catch(() => undefined);
      await storageTarget.stop().catch(() => undefined);
    }
  }, 120_000);

  it("prepares, retries, reclaims, and promotes conversion keepers through real SSH", async () => {
    const suffix = randomBytes(6).toString("hex");
    const desktopInstallationId = `desktop_phase5_${suffix}`;
    const remoteRoot = `/home/kmux/.kmux-phase5-${suffix}`;
    const roots = doctorPaths(remoteRoot);
    const token = createRemoteRuntimeToken();
    const pool = new SshTransportPool();
    let runtime: LinuxX64RemoteRuntime | undefined;
    let writer: RemoteTerminalAttachment | undefined;
    try {
      const assigned = await connectAssignedMaster(pool, `phase5-${suffix}`);
      runtime = new LinuxX64RemoteRuntime({
        pool,
        assigned,
        runtimePath: target.remoteRuntimePath,
        transferRoot: join(target.sandboxPath, `phase5-transfers-${suffix}`),
        roots,
        token
      });
      await runtime.connect();

      const leasedWorkspaceId = `workspace_leased_${suffix}`;
      const leasedSessionId = `session_leased_${suffix}`;
      const leasedSnapshot = JSON.stringify({
        workspaceId: leasedWorkspaceId,
        sessionId: leasedSessionId,
        sourceRevision: "a".repeat(64)
      });
      const leasedSnapshotHash = createHash("sha256")
        .update(leasedSnapshot, "utf8")
        .digest("hex");
      const leasedRequest = {
        transactionId: `conversion_leased_${suffix}`,
        workspaceCreateOperationId: `workspace_create_leased_${suffix}`,
        sessionCreateOperationId: `session_create_leased_${suffix}`,
        workspaceResourceKey: {
          desktopInstallationId,
          targetId: assigned.targetId,
          workspaceId: leasedWorkspaceId
        },
        sessionResourceKey: {
          desktopInstallationId,
          targetId: assigned.targetId,
          workspaceId: leasedWorkspaceId,
          sessionId: leasedSessionId
        },
        sourceWorkspaceRevision: "a".repeat(64),
        remoteSnapshot: leasedSnapshot,
        remoteSnapshotHash: leasedSnapshotHash,
        launch: {
          cwd: "/home/kmux",
          shell: "/bin/sh",
          args: ["-c", "stty -echo; exec /bin/sh"]
        },
        preparedAt: "2026-07-16T00:00:00.000Z"
      };
      const firstPrepared = await runtime.prepareConversion(leasedRequest);
      const retriedPrepared = await runtime.prepareConversion(leasedRequest);
      expect(retriedPrepared).toEqual(firstPrepared);

      let observed = await runtime.observe({
        desktopInstallationId,
        targetId: assigned.targetId
      });
      expect(observed.keepers).toContainEqual(
        expect.objectContaining({
          resourceKey: leasedRequest.sessionResourceKey,
          keeperGeneration: firstPrepared.keeperGeneration,
          lifecycleState: "provisional",
          conversionTransactionId: leasedRequest.transactionId,
          remoteSnapshotHash: leasedSnapshotHash,
          everGrantedWriterLease: false
        })
      );

      writer = await runtime.attach({
        resourceKey: leasedRequest.sessionResourceKey,
        expectedKeeperGeneration: firstPrepared.keeperGeneration,
        access: "write"
      });
      await writer.checkpoint;
      await writer.detach();
      writer = undefined;

      const unleasedWorkspaceId = `workspace_unleased_${suffix}`;
      const unleasedSessionId = `session_unleased_${suffix}`;
      const unleasedSnapshot = JSON.stringify({
        workspaceId: unleasedWorkspaceId,
        sessionId: unleasedSessionId,
        sourceRevision: "b".repeat(64)
      });
      const unleasedSnapshotHash = createHash("sha256")
        .update(unleasedSnapshot, "utf8")
        .digest("hex");
      const unleasedRequest = {
        transactionId: `conversion_unleased_${suffix}`,
        workspaceCreateOperationId: `workspace_create_unleased_${suffix}`,
        sessionCreateOperationId: `session_create_unleased_${suffix}`,
        workspaceResourceKey: {
          desktopInstallationId,
          targetId: assigned.targetId,
          workspaceId: unleasedWorkspaceId
        },
        sessionResourceKey: {
          desktopInstallationId,
          targetId: assigned.targetId,
          workspaceId: unleasedWorkspaceId,
          sessionId: unleasedSessionId
        },
        sourceWorkspaceRevision: "b".repeat(64),
        remoteSnapshot: unleasedSnapshot,
        remoteSnapshotHash: unleasedSnapshotHash,
        launch: {
          cwd: "/home/kmux",
          shell: "/bin/sh",
          args: ["-c", "stty -echo; exec /bin/sh"]
        },
        preparedAt: "2026-07-16T00:00:00.000Z"
      };
      await runtime.prepareConversion(unleasedRequest);

      const reclaimed = await runtime.reclaimProvisionals({
        desktopInstallationId,
        targetId: assigned.targetId,
        protectedTransactionIds: [],
        now: "2026-07-18T00:00:00.000Z"
      });
      expect(reclaimed).toMatchObject({
        terminatedTransactionIds: [unleasedRequest.transactionId],
        skippedEverLeasedTransactionIds: [leasedRequest.transactionId]
      });

      const promotionRequest = {
        transactionId: leasedRequest.transactionId,
        workspaceCreateOperationId: leasedRequest.workspaceCreateOperationId,
        sessionCreateOperationId: leasedRequest.sessionCreateOperationId,
        workspaceResourceKey: leasedRequest.workspaceResourceKey,
        sessionResourceKey: leasedRequest.sessionResourceKey,
        remoteSnapshotHash: leasedSnapshotHash
      };
      const promoted = await runtime.promoteConversion(promotionRequest);
      expect(await runtime.promoteConversion(promotionRequest)).toEqual(
        promoted
      );

      observed = await runtime.observe({
        desktopInstallationId,
        targetId: assigned.targetId
      });
      expect(observed.keepers).toContainEqual(
        expect.objectContaining({
          resourceKey: leasedRequest.sessionResourceKey,
          lifecycleState: "committed",
          everGrantedWriterLease: true
        })
      );
      expect(observed.keepers).toContainEqual(
        expect.objectContaining({
          resourceKey: unleasedRequest.sessionResourceKey,
          lifecycleState: "abandoned",
          processState: "exited"
        })
      );
    } finally {
      await writer?.detach().catch(() => undefined);
      await runtime?.close().catch(() => undefined);
      await pool.close();
    }
  });

  it("routes Phase 6 CLI, capture, hooks, and detached OSC notifications through one real remote keeper", async () => {
    const suffix = randomBytes(6).toString("hex");
    const desktopInstallationId = `desktop_phase6_${suffix}`;
    const workspaceId = `workspace_phase6_${suffix}`;
    const sessionId = `session_phase6_${suffix}`;
    const surfaceId = `surface_phase6_${suffix}`;
    const remoteRoot = `/home/kmux/.kmux-phase6-${suffix}`;
    const roots = doctorPaths(remoteRoot);
    const token = createRemoteRuntimeToken();
    const pool = new SshTransportPool();
    let runtime: LinuxX64RemoteRuntime | undefined;
    let attachment: RemoteTerminalAttachment | undefined;
    try {
      const assigned = await connectAssignedMaster(pool, `phase6-${suffix}`);
      const afterMaster = await target.audit.snapshot();
      runtime = new LinuxX64RemoteRuntime({
        pool,
        assigned,
        runtimePath: target.remoteRuntimePath,
        transferRoot: join(target.sandboxPath, `phase6-transfers-${suffix}`),
        roots,
        token
      });
      const hello = await runtime.connect();
      const binding = bindingFromHello(assigned, hello);
      const state = remoteCoordinatorState(
        assigned.targetId,
        workspaceId,
        "/home/kmux"
      );
      const paneId = state.workspaces[workspaceId].activePaneId;
      const store = createDurableRemoteOperationStore(
        join(target.sandboxPath, `phase6-operations-${suffix}`)
      );
      const coordinator = createIntegrationCoordinator({
        state,
        store,
        binding,
        desktopInstallationId,
        operationIds: [`create_phase6_${suffix}`, `terminate_phase6_${suffix}`]
      });
      const create = coordinator.admit({
        type: "remote-operation.command",
        workspaceId,
        expectedRemoteResourceRevision: uint64(0n),
        payload: {
          kind: "session.create",
          sessionId,
          surfaceId,
          paneId,
          launch: {
            cwd: "/home/kmux",
            shell: "/bin/sh",
            args: ["-c", "stty -echo; exec /bin/sh"],
            env: { KMUX_SURFACE_ID: surfaceId }
          }
        }
      });
      const created = await coordinator.execute(
        create.intent.operationId,
        runtimeExecutor(runtime)
      );
      const keeperGeneration = requireKeeperGeneration(created);
      const resourceKey = {
        desktopInstallationId,
        targetId: assigned.targetId,
        workspaceId,
        sessionId
      };
      attachment = await runtime.attach({
        resourceKey,
        expectedKeeperGeneration: keeperGeneration,
        access: "write"
      });
      await attachment.checkpoint;

      const directMarker = `phase6-direct-${suffix}`;
      const directInput = `printf '${directMarker}\\n'\n`;
      const directRequest = {
        resourceKey,
        expectedKeeperGeneration: keeperGeneration,
        operationId: `direct_input_${suffix}`,
        payloadHash: createHash("sha256")
          .update(directInput, "utf8")
          .digest("hex"),
        input: directInput
      };
      const directAck = await runtime.injectTerminal(directRequest);
      expect(directAck).toMatchObject({
        operationId: directRequest.operationId,
        keeperGeneration,
        boundary: "pty-write",
        byteLength: Buffer.byteLength(directInput, "utf8")
      });
      await collectTerminalUntil(attachment, directMarker);
      await expect(runtime.injectTerminal(directRequest)).resolves.toEqual(
        directAck
      );
      const directDedupeSentinel = `phase6-direct-dedupe-${suffix}`;
      await attachment.sendInput(
        uint64(1n),
        new TextEncoder().encode(`printf '${directDedupeSentinel}\\n'\n`)
      );
      const directRetryOutput = await collectTerminalUntil(
        attachment,
        directDedupeSentinel
      );
      expect(directRetryOutput.text).not.toContain(directMarker);

      const cliMarker = `phase6-cli-${suffix}`;
      const cliTextOperationId = `cli_text_${suffix}`;
      const cliKeyOperationId = `cli_key_${suffix}`;
      const cliScope =
        '--target "$KMUX_TARGET_ID" --workspace "$KMUX_WORKSPACE_ID" --session "$KMUX_SESSION_ID"';
      const cliText = `printf '${cliMarker}\\n'`;
      const cliInputCommand = [
        `"$KMUX_CLI_PATH" ${cliScope} surface send-text --operation-id ${quotePosixWord(cliTextOperationId)} --text ${quotePosixWord(cliText)}`,
        `"$KMUX_CLI_PATH" ${cliScope} surface send-key --operation-id ${quotePosixWord(cliKeyOperationId)} --key Enter`
      ].join("; ");
      await attachment.sendInput(
        uint64(2n),
        new TextEncoder().encode(`${cliInputCommand}\n`)
      );
      const cliOutput = await collectTerminalUntil(attachment, cliMarker);
      expect(cliOutput.text).toContain(cliTextOperationId);
      expect(cliOutput.text).toContain(cliKeyOperationId);
      expect(cliOutput.text).toContain('"boundary":"pty-write"');

      const cliDedupeSentinel = `phase6-cli-dedupe-${suffix}`;
      await attachment.sendInput(
        uint64(3n),
        new TextEncoder().encode(
          `${cliInputCommand}; printf '${cliDedupeSentinel}\\n'\n`
        )
      );
      const cliRetryOutput = await collectTerminalUntil(
        attachment,
        cliDedupeSentinel
      );
      expect(cliRetryOutput.text).not.toContain(cliMarker);

      const cliCaptureId = `cli_capture_${suffix}`;
      const cliCaptureSentinel = `phase6-cli-capture-${suffix}`;
      await attachment.sendInput(
        uint64(4n),
        new TextEncoder().encode(
          `"$KMUX_CLI_PATH" ${cliScope} surface capture --capture-id ${quotePosixWord(cliCaptureId)} --lines 5 --max-bytes 256; printf '${cliCaptureSentinel}\\n'\n`
        )
      );
      const cliCaptureOutput = await collectTerminalUntil(
        attachment,
        cliCaptureSentinel
      );
      expect(cliCaptureOutput.text).toContain('"type":"surface-captured"');
      expect(cliCaptureOutput.text).toContain(cliCaptureId);

      await runtime.closeBridge();
      const hookSentinel = `phase6-hook-admitted-${suffix}`;
      const hookMessage = `bridge-down-${suffix}`;
      const agentResponseSentinel = `phase6-agent-response-${suffix}`;
      await attachment.sendInput(
        uint64(5n),
        new TextEncoder().encode(
          `[ -x "$KMUX_AGENT_BIN_DIR/kmux-agent-hook" ] && printf '%s' ${quotePosixWord(JSON.stringify({ message: hookMessage }))} | "$KMUX_AGENT_BIN_DIR/kmux-agent-hook" codex Stop && printf '%s' ${quotePosixWord(JSON.stringify({ message: agentResponseSentinel }))} | KMUX_AGENT_HOOK_OUTPUT_MODE=json "$KMUX_AGENT_BIN_DIR/kmux-agent-hook" antigravity Stop && printf '${hookSentinel}\\n'\n`
        )
      );
      const hookOutput = await collectTerminalUntil(attachment, hookSentinel);
      expect(hookOutput.text).not.toContain('"durable":true');
      expect(hookOutput.text).toContain('{"decision":"allow"}');

      const oscTitle = `phase6-osc-title-${suffix}`;
      const oscMessage = `phase6-osc-message-${suffix}`;
      await attachment.sendInput(
        uint64(6n),
        new TextEncoder().encode(
          `(sleep 0.2; printf '\\033]777;notify;${oscTitle};${oscMessage}\\007') &\n`
        )
      );
      await attachment.detach();
      attachment = undefined;
      await new Promise((resolve) => setTimeout(resolve, 500));

      expectAuthority(await runtime.connect(), binding);
      const firstReplay = await runtime.replayEvents({
        desktopInstallationId,
        targetId: assigned.targetId,
        afterSequence: uint64(0n)
      });
      expect(firstReplay.events).toHaveLength(3);
      const hookEvent = firstReplay.events.find(
        (event) => event.name === "codex.Stop"
      );
      expect(hookEvent).toMatchObject({
        kind: "agent-hook",
        name: "codex.Stop",
        resourceKey,
        surfaceId,
        keeperGeneration,
        payload: { message: hookMessage }
      });
      expect(
        firstReplay.events.find((event) => event.name === "antigravity.Stop")
      ).toMatchObject({
        kind: "agent-hook",
        name: "antigravity.Stop",
        resourceKey,
        surfaceId,
        keeperGeneration,
        payload: { message: agentResponseSentinel }
      });
      const oscEvent = firstReplay.events.find(
        (event) => event.kind === "osc-notification"
      );
      expect(oscEvent).toMatchObject({
        kind: "osc-notification",
        name: "terminal.osc.777",
        resourceKey,
        surfaceId,
        keeperGeneration,
        payload: {
          protocol: 777,
          title: oscTitle,
          message: oscMessage
        }
      });
      const replayedBeforeAck = await runtime.replayEvents({
        desktopInstallationId,
        targetId: assigned.targetId,
        afterSequence: uint64(0n)
      });
      expect(replayedBeforeAck.events.map((event) => event.eventId)).toEqual(
        firstReplay.events.map((event) => event.eventId)
      );
      const replayThrough = uint64(BigInt(firstReplay.events.at(-1)!.sequence));
      await expect(
        runtime.acknowledgeEvents({
          desktopInstallationId,
          targetId: assigned.targetId,
          throughSequence: replayThrough
        })
      ).resolves.toBe(replayThrough);
      await expect(
        runtime.replayEvents({
          desktopInstallationId,
          targetId: assigned.targetId,
          afterSequence: replayThrough
        })
      ).resolves.toMatchObject({
        events: [],
        acknowledgedThrough: replayThrough,
        hasMore: false
      });

      const fullCapture = await runtime.captureSurface({
        resourceKey,
        expectedKeeperGeneration: keeperGeneration,
        captureId: `capture_full_${suffix}`,
        lineLimit: 200,
        maxBytes: 1024 * 1024
      });
      expect(fullCapture.text).toContain(hookSentinel);
      expect(fullCapture.lineCount).toBeLessThanOrEqual(200);
      expect(fullCapture.byteLength).toBe(
        Buffer.byteLength(fullCapture.text, "utf8")
      );
      const boundedCapture = await runtime.captureSurface({
        resourceKey,
        expectedKeeperGeneration: keeperGeneration,
        captureId: `capture_bounded_${suffix}`,
        lineLimit: 2,
        maxBytes: 32
      });
      expect(boundedCapture.lineCount).toBeLessThanOrEqual(2);
      expect(boundedCapture.byteLength).toBeLessThanOrEqual(32);
      expect(
        boundedCapture.linesTruncated || boundedCapture.bytesTruncated
      ).toBe(true);

      const terminate = coordinator.admit({
        type: "remote-operation.command",
        workspaceId,
        expectedRemoteResourceRevision: uint64(1n),
        payload: { kind: "session.terminate", sessionId }
      });
      await expect(
        coordinator.execute(
          terminate.intent.operationId,
          runtimeExecutor(runtime)
        )
      ).resolves.toMatchObject({
        status: "succeeded",
        remoteResourceRevision: 2n
      });

      const featureDelta = SshConnectionAudit.delta(
        afterMaster,
        await target.audit.snapshot()
      );
      expect(featureDelta.acceptedTcpConnections).toBe(0);
      expect(featureDelta.authenticationAttempts).toBe(0);
    } finally {
      await attachment?.detach().catch(() => undefined);
      await runtime?.close().catch(() => undefined);
      await pool.close().catch(() => undefined);
    }
  });

  it("keeps one durable terminal generation through bridge, SSH, remote-host, and desktop loss", async () => {
    const suffix = randomBytes(6).toString("hex");
    const desktopInstallationId = `desktop_phase3_${suffix}`;
    const workspaceId = `workspace_phase3_${suffix}`;
    const sessionId = `session_phase3_${suffix}`;
    const surfaceId = `surface_phase3_${suffix}`;
    const remoteRoot = `/home/kmux/.kmux-phase3-${suffix}`;
    const roots = doctorPaths(remoteRoot);
    const token = createRemoteRuntimeToken();
    const pool = new SshTransportPool();
    let reconnectPool: SshTransportPool | undefined;
    let firstRuntime: LinuxX64RemoteRuntime | undefined;
    let secondRuntime: LinuxX64RemoteRuntime | undefined;
    let reconnectedRuntime: LinuxX64RemoteRuntime | undefined;
    let attachment: RemoteTerminalAttachment | undefined;
    let reconnectedAttachment: RemoteTerminalAttachment | undefined;
    let routeDisconnected = false;
    try {
      const assigned = await connectAssignedMaster(pool, `phase3-${suffix}`);
      const afterMaster = await target.audit.snapshot();
      firstRuntime = new LinuxX64RemoteRuntime({
        pool,
        assigned,
        runtimePath: target.remoteRuntimePath,
        transferRoot: join(target.sandboxPath, `phase3-transfers-${suffix}`),
        roots,
        token
      });
      const hello = await firstRuntime.connect();
      phase3Diagnostic("hello");
      expect(hello).toMatchObject({
        protocolVersion: 1,
        platform: "linux",
        arch: "x86_64",
        abi: "musl",
        persistenceLevel: "ssh-disconnect"
      });
      const binding = bindingFromHello(assigned, hello);
      const state = remoteCoordinatorState(
        assigned.targetId,
        workspaceId,
        "/home/kmux"
      );
      const paneId = state.workspaces[workspaceId].activePaneId;
      const store = createDurableRemoteOperationStore(
        join(target.sandboxPath, `phase3-operations-${suffix}`)
      );
      const operationIds = [
        `create_${suffix}`,
        `launch_${suffix}`,
        `retained_create_${suffix}`,
        `adopt_mismatch_${suffix}`,
        `adopt_${suffix}`,
        `restart_${suffix}`,
        `split_${suffix}`,
        `split_terminate_${suffix}`,
        `retained_terminate_${suffix}`,
        `terminate_${suffix}`
      ];
      const coordinator = createIntegrationCoordinator({
        state,
        store,
        binding,
        desktopInstallationId,
        operationIds
      });
      const create = coordinator.admit({
        type: "remote-operation.command",
        workspaceId,
        expectedRemoteResourceRevision: uint64(0n),
        payload: {
          kind: "session.create",
          sessionId,
          surfaceId,
          paneId,
          launch: {
            cwd: "/home/kmux",
            shell: "/bin/sh",
            args: ["-c", "stty -echo; exec /bin/sh"]
          }
        }
      });
      const created = await coordinator.execute(
        create.intent.operationId,
        runtimeExecutor(firstRuntime)
      );
      expect(created).toMatchObject({
        status: "succeeded",
        remoteResourceRevision: 1n
      });
      phase3Diagnostic("create");
      const createRetry = await firstRuntime.executeOperation(
        create.intent,
        create.payload
      );
      expect(createRetry).toMatchObject({
        status: "succeeded",
        resultDigest:
          created.status === "succeeded" ? created.resultDigest : undefined
      });
      const keeperGeneration = requireKeeperGeneration(created);
      expect(requireKeeperGeneration(createRetry)).toBe(keeperGeneration);
      expect(state.sessions[sessionId]).toMatchObject({
        surfaceId,
        remoteRuntime: {
          keeperGeneration,
          remoteResourceRevision: 1n
        },
        runtimeStatus: {
          processState: "running",
          observationState: "observed",
          attachmentState: "detached"
        }
      });
      const launchMarker = `launch-marker-${suffix}`;
      const launchInput = coordinator.admit({
        type: "remote-operation.command",
        workspaceId,
        expectedRemoteResourceRevision: uint64(1n),
        payload: {
          kind: "launch-input",
          sessionId,
          input: `printf 'launch-marker-%s\\n' '${suffix}'\n`
        }
      });
      pauseBridgeAcknowledgements(firstRuntime);
      const ambiguousLaunch = coordinator.execute(
        launchInput.intent.operationId,
        runtimeExecutor(firstRuntime)
      );
      try {
        await eventually(() =>
          remoteLaunchInputIsWritten(
            roots.stateRoot,
            launchInput.intent.operationId
          )
        );
      } catch (error) {
        const diagnostics = await target.target.exec([
          "sh",
          "-lc",
          `ps -ef | grep '[k]muxd'; find ${roots.stateRoot}/sessions -maxdepth 1 -name '*.json' -print -exec cat {} \\;`
        ]);
        throw new Error(
          `launch-input did not become durable: ${error instanceof Error ? error.message : String(error)}\n${diagnostics.stdout}\n${diagnostics.stderr}`,
          { cause: error }
        );
      }
      await firstRuntime.closeBridge();
      await expect(ambiguousLaunch).resolves.toEqual({
        status: "pending",
        reason: "ambiguous"
      });
      expect(store.get(launchInput.intent.operationId)?.result).toBeUndefined();

      expectAuthority(await firstRuntime.connect(), binding);
      const launched = await coordinator.execute(
        launchInput.intent.operationId,
        runtimeExecutor(firstRuntime)
      );
      expect(launched).toMatchObject({
        status: "succeeded",
        remoteResourceRevision: 2n
      });
      phase3Diagnostic("launch-input");
      await expect(
        firstRuntime.executeOperation(launchInput.intent, launchInput.payload)
      ).resolves.toMatchObject({
        status: "succeeded",
        resultDigest:
          launched.status === "succeeded" ? launched.resultDigest : undefined
      });

      try {
        attachment = await firstRuntime.attach({
          resourceKey: {
            desktopInstallationId,
            targetId: assigned.targetId,
            workspaceId,
            sessionId
          },
          expectedKeeperGeneration: keeperGeneration,
          access: "write"
        });
      } catch (error) {
        const diagnostics = await target.target.exec([
          "sh",
          "-lc",
          `ps -ef | grep '[k]muxd'; find ${remoteRoot} -maxdepth 4 -print -exec ls -ld {} \\;; find ${roots.stateRoot}/sessions -name '*.json' -maxdepth 1 -exec cat {} \\;`
        ]);
        throw new Error(
          `phase 3 attach failed: ${error instanceof Error ? error.message : String(error)}\n${diagnostics.stdout}\n${diagnostics.stderr}`,
          { cause: error }
        );
      }
      phase3Diagnostic("attach");
      const checkpoint = await attachment.checkpoint;
      let terminalText = checkpoint
        ? Buffer.concat(
            checkpoint.chunks.map((chunk) => Buffer.from(chunk))
          ).toString("utf8")
        : "";
      let lastSequence = checkpoint
        ? uint64(BigInt(checkpoint.metadata.lastMutationSequence))
        : uint64(0n);
      if (!terminalText.includes(launchMarker)) {
        const observed = await collectTerminalUntil(attachment, launchMarker);
        terminalText += observed.text;
        lastSequence = observed.lastSequence;
      }
      expect(terminalText).toContain(launchMarker);
      expect(terminalText.split(launchMarker)).toHaveLength(2);
      phase3Diagnostic("launch-output");

      const inputMarker = `input-marker-${suffix}`;
      await expect(
        attachment.sendInput(
          uint64(1n),
          new TextEncoder().encode(`printf '${inputMarker}\\n'\n`)
        )
      ).resolves.toMatchObject({ boundary: "pty-write" });
      const firstInput = await collectTerminalUntil(attachment, inputMarker);
      lastSequence = firstInput.lastSequence;
      expect(firstInput.text).toContain(inputMarker);

      await expect(
        attachment.sendInput(
          uint64(1n),
          new TextEncoder().encode(`printf '${inputMarker}\\n'\n`)
        )
      ).resolves.toMatchObject({ boundary: "pty-write" });
      const sentinel = `sentinel-${suffix}`;
      await attachment.sendInput(
        uint64(2n),
        new TextEncoder().encode(`printf '${sentinel}\\n'\n`)
      );
      const afterRetry = await collectTerminalUntil(attachment, sentinel);
      lastSequence = afterRetry.lastSequence;
      expect(afterRetry.text).toContain(sentinel);
      expect(afterRetry.text).not.toContain(inputMarker);
      phase3Diagnostic("input-dedupe");

      const utf8Marker = `utf8-${suffix}:€:end`;
      await attachment.sendInput(
        uint64(3n),
        new TextEncoder().encode(
          `printf 'utf8-${suffix}:'; printf '\\342'; sleep 0.05; printf '\\202'; sleep 0.05; printf '\\254:end\\n'\n`
        )
      );
      const utf8Output = await collectTerminalUntil(attachment, utf8Marker);
      lastSequence = utf8Output.lastSequence;
      expect(utf8Output.text).toContain(utf8Marker);
      expect(utf8Output.text).not.toContain("�");
      phase3Diagnostic("utf8-boundary");

      const resizeAck = await attachment.resize(100, 30);
      expect(resizeAck).toMatchObject({ cols: 100, rows: 30 });
      const throughResize = await collectMutationsThroughSequence(
        attachment,
        lastSequence,
        uint64(BigInt(resizeAck.mutationSequence))
      );
      const resizeMutation = throughResize.targetMutation;
      expect(resizeMutation).toMatchObject({
        kind: "resize",
        sequence: BigInt(resizeAck.mutationSequence),
        cols: 100,
        rows: 30
      });
      lastSequence = throughResize.lastSequence;
      const detachArmedMarker = `detach-armed-${suffix}`;
      const detachedOutputOne = `detached-output-one-${suffix}`;
      const detachedOutputTwo = `detached-output-two-${suffix}`;
      await attachment.sendInput(
        uint64(4n),
        new TextEncoder().encode(
          `printf 'detach-armed-%s\\n' '${suffix}'; (sleep 0.5; printf 'detached-output-%s-%s\\n' one '${suffix}'; sleep 0.05; printf 'detached-output-%s-%s\\n' two '${suffix}') &\n`
        )
      );
      const detachArmed = await collectTerminalUntil(
        attachment,
        detachArmedMarker
      );
      lastSequence = detachArmed.lastSequence;
      await attachment.detach();
      attachment = undefined;
      phase3Diagnostic("resize-detach");

      await firstRuntime.closeBridge();
      firstRuntime = undefined;
      secondRuntime = new LinuxX64RemoteRuntime({
        pool,
        assigned,
        runtimePath: target.remoteRuntimePath,
        transferRoot: join(target.sandboxPath, `phase3-transfers-${suffix}`),
        roots,
        token
      });
      expectAuthority(await secondRuntime.connect(), binding);
      const afterBridgeLoss = await secondRuntime.observe({
        desktopInstallationId,
        targetId: assigned.targetId
      });
      expect(afterBridgeLoss.keepers).toContainEqual(
        expect.objectContaining({
          keeperGeneration,
          processState: "running",
          remoteResourceRevision: "2"
        })
      );
      phase3Diagnostic("bridge-restart");

      const featureDelta = SshConnectionAudit.delta(
        afterMaster,
        await target.audit.snapshot()
      );
      expect(featureDelta.acceptedTcpConnections).toBe(0);
      expect(featureDelta.authenticationAttempts).toBe(0);

      await secondRuntime.close();
      secondRuntime = undefined;
      await target.faults.disconnect();
      routeDisconnected = true;
      await eventually(() => Promise.resolve(!assigned.master.isRunning()));
      const keeperStillAlive = await target.target.exec([
        "sh",
        "-lc",
        `pgrep -f '${target.remoteRuntimePath} keeper serve.*${keeperGeneration}'`
      ]);
      expect(keeperStillAlive.exitCode).toBe(0);
      phase3Diagnostic("ssh-loss");
      await target.faults.reconnect();
      routeDisconnected = false;
      await pool.close();

      reconnectPool = new SshTransportPool();
      const reconnected = await reconnectAssignedMaster(
        reconnectPool,
        `phase3-reconnect-${suffix}`,
        assigned.targetId
      );
      const afterReconnectMaster = await target.audit.snapshot();
      reconnectedRuntime = new LinuxX64RemoteRuntime({
        pool: reconnectPool,
        assigned: reconnected,
        runtimePath: target.remoteRuntimePath,
        transferRoot: join(target.sandboxPath, `phase3-transfers-${suffix}`),
        roots,
        token
      });
      expectAuthority(await reconnectedRuntime.connect(), binding);
      const observed = await reconnectedRuntime.observe({
        desktopInstallationId,
        targetId: assigned.targetId
      });
      expect(observed.keepers).toContainEqual(
        expect.objectContaining({
          keeperGeneration,
          processState: "running"
        })
      );
      phase3Diagnostic("ssh-reconnect");
      reconnectedAttachment = await reconnectedRuntime.attach({
        resourceKey: {
          desktopInstallationId,
          targetId: assigned.targetId,
          workspaceId,
          sessionId
        },
        expectedKeeperGeneration: keeperGeneration,
        access: "write",
        lastReceivedSequence: lastSequence
      });
      await reconnectedAttachment.checkpoint;
      const detachedReplay = await collectTerminalUntil(
        reconnectedAttachment,
        detachedOutputTwo
      );
      const detachedOneIndex = detachedReplay.text.indexOf(detachedOutputOne);
      const detachedTwoIndex = detachedReplay.text.indexOf(detachedOutputTwo);
      expect(detachedOneIndex).toBeGreaterThanOrEqual(0);
      expect(detachedTwoIndex).toBeGreaterThan(detachedOneIndex);
      expect(detachedReplay.text.split(detachedOutputOne)).toHaveLength(2);
      expect(detachedReplay.text.split(detachedOutputTwo)).toHaveLength(2);
      const reconnectMarker = `reconnect-marker-${suffix}`;
      await reconnectedAttachment.sendInput(
        uint64(1n),
        new TextEncoder().encode(
          `printf 'reconnect-marker-%s\\n' '${suffix}'\n`
        )
      );
      const afterReconnect = await collectTerminalUntil(
        reconnectedAttachment,
        reconnectMarker
      );
      expect(afterReconnect.text).toContain(reconnectMarker);
      phase3Diagnostic("reattach-input");
      await reconnectedAttachment.detach();
      reconnectedAttachment = undefined;

      const restartedCoordinator = createIntegrationCoordinator({
        state,
        store,
        binding,
        desktopInstallationId,
        operationIds
      });
      expect(restartedCoordinator.recover()).toHaveLength(2);

      const retainedSessionId = `retained_session_${suffix}`;
      const retainedSurfaceId = `retained_surface_${suffix}`;
      const retainedLaunch = {
        cwd: "/home/kmux",
        shell: "/bin/sh",
        args: ["-c", "stty -echo; exec /bin/sh"]
      };
      const retainedCreate = restartedCoordinator.admit({
        type: "remote-operation.command",
        workspaceId,
        expectedRemoteResourceRevision: uint64(0n),
        payload: {
          kind: "session.create",
          sessionId: retainedSessionId,
          surfaceId: retainedSurfaceId,
          paneId,
          launch: retainedLaunch
        }
      });
      const retainedCreated = await restartedCoordinator.execute(
        retainedCreate.intent.operationId,
        runtimeExecutor(reconnectedRuntime)
      );
      const retainedKeeperGeneration = requireKeeperGeneration(retainedCreated);
      expect(retainedCreated).toMatchObject({
        status: "succeeded",
        remoteResourceRevision: 1n
      });

      // Model restore-disabled startup: product ownership is absent while the
      // authoritative remote descriptor and keeper remain intact.
      const retainedPane = state.panes[paneId];
      expect(retainedPane.activeSurfaceId).toBe(retainedSurfaceId);
      retainedPane.surfaceIds = retainedPane.surfaceIds.filter(
        (candidate) => candidate !== retainedSurfaceId
      );
      retainedPane.activeSurfaceId = surfaceId;
      state.workspaces[workspaceId].activePaneId = paneId;
      delete state.sessions[retainedSessionId];
      delete state.surfaces[retainedSurfaceId];

      const rejectedAdoptSurfaceId = `rejected_adopt_surface_${suffix}`;
      const rejectedAdopt = restartedCoordinator.admit({
        type: "remote-operation.command",
        workspaceId,
        expectedRemoteResourceRevision: uint64(1n),
        payload: {
          kind: "session.adopt",
          sessionId: retainedSessionId,
          surfaceId: rejectedAdoptSurfaceId,
          paneId,
          launch: { ...retainedLaunch, cwd: "/tmp" }
        }
      });
      await expect(
        restartedCoordinator.execute(
          rejectedAdopt.intent.operationId,
          runtimeExecutor(reconnectedRuntime)
        )
      ).resolves.toMatchObject({
        status: "failed",
        code: "adopt-launch-mismatch"
      });
      expect(state.sessions[retainedSessionId]).toBeUndefined();
      expect(state.surfaces[rejectedAdoptSurfaceId]).toBeUndefined();

      const adoptedSurfaceId = `adopted_surface_${suffix}`;
      const adopted = restartedCoordinator.admit({
        type: "remote-operation.command",
        workspaceId,
        expectedRemoteResourceRevision: uint64(1n),
        payload: {
          kind: "session.adopt",
          sessionId: retainedSessionId,
          surfaceId: adoptedSurfaceId,
          paneId,
          launch: retainedLaunch
        }
      });
      const adoptResult = await restartedCoordinator.execute(
        adopted.intent.operationId,
        runtimeExecutor(reconnectedRuntime)
      );
      expect(adoptResult).toMatchObject({
        status: "succeeded",
        remoteResourceRevision: 2n,
        keeperGeneration: retainedKeeperGeneration
      });
      expect(state.sessions[retainedSessionId]).toMatchObject({
        surfaceId: adoptedSurfaceId,
        remoteRuntime: {
          keeperGeneration: retainedKeeperGeneration,
          remoteResourceRevision: 2n
        },
        runtimeStatus: { processState: "running" }
      });
      await expect(
        reconnectedRuntime.executeOperation(adopted.intent, adopted.payload)
      ).resolves.toMatchObject({
        status: "succeeded",
        keeperGeneration: retainedKeeperGeneration,
        resultDigest:
          adoptResult.status === "succeeded"
            ? adoptResult.resultDigest
            : undefined
      });
      reconnectedAttachment = await reconnectedRuntime.attach({
        resourceKey: {
          desktopInstallationId,
          targetId: assigned.targetId,
          workspaceId,
          sessionId: retainedSessionId
        },
        expectedKeeperGeneration: retainedKeeperGeneration,
        access: "write"
      });
      await reconnectedAttachment.checkpoint;
      const adoptMarker = `adopt-marker-${suffix}`;
      await reconnectedAttachment.sendInput(
        uint64(1n),
        new TextEncoder().encode(`printf '${adoptMarker}\\n'\n`)
      );
      expect(
        (await collectTerminalUntil(reconnectedAttachment, adoptMarker)).text
      ).toContain(adoptMarker);
      await reconnectedAttachment.detach();
      reconnectedAttachment = undefined;
      phase3Diagnostic("adopt");

      const restart = restartedCoordinator.admit({
        type: "remote-operation.command",
        workspaceId,
        expectedRemoteResourceRevision: uint64(2n),
        payload: {
          kind: "session.restart",
          sessionId,
          surfaceId,
          launch: {
            cwd: "/home/kmux",
            shell: "/bin/sh",
            args: ["-c", "stty -echo; exec /bin/sh"]
          }
        }
      });
      const restartResult = await restartedCoordinator.execute(
        restart.intent.operationId,
        runtimeExecutor(reconnectedRuntime)
      );
      const restartedKeeperGeneration = requireKeeperGeneration(restartResult);
      expect(restartResult).toMatchObject({
        status: "succeeded",
        remoteResourceRevision: 3n
      });
      expect(restartedKeeperGeneration).not.toBe(keeperGeneration);
      await expect(
        reconnectedRuntime.executeOperation(restart.intent, restart.payload)
      ).resolves.toMatchObject({
        status: "succeeded",
        keeperGeneration: restartedKeeperGeneration,
        resultDigest:
          restartResult.status === "succeeded"
            ? restartResult.resultDigest
            : undefined
      });
      reconnectedAttachment = await reconnectedRuntime.attach({
        resourceKey: {
          desktopInstallationId,
          targetId: assigned.targetId,
          workspaceId,
          sessionId
        },
        expectedKeeperGeneration: restartedKeeperGeneration,
        access: "write"
      });
      await reconnectedAttachment.checkpoint;
      const restartMarker = `restart-marker-${suffix}`;
      await reconnectedAttachment.sendInput(
        uint64(1n),
        new TextEncoder().encode(`printf '${restartMarker}\\n'\n`)
      );
      expect(
        (await collectTerminalUntil(reconnectedAttachment, restartMarker)).text
      ).toContain(restartMarker);
      await reconnectedAttachment.detach();
      reconnectedAttachment = undefined;
      phase3Diagnostic("restart");

      const splitSessionId = `split_session_${suffix}`;
      const splitSurfaceId = `split_surface_${suffix}`;
      const split = restartedCoordinator.admit({
        type: "remote-operation.command",
        workspaceId,
        expectedRemoteResourceRevision: uint64(0n),
        payload: {
          kind: "session.create",
          sessionId: splitSessionId,
          surfaceId: splitSurfaceId,
          paneId,
          direction: "right",
          launch: {
            cwd: "/home/kmux",
            shell: "/bin/sh",
            args: ["-c", "stty -echo; exec /bin/sh"]
          }
        }
      });
      const splitResult = await restartedCoordinator.execute(
        split.intent.operationId,
        runtimeExecutor(reconnectedRuntime)
      );
      const splitKeeperGeneration = requireKeeperGeneration(splitResult);
      expect(splitResult).toMatchObject({
        status: "succeeded",
        remoteResourceRevision: 1n
      });
      expect(state.sessions[splitSessionId]).toMatchObject({
        surfaceId: splitSurfaceId,
        remoteRuntime: {
          keeperGeneration: splitKeeperGeneration,
          remoteResourceRevision: 1n
        },
        runtimeStatus: { processState: "running" }
      });
      const splitPane = state.panes[state.surfaces[splitSurfaceId].paneId];
      expect(splitPane.id).not.toBe(paneId);
      expect(state.workspaces[workspaceId].activePaneId).toBe(splitPane.id);
      phase3Diagnostic("split-create");

      const terminateSplit = restartedCoordinator.admit({
        type: "remote-operation.command",
        workspaceId,
        expectedRemoteResourceRevision: uint64(1n),
        payload: { kind: "session.terminate", sessionId: splitSessionId }
      });
      await expect(
        restartedCoordinator.execute(
          terminateSplit.intent.operationId,
          runtimeExecutor(reconnectedRuntime)
        )
      ).resolves.toMatchObject({
        status: "succeeded",
        remoteResourceRevision: 2n
      });

      const terminateRetained = restartedCoordinator.admit({
        type: "remote-operation.command",
        workspaceId,
        expectedRemoteResourceRevision: uint64(2n),
        payload: {
          kind: "session.terminate",
          sessionId: retainedSessionId
        }
      });
      await expect(
        restartedCoordinator.execute(
          terminateRetained.intent.operationId,
          runtimeExecutor(reconnectedRuntime)
        )
      ).resolves.toMatchObject({
        status: "succeeded",
        remoteResourceRevision: 3n
      });

      const terminate = restartedCoordinator.admit({
        type: "remote-operation.command",
        workspaceId,
        expectedRemoteResourceRevision: uint64(3n),
        payload: { kind: "session.terminate", sessionId }
      });
      const terminated = await restartedCoordinator.execute(
        terminate.intent.operationId,
        runtimeExecutor(reconnectedRuntime)
      );
      expect(terminated).toMatchObject({
        status: "succeeded",
        remoteResourceRevision: 4n
      });
      const terminateRetry = await reconnectedRuntime.executeOperation(
        terminate.intent,
        terminate.payload
      );
      expect(terminateRetry).toMatchObject({
        status: "succeeded",
        remoteResourceRevision: 4n,
        resultDigest:
          terminated.status === "succeeded"
            ? terminated.resultDigest
            : undefined
      });
      expect(terminateRetry).not.toHaveProperty("keeperGeneration");
      const finalObservation = await reconnectedRuntime.observe({
        desktopInstallationId,
        targetId: assigned.targetId
      });
      expect(finalObservation.keepers).toContainEqual(
        expect.objectContaining({
          keeperGeneration: restartedKeeperGeneration,
          processState: "exited",
          remoteResourceRevision: "4",
          checkpointAvailable: false,
          retainedRangeTruncated: true
        })
      );
      expect(finalObservation.keepers).toContainEqual(
        expect.objectContaining({
          keeperGeneration: splitKeeperGeneration,
          processState: "exited",
          remoteResourceRevision: "2",
          checkpointAvailable: false,
          retainedRangeTruncated: true
        })
      );
      expect(finalObservation.keepers).toContainEqual(
        expect.objectContaining({
          keeperGeneration: retainedKeeperGeneration,
          processState: "exited",
          remoteResourceRevision: "3",
          checkpointAvailable: false,
          retainedRangeTruncated: true
        })
      );
      const retainedFiles = await target.target.exec([
        "sh",
        "-lc",
        `find ${quotePosixWord(`${roots.stateRoot}/journals`)} ${quotePosixWord(`${roots.stateRoot}/checkpoints`)} -type f -print`
      ]);
      expect(retainedFiles.exitCode).toBe(0);
      expect(retainedFiles.stdout.trim()).toBe("");
      phase3Diagnostic("terminate");
      const reconnectFeatureDelta = SshConnectionAudit.delta(
        afterReconnectMaster,
        await target.audit.snapshot()
      );
      expect(reconnectFeatureDelta.acceptedTcpConnections).toBe(0);
      expect(reconnectFeatureDelta.authenticationAttempts).toBe(0);
    } finally {
      await attachment?.detach().catch(() => undefined);
      await reconnectedAttachment?.detach().catch(() => undefined);
      await firstRuntime?.close().catch(() => undefined);
      await secondRuntime?.close().catch(() => undefined);
      await reconnectedRuntime?.close().catch(() => undefined);
      if (routeDisconnected)
        await target.faults.reconnect().catch(() => undefined);
      await pool.close().catch(() => undefined);
      await reconnectPool?.close().catch(() => undefined);
    }
  });

  it("binds ordinary authority to the authenticated UID and canonical account", async () => {
    const primaryPool = new SshTransportPool();
    const alternatePool = new SshTransportPool();
    try {
      const primary = await connectAssignedMasterFor(
        target,
        primaryPool,
        "authority-primary"
      );
      const primaryPaths = doctorPaths("/home/kmux/.kmux-doctor-primary");
      const first = await runDoctor(
        target,
        primaryPool,
        primary,
        target.sshConfigPath,
        primaryPaths
      );
      const second = await runDoctor(
        target,
        primaryPool,
        primary,
        target.sshConfigPath,
        primaryPaths
      );
      expect(second).toMatchObject({
        remoteInstallationId: first.remoteInstallationId,
        executionNodeId: first.executionNodeId,
        authenticatedPrincipal: { uid: 1000, accountName: "kmux" },
        platform: "linux",
        arch: "x86_64",
        abi: "musl"
      });

      const alternateConfig = await target.configForUser("kmux-alt");
      const alternate = await connectAssignedMasterFor(
        target,
        alternatePool,
        "authority-alternate",
        alternateConfig
      );
      const alternateReport = await runDoctor(
        target,
        alternatePool,
        alternate,
        alternateConfig,
        doctorPaths("/home/kmux-alt/.kmux-doctor-alternate")
      );
      expect(alternateReport.authenticatedPrincipal).toEqual({
        uid: 1001,
        accountName: "kmux-alt"
      });
    } finally {
      await primaryPool.close();
      await alternatePool.close();
    }
  });

  it("launches the authenticated account shell unless the session explicitly overrides it", async () => {
    const suffix = randomBytes(6).toString("hex");
    const configPath = await target.configForUser("kmux-alt");
    const pool = new SshTransportPool();
    let runtime: LinuxX64RemoteRuntime | undefined;
    let attachment: RemoteTerminalAttachment | undefined;
    let overrideAttachment: RemoteTerminalAttachment | undefined;
    const desktopInstallationId = `desktop_shell_${suffix}`;
    const workspaceId = `workspace_shell_${suffix}`;
    const sessionId = `session_shell_${suffix}`;
    const resourceKey = {
      desktopInstallationId,
      targetId: `pending_shell_target_${suffix}`,
      workspaceId,
      sessionId
    } as RemoteResourceKey & { sessionId: string };
    try {
      const assigned = await connectAssignedMasterFor(
        target,
        pool,
        `phase8-shell-${suffix}`,
        configPath
      );
      resourceKey.targetId = assigned.targetId;
      const roots = doctorPaths(`/home/kmux-alt/.kmux-shell-${suffix}`);
      runtime = new LinuxX64RemoteRuntime({
        pool,
        assigned,
        runtimePath: target.remoteRuntimePath,
        roots,
        token: createRemoteRuntimeToken(),
        transferRoot: join(target.sandboxPath, `shell-transfers-${suffix}`)
      });
      const hello = await runtime.connect();
      expect(hello.authority.authenticatedPrincipal).toEqual({
        uid: 1001,
        accountName: "kmux-alt"
      });
      const createPayload: RemoteOperationPayloadDto = {
        kind: "session.create",
        sessionId,
        surfaceId: `surface_shell_${suffix}`,
        paneId: `pane_shell_${suffix}`,
        launch: { cwd: "/home/kmux-alt" }
      };
      const create = await runtime.executeOperation(
        runtimeOperationIntent(
          `create_shell_${suffix}`,
          resourceKey,
          createPayload,
          0n
        ),
        createPayload
      );
      const keeperGeneration = requireKeeperGeneration(create);
      attachment = await runtime.attach({
        resourceKey,
        expectedKeeperGeneration: keeperGeneration,
        access: "write"
      });
      const marker = `account-shell-${suffix}`;
      await attachment.sendInput(
        uint64(1n),
        new TextEncoder().encode(
          `printf '${marker}:%s:%s\\n' "$SHELL" "$ZSH_VERSION"\n`
        )
      );
      const accountShellOutput = new RegExp(`${marker}:/bin/zsh:[0-9]`, "u");
      const observed = await collectTerminalUntil(
        attachment,
        accountShellOutput
      );
      expect(observed.text).toMatch(accountShellOutput);
      await attachment.detach();
      attachment = undefined;

      const overrideSessionId = `session_shell_override_${suffix}`;
      const overrideResourceKey = {
        ...resourceKey,
        sessionId: overrideSessionId
      };
      const overrideCreatePayload: RemoteOperationPayloadDto = {
        kind: "session.create",
        sessionId: overrideSessionId,
        surfaceId: `surface_shell_override_${suffix}`,
        paneId: `pane_shell_override_${suffix}`,
        launch: { cwd: "/home/kmux-alt", shell: "/usr/bin/fish" }
      };
      const overrideCreate = await runtime.executeOperation(
        runtimeOperationIntent(
          `create_shell_override_${suffix}`,
          overrideResourceKey,
          overrideCreatePayload,
          0n
        ),
        overrideCreatePayload
      );
      overrideAttachment = await runtime.attach({
        resourceKey: overrideResourceKey,
        expectedKeeperGeneration: requireKeeperGeneration(overrideCreate),
        access: "write"
      });
      const overrideMarker = `override-shell-${suffix}`;
      await overrideAttachment.sendInput(
        uint64(1n),
        new TextEncoder().encode(
          `printf '${overrideMarker}:%s\\n' $FISH_VERSION\n`
        )
      );
      const overrideShellOutput = new RegExp(`${overrideMarker}:[0-9]`, "u");
      const overrideObserved = await collectTerminalUntil(
        overrideAttachment,
        overrideShellOutput
      );
      expect(overrideObserved.text).toMatch(overrideShellOutput);
      await overrideAttachment.detach();
      overrideAttachment = undefined;
      const overrideTerminatePayload: RemoteOperationPayloadDto = {
        kind: "session.terminate",
        sessionId: overrideSessionId
      };
      await expect(
        runtime.executeOperation(
          runtimeOperationIntent(
            `terminate_shell_override_${suffix}`,
            overrideResourceKey,
            overrideTerminatePayload,
            1n
          ),
          overrideTerminatePayload
        )
      ).resolves.toMatchObject({ status: "succeeded" });

      const terminatePayload: RemoteOperationPayloadDto = {
        kind: "session.terminate",
        sessionId
      };
      await expect(
        runtime.executeOperation(
          runtimeOperationIntent(
            `terminate_shell_${suffix}`,
            resourceKey,
            terminatePayload,
            1n
          ),
          terminatePayload
        )
      ).resolves.toMatchObject({ status: "succeeded" });
    } finally {
      await attachment?.detach().catch(() => undefined);
      await overrideAttachment?.detach().catch(() => undefined);
      await runtime?.close().catch(() => undefined);
      await pool.close();
    }
  });

  it("blocks an unknown bootstrap shell before mutation and accepts its explicit override", async () => {
    const suffix = randomBytes(6).toString("hex");
    const customShell = `/usr/local/bin/kmux-unknown-shell-${suffix}`;
    const root = `/home/kmux-alt/.kmux-unknown-bootstrap-${suffix}`;
    const roots = doctorPaths(root);
    const configured = await target.target.exec([
      "sh",
      "-c",
      `printf '%s\n' '#!/bin/sh' 'exec /bin/sh "$@"' > ${customShell} && chmod 0755 ${customShell} && usermod -s ${customShell} kmux-alt`
    ]);
    expect(configured.exitCode).toBe(0);
    const configPath = await target.configForUser("kmux-alt");
    const pool = new SshTransportPool();
    let runtime: LinuxX64RemoteRuntime | undefined;
    try {
      const assigned = await connectAssignedMasterFor(
        target,
        pool,
        `unknown-bootstrap-${suffix}`,
        configPath
      );
      const bootstrapOptions = {
        pool,
        assigned,
        artifactRoot: remoteRuntimeArtifactRoot,
        transferRoot: join(
          target.sandboxPath,
          `unknown-bootstrap-transfers-${suffix}`
        ),
        sftpPath: target.sftpPath,
        roots
      };
      await expect(
        prepareRemoteRuntime(bootstrapOptions)
      ).rejects.toMatchObject({ code: "unknown-bootstrap-shell" });
      const untouched = await target.target.exec(["test", "!", "-e", root]);
      expect(untouched.exitCode).toBe(0);
      const prepared = await prepareRemoteRuntime({
        ...bootstrapOptions,
        bootstrapShellOverride: "/bin/sh"
      });
      expect(prepared.shellPolicy).toEqual({
        accountShellPath: customShell,
        accountShellKind: "explicit",
        bootstrapShellPath: "/bin/sh"
      });
      runtime = new LinuxX64RemoteRuntime({
        pool,
        assigned,
        runtimePath: prepared.runtimePath,
        roots,
        token: createRemoteRuntimeToken(),
        transferRoot: bootstrapOptions.transferRoot,
        sftpPath: target.sftpPath,
        bootstrapShellPolicy: prepared.shellPolicy
      });
      await expect(runtime.connect()).resolves.toMatchObject({
        type: "hello",
        authority: {
          authenticatedPrincipal: { uid: 1001, accountName: "kmux-alt" }
        }
      });
    } finally {
      await runtime?.close().catch(() => undefined);
      await pool.close();
      const restored = await target.target.exec([
        "sh",
        "-c",
        `usermod -s /bin/zsh kmux-alt && rm -f ${customShell} && rm -rf ${root}`
      ]);
      expect(restored.exitCode).toBe(0);
    }
  });

  it("runs the immutable binary load generator through a real keeper PTY", async () => {
    const suffix = randomBytes(6).toString("hex");
    const pool = new SshTransportPool();
    let runtime: LinuxX64RemoteRuntime | undefined;
    let attachment: RemoteTerminalAttachment | undefined;
    const sessionId = `session_profile_smoke_${suffix}`;
    const resourceKey = {
      desktopInstallationId: `desktop_profile_smoke_${suffix}`,
      targetId: `pending_profile_smoke_${suffix}`,
      workspaceId: `workspace_profile_smoke_${suffix}`,
      sessionId
    } as RemoteResourceKey & { sessionId: string };
    try {
      const assigned = await connectAssignedMasterFor(
        target,
        pool,
        `profile-smoke-${suffix}`
      );
      resourceKey.targetId = assigned.targetId;
      runtime = new LinuxX64RemoteRuntime({
        pool,
        assigned,
        runtimePath: target.remoteRuntimePath,
        roots: doctorPaths(`/home/kmux/.kmux-profile-smoke-${suffix}`),
        token: createRemoteRuntimeToken(),
        transferRoot: join(target.sandboxPath, `profile-smoke-${suffix}`)
      });
      await runtime.connect();
      const createPayload: RemoteOperationPayloadDto = {
        kind: "session.create",
        sessionId,
        surfaceId: `surface_profile_smoke_${suffix}`,
        paneId: `pane_profile_smoke_${suffix}`,
        launch: {
          cwd: "/opt/kmux-fixtures/repository",
          shell: target.remoteRuntimePath,
          args: [
            "profile",
            "terminal-load",
            "--bytes-per-second",
            "65536",
            "--steady-chunk-bytes",
            "4096",
            "--burst-bytes",
            "4194304",
            "--burst-chunk-bytes",
            "65536",
            "--burst-chunk-interval-ms",
            "20",
            "--burst-echo-pause-ms",
            "100",
            "--seed",
            "0x4b4d555852454d31"
          ]
        }
      };
      const created = await runtime.executeOperation(
        runtimeOperationIntent(
          `create_profile_smoke_${suffix}`,
          resourceKey,
          createPayload,
          0n
        ),
        createPayload
      );
      const keeperGeneration = requireKeeperGeneration(created);
      attachment = await runtime.attach({
        resourceKey,
        expectedKeeperGeneration: keeperGeneration,
        access: "write"
      });
      await attachment.ready;
      await attachment.checkpoint;
      const marker = `profile-echo-${suffix}`;
      const observed = collectTerminalUntil(attachment, marker);
      await attachment.sendInput(
        uint64(1n),
        new TextEncoder().encode(`${marker}\n`)
      );
      expect((await observed).text).toContain(marker);

      const burstToken = `profile_burst_${suffix}`;
      const burstEcho = `profile-burst-echo-${suffix}`;
      const burstEnd = `KMUX_PROFILE_BURST_END:${burstToken}`;
      const burstObserved = collectTerminalUntil(attachment, burstEnd);
      await attachment.sendInput(
        uint64(2n),
        new TextEncoder().encode(`KMUX_PROFILE_BURST:${burstToken}\n`)
      );
      await attachment.sendInput(
        uint64(3n),
        new TextEncoder().encode(`${burstEcho}\n`)
      );
      const burstResult = await burstObserved;
      expect(burstResult.text).toContain(burstEcho);
      expect(burstResult.text).toContain(burstEnd);
      expect(attachment.isOpen()).toBe(true);

      const statusToken = `profile_status_${suffix}`;
      const statusObserved = collectTerminalUntil(
        attachment,
        `KMUX_PROFILE_STATUS_END:${statusToken}`
      );
      await attachment.sendInput(
        uint64(4n),
        new TextEncoder().encode(`KMUX_PROFILE_STATUS:${statusToken}\n`)
      );
      expect((await statusObserved).text).toMatch(
        new RegExp(`KMUX_PROFILE_STATUS:${statusToken}:[0-9]+:4194304`, "u")
      );

      const terminatePayload: RemoteOperationPayloadDto = {
        kind: "session.terminate",
        sessionId
      };
      await expect(
        runtime.executeOperation(
          runtimeOperationIntent(
            `terminate_profile_smoke_${suffix}`,
            resourceKey,
            terminatePayload,
            1n
          ),
          terminatePayload
        )
      ).resolves.toMatchObject({ status: "succeeded" });
    } finally {
      await attachment?.detach().catch(() => undefined);
      await runtime?.close().catch(() => undefined);
      await pool.close();
    }
  });

  it("rejects copied shared-home authority across two execution nodes", async () => {
    const sharedHomePath = await mkdtemp(join(tmpdir(), "kmux-shared-home-"));
    let firstTarget: StartedSshTarget | undefined;
    let secondTarget: StartedSshTarget | undefined;
    const firstPool = new SshTransportPool();
    const secondPool = new SshTransportPool();
    try {
      firstTarget = await startSshTarget({
        machineId: "11111111111111111111111111111111",
        sharedHomePath
      });
      const firstMaster = await connectAssignedMasterFor(
        firstTarget,
        firstPool,
        "shared-node-one"
      );
      const sharedPaths = doctorPaths("/home/kmux/.kmux-shared-authority");
      let firstSharedReport: AuthorityReport | undefined;
      try {
        firstSharedReport = await runDoctor(
          firstTarget,
          firstPool,
          firstMaster,
          firstTarget.sshConfigPath,
          sharedPaths
        );
      } catch (error) {
        expect(openSshStderr(error)).toMatch(
          /not on verified host-local storage/iu
        );
      }
      const firstLocal = await runDoctor(
        firstTarget,
        firstPool,
        firstMaster,
        firstTarget.sshConfigPath,
        doctorPaths("/var/lib/kmux-local/kmux/doctor")
      );

      secondTarget = await startSshTarget({
        machineId: "22222222222222222222222222222222",
        sharedHomePath
      });
      const secondMaster = await connectAssignedMasterFor(
        secondTarget,
        secondPool,
        "shared-node-two"
      );
      if (firstSharedReport) {
        await expect(
          runDoctor(
            secondTarget,
            secondPool,
            secondMaster,
            secondTarget.sshConfigPath,
            sharedPaths
          )
        ).rejects.toMatchObject({
          stderr: expect.stringMatching(/authority binding changed/iu)
        });
      }
      const secondLocal = await runDoctor(
        secondTarget,
        secondPool,
        secondMaster,
        secondTarget.sshConfigPath,
        doctorPaths("/var/lib/kmux-local/kmux/doctor")
      );
      expect(secondLocal.executionNodeId).not.toBe(firstLocal.executionNodeId);
    } finally {
      await firstPool.close();
      await secondPool.close();
      const ownershipTarget = secondTarget ?? firstTarget;
      if (ownershipTarget) {
        await restoreSharedHomeOwnership(ownershipTarget);
      }
      await secondTarget?.stop();
      await firstTarget?.stop();
      await rm(sharedHomePath, { recursive: true, force: true });
    }
  });
});

async function restoreSharedHomeOwnership(
  selectedTarget: StartedSshTarget
): Promise<void> {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    throw new Error("shared-home integration cleanup requires POSIX ownership");
  }
  const result = await selectedTarget.target.exec([
    "chown",
    "-R",
    `${uid}:${gid}`,
    "/home/kmux"
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `could not restore shared-home ownership: ${result.stderr.trim()}`
    );
  }
}

async function connectAssignedMaster(
  pool: SshTransportPool,
  suffix: string
): Promise<AssignedSshMaster> {
  return await connectAssignedMasterFor(target, pool, suffix);
}

async function reconnectAssignedMaster(
  pool: SshTransportPool,
  suffix: string,
  targetId: string
): Promise<AssignedSshMaster> {
  const effective = await resolveEffectiveSshConfig({
    sshPath: target.sshPath,
    configPath: target.sshConfigPath,
    host: target.hostAlias
  });
  const connectionAttemptId = `attempt-${suffix}`;
  await pool.connectProvisional({
    connectionAttemptId,
    effectiveConnectionPolicyHash: effective.policyHash,
    sshPath: target.sshPath,
    configPath: target.sshConfigPath,
    host: target.hostAlias,
    controlRoot: target.controlDirectoryPath
  });
  return await pool.promote({
    connectionAttemptId,
    targetId,
    effectiveConnectionPolicyHash: effective.policyHash
  });
}

function phase3Diagnostic(step: string): void {
  process.stdout.write(`[phase3-real-ssh] ${step}\n`);
}

type RuntimeHello = Awaited<ReturnType<LinuxX64RemoteRuntime["connect"]>>;

function bindingFromHello(
  assigned: AssignedSshMaster,
  hello: RuntimeHello
): RemoteTargetBinding {
  const verifiedAt = new Date().toISOString();
  return {
    id: assigned.targetId,
    authority: structuredClone(hello.authority),
    locator: {
      profileId: "profile_phase3",
      effectiveConnectionPolicyHash: assigned.effectiveConnectionPolicyHash,
      lastVerifiedAt: verifiedAt
    },
    observation: {
      platform: hello.platform,
      arch: hello.arch,
      abi: hello.abi,
      runtimeVersion: hello.runtimeVersion,
      capabilities: [...hello.capabilities],
      persistenceLevel: hello.persistenceLevel
    },
    firstVerifiedAt: verifiedAt
  };
}

function expectAuthority(
  hello: RuntimeHello,
  binding: RemoteTargetBinding
): void {
  expect(hello.authority).toEqual(binding.authority);
  expect(hello).toMatchObject({
    platform: binding.observation?.platform,
    arch: binding.observation?.arch,
    abi: binding.observation?.abi
  });
}

function remoteCoordinatorState(
  targetId: string,
  workspaceId: string,
  cwd: string
): AppState {
  const state = createInitialState();
  const window = state.windows[state.activeWindowId];
  const oldWorkspaceId = window.activeWorkspaceId;
  const workspace = state.workspaces[oldWorkspaceId];
  delete state.workspaces[oldWorkspaceId];
  workspace.id = workspaceId;
  workspace.location = workspaceLocation({ kind: "ssh", targetId }, cwd);
  state.workspaces[workspaceId] = workspace;
  window.activeWorkspaceId = workspaceId;
  window.workspaceOrder = window.workspaceOrder.map((id) =>
    id === oldWorkspaceId ? workspaceId : id
  );
  for (const pane of Object.values(state.panes)) {
    if (pane.workspaceId !== oldWorkspaceId) continue;
    pane.workspaceId = workspaceId;
    for (const surfaceId of pane.surfaceIds) {
      const surface = state.surfaces[surfaceId];
      const session = state.sessions[surface.sessionId];
      surface.cwd = locatedPathForTarget({ kind: "ssh", targetId }, cwd);
      session.launch = {
        ...session.launch,
        cwd: locatedPathForTarget({ kind: "ssh", targetId }, cwd)
      };
    }
  }
  return state;
}

function createIntegrationCoordinator(options: {
  state: AppState;
  store: DurableRemoteOperationStore;
  binding: RemoteTargetBinding;
  desktopInstallationId: string;
  operationIds: string[];
}) {
  return createRemoteOperationCoordinator({
    desktopInstallationId: options.desktopInstallationId,
    store: options.store,
    getState: () => options.state,
    getTargetBinding: (targetId) =>
      targetId === options.binding.id ? options.binding : undefined,
    dispatchFact: (fact) => {
      applyMainRemoteOperationFact(options.state, fact);
    },
    makeOperationId: () => {
      const operationId = options.operationIds.shift();
      if (!operationId)
        throw new Error("phase 3 operation ID fixture exhausted");
      return operationId;
    }
  });
}

function runtimeExecutor(
  runtime: LinuxX64RemoteRuntime
): (
  operation: DurableRemoteOperationRecord
) => Promise<RemoteOperationExecutionOutcome> {
  return async (operation) =>
    mapRuntimeOutcome(
      await runtime.executeOperation(operation.intent, operation.payload)
    );
}

function runtimeOperationIntent(
  operationId: string,
  resourceKey: RemoteResourceKey & { sessionId: string },
  payload: RemoteOperationPayloadDto,
  expectedRevision: bigint
) {
  return {
    operationId,
    kind: payload.kind,
    resourceKey,
    expectedWorkspaceRevision: "a".repeat(64),
    expectedRemoteResourceRevision: uint64(expectedRevision),
    nextRemoteResourceRevision: uint64(expectedRevision + 1n),
    ...(payload.kind === "session.create"
      ? { createOperationId: operationId }
      : {}),
    canonicalPayloadHash: createHash("sha256")
      .update(canonicalizeRemoteOperationPayload(payload))
      .digest("hex"),
    createdAt: new Date().toISOString()
  };
}

function mapRuntimeOutcome(
  outcome: RemoteRuntimeOperationOutcome
): RemoteOperationExecutionOutcome {
  return outcome.status === "succeeded"
    ? {
        status: "succeeded",
        remoteResourceRevision: outcome.remoteResourceRevision,
        resultDigest: outcome.resultDigest,
        ...(outcome.keeperGeneration === undefined
          ? {}
          : { keeperGeneration: outcome.keeperGeneration })
      }
    : {
        status: "failed",
        resultDigest: outcome.resultDigest,
        code: outcome.code,
        message: outcome.message
      };
}

function requireKeeperGeneration(outcome: {
  status: string;
  keeperGeneration?: string;
}): string {
  if (outcome.status !== "succeeded" || !outcome.keeperGeneration) {
    throw new Error("session create did not return a keeper generation");
  }
  return outcome.keeperGeneration;
}

function pauseBridgeAcknowledgements(runtime: LinuxX64RemoteRuntime): void {
  const child = (
    runtime as unknown as {
      bridge?: { child?: ChildProcess };
    }
  ).bridge?.child;
  if (!child?.stdout) {
    throw new Error(
      "real SSH bridge stdout is unavailable for fault injection"
    );
  }
  // Keep the real OpenSSH channel alive long enough for the keeper to durably
  // write launch input, but withhold its acknowledgement from the caller.
  child.stdout.pause();
}

async function remoteLaunchInputIsWritten(
  stateRoot: string,
  operationId: string
): Promise<boolean> {
  if (
    !/^\/[A-Za-z0-9/._-]+$/u.test(stateRoot) ||
    !/^[A-Za-z0-9._-]+$/u.test(operationId)
  ) {
    throw new Error("remote state root is not safe for the fixture shell");
  }
  const result = await target.target.exec([
    "sh",
    "-lc",
    `for file in ${stateRoot}/sessions/*.json; do [ -f "$file" ] || continue; cat "$file"; printf '\\036'; done 2>/dev/null`
  ]);
  if (result.exitCode !== 0) return false;
  return result.stdout.split("\u001e").some((encoded) => {
    if (!encoded) return false;
    try {
      const descriptor = JSON.parse(encoded) as {
        launchInput?: { operationId?: unknown; outcome?: unknown };
      };
      return (
        descriptor.launchInput?.operationId === operationId &&
        descriptor.launchInput.outcome === "written"
      );
    } catch {
      return false;
    }
  });
}

async function collectTerminalUntil(
  attachment: RemoteTerminalAttachment,
  marker: string | RegExp
): Promise<{ text: string; lastSequence: ReturnType<typeof uint64> }> {
  const deadline = Date.now() + 10_000;
  let text = "";
  let lastSequence = uint64(0n);
  const description = String(marker);
  while (!terminalTextMatches(text, marker)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`terminal output did not contain ${description}`);
    }
    const mutation = await nextTerminalMutationBefore(
      attachment,
      deadline,
      `terminal output timed out waiting for ${description}`
    );
    lastSequence = mutation.sequence;
    if (mutation.kind === "output" && mutation.data) {
      text += Buffer.from(mutation.data).toString("utf8");
    }
  }
  return { text, lastSequence };
}

function terminalTextMatches(text: string, marker: string | RegExp): boolean {
  if (typeof marker === "string") return text.includes(marker);
  marker.lastIndex = 0;
  return marker.test(text);
}

async function collectContiguousTerminalUntil(
  attachment: RemoteTerminalAttachment,
  previousSequence: ReturnType<typeof uint64>,
  marker: string,
  timeoutMs: number
): Promise<{
  outputBytes: number;
  lastSequence: ReturnType<typeof uint64>;
  markerFound: boolean;
  closed: boolean;
}> {
  const deadline = Date.now() + timeoutMs;
  let expected = BigInt(previousSequence) + 1n;
  let lastSequence = previousSequence;
  let outputBytes = 0;
  let tail = "";
  while (!tail.includes(marker)) {
    const mutation = await nextTerminalMutationOrClosedBefore(
      attachment,
      deadline,
      `terminal output timed out waiting for ${marker}`
    );
    if (!mutation) {
      return {
        outputBytes,
        lastSequence,
        markerFound: false,
        closed: true
      };
    }
    expect(BigInt(mutation.sequence)).toBe(expected);
    expected += 1n;
    lastSequence = mutation.sequence;
    if (mutation.kind === "output" && mutation.data) {
      const text = Buffer.from(mutation.data).toString("utf8");
      outputBytes += mutation.data.byteLength;
      tail = `${tail}${text}`.slice(-Math.max(512, marker.length * 2));
    }
  }
  return { outputBytes, lastSequence, markerFound: true, closed: false };
}

async function collectTerminalAcrossReattachments(options: {
  runtime: LinuxX64RemoteRuntime;
  attachment: RemoteTerminalAttachment;
  resourceKey: RemoteResourceKey & { sessionId: string };
  keeperGeneration: string;
  marker: string;
  initial: {
    outputBytes: number;
    lastSequence: ReturnType<typeof uint64>;
    markerFound: boolean;
    closed: boolean;
  };
  timeoutMs: number;
}): Promise<{
  attachment: RemoteTerminalAttachment;
  outputBytes: number;
  lastSequence: ReturnType<typeof uint64>;
  markerFound: true;
  lastCheckpointSequence?: bigint;
}> {
  const deadline = Date.now() + options.timeoutMs;
  let attachment = options.attachment;
  let collected = options.initial;
  let lastCheckpointSequence: bigint | undefined;
  let reattachments = 0;

  while (!collected.markerFound) {
    if (!collected.closed) {
      throw new Error(
        "terminal completion collector stopped on an open attachment"
      );
    }
    reattachments += 1;
    if (reattachments > 8 || Date.now() >= deadline) {
      throw new Error(
        `terminal completion was not recovered after ${reattachments - 1} reattachments`
      );
    }

    attachment = await options.runtime.attach({
      resourceKey: options.resourceKey,
      expectedKeeperGeneration: options.keeperGeneration,
      access: "write",
      lastReceivedSequence: collected.lastSequence
    });
    const [ready, checkpoint] = await Promise.all([
      attachment.ready,
      attachment.checkpoint
    ]);
    let resumeSequence = collected.lastSequence;
    if (checkpoint) {
      const checkpointSequence = BigInt(
        checkpoint.metadata.lastMutationSequence
      );
      expect(checkpointSequence).toBeGreaterThanOrEqual(
        BigInt(collected.lastSequence)
      );
      expect(ready.truncatedBeforeSequence).toBeDefined();
      resumeSequence = uint64(checkpointSequence);
      lastCheckpointSequence = checkpointSequence;
      if (
        Buffer.concat(
          checkpoint.chunks.map((chunk) => Buffer.from(chunk))
        ).includes(Buffer.from(options.marker))
      ) {
        return {
          attachment,
          outputBytes: collected.outputBytes,
          lastSequence: resumeSequence,
          markerFound: true,
          lastCheckpointSequence
        };
      }
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        "terminal completion timed out after checkpoint recovery"
      );
    }
    const resumed = await collectContiguousTerminalUntil(
      attachment,
      resumeSequence,
      options.marker,
      remaining
    );
    collected = {
      ...resumed,
      outputBytes: collected.outputBytes + resumed.outputBytes
    };
  }

  return {
    attachment,
    outputBytes: collected.outputBytes,
    lastSequence: collected.lastSequence,
    markerFound: true,
    ...(lastCheckpointSequence === undefined ? {} : { lastCheckpointSequence })
  };
}

async function collectMutationsThroughSequence(
  attachment: RemoteTerminalAttachment,
  previousSequence: ReturnType<typeof uint64>,
  targetSequence: ReturnType<typeof uint64>
): Promise<{
  targetMutation: RemoteTerminalMutation;
  lastSequence: ReturnType<typeof uint64>;
}> {
  if (targetSequence <= previousSequence) {
    throw new Error("target mutation sequence must advance");
  }
  const deadline = Date.now() + 10_000;
  let expectedSequence = previousSequence + 1n;
  let targetMutation: RemoteTerminalMutation | undefined;
  while (expectedSequence <= targetSequence) {
    const mutation = await nextTerminalMutationBefore(
      attachment,
      deadline,
      `terminal mutation timed out before sequence ${targetSequence}`
    );
    if (mutation.sequence !== expectedSequence) {
      throw new Error(
        `terminal mutation sequence changed from ${previousSequence} to ${mutation.sequence}; expected ${expectedSequence}`
      );
    }
    targetMutation = mutation;
    expectedSequence += 1n;
  }
  if (!targetMutation) {
    throw new Error("target mutation sequence was not observed");
  }
  return {
    targetMutation,
    lastSequence: targetSequence
  };
}

async function nextTerminalMutationBefore(
  attachment: RemoteTerminalAttachment,
  deadline: number,
  timeoutMessage: string
): Promise<RemoteTerminalMutation> {
  const mutation = await nextTerminalMutationOrClosedBefore(
    attachment,
    deadline,
    timeoutMessage
  );
  if (!mutation) throw new Error("terminal attachment closed before mutation");
  return mutation;
}

async function nextTerminalMutationOrClosedBefore(
  attachment: RemoteTerminalAttachment,
  deadline: number,
  timeoutMessage: string
): Promise<RemoteTerminalMutation | undefined> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(timeoutMessage);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const mutation = await Promise.race([
      attachment.nextMutation(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(timeoutMessage)),
          remaining
        );
      })
    ]);
    return mutation ?? undefined;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

interface RemoteSessionProcessDescriptor {
  keeperGeneration: string;
  keeperPid: number;
  childPid: number;
}

async function readRemoteSessionProcessDescriptor(
  selectedTarget: StartedSshTarget,
  stateRoot: string,
  keeperGeneration: string
): Promise<RemoteSessionProcessDescriptor> {
  const sessionsRoot = `${stateRoot}/sessions`;
  const result = await selectedTarget.target.exec([
    "sh",
    "-lc",
    `for file in ${quotePosixWord(sessionsRoot)}/*.json; do test -f "$file" || continue; if grep -F -q ${quotePosixWord(keeperGeneration)} "$file"; then cat "$file"; exit 0; fi; done; exit 1`
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`remote descriptor was not found for ${keeperGeneration}`);
  }
  const descriptor = JSON.parse(
    result.stdout
  ) as Partial<RemoteSessionProcessDescriptor>;
  if (
    descriptor.keeperGeneration !== keeperGeneration ||
    !Number.isSafeInteger(descriptor.keeperPid) ||
    Number(descriptor.keeperPid) <= 1 ||
    !Number.isSafeInteger(descriptor.childPid) ||
    Number(descriptor.childPid) <= 1
  ) {
    throw new Error(
      `remote descriptor processes are invalid for ${keeperGeneration}`
    );
  }
  return descriptor as RemoteSessionProcessDescriptor;
}

async function remoteProcessIsRunning(
  selectedTarget: StartedSshTarget,
  pid: number
): Promise<boolean> {
  const result = await selectedTarget.target.exec([
    "sh",
    "-lc",
    `kill -0 ${pid} 2>/dev/null`
  ]);
  return result.exitCode === 0;
}

async function remoteProcessDiagnostic(
  selectedTarget: StartedSshTarget,
  pid: number
): Promise<string> {
  const result = await selectedTarget.target.exec([
    "sh",
    "-lc",
    `{ ps -o pid=,ppid=,stat=,sid=,pgid=,comm= -p ${pid} 2>&1; ls -l /proc/${pid}/fd 2>&1; } || true`
  ]);
  return result.stdout.trim() || "missing";
}

async function stopRemoteSessionProcesses(
  selectedTarget: StartedSshTarget,
  descriptor: RemoteSessionProcessDescriptor
): Promise<void> {
  await selectedTarget.target.exec([
    "sh",
    "-lc",
    `kill -TERM ${descriptor.keeperPid} ${descriptor.childPid} 2>/dev/null || true`
  ]);
}

async function connectAssignedMasterFor(
  selectedTarget: StartedSshTarget,
  pool: SshTransportPool,
  suffix: string,
  configPath = selectedTarget.sshConfigPath
): Promise<AssignedSshMaster> {
  const effective = await resolveEffectiveSshConfig({
    sshPath: selectedTarget.sshPath,
    configPath,
    host: selectedTarget.hostAlias
  });
  const connectionAttemptId = `attempt-${suffix}`;
  await pool.connectProvisional({
    connectionAttemptId,
    effectiveConnectionPolicyHash: effective.policyHash,
    sshPath: selectedTarget.sshPath,
    configPath,
    host: selectedTarget.hostAlias,
    controlRoot: selectedTarget.controlDirectoryPath
  });
  return await pool.promote({
    connectionAttemptId,
    targetId: `verified-target-${suffix}`,
    effectiveConnectionPolicyHash: effective.policyHash
  });
}

function masterRequest(connectionAttemptId: string, policyHash: string) {
  return {
    connectionAttemptId,
    effectiveConnectionPolicyHash: policyHash,
    sshPath: target.sshPath,
    configPath: target.sshConfigPath,
    host: target.hostAlias,
    controlRoot: target.controlDirectoryPath
  };
}

function channelRequest<
  T extends Omit<MuxOnlyChannelRequest, keyof BaseChannel>
>(assigned: AssignedSshMaster, request: T): MuxOnlyChannelRequest {
  return channelRequestFor(target, target.sshConfigPath, assigned, request);
}

function channelRequestFor<
  T extends Omit<MuxOnlyChannelRequest, keyof BaseChannel>
>(
  selectedTarget: StartedSshTarget,
  configPath: string,
  assigned: AssignedSshMaster,
  request: T
): MuxOnlyChannelRequest {
  return {
    ...request,
    sshPath: selectedTarget.sshPath,
    sftpPath: selectedTarget.sftpPath,
    configPath,
    controlPath: assigned.master.controlPath,
    host: selectedTarget.hostAlias,
    masterGeneration: assigned.generation
  } as MuxOnlyChannelRequest;
}

interface BaseChannel {
  sshPath: string;
  sftpPath?: string;
  configPath: string;
  controlPath: string;
  host: string;
  masterGeneration: string;
  env?: NodeJS.ProcessEnv;
}

async function runBoundedChannel(
  pool: SshTransportPool,
  assigned: AssignedSshMaster,
  request: MuxOnlyChannelRequest,
  input?: string
) {
  const launch = await buildMuxOnlyLaunch(request);
  if (!pool.isCurrentGeneration(assigned.targetId, launch.masterGeneration)) {
    throw new Error("master generation changed before bounded test channel");
  }
  return await runOpenSshCommand(launch.executable, launch.args, {
    env: launch.env,
    input,
    timeoutMs: 15_000
  });
}

interface AuthorityReport {
  remoteInstallationId: string;
  executionNodeId: string;
  authenticatedPrincipal: { uid: number; accountName: string };
  platform: string;
  arch: string;
  abi: string;
}

interface DoctorPathSet {
  installRoot: string;
  authorityRoot: string;
  stateRoot: string;
  runtimeRoot: string;
}

function doctorPaths(root: string): DoctorPathSet {
  return {
    installRoot: `${root}/install`,
    authorityRoot: `${root}/authority`,
    stateRoot: `${root}/state`,
    runtimeRoot: `${root}/run`
  };
}

async function stageCompleteGenerationFixture(
  pool: SshTransportPool,
  assigned: AssignedSshMaster,
  installRoot: string,
  suffix: string
): Promise<{ generation: string; runtimePath: string }> {
  const executable = Buffer.concat([
    await readFile(linuxRuntimeArtifactPath),
    Buffer.from(`\nkmux-generation-fixture-${suffix}\n`)
  ]);
  const executableSha256 = createHash("sha256")
    .update(executable)
    .digest("hex");
  const manifest = JSON.parse(
    await readFile(linuxRuntimeManifestPath, "utf8")
  ) as Record<string, unknown>;
  manifest.sha256 = executableSha256;
  manifest.bytes = executable.byteLength;
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestSha256 = createHash("sha256")
    .update(manifestBytes)
    .digest("hex");
  const generation = `1+${executableSha256}`;
  const remoteDirectory = `${installRoot}/bin/${generation}`;
  const runtimePath = `${remoteDirectory}/kmuxd`;
  const localExecutable = join(
    target.sandboxPath,
    `old-generation-${suffix}.kmuxd`
  );
  const localManifest = join(
    target.sandboxPath,
    `old-generation-${suffix}.manifest.json`
  );
  const localSentinel = join(
    target.sandboxPath,
    `old-generation-${suffix}.install-complete`
  );
  await Promise.all([
    writeFile(localExecutable, executable, { mode: 0o700 }),
    writeFile(localManifest, manifestBytes, { mode: 0o600 }),
    writeFile(
      localSentinel,
      `${JSON.stringify({
        schemaVersion: 1,
        generation,
        executableSha256,
        manifestSha256
      })}\n`,
      { mode: 0o600 }
    )
  ]);
  await runBoundedChannel(
    pool,
    assigned,
    channelRequest(assigned, {
      kind: "control",
      remoteCommand: `mkdir -m 700 ${remoteDirectory}`
    })
  );
  await runBoundedChannel(
    pool,
    assigned,
    channelRequest(assigned, { kind: "sftp" }),
    [
      `put ${quoteSftpPath(localExecutable)} ${quoteSftpPath(runtimePath)}`,
      `chmod 700 ${quoteSftpPath(runtimePath)}`,
      `put ${quoteSftpPath(localManifest)} ${quoteSftpPath(`${remoteDirectory}/manifest.json`)}`,
      `chmod 600 ${quoteSftpPath(`${remoteDirectory}/manifest.json`)}`,
      `put ${quoteSftpPath(localSentinel)} ${quoteSftpPath(`${remoteDirectory}/install-complete`)}`,
      `chmod 600 ${quoteSftpPath(`${remoteDirectory}/install-complete`)}`,
      "quit",
      ""
    ].join("\n")
  );
  return { generation, runtimePath };
}

async function runDoctor(
  selectedTarget: StartedSshTarget,
  pool: SshTransportPool,
  assigned: AssignedSshMaster,
  configPath: string,
  paths: DoctorPathSet
): Promise<AuthorityReport> {
  try {
    const result = await runBoundedChannel(
      pool,
      assigned,
      channelRequestFor(selectedTarget, configPath, assigned, {
        kind: "control",
        remoteCommand: `${selectedTarget.remoteRuntimePath} doctor --install-root ${paths.installRoot} --authority-root ${paths.authorityRoot} --state-root ${paths.stateRoot} --runtime-root ${paths.runtimeRoot}`
      })
    );
    return JSON.parse(result.stdout) as AuthorityReport;
  } catch (error) {
    if (error instanceof OpenSshProcessError) {
      error.message = `doctor failed for ${paths.authorityRoot}: ${error.stderr.trim()}`;
    }
    throw error;
  }
}

function openSshStderr(error: unknown): string {
  return error instanceof OpenSshProcessError
    ? error.stderr
    : error instanceof Error
      ? error.message
      : String(error);
}

function quotePosixWord(value: string): string {
  if (value.includes("\0")) {
    throw new Error("POSIX fixture word contains NUL");
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function quoteSftpPath(path: string): string {
  if (/[\0\r\n]/u.test(path)) {
    throw new Error("SFTP fixture path contains a forbidden character");
  }
  return `"${path.replace(/[\\"]/gu, (character) => `\\${character}`)}"`;
}

function createHeadlessTerminal(
  cols: number,
  rows: number
): {
  terminal: HeadlessTerminal;
  serialize: SerializeAddon;
} {
  const terminal = new HeadlessTerminalCtor({
    cols,
    rows,
    scrollback: 100,
    allowProposedApi: true
  });
  const serialize = new SerializeAddon();
  terminal.loadAddon(serialize);
  return { terminal, serialize };
}

async function writeTerminal(
  terminal: HeadlessTerminal,
  data: Uint8Array
): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(data, resolve));
}

function snapshotTerminal(terminal: HeadlessTerminal): {
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
  lines: string[];
} {
  const buffer = terminal.buffer.active;
  const lines = Array.from({ length: terminal.rows }, (_, row) =>
    (
      buffer.getLine(buffer.viewportY + row)?.translateToString(false) ?? ""
    ).trimEnd()
  );
  return {
    cols: terminal.cols,
    rows: terminal.rows,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    lines
  };
}

async function reserveLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("unable to reserve a local TCP port");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitForPort(port: number): Promise<void> {
  await eventually(async () => {
    const socket = connect({ host: "127.0.0.1", port });
    return await new Promise<boolean>((resolve) => {
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
  });
}

async function waitForInspectedPort(
  runtime: LinuxX64RemoteRuntime,
  resourceKey: {
    desktopInstallationId: string;
    targetId: string;
    workspaceId: string;
    sessionId: string;
  },
  port: number
): Promise<void> {
  let observedPorts: number[] = [];
  await eventually(async () => {
    const inspection = await runtime.inspectPorts({ resourceKey });
    observedPorts = inspection.ports;
    return observedPorts.includes(port);
  }).catch((error: unknown) => {
    throw new Error(
      `remote port ${port} was not discovered; observed ports: ${observedPorts.join(", ") || "none"}`,
      { cause: error }
    );
  });
}

async function echoThroughSocket(port: number, value: string): Promise<string> {
  const socket = connect({ host: "127.0.0.1", port });
  await onceConnected(socket);
  socket.write(value);
  return await readExact(socket, Buffer.byteLength(value)).then((data) => {
    socket.destroy();
    return data.toString("utf8");
  });
}

async function echoThroughSocks(port: number, value: string): Promise<string> {
  const socket = connect({ host: "127.0.0.1", port });
  await onceConnected(socket);
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  expect([...(await readExact(socket, 2))]).toEqual([0x05, 0x00]);
  socket.write(
    Buffer.from([
      0x05,
      0x01,
      0x00,
      0x01,
      127,
      0,
      0,
      1,
      18080 >> 8,
      18080 & 0xff
    ])
  );
  const response = await readExact(socket, 10);
  expect(response[0]).toBe(0x05);
  expect(response[1]).toBe(0x00);
  socket.write(value);
  const echo = await readExact(socket, Buffer.byteLength(value));
  socket.destroy();
  return echo.toString("utf8");
}

async function onceConnected(socket: Socket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
}

async function readExact(socket: Socket, bytes: number): Promise<Buffer> {
  let buffered = Buffer.alloc(0);
  return await new Promise<Buffer>((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.byteLength >= bytes) {
        cleanup();
        resolve(buffered.subarray(0, bytes));
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      cleanup();
      reject(
        new Error(`socket closed after ${buffered.byteLength}/${bytes} bytes`)
      );
    };
    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve())
  );
  child.kill("SIGTERM");
  await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(resolve, 2_000))
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      closed,
      new Promise((resolve) => setTimeout(resolve, 2_000))
    ]);
  }
}

async function readChildOutputLine(
  child: ChildProcess,
  timeoutMs = 30_000
): Promise<string> {
  return await new Promise<string>((resolveLine, rejectLine) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      rejectLine(new Error(`timed out waiting for child output: ${stderr}`));
    }, timeoutMs);
    const onStdout = (chunk: Buffer): void => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(-64 * 1024);
      const newline = stdout.indexOf("\n");
      if (newline === -1) return;
      cleanup();
      resolveLine(stdout.slice(0, newline));
    };
    const onStderr = (chunk: Buffer): void => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-64 * 1024);
    };
    const onClose = (): void => {
      cleanup();
      rejectLine(new Error(`child closed before readiness: ${stderr}`));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("close", onClose);
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("close", onClose);
  });
}

async function eventually(
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`condition did not become true within ${timeoutMs} ms`);
}
