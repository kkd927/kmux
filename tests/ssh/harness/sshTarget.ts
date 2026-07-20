import { randomBytes } from "node:crypto";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ToxiProxyContainer,
  type CreatedProxy,
  type StartedToxiProxyContainer
} from "@testcontainers/toxiproxy";
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer
} from "testcontainers";

import {
  assertSystemOpenSshExecutable,
  runOpenSshCommand
} from "../../../apps/desktop/src/remote-host/openSshProcess";
import { SshConnectionAudit } from "./connectionAudit";
import { createSshTestIdentity, type SshTestIdentity } from "./identity";
import { SshTransportFaults } from "./transportFaults";

const harnessDirectory = dirname(fileURLToPath(import.meta.url));
const imageDirectory = join(harnessDirectory, "../image");
const runtimeArtifactPath = join(
  harnessDirectory,
  "../../../remote/kmuxd/dist/linux-x64-musl/kmuxd"
);
const REMOTE_RUNTIME_PATH = "/opt/kmux-runtime/kmuxd";
const TARGET_IMAGE_TAG = "kmux/ssh-target:phase1-v1";
const TOXIPROXY_IMAGE =
  "ghcr.io/shopify/toxiproxy:2.9.0@sha256:b44c283298cea49e2defaba1b3028783798346f2a926684e3a345fd8441af3b8";
const TARGET_NETWORK_ALIAS = "kmux-ssh-target";

let targetImageBuild: Promise<void> | undefined;

export class SshHarnessPrerequisiteError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "SshHarnessPrerequisiteError";
  }
}

export interface SshTargetOptions {
  sftpEnabled?: boolean;
  machineId?: string;
  sharedHomePath?: string;
  storageFixtureMiB?: number;
  pathFixtures?: boolean;
}

export type SshFixtureUser = "kmux" | "kmux-alt";

export interface StartedSshTarget {
  sandboxPath: string;
  identity: SshTestIdentity;
  sshPath: string;
  sftpPath: string;
  sshConfigPath: string;
  knownHostsPath: string;
  globalKnownHostsPath: string;
  controlDirectoryPath: string;
  controlPath: string;
  hostAlias: string;
  proxyHost: string;
  proxyPort: number;
  expectedHostKeyFingerprint: string;
  remoteRuntimePath: string;
  storageFixturePath?: string;
  pathFixturePaths?: {
    noexecInstallRoot: string;
    readonlyInstallRoot: string;
  };
  target: StartedTestContainer;
  proxyContainer: StartedToxiProxyContainer;
  proxy: CreatedProxy;
  network: StartedNetwork;
  audit: SshConnectionAudit;
  auditBaseline: Awaited<ReturnType<SshConnectionAudit["snapshot"]>>;
  faults: SshTransportFaults;
  configForUser(user: SshFixtureUser): Promise<string>;
  stop(): Promise<void>;
}

export interface StartedSshBastion {
  hostAlias: string;
  host: string;
  port: number;
  destinationNetworkHost: string;
  knownHostsPath: string;
  target: StartedTestContainer;
  audit: SshConnectionAudit;
  auditBaseline: Awaited<ReturnType<SshConnectionAudit["snapshot"]>>;
  stop(): Promise<void>;
}

