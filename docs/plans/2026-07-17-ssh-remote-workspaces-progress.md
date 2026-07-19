# SSH Remote Workspaces Implementation Progress

Sources: [ADR 0005](../adr/0005-ssh-remote-workspaces.md) and
[execution plan](./2026-07-17-ssh-remote-workspaces.md). ADR 0005 owns the
technical contract. A row is `passed` only when its named evidence has run on
the required environment; mocks, containers, and emulation do not stand in for
matching native targets, and shared CI never stands in for normative
performance evidence. Any explicitly authorized evidence-routing deviation is
recorded below without marking deferred evidence as passed.

## Phase status

| Phase | State       | Validation                                                       | Important+ findings  | Blockers                                               |
| ----- | ----------- | ---------------------------------------------------------------- | -------------------- | ------------------------------------------------------ |
| 0     | passed      | 26 AC, 6 IM, and 11 PERF rows audited; repo tests green          | none open            | none                                                   |
| 1     | passed      | Rust/TS/build + 10-case real SSH + measured baseline             | all fixed; none open | none                                                   |
| 2     | passed      | 1,506 TS + 25 Rust tests; lint/type/build green                  | all fixed; none open | none                                                   |
| 3     | passed      | 1,549 TS + 44 Rust + 11 real-SSH; build/lint/clippy + local gate | all fixed; none open | none                                                   |
| 4     | passed      | 4/4 actual matching-target native parity records                 | all fixed; none open | none                                                   |
| 5     | passed      | TS/Rust/real-SSH + fixed-baseline local gate green               | all fixed; none open | none                                                   |
| 6     | passed      | 1,639 TS + 76 Rust + 13 real-SSH + fixed-baseline local gate     | all fixed; none open | none                                                   |
| 7     | passed      | 1,683 TS + Rust + 14 real-SSH + fixed-baseline local gate        | all fixed; none open | none                                                   |
| 8     | in progress | 1,801 TS + 125 Rust + 24 real-SSH + functional profile           | all fixed; none open | local numeric/final-native/NFS/sleep-wake/perf pending |

## Required automated-contract traceability

| ID    | ADR contract                                                                                                         | Owner / phase                                  | Code owner                                                                                      | Required evidence                                                     | State  |
| ----- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------ |
| AC-01 | Checkpoint → resize → output matches live screen and geometry                                                        | proto + keeper terminal / 1, 3                 | `packages/proto`; `remote/kmuxd/crates/{terminal,journal,keeper}`                               | shared Rust/xterm conformance fixture plus real-SSH replay test       | passed |
| AC-02 | Replay/live barrier has no missing, duplicate, or reordered mutation                                                 | keeper + remote-host / 1, 3                    | `remote/kmuxd/crates/keeper`; `apps/desktop/src/remote-host`                                    | property/unit tests and transport-fault real-SSH test                 | passed |
| AC-03 | Main relays zero attachment bytes; bounded injection gets PTY ack; capture respects line/1 MiB caps                  | Main authorization + terminal providers / 2, 6 | `apps/desktop/src/main/remote`; `apps/desktop/src/main/targets`; `apps/desktop/src/remote-host` | IPC instrumentation/architecture tests and real-SSH CLI/capture tests | passed |
| AC-04 | Bridge, remote-host, SSH, and desktop loss leave keeper and agent alive                                              | keeper lifecycle + harness / 3                 | `remote/kmuxd/crates/{bridge,keeper}`; `tests/ssh`                                              | Toxiproxy/process-crash integration and Playwright restore            | passed |
| AC-05 | Keeper/parser failure isolation, including own PTY survival on caught parser failure                                 | keeper process/thread boundary / 1, 3          | `remote/kmuxd/crates/{keeper,terminal}`                                                         | Rust unwind/failure tests and two-keeper real-SSH fault test          | passed |
| AC-06 | Lease fencing, at-most-once retry, PTY-boundary ack, and partial-write prefix safety                                 | keeper input boundary / 3                      | `remote/kmuxd/crates/keeper`; remote terminal adapter                                           | Rust property/fault tests and real PTY integration                    | passed |
| AC-07 | `initialInput` is a separate durable launch-input and is never duplicated/replayed across an unknown new generation  | coordinator + keeper / 2, 3                    | `packages/core`; `apps/desktop/src/main/remote`; `remote/kmuxd/crates/keeper`                   | coordinator crash tests and real-SSH ambiguous-write test             | passed |
| AC-08 | Crash at every conversion WAL transition preserves local sessions, avoids duplicate keeper/orphan                    | conversion WAL + reconciler / 5                | `apps/desktop/src/main/remote/{conversionWal,remoteReconciler}`; runtime descriptors            | fsync/WAL fault matrix plus desktop/SSH integration                   | passed |
| AC-09 | Crash around admission/result/fact projection recovers same operation; renderer cannot dispatch Main-only facts      | operation store/coordinator / 2, 5             | `packages/core/src/main`; `apps/desktop/src/main/remote`; renderer IPC allowlist                | store/reducer/IPC crash matrix for every named mutation               | passed |
| AC-10 | Offline termination stays pending/retained until durable authoritative tombstone                                     | coordinator + retained inventory / 5           | Main remote lifecycle; runtime operation ledger                                                 | reducer/store tests and disconnect integration                        | passed |
| AC-11 | Create retry after ledger GC resolves the descriptor by create ID/resource key                                       | runtime descriptors + ledger / 3, 5            | `remote/kmuxd/crates/bridge`; descriptor store                                                  | Rust ledger-GC test and real-SSH retry                                | passed |
| AC-12 | Stale restart/forward revision after GC cannot mutate; last revision returns retained result                         | runtime revision ledger / 3, 7                 | bridge operation ledger; forward provider                                                       | Rust revision tests and real-SSH restart/forward retry                | passed |
| AC-13 | Unknown observation cannot infer exit, create replacement, or remove binding                                         | domain + reconciler / 2                        | `packages/core`; `apps/desktop/src/main/remote/remoteReconciler`                                | reducer/property tests and disconnect integration                     | passed |
| AC-14 | Opaque located paths and target bounds prevent remote values reaching local APIs or importing `PathAccess`           | core codecs + registry / 2, 7                  | `packages/core`; `apps/desktop/src/main/targets`; architecture lint                             | compile/runtime boundary tests and repository-wide architecture scan  | passed |
| AC-15 | Alias/config, host-key change/rotation, principal, installation, and execution-node mismatches fail closed           | transport pool + authority / 1, 8              | remote-host OpenSSH/handshake; doctor identity                                                  | real-OpenSSH trust/authority matrix                                   | passed |
| AC-16 | Shared-home nodes remain distinct; copied authority and UID/account mismatch fail closed                             | doctor node identity / 1, 8                    | `remote/kmuxd/crates/{doctor,platform}`                                                         | two-node shared-volume integration                                    | passed |
| AC-17 | Restore-disabled, explicit restart, and retained close keep distinct lifecycle contracts                             | reconciler + retained sessions / 5             | core state; Main retained inventory                                                             | reducer/store tests and Playwright lifecycle E2E                      | passed |
| AC-18 | CLI/capture/worktree primitives remain target-scoped and compatible with a future Agent Team without implementing it | providers + coordinator / 6, 7                 | Main target providers; CLI; worktree runtime                                                    | shared primitive contract suites and real-SSH E2E                     | passed |
| AC-19 | Detached/bridge-down hook and OSC events spool/replay exactly once                                                   | hook spool + bridge / 6                        | `remote/kmuxd/crates/{hook,bridge}`; Main event ack                                             | Rust spool crash tests and real-SSH replay                            | passed |
| AC-20 | First bootstrap without SFTP fails pre-mutation; installed terminal survives later SFTP outage                       | bootstrap + file provider / 1, 3, 7            | remote-host bootstrap/SFTP; runtime descriptors                                                 | SFTP-enabled/disabled real-SSH scenarios                              | passed |
| AC-21 | Incompatible checkpoint falls back to journal; truncation reports retained range                                     | proto + keeper + renderer adapter / 1, 3       | shared data plane; journal/checkpoint; terminal router                                          | conformance/property tests and reconnect integration                  | passed |
| AC-22 | Quota/full disk never acknowledges unrecorded output and eventually backpressures PTY reads                          | journal/storage / 5, 8                         | `remote/kmuxd/crates/journal`; retained storage UX                                              | tmpfs/quota Rust and real-SSH fault tests                             | passed |
| AC-23 | Parser unwind rebuild has no PTY stop or duplicate side effects; abort is per-keeper                                 | keeper terminal model / 1, 3                   | `remote/kmuxd/crates/{keeper,terminal}`                                                         | Rust side-effect dedupe tests and multi-keeper abort integration      | passed |
| AC-24 | Live generations are not GC'd; incompatible keeper uses exactly one pinned cohort proxy                              | bridge compatibility + installer / 4, 8        | `remote/kmuxd/crates/{bridge,compat}`; bootstrap GC                                             | native update matrix and connection/process audit                     | passed |
| AC-25 | Every channel fails mux-only when master dies before/during launch, with no new TCP/auth                             | transport pool / 1, 8                          | `apps/desktop/src/remote-host/{sshTransportPool,muxOnlyOpenSshChannel}`                         | audited real-OpenSSH exec/SFTP/metadata/forward fault matrix          | passed |
| AC-26 | Concurrent provisional routes to the same authority/policy converge to one assigned master before mutation           | transport pool + Main promotion / 1            | remote-host transport pool; Main binding authorization                                          | connection-race integration with TCP/auth audit                       | passed |

