import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type {
  RemoteRuntimeRootsDto,
  SshEffectiveConnectionVm,
  SshProfileDto
} from "@kmux/proto";

import type { RemoteHostEffectiveSshConfig } from "../../shared/remoteHostProtocol";
import { durableAtomicReplace } from "./durableAtomicWrite";

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_HOST_KEY_OBSERVATION_BYTES = 4 * 1024;
const HOST_KEY_OBSERVER_FILE = "host-key-observer.sh";
const HOST_KEY_OBSERVER_SCRIPT = `#!/bin/sh
set -f
umask 077
output=$1
fingerprint=$2
reason=$3
case "$reason:$fingerprint" in
  HOSTNAME:SHA256:*|ADDRESS:SHA256:*|HOSTNAME:MD5:*|ADDRESS:MD5:*)
    printf '%s\\n' "$fingerprint" > "$output" || exit 1
    ;;
esac
exit 0
`;

export interface ResolvedSshProfileConnection {
  profile: SshProfileDto;
  sshPath: string;
  configPath: string;
  hostKeyObservationPath: string;
  host: string;
  effective: SshEffectiveConnectionVm;
  rootOverrides: Partial<RemoteRuntimeRootsDto>;
}

export interface SshProfileConnectionResolver {
  resolve(profile: SshProfileDto): Promise<ResolvedSshProfileConnection>;
}

export function createSshProfileConnectionResolver(options: {
  homeDir: string;
  configRoot: string;
  sshPath?: string;
  env?: NodeJS.ProcessEnv;
  resolveEffective: (options: {
    sshPath: string;
    configPath: string;
    host: string;
    env?: NodeJS.ProcessEnv;
  }) => Promise<RemoteHostEffectiveSshConfig>;
}): SshProfileConnectionResolver {
  if (!isAbsolute(options.homeDir) || !isAbsolute(options.configRoot)) {
    throw new TypeError("SSH profile resolver roots must be absolute");
  }
  const sshPath = options.sshPath ?? "/usr/bin/ssh";
  const resolveEffective = options.resolveEffective;
  return Object.freeze({
    async resolve(
      profile: SshProfileDto
    ): Promise<ResolvedSshProfileConnection> {
      const host = profile.sshConfigHost ?? internalProfileHost(profile.id);
      assertSafeConfigToken(host, "SSH host alias");
      const configPath = join(
        options.configRoot,
        `${createHash("sha256").update(profile.id).digest("hex")}.conf`
      );
      const profileHash = createHash("sha256").update(profile.id).digest("hex");
      const observerPath = join(options.configRoot, HOST_KEY_OBSERVER_FILE);
      const hostKeyObservationPath = join(
        options.configRoot,
        `${profileHash}.host-key-fingerprint`
      );
      durableAtomicReplace(
        options.configRoot,
        HOST_KEY_OBSERVER_FILE,
        new TextEncoder().encode(HOST_KEY_OBSERVER_SCRIPT)
      );
      durableAtomicReplace(
        options.configRoot,
        `${profileHash}.host-key-fingerprint`,
        new Uint8Array()
      );
      const config = renderProfileConfig({
        profile,
        host,
        userConfigPath: join(options.homeDir, ".ssh", "config"),
        observerPath,
        hostKeyObservationPath
      });
      const bytes = new TextEncoder().encode(config);
      if (bytes.byteLength > MAX_CONFIG_BYTES) {
        throw new RangeError("generated SSH profile config is oversized");
      }
      durableAtomicReplace(
        options.configRoot,
        configPath.slice(options.configRoot.length + 1),
        bytes
      );
      const effective = await resolveEffective({
        sshPath,
        configPath,
        host,
        ...(options.env === undefined ? {} : { env: options.env })
      });
      return {
        profile: structuredClone(profile),
        sshPath,
        configPath,
        hostKeyObservationPath,
        host,
        effective: toEffectiveVm(effective),
        rootOverrides: profileRootOverrides(profile)
      };
    }
  });
}