export async function startSshTarget(
  options: SshTargetOptions = {}
): Promise<StartedSshTarget> {
  const tools = resolveSystemTools();
  await Promise.all([
    assertSystemOpenSshExecutable(tools.sshPath),
    assertSystemOpenSshExecutable(tools.sftpPath),
    assertSystemOpenSshExecutable(tools.sshKeyscanPath),
    assertSystemOpenSshExecutable(tools.sshKeygenPath)
  ]);
  await access(runtimeArtifactPath).catch((error: unknown) => {
    throw new SshHarnessPrerequisiteError(
      "SSH integration requires the linux-x64-musl kmuxd artifact; run `npm run build:remote:linux-x64` and retry.",
      { cause: error }
    );
  });

  const sandboxPath = await mkdtemp(join(tmpdir(), "kmux-ssh-"));
  await chmod(sandboxPath, 0o700);
  const controlDirectoryPath = join(sandboxPath, "mux");
  await mkdir(controlDirectoryPath, { mode: 0o700 });
  const identity = await createSshTestIdentity({
    sandboxPath,
    name: "identity",
    sshKeygenPath: tools.sshKeygenPath
  });

  let network: StartedNetwork | undefined;
  let target: StartedTestContainer | undefined;
  let proxyContainer: StartedToxiProxyContainer | undefined;
  try {
    await ensureTargetImage();
    network = await new Network().start();
    const storageFixturePath = options.storageFixtureMiB
      ? "/home/kmux/.kmux-storage-fixture"
      : undefined;
    const pathFixturePaths = options.pathFixtures
      ? {
          noexecInstallRoot: "/home/kmux/.kmux-noexec-install",
          readonlyInstallRoot: "/home/kmux/.kmux-readonly-install"
        }
      : undefined;
    if (
      options.storageFixtureMiB !== undefined &&
      (!Number.isSafeInteger(options.storageFixtureMiB) ||
        options.storageFixtureMiB < 8 ||
        options.storageFixtureMiB > 512)
    ) {
      throw new TypeError("storage fixture size must be 8-512 MiB");
    }
    const targetContainer = new GenericContainer(TARGET_IMAGE_TAG)
      .withNetwork(network)
      .withNetworkAliases(TARGET_NETWORK_ALIAS)
      .withExposedPorts(22)
      .withEnvironment({
        KMUX_NODE_MACHINE_ID:
          options.machineId ?? randomBytes(16).toString("hex"),
        KMUX_DISABLE_SFTP: options.sftpEnabled === false ? "1" : "0"
      })
      .withCopyContentToContainer([
        {
          content: `${identity.publicKey}\n`,
          target: "/etc/ssh/authorized_keys/kmux",
          mode: 0o644
        },
        {
          content: `${identity.publicKey}\n`,
          target: "/etc/ssh/authorized_keys/kmux-alt",
          mode: 0o644
        }
      ])
      .withCopyFilesToContainer([
        {
          source: runtimeArtifactPath,
          target: REMOTE_RUNTIME_PATH,
          mode: 0o755
        }
      ])
      .withTmpFs({
        "/run": "rw,nosuid,nodev,size=64m,mode=755",
        "/tmp": "rw,nosuid,nodev,size=128m,mode=1777",
        ...(storageFixturePath
          ? {
              [storageFixturePath]: `rw,nosuid,nodev,size=${options.storageFixtureMiB}m,mode=700`
            }
          : {}),
        ...(pathFixturePaths
          ? {
              [pathFixturePaths.noexecInstallRoot]:
                "rw,noexec,nosuid,nodev,size=8m,mode=700",
              [pathFixturePaths.readonlyInstallRoot]:
                "ro,noexec,nosuid,nodev,size=8m,mode=755"
            }
          : {})
      })
      .withWaitStrategy(Wait.forListeningPorts())
      .withStartupTimeout(120_000);
    if (options.sharedHomePath) {
      targetContainer.withBindMounts([
        {
          source: options.sharedHomePath,
          target: "/home/kmux",
          mode: "rw"
        }
      ]);
    }
    target = await targetContainer.start();
    if (storageFixturePath) {
      const ownership = await target.exec([
        "sh",
        "-lc",
        `chown kmux:kmux ${storageFixturePath} && chmod 0700 ${storageFixturePath}`
      ]);
      if (ownership.exitCode !== 0) {
        throw new Error(
          `could not prepare storage fixture: ${ownership.stderr.trim()}`
        );
      }
    }
    if (pathFixturePaths) {
      const ownership = await target.exec([
        "sh",
        "-lc",
        `chown kmux:kmux ${pathFixturePaths.noexecInstallRoot} && chmod 0700 ${pathFixturePaths.noexecInstallRoot}`
      ]);
      if (ownership.exitCode !== 0) {
        throw new Error(
          `could not prepare path fixtures: ${ownership.stderr.trim()}`
        );
      }
    }

    proxyContainer = await new ToxiProxyContainer(TOXIPROXY_IMAGE)
      .withNetwork(network)
      .start();
    const proxy = await proxyContainer.createProxy({
      name: `sshd-${randomBytes(8).toString("hex")}`,
      upstream: `${TARGET_NETWORK_ALIAS}:22`,
      enabled: true
    });

    const hostKey = await probeExpectedHostKey({
      target,
      proxyHost: proxy.host,
      proxyPort: proxy.port,
      sandboxPath,
      sshKeyscanPath: tools.sshKeyscanPath,
      sshKeygenPath: tools.sshKeygenPath
    });
    const knownHostsPath = join(sandboxPath, "known_hosts");
    const globalKnownHostsPath = join(sandboxPath, "global_known_hosts");
    await writeFile(knownHostsPath, hostKey.knownHostsLine, { mode: 0o600 });
    await writeFile(globalKnownHostsPath, "", { mode: 0o600 });

    const sshConfigPath = join(sandboxPath, "ssh_config");
    const hostAlias = "kmux-test";
    await writeFile(
      sshConfigPath,
      buildSshConfig({
        hostAlias,
        hostName: proxy.host,
        port: proxy.port,
        identityPath: identity.privateKeyPath,
        knownHostsPath,
        globalKnownHostsPath
      }),
      { mode: 0o600 }
    );

    const audit = new SshConnectionAudit(target);
    const auditBaseline = await audit.snapshot();
    const faults = new SshTransportFaults(proxy);
    let stopped = false;

    return {
      sandboxPath,
      identity,
      sshPath: tools.sshPath,
      sftpPath: tools.sftpPath,
      sshConfigPath,
      knownHostsPath,
      globalKnownHostsPath,
      controlDirectoryPath,
      controlPath: join(controlDirectoryPath, "master.sock"),
      hostAlias,
      proxyHost: proxy.host,
      proxyPort: proxy.port,
      expectedHostKeyFingerprint: hostKey.fingerprint,
      remoteRuntimePath: REMOTE_RUNTIME_PATH,
      ...(storageFixturePath === undefined ? {} : { storageFixturePath }),
      ...(pathFixturePaths === undefined ? {} : { pathFixturePaths }),
      target,
      proxyContainer,
      proxy,
      network,
      audit,
      auditBaseline,
      faults,
      async configForUser(user): Promise<string> {
        const configPath = join(sandboxPath, `ssh_config_${user}`);
        await writeFile(
          configPath,
          buildSshConfig({
            hostAlias,
            hostName: proxy.host,
            port: proxy.port,
            identityPath: identity.privateKeyPath,
            knownHostsPath,
            globalKnownHostsPath,
            user
          }),
          { mode: 0o600 }
        );
        return configPath;
      },
      async stop(): Promise<void> {
        if (stopped) return;
        stopped = true;
        await proxyContainer?.stop().catch(() => undefined);
        await target?.stop().catch(() => undefined);
        await network?.stop().catch(() => undefined);
        await rm(sandboxPath, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await proxyContainer?.stop().catch(() => undefined);
    await target?.stop().catch(() => undefined);
    await network?.stop().catch(() => undefined);
    await rm(sandboxPath, { recursive: true, force: true });
    if (isContainerPrerequisiteFailure(error)) {
      throw new SshHarnessPrerequisiteError(
        "SSH integration requires a running Docker-compatible Testcontainers runtime; start Docker Desktop or configure a supported runtime, then rerun `npm run test:ssh:integration`.",
        { cause: error }
      );
    }
    throw error;
  }
}

export async function startSshBastion(
  destination: StartedSshTarget
): Promise<StartedSshBastion> {
  const tools = resolveSystemTools();
  await Promise.all([
    assertSystemOpenSshExecutable(tools.sshKeyscanPath),
    assertSystemOpenSshExecutable(tools.sshKeygenPath)
  ]);
  await ensureTargetImage();
  const suffix = randomBytes(8).toString("hex");
  const hostAlias = `kmux-bastion-${suffix}`;
  const networkAlias = `kmux-ssh-bastion-${suffix}`;
  let bastion: StartedTestContainer | undefined;
  try {
    bastion = await new GenericContainer(TARGET_IMAGE_TAG)
      .withNetwork(destination.network)
      .withNetworkAliases(networkAlias)
      .withExposedPorts(22)
      .withEnvironment({
        KMUX_NODE_MACHINE_ID: randomBytes(16).toString("hex"),
        KMUX_DISABLE_SFTP: "0"
      })
      .withCopyContentToContainer([
        {
          content: `${destination.identity.publicKey}\n`,
          target: "/etc/ssh/authorized_keys/kmux",
          mode: 0o644
        }
      ])
      .withTmpFs({
        "/run": "rw,nosuid,nodev,size=64m,mode=755",
        "/tmp": "rw,nosuid,nodev,size=128m,mode=1777"
      })
      .withWaitStrategy(Wait.forListeningPorts())
      .withStartupTimeout(120_000)
      .start();
    const host = bastion.getHost();
    const port = bastion.getMappedPort(22);
    const bastionHostKey = await probeExpectedHostKey({
      target: bastion,
      proxyHost: host,
      proxyPort: port,
      sandboxPath: destination.sandboxPath,
      sshKeyscanPath: tools.sshKeyscanPath,
      sshKeygenPath: tools.sshKeygenPath
    });
    const destinationHostKey = (
      await readFile(destination.knownHostsPath, "utf8")
    )
      .trim()
      .split(/\s+/u);
    if (
      destinationHostKey.length !== 3 ||
      destinationHostKey[1] !== "ssh-ed25519"
    ) {
      throw new Error("destination known-hosts fixture is invalid");
    }
    const knownHostsPath = join(
      destination.sandboxPath,
      `bastion_known_hosts_${suffix}`
    );
    await writeFile(
      knownHostsPath,
      [
        bastionHostKey.knownHostsLine.trim(),
        `${TARGET_NETWORK_ALIAS} ${destinationHostKey[1]} ${destinationHostKey[2]}`,
        ""
      ].join("\n"),
      { mode: 0o600 }
    );
    const audit = new SshConnectionAudit(bastion);
    const auditBaseline = await audit.snapshot();
    let stopped = false;
    return {
      hostAlias,
      host,
      port,
      destinationNetworkHost: TARGET_NETWORK_ALIAS,
      knownHostsPath,
      target: bastion,
      audit,
      auditBaseline,
      async stop(): Promise<void> {
        if (stopped) return;
        stopped = true;
        await bastion?.stop().catch(() => undefined);
      }
    };
  } catch (error) {
    await bastion?.stop().catch(() => undefined);
    throw error;
  }
}

async function ensureTargetImage(): Promise<void> {
  targetImageBuild ??= GenericContainer.fromDockerfile(imageDirectory)
    .withBuildkit()
    .build(TARGET_IMAGE_TAG, { deleteOnExit: false })
    .then(() => undefined);
  await targetImageBuild;
}

function resolveSystemTools(): {
  sshPath: string;
  sftpPath: string;
  sshKeyscanPath: string;
  sshKeygenPath: string;
} {
  return {
    sshPath: process.env.KMUX_TEST_SSH_PATH ?? "/usr/bin/ssh",
    sftpPath: process.env.KMUX_TEST_SFTP_PATH ?? "/usr/bin/sftp",
    sshKeyscanPath:
      process.env.KMUX_TEST_SSH_KEYSCAN_PATH ?? "/usr/bin/ssh-keyscan",
    sshKeygenPath:
      process.env.KMUX_TEST_SSH_KEYGEN_PATH ?? "/usr/bin/ssh-keygen"
  };
}

async function probeExpectedHostKey(options: {
  target: StartedTestContainer;
  proxyHost: string;
  proxyPort: number;
  sandboxPath: string;
  sshKeyscanPath: string;
  sshKeygenPath: string;
}): Promise<{ fingerprint: string; knownHostsLine: string }> {
  const expectedResult = await options.target.exec([
    "ssh-keygen",
    "-lf",
    "/run/kmux-ssh/ssh_host_ed25519_key.pub",
    "-E",
    "sha256"
  ]);
  if (expectedResult.exitCode !== 0) {
    throw new Error(`unable to read target host key: ${expectedResult.stderr}`);
  }
  const expectedFingerprint = parseFingerprint(expectedResult.stdout);

  const knownHostsLine = await scanExpectedHostKey(options);
  const scannedKeyPath = join(options.sandboxPath, "scanned_host_key");
  await writeFile(scannedKeyPath, `${knownHostsLine}\n`, { mode: 0o600 });
  const scanned = await runOpenSshCommand(
    options.sshKeygenPath,
    ["-lf", scannedKeyPath, "-E", "sha256"],
    { timeoutMs: 10_000 }
  );
  const scannedFingerprint = parseFingerprint(scanned.stdout);
  if (scannedFingerprint !== expectedFingerprint) {
    throw new Error(
      `host-key readiness mismatch: expected ${expectedFingerprint}, observed ${scannedFingerprint}`
    );
  }
  return {
    fingerprint: expectedFingerprint,
    knownHostsLine: `${knownHostsLine}\n`
  };
}

async function scanExpectedHostKey(options: {
  proxyHost: string;
  proxyPort: number;
  sshKeyscanPath: string;
}): Promise<string> {
  let lastFailure: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const scan = await runOpenSshCommand(
        options.sshKeyscanPath,
        [
          "-T",
          "2",
          "-t",
          "ed25519",
          "-p",
          String(options.proxyPort),
          options.proxyHost
        ],
        { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 }
      );
      const knownHostsLine = scan.stdout
        .split(/\r?\n/u)
        .find((line) => line.length > 0 && !line.startsWith("#"));
      if (knownHostsLine) return knownHostsLine;
      lastFailure = new Error(
        "host-key readiness probe returned no ED25519 key"
      );
    } catch (error) {
      lastFailure = error;
    }
    if (attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 100));
    }
  }
  throw new Error("host-key readiness probe exhausted bounded retries", {
    cause: lastFailure
  });
}