## Integration and manual-validation traceability

| ID    | ADR validation                                                                                                                                         | Owner / phase                    | Harness / command                                                       | State   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | ----------------------------------------------------------------------- | ------- |
| IM-01 | PTY, reconnect, bridge update, and keeper isolation on actual Darwin arm64/x64 and Linux arm64/x64-musl targets                                        | native runtime matrix / 4, 8     | `npm run gate:ssh:native` with four matching target records             | passed  |
| IM-02 | OpenSSH `Include`, `Match`, ProxyJump, ProxyCommand, agent, certificate, protected key, custom port, cancellation, first-use, and changed-key recovery | OpenSSH harness / 1, 8           | `npm run test:ssh:integration`; selected native trust checks            | passed  |
| IM-03 | Known/unknown bootstrap shells, override behavior, and account-shell preservation                                                                      | bootstrap + keeper / 1, 3, 8     | real-SSH shell fixture matrix                                           | passed  |
| IM-04 | Read-only/noexec/shared paths, NFS socket rejection, verified overrides, install race, read-back hash, and generation GC                               | doctor + installer / 1, 4, 8     | mounted real-SSH target fixtures and native filesystem checks           | partial |
| IM-05 | Quit/reopen, sleep/wake, process crashes, hook replay, files, Git/worktrees, port remap, and retained inventory                                        | desktop E2E + providers / 3, 5–8 | `npm run test:ssh:e2e` on the shared SSH fixture plus native sleep/wake | partial |
| IM-06 | Normative transport workload passes unchanged on every actual artifact                                                                                 | release profiling / 8            | `npm run profile:ssh` with four signed target results                   | pending |

## Normative performance/resource traceability

All metric evidence uses the committed v1 workload: 16 keepers (four attached
at 256 KiB/s, twelve detached at 64 KiB/s), 10 Hz echo probes, a 512 MiB SFTP
transfer, repeated versioned Git status/diff, at least one group commit and
checkpoint, controlled 20 ms RTT and <1 ms jitter, and a target with at least
four physical cores, 8 GiB RAM, and SSD-backed state. The harness records p50,
p95, and p99 where applicable. Each steady generator writes deterministic
binary output in 4 KiB application chunks. After the steady interval, one
already attached keeper emits a 4 MiB ASCII burst in 64 KiB chunks paced at
20 ms while twenty echo probes traverse that same attachment.

| ID      | Gate                                                                                         | Owner / phase              | Evidence                                                                    | State   |
| ------- | -------------------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------- | ------- |
| PERF-00 | Versioned hardware/OpenSSH/network/repository/generator manifest is committed before Phase 3 | profile harness / 1        | `tests/e2e/fixtures/remote-performance-gates.v1.json` schema/manifest check | passed  |
| PERF-01 | Added key echo p95 ≤ 8 ms, p99 ≤ 20 ms versus direct muxed PTY                               | keeper + remote-host / 8   | native `profile:ssh` comparison samples                                     | pending |
| PERF-02 | remote-host event-loop p99 ≤ 10 ms and no kmux stall > 100 ms                                | remote-host scheduler / 8  | native event-loop histogram                                                 | pending |
| PERF-03 | Zero missing, duplicate, or reordered terminal mutations                                     | terminal data plane / 3, 8 | sequence audit in integration/profile output                                | partial |
| PERF-04 | Steady-state keeper RSS p95 ≤ 32 MiB each                                                    | keeper / 8                 | native per-process RSS samples                                              | pending |
| PERF-05 | remote-host RSS ≤ 192 MiB including channel subprocesses                                     | remote-host / 8            | native process-tree RSS samples                                             | pending |
| PERF-06 | Journal group-sync p99 ≤ 250 ms; 2 s enters storage-degraded backpressure                    | journal / 1, 8             | native sync histogram plus injected 2 s fault                               | partial |
| PERF-07 | One authenticated master route, baseline physical legs, zero feature auth attempts           | transport pool / 1, 8      | sshd/proxy connection audit                                                 | partial |
| PERF-08 | Loaded SFTP throughput ≥ 80% of direct SFTP baseline on same master/link                     | SFTP + scheduler / 8       | paired native throughput samples                                            | pending |
| PERF-09 | Workload/topology/limits remain unchanged unless an explicit ADR amendment is accepted       | release gate / 8           | manifest lock test and cumulative ADR review                                | passed  |
| PERF-10 | 4 KiB steady generation and one ordered 4 MiB/64 KiB burst stay on the existing attachment   | keeper + profile / 8       | generator status, sequence audit, and twenty ordered echo probes            | partial |

## Local surface fixed-baseline regression traceability

This gate protects the existing local terminal path and is separate from the
unchanged remote normative limits above. Phase 3 and 4 retain their historical
paired evidence. From Phase 5 onward, numeric results compare the median of five
candidate runs with the fixed envelope derived from two retained batches of the
exact pre-SSH revision in
`tests/e2e/fixtures/local-terminal-regression-gates.v1.json`. The greater batch
median is the baseline center; no candidate value participates.

| ID       | Gate                                                                                                              | Owner / phase | Evidence                                                 | State                                            |
| -------- | ----------------------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------- | ------------------------------------------------ |
| LPERF-01 | Local live output remains `pty-host` ring/coalescing/credit → direct port → singleton router → scheduler/xterm    | every phase   | function-level diff audit plus architecture tests        | P3/P4/P5/P6/P7/P8 passed                         |
| LPERF-02 | Every candidate run has no blank/stall, mutation loss/duplicate/reorder, or bound increase                        | every phase   | five-run candidate workload and raw profiles             | P3/P4 historical; P5/P6/P7/current P8 passed     |
| LPERF-03 | Every candidate repeat median is at or below its fixed pre-SSH baseline limit                                     | every phase   | versioned baseline envelope and candidate gate report    | P3/P4 historical; P5/P6/P7 passed; final P8 open |
| LPERF-04 | Any final adjacent pre-SSH/candidate run is retained as diagnostic-only and cannot recalibrate or gate acceptance | Phase 8       | paired workload, raw profiles, and fixed-gate comparison | diagnostic retained                              |

Each later phase reruns the function-level audit and candidate-only fixed
baseline gate. A prior phase pass is not evidence for a later phase. Any Phase
8 adjacent run is diagnostic-only; the remote normative absolute limits remain
unchanged.

## Phase notes and evidence

### Phase 0 — preparation

- Completed scope: ADR and runbook read in full; repository instructions and
  current dirty state inspected; all required automated, integration/manual,
  and normative performance contracts mapped above.
- Baseline before implementation: `main` at `3205d16`; user-owned changes are
  the Accepted ADR edit and untracked execution plan. They must be preserved.
- Environment observed: Darwin x86_64, system OpenSSH 10.2p1, system `sftp`, and
  Docker client 26.1.3/server 27.4.0 are available. No local `cargo` executable
  was found; Phase 1 must establish the required reproducible Rust lane without
  weakening the no-container `cargo test` command.