function renderProfileConfig(options: {
  profile: SshProfileDto;
  host: string;
  userConfigPath: string;
  observerPath: string;
  hostKeyObservationPath: string;
}): string {
  const { profile } = options;
  const lines = [`Host ${options.host}`];
  if (profile.host !== undefined) {
    lines.push(`  HostName ${quoteConfigValue(profile.host)}`);
  }
  if (profile.user !== undefined) {
    lines.push(`  User ${quoteConfigValue(profile.user)}`);
  }
  if (profile.port !== undefined) lines.push(`  Port ${profile.port}`);
  if (profile.identityFile !== undefined) {
    lines.push(`  IdentityFile ${quoteConfigValue(profile.identityFile)}`);
  }
  // Agent forwarding is a profile capability and is off unless the user
  // explicitly enables it. Placing this before Include makes the first-value
  // OpenSSH rule enforce the profile choice over ambient wildcard config.
  lines.push(`  ForwardAgent ${profile.forwardAgent === true ? "yes" : "no"}`);
  // `%f` is expanded by OpenSSH from the host key it is evaluating. The
  // helper records only HOSTNAME/ADDRESS fingerprints and returns no host-key
  // rows, so normal UserKnownHostsFile/GlobalKnownHostsFile trust remains the
  // sole verifier. The observation is consumed only after the master succeeds.
  lines.push(
    `  KnownHostsCommand /bin/sh ${quoteConfigValue(options.observerPath)} ${quoteConfigValue(options.hostKeyObservationPath)} "%f" "%I"`
  );
  lines.push(`Include ${quoteConfigValue(options.userConfigPath)}`, "");
  return lines.join("\n");
}

export function readObservedSshHostKeyFingerprint(
  path: string
): string | undefined {
  if (!isAbsolute(path)) {
    throw new TypeError("host-key observation path must be absolute");
  }
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size > MAX_HOST_KEY_OBSERVATION_BYTES ||
    (typeof process.getuid === "function" &&
      metadata.uid !== process.getuid()) ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error("host-key observation file is not a private regular file");
  }
  const value = readFileSync(path, "utf8").trim();
  if (!value) return undefined;
  if (
    Buffer.byteLength(value, "utf8") > 512 ||
    !/^(?:SHA256:[A-Za-z0-9+/=_-]+|MD5:(?:[a-fA-F0-9]{2}:){15}[a-fA-F0-9]{2})$/u.test(
      value
    )
  ) {
    return undefined;
  }
  return value;
}

function profileRootOverrides(
  profile: SshProfileDto
): Partial<RemoteRuntimeRootsDto> {
  return {
    ...(profile.installPathOverride === undefined
      ? {}
      : { installRoot: profile.installPathOverride }),
    ...(profile.authorityPathOverride === undefined
      ? {}
      : { authorityRoot: profile.authorityPathOverride }),
    ...(profile.statePathOverride === undefined
      ? {}
      : { stateRoot: profile.statePathOverride }),
    ...(profile.runtimePathOverride === undefined
      ? {}
      : { runtimeRoot: profile.runtimePathOverride })
  };
}

function toEffectiveVm(
  config: RemoteHostEffectiveSshConfig
): SshEffectiveConnectionVm {
  return {
    hostName: config.hostName,
    user: config.user,
    port: config.port,
    identityFiles: [...config.identityFiles],
    ...(config.proxyJump === undefined ? {} : { proxyJump: config.proxyJump }),
    ...(config.proxyCommand === undefined
      ? {}
      : { proxyCommand: config.proxyCommand }),
    policyHash: config.policyHash
  };
}

function internalProfileHost(profileId: string): string {
  return `kmux-profile-${createHash("sha256")
    .update(profileId)
    .digest("hex")
    .slice(0, 24)}`;
}

function assertSafeConfigToken(value: string, name: string): void {
  if (
    value.length === 0 ||
    value.length > 512 ||
    value.startsWith("-") ||
    !/^[A-Za-z0-9_.:@%+[\]-]+$/u.test(value)
  ) {
    throw new TypeError(`${name} cannot be represented safely in ssh_config`);
  }
}

function quoteConfigValue(value: string): string {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 32 * 1024 ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new TypeError("SSH config value must be bounded single-line text");
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