function parseFingerprint(output: string): string {
  const match = /\bSHA256:[A-Za-z0-9+/]+\b/u.exec(output);
  if (!match)
    throw new Error(`unable to parse SSH fingerprint from: ${output}`);
  return match[0];
}

function buildSshConfig(options: {
  hostAlias: string;
  hostName: string;
  port: number;
  identityPath: string;
  knownHostsPath: string;
  globalKnownHostsPath: string;
  user?: SshFixtureUser;
}): string {
  const fields = Object.values(options);
  if (fields.some((value) => /[\r\n]/u.test(String(value)))) {
    throw new Error("SSH fixture configuration contains a newline");
  }
  return [
    `Host ${options.hostAlias}`,
    `  HostName ${options.hostName}`,
    `  Port ${options.port}`,
    `  User ${options.user ?? "kmux"}`,
    `  IdentityFile ${options.identityPath}`,
    "  IdentitiesOnly yes",
    `  UserKnownHostsFile ${options.knownHostsPath}`,
    `  GlobalKnownHostsFile ${options.globalKnownHostsPath}`,
    "  StrictHostKeyChecking yes",
    "  UpdateHostKeys no",
    "  HashKnownHosts no",
    "  ControlMaster no",
    "  ControlPersist no",
    "  BatchMode yes",
    "  PasswordAuthentication no",
    "  KbdInteractiveAuthentication no",
    "  LogLevel ERROR",
    ""
  ].join("\n");
}

function isContainerPrerequisiteFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /container runtime|docker|podman|socket|strategy could be found/iu.test(
    message
  );
}

export async function readSshImageManifest(): Promise<unknown> {
  return JSON.parse(
    await readFile(join(imageDirectory, "manifest.json"), "utf8")
  ) as unknown;
}
