# SSH Remote Workspaces Implementation Execution Plan

> **For the implementation agent:** Read this document and
> `docs/adr/0005-ssh-remote-workspaces.md` completely before changing code.
> ADR 0005 is the technical source of truth. This document defines only the
> execution loop, concrete test harness, phase gates, and reporting process.

**Goal:** Implement all eight phases of accepted ADR 0005 without weakening its
architecture, durability, security, compatibility, or performance contracts.

**Architecture Decision:** `docs/adr/0005-ssh-remote-workspaces.md`

**Progress Record:**
`docs/plans/2026-07-17-ssh-remote-workspaces-progress.md`

## Source of Truth and Working Rules

- ADR 0005 owns every technical contract and acceptance criterion. If this
  runbook conflicts with it, the ADR wins; do not maintain a second
  interpretation here.
- Work through ADR 0005's implementation phases 1 through 8 in order. Finish a
  usable contract slice, recovery behavior, and meaningful tests together;
  scaffolding or a happy-path demo does not complete a phase.
- At each phase boundary, re-read the relevant ADR sections and inspect the
  current code. Do not rely on an old summary or progress note.
- Preserve existing local workspace, terminal continuity, pane/surface, restore,
  Git/worktree, file, usage, and port behavior, plus the target-scoped seams
  reserved for future Agent Team compatibility.
- Preserve the local live-output architecture named in ADR 0005. SSH may add a
  second runtime owner behind the common data-plane boundary, but it may not
  put Main, target routing, remote framing, or new scheduling work into the
  local per-delta path.
- Follow repository `AGENTS.md` instructions. Add tests for durable behavior and
  material boundaries, not incidental implementation details or trivial UI.
- Preserve unrelated changes and avoid destructive Git operations. Do not
  commit, push, publish, or mutate external infrastructure without separate user
  authorization.
- Continue after a phase gate passes. Pause only under the deviation and blocker
  policy below.

## Progress and Review Loop

Create the progress record before implementation. Keep it concise and update it
after every phase so another context can resume without reconstructing history.
Use one status table with `Phase`, `State`, `Validation`, `Important+ findings`,
and `Blockers`. Under each phase record completed scope, checked ADR/traceability
rows, exact commands and results, fixed findings, material decisions, and next
entry conditions.

Run this loop for each phase:

1. Re-read the phase and touched ADR sections; inspect current code, tests,
   boundaries, dirty state, and reproducible baseline failures. Confirm that
   the versioned pre-SSH local-surface baseline and gate contract are present.
2. Map applicable ADR bullets and required tests to concrete owners, changes,
   and commands in the progress record.
3. Implement the smallest complete vertical change, migrate callers, and remove
   superseded paths.
4. Run proportional formatting, type checks, lint, tests, builds, fault
   injection, real-target checks, and benchmarks, including the versioned local
   surface candidate gate.
5. Review the cumulative phase diff for architecture, correctness, security,
   durability, bounds, performance, compatibility, and maintainability. Fix all
   Critical and Important findings, rerun checks, and review again.
6. Update progress, re-read the next phase, and continue.

Review severity:

- **Critical:** Data loss, security/trust violation, duplicate destructive
  mutation, cross-target execution, terminal continuity loss, or an unshippable
  core ADR violation.
- **Important:** Wrong lifecycle/recovery behavior, unbounded resource use,
  hidden fallback, material regression, incompatible update/protocol behavior,
  missing major feature compatibility, or costly architectural drift.
- **Minor:** Local clarity or polish that does not affect a contract, safety,
  performance gate, or architectural ownership.

## Phase Gates

Phase 0 is preparation. Create a traceability table for every item under ADR
0005's **Required Automated Contracts**, **Integration and Manual Validation**,
and **Normative Performance and Resource Gates**, mapping each to its owner,
phase, code, test/harness, and state.

The remaining gates refer directly to ADR 0005 rather than restating it:

| Phase | ADR source                                                                               | Gate before continuing                                                                                                                                                       |
| ----- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `Implementation Plan / 1` and `Test Strategy / Verification Layers and Harness Boundary` | All spikes have recorded evidence; the real-OpenSSH harness and benchmark manifest run reproducibly; a core-decision failure follows the deviation policy.                   |
| 2     | `Implementation Plan / 2`                                                                | Domain, operation, provider, and common data-plane migrations satisfy their traceability rows while local behavior remains green.                                            |
| 3     | `Implementation Plan / 3`                                                                | The Linux x64 vertical slice passes the required real-OpenSSH integration job, crash recovery, and continuity checks.                                                        |
| 4     | `Implementation Plan / 4`                                                                | All four artifacts pass the actual matching-target matrix; emulation is not accepted as parity evidence.                                                                     |
| 5     | `Implementation Plan / 5`                                                                | WAL/lifecycle fault injection and retained-session traceability rows pass at every required transition.                                                                      |
| 6     | `Implementation Plan / 6`                                                                | Hook, CLI, capture, and notification pass through real remote execution; their target-scoped primitives remain future-Agent-Team compatible without implementing Agent Team. |
| 7     | `Implementation Plan / 7`                                                                | All target-local feature providers pass without local fallback or path leakage.                                                                                              |
| 8     | `Implementation Plan / 8` and all `Test Strategy` gates                                  | Security, storage, update, native-target, and normative performance gates pass unchanged.                                                                                    |

Every phase additionally requires zero unresolved Critical or Important review
findings, an updated progress record, and fixed-baseline evidence that the phase
did not regress the established local surface output path.

### Versioned local surface baseline regression procedure

This procedure applies to every phase, not only Phase 3:

The protected live-output path is `pty-host` ring/coalescing/credit → direct
renderer `MessagePort` → singleton `TerminalStreamRouter` → existing
scheduler/xterm. Review each phase at function level and reject any SSH change
that inserts Main relay, remote selection, extra buffering, serialization, or
instrumentation into this local path.

1. Keep the immutable pre-SSH capture, the separately measured repeatability
   batch from that exact revision, and their raw source evidence in
   `local-terminal-regression-gates.v1.json`. For each metric, take the greater
   pre-SSH batch median as the fixed baseline center and add the larger of its
   relative and absolute noise allowance. The contract must recompute declared
   repeatability medians from the retained raw source. Never calibrate from a
   post-change tree.
2. Run `npm run gate:terminal-data-plane`. The runner smoke-checks and builds
   the immutable phase candidate exactly once, then executes the unchanged
   measurement workload for the manifest's fixed repeat count. It must not run
   a build, typecheck, smoke check, or other preparation between measured
   samples. The runner preserves preparation logs, raw profiler output, exact
   failures, environment metadata, and every emitted percentile, including
   p95/p99.
3. Require every run to pass functional continuity and fixed resource bounds.
   These failures are never averaged away. Evaluate latency/resource metrics
   by comparing the candidate repeat median with the fixed baseline limit; do
   not select or omit an emitted outlier.
4. A run may be replaced only when an infrastructure failure prevented complete
   metric emission. Historical single-run absolute latency assertions are
   diagnostic because the immutable pre-SSH source itself had isolated noisy
   failures; the fixed baseline envelope is the phase acceptance result. The
   ADR's remote normative absolute limits remain mandatory and unchanged.
5. If Phase 8 runs adjacent immutable pre-SSH/final-candidate pairs, retain both
   sides as diagnostic environment-drift evidence only. Pair ordering cannot
   gate the phase, replace a candidate sample, or recalibrate the fixed
   envelope; the candidate-only fixed-baseline command remains the sole local
   performance acceptance result.

### Runtime maintenance acceptance procedure

Phase 8 Settings exposes two distinct target-scoped maintenance operations:

1. `Clean Runtime` runs executable-generation GC in place. It may remove only
   idle, unreferenced generations and must leave the connected current/live
   generation and every session/journal/worktree/authority record intact.
2. `Reset Runtime…` is explicit compatibility repair, not state deletion. Main
   must reject it before connecting when a workspace or retained-session record
   references the verified target. `remote-host` must close target attachments
   and the bridge before asking the installer to remove the current generation;
   the installer must still reject any live keeper/process descriptor or shared
   generation lease. Success disconnects the target and forces verified
   reinstall on the next connection while preserving authority and durable
   remote state.
3. Unit tests own exact IPC/protocol decoding and Main/remote-host sequencing.
   Rust tests own descriptor/lease fencing and idle-generation removal. The real
   OpenSSH integration gate must prove live refusal, idle reset, executable
   removal, and subsequent SFTP reinstall of the verified generation.

## Real SSH Test Harness

The harness must test the architecture's system OpenSSH dependency, not replace
it with an in-process JavaScript SSH client or mock server.

### Stack and ownership

- Use Node Testcontainers `GenericContainer` from a separate Vitest integration
  configuration. There is no need to make Docker a prerequisite for the fast
  default `npm test` suite.
- Build a repository-owned, digest-pinned SSH target image containing a real
  OpenSSH `sshd`, SFTP subsystem, Git fixtures, ordinary test users, and tools
  needed by the built `kmuxd` artifact. Do not depend on an opaque third-party
  preconfigured SSH image.
- Invoke the host's system `ssh` and `sftp`, exactly as `remote-host` does. Give
  every suite isolated temporary keys, `ssh_config`, `known_hosts`,
  `ControlPath`, home, install, state, and runtime paths.
- Put `@testcontainers/toxiproxy` between the client and `sshd` for deterministic
  disconnect, reconnect, latency, jitter, timeout, and bandwidth faults while
  the target and keeper remain alive.
- Reuse the same target fixture from Playwright for desktop create/attach/split,
  lifecycle, hook/CLI/capture, future-Agent-Team compatibility, Git/file, and
  forwarding E2E. Do not add Team UI, state, or orchestration coverage in this
  project because that product surface is not implemented here.

