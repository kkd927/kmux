import type { SshProfileDto, SshProfileVm } from "@kmux/proto";

export function sameSshProfileDefinition(
  left: SshProfileDto,
  right: SshProfileDto
): boolean {
  return (
    JSON.stringify(profileDefinition(left)) ===
    JSON.stringify(profileDefinition(right))
  );
}

export function mergeSshProfileResolution(
  current: SshProfileVm,
  requested: SshProfileDto,
  resolved: SshProfileVm
): SshProfileVm | null {
  if (
    !sameSshProfileDefinition(current, requested) ||
    !sameSshProfileDefinition(resolved, requested)
  ) {
    return null;
  }
  const merged = { ...current };
  if (resolved.effectiveConnection) {
    merged.effectiveConnection = structuredClone(resolved.effectiveConnection);
  } else {
    delete merged.effectiveConnection;
  }
  return merged;
}

function profileDefinition(profile: SshProfileDto): unknown {
  return {
    id: profile.id,
    name: profile.name,
    sshConfigHost: profile.sshConfigHost ?? null,
    host: profile.host ?? null,
    user: profile.user ?? null,
    port: profile.port ?? null,
    identityFile: profile.identityFile ?? null,
    defaultRemoteCwd: profile.defaultRemoteCwd ?? null,
    shellOverride: profile.shellOverride ?? null,
    bootstrapShellOverride: profile.bootstrapShellOverride ?? null,
    installPathOverride: profile.installPathOverride ?? null,
    authorityPathOverride: profile.authorityPathOverride ?? null,
    statePathOverride: profile.statePathOverride ?? null,
    runtimePathOverride: profile.runtimePathOverride ?? null,
    sessionRetentionQuotaMiB: profile.sessionRetentionQuotaMiB ?? null,
    targetRetentionQuotaMiB: profile.targetRetentionQuotaMiB ?? null,
    env: Object.entries(profile.env ?? {}).sort(([left], [right]) =>
      left.localeCompare(right)
    ),
    forwardAgent: profile.forwardAgent ?? null,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt
  };
}
