# Controlled native SSH profile

`npm run profile:ssh` is the release-blocking ADR 0005 transport workload. Run
it once for each of `darwin-arm64`, `darwin-x64`, `linux-arm64-musl`, and
`linux-x64-musl` on an actual matching target. Docker, emulation, shared CI, and
a configuration with `sharedHost: true` are diagnostic evidence only.

Start from `native-profile.template.json` and keep the resulting target-specific
configuration outside the repository if it contains private host information.
The configuration must use normalized absolute local and remote paths. Set
`runtimeArtifactPath` to the exact local packaged runtime and `runtimeSha256` to
its SHA-256. Before opening an SSH master, the harness requires that path to be
a bounded executable regular file and hashes it. It then reads `runtimePath`
back over the assigned OpenSSH master and requires the same hash before any
workspace/session mutation. The report records the verified hash and local
source revision.

The controlled target must have at least four physical cores, 8 GiB of RAM,
SSD-backed kmux state, the versioned Git fixture at commit
`8408912c3abac9be93ece7e8f360dac4eadf4507`, and a controlled 20 ms RTT with at
most 1 ms injected jitter. Record the inspection and shaper commands/results in
the two `evidence` fields. Set `sharedHost` to `false` only for a dedicated,
non-CI measurement host. A normative run also rejects a dirty local worktree.
The harness records the host OpenSSH client version and the target OpenSSH
server version observed through the assigned master in every report.

Use the checked-in v1 performance manifest unchanged on every target. Its
steady terminal stream uses deterministic binary output in 4 KiB application
chunks. After the 120-second steady interval, one of the four already attached
keepers emits a 4 MiB ASCII burst in 64 KiB chunks paced at 20 ms while twenty
echo probes traverse that same attachment without pausing its output. The
harness requires all probes to precede the burst end marker and satisfy the
manifest's added p95/p99 echo limits, then queries every generator for exact
steady and burst byte counts. Changing this generator shape requires an ADR
amendment and benchmark evidence.

Profiling and SSH implementation work must not instrument or reroute the local
surface live-output path. That path remains `pty-host` ring/coalescing/credit →
direct renderer `MessagePort` → singleton router → existing scheduler/xterm.
The versioned local regression gate compares the immutable pre-SSH capture with
each phase candidate; the SSH profile is a separate remote transport gate.

`auditSnapshot.executable` is an absolute local executable that prints one JSON
object containing these exact monotonic counters:

```json
{
  "acceptedAuthentications": 0,
  "acceptedTcpConnections": 0,
  "authenticationAttempts": 0,
  "closedConnections": 0,
  "liveTcpConnections": 0,
  "physicalTcpLegs": 0
}
```

The counters must come from the target `sshd` and every resolved proxy/bastion
leg, not from process inference. The harness samples before master creation,
after master creation, and after the workload. The first delta must contain one
authentication and the configured physical-leg count; the feature delta must
contain no connection or authentication attempt. `resolvedRoutePhysicalTcpLegs`
is the expected physical-leg delta for the resolved route.

Run a target configuration with an absolute path:

```sh
KMUX_SSH_PROFILE_CONFIG=/absolute/path/to/config.json npm run profile:ssh
```

By default the JSON report is written under `.kmux/ssh-profile`. Preserve the
report, its SHA-256, the packaged-runtime source, and the audit/hardware/network
evidence for each of the four targets. `npm run profile:ssh:functional` remains
non-normative Docker evidence and cannot replace any of these records.