References: [Testcontainers containers](https://node.testcontainers.org/features/containers/),
[Vitest global setup](https://node.testcontainers.org/quickstart/global-setup/),
[Toxiproxy](https://node.testcontainers.org/modules/toxiproxy/), and
[OpenSSH ControlMaster](https://man.openbsd.org/ssh_config#ControlMaster).

Preferred layout:

```text
tests/ssh/
  image/{Dockerfile,sshd_config}
  harness/{sshTarget,identity,transportFaults,connectionAudit}.ts
  integration/
  fixtures/
tests/e2e/
  kmux-ssh-remote-workspace.spec.ts
vitest.ssh.config.ts
```

### Harness rules

- Readiness requires both a listening port and a successful expected host-key
  probe; do not rely only on a log line. Start the audited connection baseline
  after readiness probes complete.
- Run a minimal init/reaper as container PID 1 so detached keeper behavior is not
  an artifact of running `sshd` as PID 1.
- Never use `StrictHostKeyChecking=no`, `/dev/null` known-hosts storage, or a
  product-only trust bypass. First use, rejection, change, and rotation use an
  isolated real `known_hosts` flow.
- Count accepted TCP connections and authentication attempts at `sshd` and, when
  useful, at the proxy. Assert the one-master topology instead of inferring it
  from successful commands.
- To test SSH loss, disable the proxy, reset the TCP route, or kill the local
  `ControlMaster`; do not stop the target container. Stopping the target is a
  separate target-loss/reboot test because it also kills keepers.
- Run the actual built `kmuxd` artifact. A fixture stub may test a local adapter
  unit but cannot pass a remote runtime integration gate.
- Exercise SFTP-enabled and SFTP-disabled bootstrap, host-key replacement behind
  the same proxy address, multiple principals/UIDs, and two execution nodes that
  share a home volume.
- Use read-only and bounded `tmpfs` mounts, including `noexec`, for path probes,
  quota, full-disk, journal, and backpressure cases. Keep destructive fixtures
  inside test-owned mounts.
- A ProxyJump scenario uses a separate bastion container. Feature traffic still
  has to converge on the assigned target master and connection-count baseline.

### Test lanes and commands

Introduce stable scripts with these responsibilities; exact filenames may
change if the same separation remains clear:

| Command                                                          | Environment                        | Required evidence                                                           |
| ---------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------- |
| `npm test`                                                       | No container required              | TS unit/contract/reducer/provider tests                                     |
| `cargo test --manifest-path remote/kmuxd/Cargo.toml --workspace` | No container required              | Rust frame, journal, parser, PTY abstraction, lease, and platform contracts |
| `npm run test:ssh:integration`                                   | Container runtime + system OpenSSH | Real Linux SSH/SFTP/PTY/bootstrap/mux/recovery and fault tests              |
| `npm run test:ssh:e2e`                                           | Built desktop + container target   | Playwright user-visible remote workflows                                    |
| `npm run gate:ssh:native`                                        | Actual matching targets            | Four-artifact PTY, isolation, update, shell, and persistence parity         |
| `npm run profile:ssh`                                            | Controlled native targets          | ADR normative workload and latency/resource gates                           |
| `npm run gate:terminal-data-plane`                               | Baseline-compatible local host     | Five-run candidate continuity, bounds, and fixed-baseline latency evidence  |

The required Linux SSH integration CI job must fail with an actionable
prerequisite error when Docker or another configured container runtime is
unavailable; it must not silently skip. Local Docker Desktop works, and other
supported Testcontainers runtimes may be configured explicitly.

Run focused real-SSH integration on pull requests once phase 3 is active. Run
the larger disconnect/fault and desktop matrix on pull requests or nightly as
runtime permits, but keep every release-blocking contract on a required CI or
release gate. Native macOS/Linux x64/arm64 parity and performance require actual
matching runners or VMs. Docker Desktop, shared-host CI, and QEMU may provide
functional smoke evidence only; they cannot satisfy native or normative
performance gates. See [Docker multi-platform build limitations](https://docs.docker.com/build/building/multi-platform/).

## Deviation and Blocker Policy

- If evidence requires changing a core ADR decision, stop that line of work.
  Record the evidence, affected contracts, alternatives, migration impact, and a
  proposed follow-up ADR; report it before implementing a different architecture.
- A non-core implementation choice may change when all ADR contracts remain
  intact and the result is simpler or more efficient. Record material choices in
  the progress file.
- When credentials, signing, a native target, or another external prerequisite
  blocks a required gate, finish safe local work and record the exact prerequisite
  and resume command. Do not mark the gate passed, weaken it, or substitute mock,
  container, or emulated evidence where the ADR requires a native target.

## Final Verification and Report

Before completion:

- resolve every traceability row with passing evidence and leave no required gate
  blocked
- run repository formatting, type checks, lint, tests, builds, packaging,
  `git diff --check`, the full native target matrix, and the unchanged normative
  performance workload
- verify every phase's candidate-only fixed-baseline local-surface evidence;
  retain any final adjacent pre-SSH/candidate run as diagnostic evidence only
- review the cumulative implementation against all of ADR 0005 and relevant ADR
  0002/0003/0004 ownership rules
- search for forbidden parallel IDs/protocols, direct SSH fallback,
  feature-local SSH branching, unbounded queues, path leakage,
  renderer-dispatched result facts, implicit replacement, and undocumented
  fallback paths
- finish with zero Critical or Important findings

The final report includes the delivered feature coverage, phase status,
architecture conformance, exact validation/benchmark/target evidence, all fixed
Critical or Important findings, material decisions, remaining risks, and a
changed-package summary. Do not call the goal complete while any required gate
is blocked.