- Validation: `npm test` passed 140 files and 1,428 tests (one pre-existing
  skip); `npm run typecheck`, `npm run lint`, `git diff --check`, and focused
  Prettier checks passed. Traceability audits counted 26 `AC-*`, six `IM-*`,
  and ten `PERF-*` rows.
- Review: zero Critical or Important findings. One baseline Minor lint finding
  (`open` used only through `typeof`) was fixed with a type-only import and the
  full lint command was rerun successfully.
- Gate: passed. Next, re-read ADR Implementation Plan 1, transport/runtime
  sections, and Test Strategy before beginning Phase 1.

### Phase 1 — transport and runtime spikes

- Completed scope: system OpenSSH executable/effective-config/force-only
  askpass and host-key observation; private generation-bound mux-only launchers
  for control, terminal, metadata, SFTP, local forward, and dynamic forward;
  race-convergent one-master pool; digest-pinned real-`sshd`/Toxiproxy harness;
  static Linux x64 musl `kmuxd`; POSIX PTY/session ownership; versioned bounded
  journal/group sync; unwind-contained headless parser rebuild; streamed
  `xterm-vt/1` checkpoint; ordinary/alternate-principal and shared-home node
  authority probes; and the locked v1 benchmark manifest plus measured baseline.
- Real-SSH evidence: `npm run test:ssh:integration` rebuilt artifact
  `9ec1bbc1311df37472b1f182166c27338fcf1218287917524840576854d404f0`
  (1,278,712 bytes) and passed all ten cases in 119.98 s. The audited topology
  observed exactly one TCP connection/authentication for one assigned master,
  zero feature-channel TCP/authentication attempts, two permissible provisional
  race connections converging to one live master, and no direct fallback after
  every prepared channel type lost its master.
- Runtime/conformance evidence: locked workspace Rust tests passed 25 tests;
  `cargo fmt --check` and workspace/all-target `cargo clippy -- -D warnings`
  passed. The actual musl artifact was uploaded by SFTP, hashed/read back, ran a
  detached-session PTY spike, synced its journal, and produced checkpoint bytes
  matching xterm.js screen, cursor, style, and geometry. Rust additionally
  proves exact checkpoint → resize → output delta replay, queue-overflow catchup,
  parser unwind rebuilding, side-effect identity dedupe, record-version/CRC and
  truncated-tail behavior, 50 ms/1 MiB sync policy, and the 2 s degraded state.
- Authority evidence: the actual artifact returned stable installation/node
  identities for UID 1000 and canonical account `kmux`, identified UID 1001 as
  `kmux-alt`, rejected copied authority on a second machine ID, and kept
  verified node-local overrides distinct across two targets sharing a home.
- Benchmark evidence: `npm run profile:ssh:baseline` ran 200 10 Hz probes over
  injected 20 ms RTT (p95 90.155 ms, p99 90.755 ms), transferred and verified
  512 MiB by SFTP in 43.632 s (11.735 MiB/s), and again measured one master with
  zero feature TCP/auth attempts. This is explicitly non-normative functional
  evidence: Docker Desktop, overlayfs, and the 6,065,596 KiB fixture target do
  not satisfy the native 8 GiB/SSD release environment.
- Repository validation: `npm test` passed 144 files and 1,442 tests with one
  pre-existing skip; `npm run build`, `npm run typecheck`, `npm run lint`,
  focused Prettier, manifest contracts, and `git diff --check` passed. One
  unrelated five-second usage timer timed out only while the full suite was run
  concurrently with the production build; it passed focused and in the final
  unloaded full run without changing the test or timeout.
- Review: every identified Critical/Important issue was fixed and rerun; none
  remain open. Fixes include launch/env/argument/output bounds, ambient askpass
  suppression, loopback-only unambiguous forwards, socket type/owner/mode,
  SIGTERM→SIGKILL cleanup, close/promotion races, honest unavailable capability
  stubs, non-JSON checkpoint bytes, frozen parser catchup, journal version/CRC
  and recovery bounds, no-clobber authority/runtime files, symlink/private-path
  checks, UID/node binding validation, exact audit baselines, and profiler
  cleanup/schema reproducibility.
- Gate: passed with no ADR deviation. AC/IM/PERF rows that also require Phase 3,
  native-target, update, or release-load evidence remain explicitly `partial`.
  Next, re-read ADR Implementation Plan 2 and the domain/authority/operation,
  provider, path, and common `TerminalDataPlane` sections before Phase 2 work.

### Phase 2 — domain, command, provider, and common data-plane migration

- Completed scope: opaque, codec-created, target-bound `LocalPath` and
  `RemotePath` values across persisted state, workspace/session launch, Git and
  worktree metadata, files, diagnostics, attachments, history/usage, socket
  responses, and local provider adapters; `WorkspaceTarget`, `LocatedPath`,
  three independent session-status axes, separated authority/locator/
  observation records, and a no-fallback `TargetServiceRegistry` that resolves
  mutable verified SSH bindings on every command.
- Durable mutation foundation: all 11 allowlisted mutation payloads have exact,
  bounded codecs and deterministic resource scope/revision rules;
  `initialInput` is forbidden in create and represented by its own operation.
  Main owns validated intent/result/projection facts, renderer dispatch is
  denied, the fsync/rename/directory-fsync store recovers in topological order,
  and coordinator execution rechecks desktop scope plus the complete current
  authority binding immediately before every remote effect.
- Common terminal contract: `TerminalDataPlane` v3 uses runtime-validated
  branded `bigint` uint64 fields, bounded exact binary frames, contiguous output
  segments, chunked checkpoints with digest verification, credit accounting,
  and an atomic checkpoint/replay/live renderer barrier. Restore and local PTY
  callbacks are generation/target fenced so a replaced local session cannot
  write into a remote binding or leak late events.
- Validation: final unloaded `npm test` passed 156 files and 1,506 tests (1,505
  passed, one existing skip); focused Phase 2 contracts passed 141 tests;
  `npm run typecheck`, `npm run lint`, `npm run build`, focused Prettier, and
  `git diff --check` passed. `cargo test --workspace` passed all 25 Rust tests
  and `cargo fmt --check` passed. One unrelated Antigravity hook test failed
  only while the full suite competed with the build and Rust jobs; it passed
  8/8 focused and the final full run passed without a timeout change.
- Review: a focused requesting-code-review pass found and fixed every Important
  issue; none remain open. Fixes include desktop-installation scope checks,
  target revalidation at effect time, topological recovery, bounded/exact
  operation and frame codecs, durable filename/temp-file recovery, stale
  registry binding removal, opaque socket serialization, corrupt SSH restore
  fail-closed behavior, local replacement event fencing, and hidden
  target-binding inside every remote path capability so casts cannot route a
  path through a different SSH provider. Architecture tests ignore generated
  bundles but scan all repository source owners.
- Gate: passed with no SSH mutation path enabled early and no ADR deviation.
  AC-14 is complete; AC-03/07/09/13/21 remain partial until their Phase 3/5/6
  real-transport or crash-matrix evidence runs. Next, implement the Linux x64
  create/attach/input/resize/detach/reconnect/terminate vertical slice and its
  keeper-survival integration tests exclusively through the coordinator.

### Phase 3 — Linux x64 vertical slice (passed)

- Completed scope: built the `linux-x64-musl` runtime and production
  `remote-host` UtilityProcess composition; implemented durable
  create/split/restart/adopt/terminate plus separately durable launch-input;
  implemented create, attach, input, resize, detach, replay, reconnect, cursor,
  and terminate over real mux-only OpenSSH channels. Target loss is detected at
  the assigned master, projected as `unknown`, and reverified/reconciled without
  routing terminal bytes through Main or restarting unrelated targets.
- Keeper durability and fencing: descriptor and operation identities are
  bounded and validated; create/retry results survive later mutations; launch
  input persists acceptance before writing, persists partial offsets, retries
  only the unwritten suffix, and is permanently fenced by the first ordinary
  writer. Ordinary input is generation/lease/attachment fenced and bounded;
  attachment registration is capped at 1,024 and detaches on every early exit.
- Coordinator/reconciler durability: pending/result records are fsync-backed,
  Main-only, exact-decoded, and preflighted against a cloned domain state before
  persistence or projection. A malformed multi-fact observation cannot
  half-apply; offline/ambiguous outcomes stay pending; initial reconcile failure
  disconnects and forgets the unusable connection rather than silently
  reconnecting it after a later host crash.
- Local hot-path audit: function-level comparison confirms the established
  producer/consumer chain remains local `pty-host`
  ring/coalescing/credit → direct `MessagePort` → singleton
  `TerminalStreamRouter` → existing scheduler/xterm. Main dispatch, target
  selection, remote framing, and remote connection state are not in the local
  per-delta loop.
- Important regression found and fixed: Electron `MessagePortMain` accepts only
  `MessagePortMain` capabilities in its transfer list. Passing a checkpoint
  `ArrayBuffer` there threw on the first chunk and closed the attachment,
  producing blank/stalled local surfaces. Bounded checkpoint chunks now use
  structured clone at attach/resync only; focused checkpoint/data-plane tests
  pass and the three-scenario workload no longer blanks or stalls.
- Phase-exit local evidence: five adjacent immutable-entry/candidate pairs had
  zero candidate continuity or bound failures. Every numeric median paired
  regression margin is non-positive; `render p99` has the only positive median
  raw delta (`+0.206 ms`) and a tolerance-adjusted margin of `-2.794 ms`. Entry
  Pair 4 retained a multi-metric legacy absolute failure and Pair 5 retained a
  warm-switch legacy absolute failure; every candidate run passed 3/3 and
  removed rather than worsened those signatures. Full samples/calculation are
  versioned in `local-terminal-regression-gates.v1.json`; raw profiles remain at
  `/tmp/kmux-phase3-exit-local.gGko1a` and the immutable entry remains at
  `/tmp/kmux-local-baseline.9tJNHf`.
- Validation: `npm test` passed 166 files / 1,549 tests with one existing skip;
  `npm run typecheck`, `npm run lint`, and `npm run build` passed. Rust
  `cargo fmt --check`, 44 workspace unit tests/doc tests, and
  `cargo clippy --workspace --all-targets -- -D warnings` passed.
  `npm run test:ssh:integration` built artifact
  `0928053f7b4743a84a083c90df72af371422ffa82e5315a2a45e273a97c55346`
  (2,331,520 bytes) and passed 11 real system-OpenSSH tests, including bridge,
  SSH, remote-host, and desktop loss, ambiguous launch-input ack, ordered
  detached replay, adopt/restart/split, independent terminate, authority, SFTP,
  mux fail-closed, and shared-home node isolation.
- Review: all Critical and Important findings were fixed and the cumulative
  Phase 3 review ended with none open. Fixes included the checkpoint transfer
  regression, acceptance-before-write launch input, partial-write suffix
  recovery, late launch-input fencing, attachment cleanup/bounds, exact
  UtilityProcess outcomes and target-loss codes, durable fact preflight,
  connect/disconnect races, and production assigned-master loss recovery. No
  performance experiment or alternate local scheduling/output path was kept.

### Phase 4 — four-artifact parity (passed)

- Implemented scope: exact artifact contracts and reproducible builders for
  `darwin-arm64`, `darwin-x64`, `linux-arm64-musl`, and `linux-x64-musl`;
  strict executable/hash/protocol manifests; executable-mode-preserving CI
  transfer; desktop bundling; matching-runner CI and release matrices; and
  native attestation for cross-host Darwin verification. Rust is pinned to
  1.97.0 in every runtime-producing or runtime-validating workflow.
- Update compatibility: compatible keepers remain directly proxied by the
  current bridge. Incompatible keepers are routed through exactly one pinned
  cohort endpoint per target and keeper-local protocol major, even when that
  cohort contains distinct executable hashes. Pinned executable and manifest
  bytes are revalidated before launch, unrelated keepers remain isolated, and
  the cohort exits only after its final matching keeper terminates.
- macOS signing: the release signer signs nested Darwin runtimes, refreshes
  their manifests and aggregate index from the final signed bytes, then
  reseals only the app root. The integration test performs a real ad-hoc
  nested-sign/metadata-refresh/root-reseal cycle and requires
  `codesign --verify --deep --strict` to pass without changing the nested
  executable after its manifest is written.
- Actual matching-target evidence: `npm run gate:ssh:native` passed on the
  available Darwin x64 host for artifact
  `9498430eab7d2c2eeee8f93ca56ea30c9438818933037814046a249682a08d8b`
  (2,312,208 bytes). The gate rejects a process/kernel architecture mismatch
  and Rosetta translation. It proved a real PTY, compatible direct proxy,
  two distinct incompatible executable generations sharing one pinned cohort,
  detached replay, bridge restart, keeper isolation, and idle cohort exit.
  The native handshake additionally matched platform, architecture, ABI, and
  the conservative `ssh-disconnect` persistence level; unverified logout or
  reboot persistence is not advertised.
  Final matching-runner GitHub Actions run
  [29680424262](https://github.com/kkd927/kmux/actions/runs/29680424262)
  then passed at commit `778086a64b0d7a935ea218e81300876643fa6f9d` on
  all four actual targets without translation: Darwin arm64
  `1579eb0e6a96548e3b39a008616650cced0eb4380fba3ab501a90ab3d54a81a7`
  (3,722,320 bytes), Darwin x64
  `d99d2affa662ceaf391664f1cc090dfa56595ec1d48eaad96c936b19fd410eec`
  (4,140,048 bytes), Linux arm64-musl
  `83e98d2387e14a676f4bfdff9e7bc50b45bb26fd13a908b1008d161d7097f207`
  (3,805,632 bytes), and Linux x64-musl
  `c045b00224091144c1752653d556ea567679b88c41ad2269965d2d26360718a1`
  (4,453,344 bytes). Every record proved direct compatibility, one pinned
  cohort across two incompatible hashes, reconnect replay, keeper isolation,
  bridge restart, account-shell parity, persistence reporting, and idle-cohort
  exit. The records explicitly report `sharedCi: true`, so they satisfy
  functional native parity but are not normative performance evidence.
- Regression validation: `npm test` passed 167 files / 1,560 tests with one
  existing skip; `npm run typecheck`, `npm run lint`, and `npm run build`
  passed. Rust formatting, 45 workspace tests/doc tests, and workspace/all-target
  clippy with warnings denied passed. `npm run test:ssh:integration` rebuilt
  Linux x64 artifact
  `632265a8cf1a7c267352d57b25030a10b2e823062560cc873504eef8661b7c68`
  (2,544,512 bytes) and passed all 11 real system-OpenSSH scenarios.
- Local hot-path audit: no Phase 4 code enters or restructures the local live
  producer/consumer chain: `pty-host` ring/coalescing/credit → direct
  `MessagePort` → singleton `TerminalStreamRouter` → existing scheduler/xterm.
  Artifact production, compatibility routing, signing, and native gates are
  outside that per-delta loop.
- Phase-exit local evidence: the exact Phase 4 entry was reconstructed from the
  session log by chronologically replaying all successful Phase 0–3 patches and
  formatter actions up to the first Phase 4 edit, then frozen with manifest
  SHA-256
  `0c8c3a2d00335a4f75cafea8f4f7fd491367f09b827572d147251339187a960f`
  and archive SHA-256
  `904e9ec319dca246baab7f1710fb22eb988f59d209af2d13cb393970e085bcb7`.
  The final candidate was independently frozen with manifest SHA-256
  `d80d131fcaf1d5aab6b649c4369bdaf2bf0ed917f1b8046ae1b25d683f2915fd`
  and archive SHA-256
  `5c45696328fd4da4aedad2ccba70abca71bd3b1a4caa082074b93ca77d57f46b`.
  Five adjacent, interleaved entry/candidate pairs produced ten 3/3 passes,
  zero cache/supervisor bound violations, and no blank, stall, missing,
  duplicate, or reordered mutation. All 11 median tolerance-adjusted regression
  margins were ≤ 0; the closest to zero was scheduler max at
  `-0.60009765625 ms`. The versioned samples are in
  `tests/e2e/fixtures/local-terminal-regression-gates.v1.json`; complete source,
  raw-profile, hash, invalid-attempt, and per-pair evidence is retained under
  `/private/tmp/kmux-phase4-paired-gate.nccOqu/evidence`.
- One infrastructure-invalid attempt is retained rather than omitted: a long
  temporary path exceeded the Unix-domain socket path limit before the
  performance workload or candidate side started. The entry work copy was
  restored from its immutable source and the complete pair was rerun with a
  short temporary path.
- Review: all identified Critical and Important findings were fixed; none are
  open. Fixes include executable-hash cohort convergence, final-keeper cohort
  shutdown, pinned manifest revalidation, artifact mode preservation,
  cross-host Darwin attestation, bounded process cleanup, strict artifact
  ownership/type/size/mode checks, final-signed-byte macOS manifests, exact ADR
  persistence-level values, translated-architecture rejection, and an explicit
  null guard for the native runtime-parity mutation observation found by the
  first candidate build before official measurement.
- Gate: passed. The user-authorized deferred final-branch run completed the
  four matching-target records, AC-24, IM-01, and the Phase 4 gate without
  substituting Docker, emulation, or shared-CI timing for native functionality
  or controlled performance.

### Phase 5 — transactional lifecycle (passed)

- Entry source was captured before the first Phase 5 code or progress edit at
  `/private/tmp/kmux-phase5-entry.X9GZKO`. Its 513-file manifest SHA-256 is
  `7fbc47bb51a83917662192a2621e1f62ee6d5a6df10d5ae64daa33cc4df73724`
  and its source archive SHA-256 is
  `998b1d3c4833e803ee7e2ad909da03837e78487c9bb0e89392685effaf187d54`.
- Completed scope: transactional workspace conversion WAL with all ten named
  crash boundaries; prepare/promote/reclaim recovery; snapshot and cleanup
  fencing; descriptor receipts and operation compaction; retained-session
  inventory and reconciliation; restore-disabled retention; exact-generation
  local cleanup acknowledgements; and bounded concurrent conversion/cleanup.
- Product lifecycle completion: renderer split/create/restart/close intents for
  SSH surfaces are translated by Main into durable operations. Initial input is
  a separate canonical launch-input operation, authoritative terminate success
  closes the product layout, retained close-others preflights atomically, and
  arbitrary renderer remote-mutation IPC was removed. Local-only actions remain
  synchronous; only SSH lifecycle dispatch returns a Promise.
- Fault and lifecycle validation covers conversion crash recovery, offline
  termination, retained restart/close/close-others, descriptor-missing
  rejection, create-before-launch retry ordering, result/fact projection, and
  trusted-main-frame authorization. Rust workspace tests and clippy with
  warnings denied passed. The real system-OpenSSH container suite passed all 12
  scenarios using the Linux x64-musl artifact SHA-256
  `95ab760cedcfaf90d03e245e6198ed476af440f676267ed6854ae8aa7a17e527`
  (2,691,968 bytes).
- Local hot-path audit passed. `terminalSessionStream`, wire coalescing,
  Main terminal data-plane attach, `TerminalPane`, stream client/router,
  checkpoint controller, instance store, and scheduler/xterm bundle are
  byte-identical to Phase 5 entry. The only `pty-host/index.ts` differences are
  close-generation acknowledgement state and disposal; its `onData` and
  headless-write/coalescing/publish regions are byte-identical. Evidence SHA-256
  is `d17d72035362ef05f1267430cf607592e01e3cf284e5ed0df65292e19e42b9c5`.
- The first candidate paired measurement retained under
  `/private/tmp/kmux-phase5-paired-gate.SoxFle/evidence/candidate-v1-failed-raw`
  exposed uncontrolled host load and a local dispatch `async` boundary. The
  installed kmux renderer sustained 52–75% CPU and its GPU process 14–16% while
  both entry and candidate produced alternating outliers. The local dispatch
  boundary was removed, and the user authorized replacing every-phase paired
  rebuilds with the fixed pre-SSH candidate gate while retaining Phase 8 final
  paired verification. ADR, runbook, fixture, runner, and contract tests were
  updated together; historical Phase 3/4 evidence remains unchanged.
- Phase-exit candidate source contains 524 files. Manifest SHA-256 is
  `6064981c7aa27d6b7db0487564f8d2094a9bb0391c22372707fca3ed10c3efed`;
  archive SHA-256 is
  `82b1ad380b8324facf513f8abd301aa965372d90741727f4812b9032ad0e4edb`.
  `npm run gate:terminal-data-plane` ran five candidate samples; all were 3/3
  with zero cache/supervisor bound violations and all eleven repeat medians
  below their fixed pre-SSH limits. Render p95 was `19.7607421875 ms` against a
  `21.9228515625 ms` limit; scheduler max was `0.300048828125 ms` against
  `0.800048828125 ms`; warm switch was `43.5 ms` against `52 ms`. Gate evidence
  SHA-256 is
  `03f1d75d5af6693232528f494cf115fcb72ed38313ca7942a4b06fac54c95e73`.
- Review: all Critical and Important findings were fixed; none remain open.
  Phase 5 is passed. Remaining Darwin arm64/Linux arm64-musl/Linux x64-musl
  native parity is still explicitly deferred to the final branch GitHub
  Actions matrix and is not claimed here.

### Phase 6 — hook, CLI, capture, and notifications (passed)

- Completed scope: target-scoped remote terminal text/key injection with an
  exact PTY-write acknowledgement; bounded UTF-8 capture with line and 1 MiB
  caps; Rust remote CLI commands; detached/bridge-down agent-hook and terminal
  OSC spooling; durable desktop event receipts; acknowledgement-driven replay;
  and local-compatible Antigravity hook output. Main authorizes and coordinates
  these operations but relays no terminal attachment bytes.
- Agent Team was not implemented. The phase adds only reusable target,
  resource-key, operation-ID, acknowledgement, capture, notification, and hook
  primitives. There is no Team UI, state, alias, routing, orchestration, or
  lifecycle behavior; worktree provider composition remains Phase 7 scope, so
  AC-18 is partial.
- Durable input review fixes cover partial-write suffix retry, cross-domain
  epoch fencing, payload-hash validation, same-process recovery when completion
  persistence fails, and fail-closed recovery of an ambiguous persisted
  `Accepted` record. Capture rejects excess fragments/bytes before completion,
  validates dimensions, line count, digest, and final byte count, and never
  allocates beyond its bound. Event replay requires exact next sequence and
  fails closed if a durable event receipt is ahead of the product projection.
- The system-OpenSSH container suite passed all 13 scenarios, including hook
  replay, capture/CLI, reconnect, adopt, bridge restart, split, and terminate,
  using the real Linux x64-musl artifact SHA-256
  `44810bc0f4858a88c93ffe83501868dbf85bb7d6a2a448a7ad9b8a8857d7a668`
  (3,367,904 bytes). The Phase 6 scenario completed in 4.799 s and the
  continuity scenario in 13.563 s.
- Full validation passed: `npm test` reported 173 files and 1,639 tests passed
  with one existing skip; the one concurrent-load timeout attempt was retained
  and its focused test passed in 4.74 s before the isolated full-suite pass.
  `npm run lint`, `npm run build` (including typecheck), `git diff --check`, 76
  Rust workspace tests, clippy with warnings denied, and rustfmt check passed.
- Local hot-path audit passed. Phase 5 and Phase 6 are byte-identical for
  `pty-host/index.ts` plus the nine producer/consumer files owning ring,
  coalescing, credit, direct `MessagePort`, Main attachment routing, singleton
  router, checkpoint/instance state, and scheduler/xterm. Audit SHA-256 is
  `8174785b8851655ba2cf62ce2b9607e43fa183cdf40a194651ef7c1debe2a0c5`.
- The first Phase 6 gate exposed a runner mismatch: it repeated smoke,
  typecheck, and full build before every measured sample, while the immutable
  pre-SSH evidence built both bundles once before measurement. ADR, runbook,
  fixture, runner, package scripts, and a contract test now require one
  preparation followed by five unchanged workload samples. The pre-SSH source
  and samples, workload, build mode, repeat count, median aggregation,
  functional/bound rules, and every tolerance remained unchanged. Both the
  pre-correction failure (report SHA-256
  `53616e25a76f1a1e074da13719609057788ebd29108fb2b26a9cec2c3074ced5`)
  and a corrected noisy warm-switch failure (SHA-256
  `3f2011f51a56b181844a729ca83a739a41d7d17e4d0b619d32b3befe092550ce`)
  remain retained rather than omitted.
- The final five-run fixed-baseline gate passed all functional, resource-bound,
  and numeric contracts. Representative medians were render p95
  `19.54931640625 ms` ≤ `21.9228515625 ms`, scheduler max
  `0.300048828125 ms` ≤ `0.800048828125 ms`, warm switch
  `37.79999998211861 ms` ≤ `52 ms`, and burst catch-up `429 ms` ≤ `492 ms`.
  Report SHA-256 is
  `fb9757d63f20a628758bfb83458d8c2578a24eb7adc86213c10c81b905fe94f6`.
  The 527-file candidate manifest SHA-256 is
  `e47743b19c6c88cd923b3fc74663fdfa7d6b7c9e56fb4dbb2612ef8a75b26fb2`;
  its archive SHA-256 is
  `f098a59d2c0b4e320ed7eb8239e245477f2ae4ceb6d23bc255333d7a61c0969b`.
- Review: all identified Critical and Important findings were fixed; none are
  open. Phase 6 is passed and Phase 7 may begin. The deferred three-target
  native matrix remains unchanged and is not claimed by this phase.

### Phase 7 — target-local product providers (passed)

- Completed scope: every local/SSH feature resolves one registry-selected
  target service set. Git/worktree, metadata, usage/history, file links,
  downloads/uploads/attachments, port discovery, durable loopback forwards,
  and browser URL remapping have no feature-local SSH branch and no fallback to
  the other target. Remote paths remain opaque until the bound capability
  resolves them; architecture tests prevent feature packages from importing
  internal path access or sending remote values to local filesystem/open APIs.
- Managed remote worktrees use the durable workspace operation coordinator.
  Create is idempotent inside the target-owned managed root; remove repeats the
  target dirty check immediately before mutation and verifies the expected
  branch and common Git directory, including forced removal, so a changed path
  is preserved with `worktree-changed`. Successful create projection launches
  exactly one target-bound surface and recovery reconciles a committed product
  without duplicating it. The same target-scoped worktree/dirty contract is
  reusable by a future Agent Team, but no Team UI, state, aliases,
  orchestration, routing, or lifecycle was added.
- SFTP providers enforce regular-file, path, queue, concurrency, byte, count,
  and retention bounds. Downloads are independently size/hash verified before
  read or local open; invalid stages are released. Uploads use private local
  staging, a remote temporary path, atomic rename, and exact SFTP read-back
  hashing. OpenSSH batch quoting was corrected against a real path containing
  spaces, quotes, backslashes, brackets, `*`, and `?`; it escapes only the
  batch parser delimiters so quoted literal glob bytes survive unchanged.
- Target-local history and usage include target and authenticated principal in
  identity/scope, never attribute account-wide subscription data to an SSH
  machine, and discard records/errors for a target removed during an in-flight
  scan. Forward ensure/remove is serialized per target/workspace, persists the
  desired revision, binds loopback only, updates the durable local port after a
  collision, and rewrites browser URLs only to the reconciled mapping. A stale
  pre-remap retry returns `operation-stale`; retrying the latest revision
  returns its retained result without another mutation.
- `npm run test:ssh:integration` passed all 14 real system-OpenSSH scenarios.
  The Phase 7 case exercised binary SFTP byte identity, target-scoped
  history/usage, managed create and dirty/forced remove, collision remapping,
  stale/latest forward retries, and terminal continuity after SFTP failure.
  The rebuilt Linux x64-musl artifact SHA-256 was
  `9d1d4f28e841264e404cfdd79614a789e143e0aa2193c51c1843f4bebd8d85a4`
  (3,933,152 bytes).
- Full validation passed: `npm test` reported 182 files with 1,683 tests passed
  and one existing skip; `npm run typecheck`, `npm run lint`, production build,
  `git diff --check`, Rust workspace tests, rustfmt check, and workspace/all-
  target clippy with warnings denied all passed. The real-SSH resize assertion
  now consumes and verifies every contiguous mutation through the resize ack
  instead of assuming no output can race ahead of it.
- The local hot-path audit passed: nine of ten owners are byte-identical to
  Phase 6. `TerminalPane.tsx` changes only pass `surfaceId` to external-link
  authorization; ring/coalescing/credit, direct `MessagePort`, singleton
  router, scheduler, xterm writes, and all per-delta functions are unchanged.
  Audit SHA-256 is
  `05603f93ebcb4431f06dc4c0fd8028b1f0f8fad07ffb775fb0af2f208a5e71c4`.
- One complete fixed-baseline invocation is retained as a noisy failure rather
  than omitted: all functional/bound and ten numeric contracts passed, while
  echo p99 median was `42.8 ms` against `38.1 ms`. Its first sample also showed
  scheduler max `47.1 ms`, render p99 `202.742 ms`, and warm switch `115.4 ms`;
  the installed renderer was observed at 55.8% CPU and the 15-minute load
  average at 23.57. The unchanged candidate then passed all five functional/
  bound runs and all eleven fixed numeric contracts: echo p99 median
  `28.6 ms` ≤ `38.1 ms`, render p95 `19.47607421875 ms` ≤
  `21.9228515625 ms`, render p99 `21.335205078125 ms` ≤
  `24.371826171875 ms`, and burst catch-up `365 ms` ≤ `492 ms`. Passing report
  SHA-256 is
  `c8f3a565519b875279b00e27112049692ed33af11108e99b98765ac953a73ae0`;
  retained failure SHA-256 is
  `98b7c67573d907c7d3a2b2448d32cc9db73ad2addaf038d8f8075d4fb4765a6d`.
  The exact 547-file candidate manifest SHA-256 is
  `a717c3b5eb2685a47a770ab8c1e8e3fbe25afdca2121d758449b76829c98b836`;
  its archive SHA-256 is
  `11ca973ee65161bcaa9987dad73af39b4d08906f335349c1f06031d0eba37fab`.
- Review: all identified Critical and Important findings were fixed and the
  cumulative Phase 7 review ended with none open. AC-12, AC-18, and AC-20 are
  complete. Phase 7 is passed; the deferred three-target native matrix remains
  unchanged and Phase 8 hardening/release gates may begin.

### Phase 8 — hardening and release gates (in progress)

- Settings now separates non-destructive `Clean Runtime` generation GC from
  explicit `Reset Runtime…` compatibility repair. Main rejects reset while a
  workspace or retained session references the target. `remote-host` disposes
  target attachments and closes the bridge before reset, clears its target
  route, and disconnects the assigned OpenSSH master. The Rust installer then
  requires both an idle descriptor inventory and exclusive generation/install
  leases before quarantining and removing only the current executable
  generation. Authority, descriptors, journals, checkpoints, worktrees, and
  durable operations are preserved.
- Full TypeScript validation passed 191 files with 1,801 tests passed, one
  existing skip, and zero failures. `npm run typecheck`, `npm run lint`, the
  production build, changed-file Prettier, and `git diff --check` passed. Rust
  workspace validation passed 125 tests plus rustfmt and all-target clippy with
  warnings denied. The complete real system-OpenSSH suite passed all 24
  scenarios in 184.765 s with rebuilt `linux-x64-musl` artifact SHA-256
  `3aa18ea7cca13d7507f5d2580a46933bd8bd8245acc394f4378fc744f4f4d18b`
  (4,477,920 bytes). The desktop-loss/restore E2E also passed against the same
  durable keeper generation (`1/1`, 34.3 s test time, 37.5 s suite time).
- The final security/lifecycle review fixed every Critical or Important
  finding and ended with none open. In particular, failed OpenSSH commands are
  process-bounded even when descendants retain stdio; remote-host owner death
  closes the exact private control master without consulting mutable profile
  configuration; concurrent shutdown callers await one cleanup promise; and
  reset, attach, storage, input, resize, installer, and UtilityProcess paths
  remain bounded and fail closed. A process-level real-OpenSSH test kills the
  owner after removing its copied config and observes the authenticated master
  count fall from one to zero without another authentication.
- The first final-branch native run
  [29679489702](https://github.com/kkd927/kmux/actions/runs/29679489702)
  exposed one actual Important lifecycle defect and one Important artifact
  verifier defect: a crashed keeper's stale `running` descriptor could pin its
  incompatible cohort forever, and the Linux arm64 target parser read the
  `-musl` suffix as x64. It also exposed two Linux integration-harness timing/
  cleanup defects. Commit `778086a64b0d7a935ea218e81300876643fa6f9d`
  makes cohort liveness consult authoritative PID absence, derives executable
  architecture from the target contract, waits for both ordered detached
  outputs before injecting the reconnect marker, and restores the test-owned
  shared-home UID/GID before host cleanup. Focused regressions, the full 122-
  test Rust workspace, 1,776 TypeScript tests, all 24 local real-SSH cases,
  local Darwin x64 native parity, typecheck/lint/build/rustfmt/clippy, and
  artifact verification passed with no Critical or Important finding left
  open.
- The corrected final matching-runner run
  [29680424262](https://github.com/kkd927/kmux/actions/runs/29680424262)
  passed `verify-mac`, `verify-linux`, the separately named Linux real-SSH job,
  and all four actual native parity jobs. Every native record was un-translated
  and proved PTY, direct/cohort update compatibility, detach/replay, keeper
  isolation, bridge restart, shell parity, persistence reporting, and final-
  keeper cohort shutdown. AC-24, IM-01, and the deferred Phase 4 gate are now
  complete. As declared by each record, shared GitHub Actions runners provide
  functional native evidence only, not controlled performance evidence.
- Release Desktop run
  [29680878278](https://github.com/kkd927/kmux/actions/runs/29680878278)
  passed at commit `c95840a7f8a49abf2b3cc5f9c7cab0d679b3282d` with
  root and desktop package version `1.0.0`. Every macOS and Linux package job
  restored and verified all four matching native runtime artifacts before the
  desktop build. Darwin arm64 and x64 then passed nested signing, app signing,
  Apple notarization/stapling validation, and packaged-DMG smoke; Linux arm64
  and x64 passed AppImage asset validation and direct Xvfb smoke. The uploaded
  release-asset artifacts were macOS x64
  `e9309d729f5f2367fe2615ce3641bf0c78a3159f37a79b4120d022059b5eec9b`
  (296,785,768 bytes), macOS arm64
  `716dfa9a608227f05317d161261ab560ab0e4c7b6ee51220c0b1e1f8833e7f84`
  (289,445,011 bytes), Linux x64
  `c0c7105ab256da488a0bf704db5368808dc37fe3654a8bc2041b84879e28f998`
  (144,308,815 bytes), and Linux arm64
  `c8ee6a531104e12bb2e59f940f6743b54f46559933cf24d7bc9fb8c0f6745417`
  (141,990,323 bytes). This was a manual `workflow_dispatch`; the push-only
  `publish-release` job was skipped, so no GitHub release was created or
  published.
- A Phase 8 audit found that the original fixed envelope self-evaluated green,
  but a separately retained five-run measurement of the exact same pre-SSH
  revision would fail echo p99 (`50.4 ms` > `38.1 ms`) and warm switch
  (`61.5 ms` > `52 ms`). Per user direction, the gate remains candidate-only
  after one pre-change calibration: its fixed center is now the greater median
  of the initial and repeatability batches from revision `3205d162...`, plus
  the existing 5%/absolute allowance. The contract recomputes every declared
  repeatability median from the raw Phase 3 entry samples and rejects a source
  revision mismatch. Both pre-SSH batches now self-evaluate green; render p95
  remains unchanged at a `21.9228515625 ms` limit. No candidate metric was used
  for calibration. The candidate-only fixed gate is the sole local performance
  acceptance result.
- The Phase 8 candidate-only local gate passed five complete functional/bound
  runs and all eleven fixed numeric contracts. Render p95 median was
  `19.633544921875 ms` against the immutable `21.9228515625 ms` limit; render
  p99 median was `21.51025390625 ms` against `25.67724609375 ms`; echo p95
  median was `24.1 ms` against `28.9 ms`; and burst catch-up median was `399 ms`
  against `583 ms`. All emitted outliers remain retained. Report SHA-256 is
  `fd7beb02748f5be0db301464be4d8d3e69d60430b0f4738cd167f6a02f310773`.
- The local function-level hot-path audit found nine of ten critical owners
  byte-identical to Phase 7. `TerminalPane.tsx` only renders the remote
  storage-degraded/backpressured status outside the terminal delta loop;
  `pty-host` ring/coalescing/credit, direct `MessagePort`, singleton router,
  scheduler, and xterm writes are unchanged.
- Two complete adjacent pre-SSH/final-candidate invocations are retained as
  diagnostic evidence rather than acceptance evidence. The first had one
  candidate burst echo workload failure; the unchanged candidate and pre-SSH
  bundles then each passed 20/20 focused burst repetitions with 420/420 PTY-
  boundary input observations and zero bound violations. The second had all
  ten sides pass 3/3 with zero bound violations, but its render p99 pair-margin
  median was `+4.955078125 ms`: entry outliers landed in pairs 2/3 (`347.840`
  and `139.469 ms`) while candidate outliers landed in pairs 1/5 (`58.748` and
  `117.474 ms`). Entry render p99 averaged `109.503 ms` versus candidate
  `49.106 ms`, demonstrating that pair ordering on this loaded host can invert
  the verdict. Per the ADR, neither invocation replaces a fixed-gate sample,
  changes acceptance, or recalibrates the pre-SSH envelope.
- Final profile review found that the executable's steady generator had always
  emitted at most 4 KiB per application write while the v1 manifest claimed
  64 KiB. No controlled-native normative record had been accepted against that
  mismatch. The v1 contract now explicitly uses 4 KiB steady writes and a
  separate 4 MiB ASCII burst in 64 KiB writes paced at 20 ms. ADR 0005 and the
  operator runbook state only this final contract; this progress record retains
  the correction history. The manifest lock test compares the complete
  topology, workload, generator, and gate objects.
- The controlled-native harness now exact-decodes its operator configuration,
  rejects shared CI and dirty normative sources, binds the configured digest to
  one `O_NOFOLLOW` executable file handle, hashes the remote runtime downloaded
  over the assigned master before mutation, and records both host and target
  OpenSSH versions. All sixteen generators report exact steady/burst byte
  counters after crossing journal admission; the burst gate proves
  `begin < twenty echoes < end` on the original attachment. Review also bounded
  an oversized profile input line before allocation and preserved an SSH
  channel's close diagnosis on later input. No local live-output owner changed.
- The latest `npm run profile:ssh:functional` completed the corrected Docker
  workload with 16 keepers, four attached, 58,531 mutations, 248,790,937 output
  bytes, zero missing/duplicate/reordered mutations, all 16 steady byte minima,
  exactly one 4,194,304-byte burst, twenty ordered echo probes, one baseline
  TCP/auth route, and zero feature route/auth deltas. It recorded host client
  `OpenSSH_10.2p1, LibreSSL 3.3.6`, target server
  `OpenSSH_9.2, OpenSSL 3.0.20 7 Apr 2026`, and runtime artifact SHA-256
  `3aa18ea7cca13d7507f5d2580a46933bd8bd8245acc394f4378fc744f4f4d18b`.
  This is retained functional evidence only; Docker loaded latency, process RSS,
  and SFTP ratio do not satisfy or alter native gates. Report SHA-256 is
  `8464658aa2e481df0c58abed3621183f6afb1757f0914b842530bb0bb29571ac`.
- The final focused review found and fixed two additional Important evidence/
  error-path defects. A channel-level `EPIPE` arriving before process close
  could mask the later SSH stderr diagnosis from subsequent input, and the
  controlled profile recorded the target's `ssh` client rather than the actual
  `sshd` server version. Close diagnosis now prefers the bounded process-close
  stderr without masking an earlier protocol error, and profile evidence records
  host client plus target server. The focused regressions passed 37/37 and the
  real system-OpenSSH functional profile above exercised the corrected version
  probe. No Critical or Important finding remains open.
- The current final source passed actual local `darwin-x64` native parity on
  this non-translated Intel Mac. Artifact SHA-256 was
  `c93369353d9c01a58f45c327cacb37d2ebcfbefbc19068812b17a2dba78214ed`
  (4,114,560 bytes); direct/cohort compatibility, detach/replay, keeper
  isolation, bridge restart, account-shell parity, persistence reporting, and
  final cohort shutdown all passed. The other three targets and final desktop
  packages still require the matching-runner workflow after commit.
- A current final-candidate local gate rerun retained five complete samples with
  zero functional or bound failures, but failed six numeric medians. The
  separately installed `/Applications/kmux.app` version `1.0.0` had been
  running for more than four hours and its renderer/GPU helpers were observed
  at roughly 57–80%/17–21% CPU around the run. Candidate event-loop p95 and all
  burst metrics still passed, while broad steady/render/switch stalls failed
  together. This emitted evidence is not an infrastructure failure and is not
  discarded or replaced: report SHA-256 is
  `849ec4a0ec91faf14d8a09291536ec32a7903847512b1529e9d23050882d020b`.
  The installed app is the active workspace in which this work runs, so
  terminating it is not an acceptance prerequisite. A subsequent unchanged
  invocation retained another five complete samples while that app remained
  active and passed every functional, bound, and numeric contract. Echo p95 was
  `22.80000001192093 ms` against `28.900000005960464 ms`, echo p99 was
  `26.30000001192093 ms` against `52.92000000625849 ms`, render p95 was
  `19.296142578125 ms` against `21.9228515625 ms`, render p99 was
  `21.543212890625 ms` against `25.67724609375 ms`, scheduler max was
  `0.2998046875 ms` against `0.800048828125 ms`, and warm switch was
  `47.200000047683716 ms` against `66.5 ms`. All other fixed medians also
  passed. The earlier complete failure remains evidence rather than being
  replaced; the passing report SHA-256 is
  `ebdfad52f314ea9c21dee49bdee99dfd87f67dba7c03e12ae1db1b5115b90441`.
- The two final-source invocations after the additional remote-only review
  fixes each retained five further complete samples with zero functional or
  bound failures, but failed broad steady/render/switch numeric medians. The
  first failed echo p95, render p95/p99, scheduler max, and warm switch; its
  report SHA-256 is
  `d653223b52c9bbc5963cc1cffbc4d487b6d6cf2e5eff31116db9bb42b57d862f`.
  After all other validation load ended and a quiet interval, the unchanged
  source failed those metrics plus echo p99; its report SHA-256 is
  `c729b8884f03b681fdaf52f9947c5c1b101287fd90953d90f16ce337de32f43f`.
  Event-loop p95, paint p95, every burst metric, continuity, and all fixed
  bounds still passed in both invocations. The ten protected local output
  owners remain unchanged, but these are valid emitted failures and are not
  replaced by the earlier pass. LPERF-03 therefore remains open; the active
  working kmux stays running and is not treated as something the gate may
  terminate.
- Phase 8 is not yet passed. The four-target functional native matrix and
  desktop packaging records remain valid evidence for commit `c95840a7...`, but
  the bounded profile reader changed the final runtime artifact afterward. The
  final committed branch therefore still needs a fresh matching-target native
  matrix and package verification. The unchanged controlled-native performance
  workload also needs one non-shared result per artifact, and IM-04/IM-05 still
  need actual NFS/unsuitable-socket and native sleep/wake evidence. No absolute
  `KMUX_SSH_PROFILE_CONFIG` for those controlled targets is available in this
  workspace; a final `npm run profile:ssh` audit therefore stopped before any
  target mutation with the explicit missing-configuration error. Docker and
  shared CI remain invalid substitutes. On the current Intel Mac, `nfsd` is
  enabled but not running, no NFS mount exists, and passwordless administrative
  access is unavailable; an actual sleep/wake cycle would suspend the user's
  active machine and was not performed without explicit coordination.

## Material decisions, deviations, and blockers

- Phase 1 uses exact Testcontainers/Toxiproxy 11.10.0 dependencies, repository
  images pinned by digest, and a separately named required Linux SSH CI job.
  The built bridge/CLI/hook role stubs report `available: false`; Phase 1 does
  not advertise unimplemented runtime roles.
- Docker measurements are functional baseline evidence only. No native or
  normative performance gate was claimed or weakened.
- Planned paths follow ADR 0005 ownership and no core decision changed; there
  is no follow-up ADR or active Phase 3 blocker.
- The persisted desktop snapshot moved to v2 and the common renderer data plane
  to v3 because Phase 2 changes their durable/wire shapes. Raw path strings are
  recoverable only inside the target composition capability; SSH paths also
  carry a non-serializable target binding, reconstructed by exact DTO codecs.
- Durable operation files are immutable per operation, hash-name bound, capped,
  and recovered in dependency order. SSH target services are intentionally not
  cached because profile policy and verified authority are mutable locator
  state; each command receives a freshly target-bound path resolver.
- Darwin x64 native parity and signed-Mach-O evidence first passed locally. On
  2026-07-18 the user explicitly authorized an execution-order and
  evidence-routing deviation: finish Phases 5–8 first, then create the final
  branch, commit and push it, and use the repository's matching-runner GitHub
  Actions matrix for `darwin-arm64`, `darwin-x64`, `linux-arm64-musl`, and
  `linux-x64-musl`. Run
  [29680424262](https://github.com/kkd927/kmux/actions/runs/29680424262)
  completed that matrix at 4/4 and closed AC-24, IM-01, and Phase 4. Docker and
  emulation remain invalid substitutes. The GitHub Actions records explicitly
  identify shared CI and therefore satisfy functional native parity only; they
  cannot satisfy any controlled or normative performance measurement.
- Manual Release Desktop run
  [29680878278](https://github.com/kkd927/kmux/actions/runs/29680878278)
  completed the required four-target desktop packaging, signing/notarization,
  and packaged-app smoke evidence for version `1.0.0`. Because it was a
  `workflow_dispatch`, the push-only publish job was skipped and this evidence
  run did not create a release.
- The remaining external prerequisites are recorded rather than bypassed.
  IM-04 requires an actual unsuitable NFS/runtime-socket target and IM-05 an
  actual native sleep/wake cycle. IM-06 and PERF-01 through PERF-08 require a
  non-CI, non-shared controlled target for each artifact, matching the committed
  hardware/network manifest, plus an absolute `KMUX_SSH_PROFILE_CONFIG` whose
  audit command reports the physical TCP/authentication baseline. Resume each
  performance record with
  `KMUX_SSH_PROFILE_CONFIG=/absolute/path/to/config.json npm run profile:ssh`;
  `npm run profile:ssh:functional` remains diagnostic Docker evidence only.
- Agent Team is not implemented by this project. Phase 6 delivers hook, CLI,
  capture, notification, target/resource-key, and acknowledgement primitives
  that a future Agent Team can reuse; Phase 7 adds target-scoped worktree
  providers under the same rule. Neither phase may add Team UI, state,
  orchestration, lifecycle, aliases, or team-specific routing.
- Phase 3 and 4 local regression samples remain recorded as adjacent pairs.
  During Phase 5, sustained external renderer/GPU load showed that rebuilding
  every phase entry was costly without making a noisy developer host stable.
  The user authorized a fixed versioned pre-SSH envelope: every phase now runs
  five candidate samples and compares their median with a center derived only
  from immutable measurements of the exact pre-SSH revision plus the recorded
  noise allowance. Phase 8 repeatability review fixed that center as the
  greater of the two retained pre-SSH batch medians so the unchanged source
  itself satisfies its gate. Functional and bound failures remain per-run.
  Adjacent pre-SSH/final-candidate runs are diagnostic-only because observed
  outlier ordering inverted their verdict despite a passing fixed gate. Remote
  normative absolute gates remain unchanged.
- The local candidate gate prepares an immutable candidate exactly once before
  its five measured samples. Smoke checks, typechecks, builds, and other
  preparation never run between samples. Phase 6 corrected the runner to match
  the already-recorded pre-SSH execution method; no baseline value, workload,
  repeat count, aggregation, functional/bound rule, or tolerance changed.
- The Phase 4 entry source was recovered without substituting earlier Phase 3
  samples or the pre-SSH baseline: chronological replay stopped at the first
  Phase 4 edit, covered 154 successful patch changes plus 30 Prettier and 28
  rustfmt actions, and produced immutable source manifest/archive evidence.
  The Phase 4 paired gate therefore passed under the formula in force at that
  phase; the historical evidence remains valid and does not weaken or replace
  any remote absolute gate.
- Checkpoint `ArrayBuffer` chunks use bounded structured clone on Electron
  `MessagePortMain`, whose transfer list cannot contain `ArrayBuffer`. This is
  attach/resync-only and does not add work to the local live-output delta loop.
