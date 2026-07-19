# 0005: SSH Remote Workspaces and the kmux Remote Runtime

## Status

Accepted

This ADR fixes the architecture and final feature contract for SSH remote
workspaces. Implementation is staged, but the stages are not permission to
silently change the decisions below. If either spike disproves a core decision,
the replacement must be recorded in a follow-up ADR.

## Context

kmux does not currently have first-class SSH workspace support. A user can run
`ssh` inside a local terminal, but that makes SSH an opaque child process rather
than a kmux workspace location. kmux then cannot reliably know which machine
owns a path, process, port, Git repository, agent session, or terminal stream.

That is insufficient for kmux's primary product requirement: coding-agent
output must stay stable, readable, and attached to the correct conversation
while users switch surfaces, split panes, restore the desktop, and recover from
network loss.

First-class SSH support must therefore cover more than remote shell launch:

- remote PTYs must survive loss of the desktop connection
- terminal restore must not silently lose, duplicate, or reorder agent output
- a stale remote session reference must never create a replacement local shell
- local and remote paths must remain distinct at the domain-model boundary
- agent history, usage, hooks, notifications, Git, files, and ports must carry
  remote target identity
- SSH aliases and connection settings may change without silently rebinding an
  existing workspace to a different machine
- large file or Git traffic must not make active agent terminals unresponsive
- remote setup must not require the user to install Node, npm packages, a
  compiler toolchain, `tmux`, `screen`, or `zellij`

Comparable products validate the local-UI/remote-runtime pattern:

- VS Code Remote SSH keeps the UI local and runs a server beside remote files
  and processes. The architecture is instructive, but VS Code Remote Development
  components and VS Code Server are not reusable product dependencies.
- cmux uses a remote helper for SSH workspaces, CLI relay, and session
  management.
- Orca uses a remote relay to own PTYs and provide remote filesystem, Git,
  hooks, reconnect, and port features. Its implementation also demonstrates two
  failure modes this ADR avoids: installing native npm dependencies on the
  remote host and placing interactive PTY traffic behind bulk traffic on one
  ordered application channel.

References:

- <https://code.visualstudio.com/docs/remote/faq>
- <https://cmux.com/docs/ssh>
- <https://github.com/stablyai/orca>
- <https://github.com/stablyai/orca/blob/20ebe858af628f3e2b5f73838310636dec6fe0ed/docs/reference/ssh-typing-latency-under-relay-load.md>

The architectural pattern is:

```text
local desktop UI
  <-> authenticated SSH transports
remote runtime beside files, shells, ports, Git, and agents
```

SSH is the authentication and transport layer. It is not the terminal-session
owner and it is not the remote workspace identity.

## Decision Summary

Implement SSH as a first-class workspace location backed by system OpenSSH and
a self-contained Rust remote runtime.

The fixed defaults are:

- one system OpenSSH `ControlMaster` per verified target, with independent
  purpose-specific channels; v1 has no hidden second or bulk-master fallback
- one desktop `remote-host` Electron `UtilityProcess` that owns OpenSSH
  subprocesses and the remote terminal data plane
- one Rust `kmuxd` binary whose `bridge`, `keeper`, `hook`, `cli`, and
  `doctor` subcommands run as separate processes
- one keeper process per terminal session, with a single fenced writer lease
- execution-node-scoped remote authority, even when a home/workspace filesystem
  is shared
- one Main-owned durable operation coordinator for every SSH mutation and one
  registry of small target-bound feature capabilities
- pinned terminal-only cohort proxies only while incompatible live keeper
  generations require them
- bundled `darwin-arm64`, `darwin-x64`, `linux-arm64-musl`, and
  `linux-x64-musl` artifacts at the same supported tier
- required SFTP for first bootstrap, a 24-hour uncommitted-provisional TTL, and
  persistence across SSH disconnect and desktop restart
- no Windows remote runtime, ConPTY, or named-pipe support

The runtime is split by responsibility and failure domain:

```text
Electron Main
  product state / authorization / durable operation store / reconciler
        │ control IPC + MessagePort transfer
        ▼
remote-host UtilityProcess
  SshTransportPool
  one OpenSSH ControlMaster per target
  control / terminal / metadata / SFTP / forwarding subprocess
  remote wire validation + TerminalDataPlane adapter
        │                         │
        │ direct MessagePort      │ independent SSH channels
        ▼                         ▼
Renderer                    remote kmuxd bridge
existing TerminalStreamRouter  bounded metadata tasks
                                hook/CLI event spool
                                keeper discovery + opaque stream proxy
                                      │
                                      ├─ keeper A: PTY + journal + headless
                                      └─ keeper B: PTY + journal + headless
```

Electron Main owns product state, authorization, reconciliation, and durable
write-ahead state. It authorizes and transfers `MessagePort` capabilities, but
it never receives or relays renderer-attachment output, checkpoints,
interactive input, resize, or stream credit. Bounded CLI and future-Agent-Team
input commands and explicit bounded capture results may cross Main's authorized
control plane; they are not part of the interactive stream. Injected input
receives a PTY-boundary acknowledgement. The renderer and `remote-host` reuse
the existing `@kmux/proto` `TerminalDataPlane` contract and the renderer's
existing `TerminalStreamRouter`; there is no second renderer protocol for SSH.

Each remote session keeper owns one PTY, its terminal materialization, and its
retained mutation history. The bridge is a restartable discovery and routing
process. It treats keeper streams as opaque bytes and does not own PTY lifetime
or interpret the terminal protocol.

This separation allows the bridge, SSH connection, or desktop to restart
without terminating unrelated remote sessions.

Agent Team is not an implemented kmux product surface at the time of this ADR.
References to Agent Team below are forward-compatibility constraints on the
hook, CLI, capture, route-key, acknowledgement, and worktree primitives. This
ADR and Phase 6 do not authorize or require an Agent Team model, UI,
orchestration, team lifecycle, alias manager, or team-specific routing path.
When that product surface is implemented under ADR 0003, it must consume these
same target-scoped primitives instead of forcing an SSH-specific redesign.

## Architectural Invariants

The implementation must preserve these invariants:

1. A workspace has exactly one location: local or one verified remote target.
2. `SshProfile.id` is a mutable locator identity, not remote-machine identity.
3. Remote authority combines the installation ID, execution-node ID, and
   normalized authenticated principal. Profile/effective-policy data, shared
   filesystem identity, and observed platform data are not execution authority.
4. A transport disconnect never means the remote process exited.
5. Failure to observe a remote session is `unknown`, not proof that it is dead.
6. Attaching an existing session must never silently create a replacement
   session, especially not a local one.
7. A remote create, split, restart, adopt, terminate, or forward mutation occurs
   only from an explicit, durably recorded remote operation.
8. Remote mutations are idempotent and retryable through stable operation IDs,
   deterministic resource keys, and Main-only authoritative result facts.
9. Existing UUID-based `workspaceId` and `sessionId` values are reused inside
   desktop-installation and target scope. No parallel remote IDs are minted.
10. Terminal output, resize, and exit share one monotonic mutation sequence
    within a keeper generation.
11. Replay and live output have an explicit barrier; they cannot overlap or
    leave an unobserved gap.
12. SSH support does not replace or add work to the established local live
    output hot path: local `pty-host` ring/coalescing/credit, direct
    `MessagePort`, the singleton `TerminalStreamRouter`, and the existing
    scheduler/xterm pipeline remain the local surface path. In particular,
    Main, target dispatch, checkpoint hashing, remote framing, and remote
    connection state do not enter the per-delta local output loop.
13. Interactive terminal traffic is not queued behind bulk file, Git, search,
    or browser traffic in one ordered application stream.
14. Target-bound capability providers are the only code allowed to unwrap
    located paths. Remote paths are never passed to local filesystem APIs as
    local paths.
15. Closing or restarting the desktop detaches remote sessions by default; it
    does not terminate them.
16. Restore preferences control layout restoration, not keeper lifetime.
17. One keeper grants only one fenced writer lease at a time.
18. The remote runtime runs as the authenticated SSH user and does not require
    root or public listening ports.
19. Remote bootstrap does not depend on a user-installed language runtime,
    package manager, native build toolchain, or terminal multiplexer.
20. Failure in a keeper or its headless parser cannot terminate another
    session. A recoverable parser error or unwind cannot terminate its own PTY
    owner; process-abort and resource-exhaustion failures remain isolated to
    that keeper.
21. Every feature channel is mux-only and fails closed if its assigned
    `ControlMaster` is unavailable; an ordinary direct SSH fallback is never
    allowed.
22. Windows remote, ConPTY, and named pipes are explicitly unsupported.

## Product UX

### Primary Entry Point

The existing workspace menu gets:

```text
Convert to SSH Workspace...
```

The action always opens one dialog containing both the saved connection picker
and the continuation choice:

```text
SSH Workspace

SSH connection
  [ dev-gpu                                      v ]

How would you like to continue?

  Convert current workspace
  Replaces this workspace's local session/pane content with one remote surface
  after the SSH workspace is ready.

  Create new SSH workspace
  Keeps the current workspace and all of its sessions unchanged.

                                    Cancel    Continue
```

The connection picker includes:

```text
Saved SSH Connections
  dev-gpu
  staging
  ec2-agent-box

  New SSH Connection...
  Manage SSH Connections...
```

The same dialog is shown whether the current workspace is empty, contains only
the default surface, or has many active sessions. kmux does not add or maintain
`workspace.isPristine` merely to select a dialog variant. The user's requested
operation is explicit, and the confirmation cost is small compared with
unexpectedly terminating local work.

`Continue` enters a visible verification/bootstrap state when the selected
profile has no current target binding. It cannot start conversion/create until
the immutable authority and `targetId` are known; cancellation leaves the local
workspace unchanged.

### Transactional Conversion

Conversion is not part of the ordinary debounced workspace snapshot path. It
uses a durable write-ahead log with this state machine:

```text
preparing
  -> remote-created
  -> commit-decided
  -> committed
  -> cleanup-complete
```

A verified `RemoteTargetBinding` is a prerequisite to starting this state
machine because `RemoteResourceKey` contains immutable `targetId`. Selecting a
new/unverified profile may establish the provisional OpenSSH master, install or
start the helper, and complete the authority handshake before the user can
commit the conversion. That preparation may mutate only kmux's content-addressed
runtime installation/authority records; it cannot create a workspace, keeper,
worktree, or forward, and it cannot change the local product workspace.

After target verification, the transaction rechecks the effective-policy hash
and persists `preparing` before the first remote workspace/resource mutation.
This is the enforceable mutation boundary; the ADR does not pretend that a
deterministic target-scoped resource key exists before the first network packet.

Main durably persists `preparing` with the
conversion transaction ID, create operation ID, deterministic
`RemoteResourceKey`, source workspace version, and preservation whitelist.
It also records the exact local session/generation cleanup set before any graph
replacement can hide those resources. Remote creation first writes a
provisional resource descriptor containing the same identities.

The states have precise recovery meaning:

- `remote-created`: the provisional resource descriptor, initial keeper
  descriptor, and forced remote workspace snapshot are durable. Local product
  state and every replaced local session are still intact.
- `commit-decided`: Main has durably recorded an immutable decision to roll
  forward, including the complete replacement product-state patch, its expected
  source version, immutable cleanup set, and the remote snapshot/resource
  hashes. This state is the point of no automatic rollback, but it is not
  permission to destroy the local sessions.
- `committed`: the forced desktop product snapshot contains the SSH location
  and replacement pane/surface graph, and the matching remote descriptor is
  promoted from provisional to committed. Both sides identify the same
  transaction, operation, resource key, and snapshot hash.
- `cleanup-complete`: termination of replaced local sessions and cleanup of
  unused provisional artifacts have been durably acknowledged. Only then may
  the WAL entry be compacted.

After the remote snapshot force succeeds, Main writes `commit-decided` before
changing product state. It then idempotently forces the replacement desktop
snapshot and promotes the remote descriptor, in either recoverable order. Main
writes `committed` only after observing both durable results. Termination of the
replaced local sessions is exclusively a post-`committed` cleanup operation;
the termination acknowledgement is required before `cleanup-complete`.

No local session is terminated while the WAL is `preparing`, `remote-created`,
or `commit-decided`. Host verification, authentication, bootstrap, protocol
negotiation, remote creation, snapshot, and pre-commit failures therefore leave
the local workspace running. After `commit-decided`, recovery always rolls
forward and retains the old local sessions until the committed product state
and remote promotion agree.

The conversion WAL uses a new durability primitive rather than the ordinary
debounced workspace writer. Each decision record is written to a sibling
temporary file, the file is flushed and `fsync`ed, the rename is atomic, and
the parent directory is `fsync`ed before the transition is acknowledged. The
forced desktop snapshot uses the same atomic-replace durability contract.
The WAL records the expected product version and complete intended patch, so it
remains the recovery source of truth if the product snapshot lags; the two files
do not pretend to provide a cross-file filesystem transaction.

Crash recovery compares the WAL, persisted workspace version/hash, and remote
resource descriptor, then resumes the idempotent force, promotion, or cleanup
step. Even after the remote operation ledger has been garbage-collected, the
descriptor's create operation ID and deterministic resource key prevent a
retry from creating a duplicate keeper. WAL records are bounded and compacted
only at terminal states, so this low-frequency durability path is not on the
terminal journal or renderer hot path.

On restart, kmux reclaims unfinished provisional keepers before ordinary
inventory work. A provisional keeper that never commits and has never granted a
writer lease is terminated after 24 hours. A keeper that has granted a lease is
never removed by this automatic TTL.

Conversion preserves only:

- `workspaceId`
- window membership and ordering
- user title and `WorkspaceTitleSource`
- pinned state

It clears local/detected worktree bindings, the prior local cwd, Git state,
ports, status, progress, logs, earlier surface notifications, and any future Agent Team
bindings. Prepare supplies a new provider-validated `RemotePath` default cwd
bound to the selected workspace target from the explicit request or profile
default. kmux-managed local worktree directories are not automatically deleted.

The implementation must not attempt to migrate a live local process into a
remote PTY. Conversion replaces the workspace's active session set only after
remote preparation succeeds.

### Creating a New SSH Workspace

`Create new SSH workspace` creates a separate workspace using the selected
connection. The current workspace, panes, surfaces, processes, and title are
unchanged.

The new workspace receives one normal initial surface through the same remote
session creation path used by later splits. The initial surface is not a special
case in the persistence or reconciliation model.

### Workspace Titles

Workspace title provenance is explicit:

```ts
type WorkspaceTitleSource = "auto" | "user";
```

For an auto-titled workspace, conversion or creation uses:

```text
SSH: <connection name>
```

A user-provided title is preserved.

### Settings

Settings gets an `SSH Connections` section with:

- list, add, edit, duplicate, and delete profiles
- import/sync OpenSSH config aliases
- test connection
- display the effective host/user/port after OpenSSH resolution
- show host-key fingerprint as an audit observation when OpenSSH can provide it;
  never synthesize one
- show last connection/bootstrap error
- show the verified installation ID, execution-node ID, and normalized
  authenticated principal separately from profile and platform observations
- show remote runtime version, capabilities, and persistence level
- show and terminate retained remote sessions
- `Clean Runtime`: collect only unreferenced executable generations. It is
  non-destructive to the current/live generation and preserves remote
  authority, keeper descriptors, journals, checkpoints, worktrees, operation
  records, and product bindings.
- `Reset Runtime…`: explicitly retire the currently installed executable
  generation so the next connection reinstalls the verified artifact. Main
  refuses the operation while a local workspace or retained-session record
  references the target; the remote installer independently refuses it while
  any keeper, bridge, or other process/generation lease still references the
  generation. Reset disconnects the target and clears only stale runtime
  observation. It preserves installation/authority identity, session state,
  journals, checkpoints, worktrees, and durable operation records. It is not a
  broad remote-state wipe.

Profile fields:

```text
Name
OpenSSH config alias, or explicit host
User
Port
Identity file
Default remote cwd
Default shell override, optional
Bootstrap shell override, required for unknown bootstrap shells
Install/authority/state/runtime path overrides, optional
Session/target retained-data quota overrides, optional
Environment overrides
Agent forwarding, off by default
```

Private-key passphrases and passwords are not persisted in ordinary kmux
settings. Prefer the user's SSH agent and OS credential facilities.

Deleting a profile does not silently delete an immutable target binding or
remote sessions referenced by workspaces. kmux must either prevent deletion
while referenced, let the user assign a replacement profile that verifies as
the same target, or leave the workspace in an explicit `locator missing` state.

## Domain Model

### SSH Profile: Mutable Locator

An SSH profile describes how to reach a host today:

```ts
interface SshProfile {
  id: Id;
  name: string;

  sshConfigHost?: string;
  host?: string;
  user?: string;
  port?: number;
  identityFile?: string;

  defaultRemoteCwd?: string;
  shellOverride?: string;
  bootstrapShellOverride?: string;
  installPathOverride?: string;
  authorityPathOverride?: string;
  statePathOverride?: string;
  runtimePathOverride?: string;
  sessionRetentionQuotaMiB?: number;
  targetRetentionQuotaMiB?: number;
  env?: Record<string, string>;
  forwardAgent?: boolean;

  createdAt: string;
  updatedAt: string;
}
```

`identityFile` is local OpenSSH locator configuration and never enters
workspace path state. `defaultRemoteCwd` and the install/authority/state/runtime
overrides are provider-scoped remote configuration; before a cwd enters
workspace/session or feature-domain state, the provider wraps it in a
target-checked `LocatedPath`.

`sshConfigHost` is preferred. system OpenSSH resolves `HostName`, `User`,
`Port`, `Include`, `Match`, `ProxyJump`, `ProxyCommand`, identity, certificate,
agent, and security-key configuration.

Changing a profile is permitted. It does not change the identity of remote
workspaces already bound through that profile.

### Authority, Locator, and Observation

Do not collapse remote authority, today's route to it, and observed runtime
facts into one identity record:

```ts
interface RemoteAuthenticatedPrincipal {
  uid: number;
  accountName: string;
}

interface RemoteAuthorityIdentity {
  remoteInstallationId: Id;
  executionNodeId: Id;
  authenticatedPrincipal: RemoteAuthenticatedPrincipal;
}

interface RemoteTargetLocator {
  profileId: Id;
  effectiveConnectionPolicyHash: string;
  lastVerifiedAt: string;
}

interface RemoteTargetObservation {
  platform: string;
  arch: string;
  abi: string;
  runtimeVersion: string;
  capabilities: string[];
}

interface RemoteTargetBinding {
  id: Id;
  authority: RemoteAuthorityIdentity;
  locator: RemoteTargetLocator;
  observation?: RemoteTargetObservation;
  sshHostKeyFingerprint?: string; // audit observation, not authority
  firstVerifiedAt: string;
}
```

`remoteInstallationId` identifies one kmux-owned persistent installation/state
namespace. It is deliberately insufficient as a process authority because a
home directory can be shared by several cluster nodes. `executionNodeId`
identifies the node that owns PTYs, processes, loopback ports, journals, and
runtime sockets. v1 targets are execution-node scoped even when workspace files
live on shared storage.

A small platform `NodeIdentityBackend` creates `executionNodeId` once in a
verified host-local authority root and binds it to a platform node observation.
The raw platform identifier is not sent to the desktop. A known network/shared
install, authority, or state root requires an explicit host-local
`installPathOverride`, `authorityPathOverride`, or `statePathOverride`. A
copied record or changed node binding requires explicit repair/rebind, and a
platform without a strong stable
node observation is unsupported for v1; a path override cannot waive identity
verification. Workspace repositories may remain on shared storage; kmux
execution descriptors, journals, and sockets may not silently share an
execution identity. Cluster-wide targets that deliberately roam between nodes
would require separate storage-authority and execution-node identities in a
follow-up ADR.

`authenticatedPrincipal` is obtained inside `kmuxd` from the effective POSIX
UID and the canonical account name returned for that UID. The UID is an
unsigned integer in its platform range; the account name is preserved exactly
as UTF-8 with no case folding or whitespace normalization. Both fields are
required and both participate in comparison. The OpenSSH connection proves
which account launched `kmuxd`; a helper-reported UID/name change or an
unresolvable account fails closed rather than being replaced with a display
string. `platform`, `arch`, `abi`, runtime version, and capabilities are
observations that may legitimately change. The profile and effective-policy
hash describe the current locator.

Every connection delegates host trust to system OpenSSH. When the installed
OpenSSH supports it, kmux uses `KnownHostsCommand` token expansion (`%f` or
`%K`) to record the verified key fingerprint as an audit observation. If
OpenSSH cannot expose the value, kmux stores no fingerprint rather than
inventing one. OpenSSH still blocks a changed host key, and kmux requires
authority re-verification before attaching existing resources.

Remote-state deletion, principal changes, an installation-ID or
execution-node-ID mismatch, or an SSH alias that reaches a different authority
fail closed. Rebinding is an explicit product operation.

`RemoteTargetBinding.id`, not `SshProfile.id`, is used as `targetId` in durable
product records.

See [OpenSSH ssh(1)](https://man.openbsd.org/ssh) and
[ssh_config(5)](https://man.openbsd.org/ssh_config).

### Located Paths

```ts
declare class LocalPath {
  private readonly localPathBrand: never;
  private readonly rawValue: string;
  private constructor();
}

declare class RemotePath {
  private readonly remotePathBrand: never;
  private readonly rawValue: string;
  private constructor();
}

type LocatedPath =
  | { kind: "local"; path: LocalPath }
  | { kind: "ssh"; targetId: Id; path: RemotePath };
```

`LocatedPath` is required for cwd, Git/worktrees, file links, attachments,
capture diagnostics, external agent sessions, and every target-local usage or
history record. These are opaque branded value objects, not `string & brand`,
so neither is assignable to Node/Electron path APIs. Values are created or
restored only by schema-validating codecs; a cast or raw constructor at a
feature call site is forbidden. There is no exported generic
`unwrapLocatedPath` helper.

The located-path module keeps raw storage private. The registry receives an
internal `PathAccess` capability and injects only `unwrapLocal(LocalPath)` into
local providers and only `unwrapRemote(RemotePath)` into a target-bound SSH
provider. Feature packages cannot import that capability. Package-boundary
linting and architecture tests enforce the import rule. A bare string may be
extracted only after the provider verifies its own location/target scope.

Persistence and IPC use separate schema DTOs containing encoded strings. Those
DTOs are decoded into the opaque values at the process/domain boundary and are
never accepted by a provider interface. This explicit codec step preserves
serializability without making the raw representation a feature-domain type.

Remote values must never reach `existsSync`, `realpathSync`,
`shell.openPath`, local Git clients, or any other local filesystem API.

### Workspace, Session, and Resource Identity

Existing UUID identities are reused:

```ts
type WorkspaceTarget = { kind: "local" } | { kind: "ssh"; targetId: Id };

type WorkspaceLocation =
  | { target: { kind: "local" }; defaultCwd: LocalPath }
  | {
      target: { kind: "ssh"; targetId: Id };
      defaultCwd: RemotePath;
    };

interface RemoteResourceKey {
  desktopInstallationId: Id;
  targetId: Id;
  workspaceId: Id;
  sessionId?: Id;
}
```

There is no `remoteWorkspaceId` or `remoteSessionId`. The existing
`workspaceId` and `sessionId` values are unique UUIDs and are interpreted
within `desktopInstallationId + targetId` scope. The full
`RemoteResourceKey` is used for remote descriptors, create deduplication,
authorization, reconciliation, hooks, and metadata.
`desktopInstallationId` is a durable random identity created once for the
desktop installation, not once per process, profile, or connection.

Rules:

- surfaces and sessions inherit the workspace location
- local and SSH workspaces may be visible side by side
- multiple workspaces may share one remote target and SSH transport pool
- two hosts containing `/home/user/app` do not collide
- a profile locator can be replaced only after verifying the same target
- absence from an inventory response never authorizes a replacement create
- a workspace target is selected once; its default cwd does not carry a second,
  independently mutable copy of `targetId`
- a durable workspace does not embed mutable `profileId`; connection lookup
  follows `targetId -> RemoteTargetBinding.locator`

### Runtime Target and Launch Location

```ts
type RuntimeTarget = WorkspaceTarget;

interface SessionLaunchConfig<TPath extends LocalPath | RemotePath> {
  cwd: TPath;
  shell?: string;
  args?: string[];
  initialInput?: string;
  env?: Record<string, string>;
  title?: string;
}
```

The local PTY host accepts only `SessionLaunchConfig<LocalPath>`. A
target-bound remote terminal provider accepts only
`SessionLaunchConfig<RemotePath>`, authorizes it against its selected target,
and runs it through `remote-host` and the verified binding. Stored references
that can cross targets use `LocatedPath`; an already selected provider uses its
branded path type.

Every process, session, agent, usage, notification, file, Git, port, and
worktree record includes `targetId` where identity or matching is involved.

### Independent Session Status Axes

Connection loss must not collapse process, observation, and attachment state:

```ts
interface SessionRuntimeStatus {
  processState: "pending" | "running" | "exited";
  observationState: "unknown" | "observed";
  attachmentState: "detached" | "connecting" | "attached" | "failed";
}
```

`observationState: "unknown"` cannot change `processState` to `exited`,
spawn a replacement, or remove a future Agent Team binding. `attachmentState`
describes the desktop connection only and is not process liveness.

### Durable Remote Operations

Every remote mutation, not only conversion, crosses one durable command
boundary. The operation kinds are deliberately domain-level and bounded:

```ts
type RemoteOperationKind =
  | "workspace.create"
  | "session.create"
  | "session.restart"
  | "session.adopt"
  | "session.terminate"
  | "workspace.terminate"
  | "worktree.create"
  | "worktree.remove"
  | "forward.ensure"
  | "forward.remove"
  | "launch-input";

interface RemoteOperationIntent {
  operationId: Id;
  kind: RemoteOperationKind;
  resourceKey: RemoteResourceKey;
  expectedWorkspaceRevision: string;
  expectedRemoteResourceRevision: Uint64;
  nextRemoteResourceRevision: Uint64;
  conversionTransactionId?: Id;
  createOperationId?: Id;
  canonicalPayloadHash: string;
  createdAt: string;
}
```

The durable record also contains the canonical payload and the exact pending
product fact that recovery must apply. A renderer command is not itself an
authoritative reducer fact. The flow is:

```text
renderer / CLI / future Agent Team command
  -> Main authorization and RemoteOperationCoordinator
  -> durable intent + pending product fact + outbox admission
  -> Main-only pending fact applied to product state
  -> reconciler performs the remote mutation
  -> authoritative result is durably recorded
  -> Main-only success/failure fact updates product state
```

The intent is durably admitted before Main acknowledges the command or exposes
pending UI state. If the ordinary product snapshot lags, startup replays the
stored pending fact. A remote result is persisted before its success/failure
fact is dispatched, so startup can also finish that projection. This gives the
operation record transactional authority without requiring a fictitious atomic
transaction across unrelated files.

Offline, timeout, and ambiguous disconnect outcomes remain pending and retry the
same operation ID; they are not projected as remote failure. Only an
authoritative validation/authorization/runtime result can terminally fail an
operation. User cancellation is itself durably recorded and may become terminal
only if the remote reports that mutation never began or confirms the matching
compensating result.

Split maps to `session.create` plus a pending pane/surface projection. Restart
maps to `session.restart` and replaces the keeper generation only after an
authoritative result. Adopt changes layout ownership only after the existing
resource is verified. Termination leaves a `termination-pending` product and
retained-inventory state until the matching remote tombstone/ack is durable; an
offline request does not optimistically erase the resource.

Managed worktree create/remove and desired forward changes also use this
coordinator because they have durable product ownership or destructive safety
preconditions. Ephemeral read-only queries and bounded file transfer chunks use
provider request IDs/cancellation but do not create fake pending product state.

Remote creation is legal only while its persisted operation is pending. The
bridge either returns the matching existing descriptor or creates exactly that
resource and persists the descriptor before success. The reconciler observes
and attaches known resources, but it never creates a shell because an
authoritative inventory omitted a keeper. Restart never happens as an attach
fallback.

The renderer-facing IPC exposes allowlisted commands only. Internal remote
pending/result facts are Main-only and cannot be sent through a generic
`dispatch` IPC or imported by renderer code. `@kmux/core` exposes them through a
Node/Main-only package subpath excluded from the renderer bundle; the public
`AppAction` union does not contain them. Local workspaces may retain their
existing direct reducer/effect path; the stricter durable coordinator applies
whenever the selected `WorkspaceTarget` is SSH.

Concretely, split/create/restart/adopt/terminate renderer messages are commands,
not prebuilt reducer actions. Main resolves the current workspace target first:
local targets may dispatch the existing reducer/effect transition, while SSH
targets enter the coordinator before any reducer mutation. Any legacy generic
`kmux:dispatch` endpoint rejects actions that could mutate remote resource
lifecycle, even if a renderer constructs a structurally similar public action.

### Agent Session References

```ts
interface AgentSessionRef {
  vendor: "codex" | "claude" | "gemini" | "opencode" | string;
  id: string;
  targetId: Id;
  cwd: LocatedPath;
}
```

Agent restore never matches only `vendor + id` or only `cwd`.

## Desktop Architecture

### Electron Main: Product Control Plane

Electron Main remains the single writer for product state. It owns:

- profile CRUD and OpenSSH alias import
- verified target bindings and explicit rebind operations
- workspace, pane, surface, and session authorization
- desired state, durable outbox operations, conversion WAL, and reconciliation
- `remote-host` lifecycle and `MessagePort` capability transfer
- retained-session inventory and destructive-action authorization

Main may receive bounded metadata, readiness, exit, health, notification, and
diagnostic control messages. It must not receive, copy, parse, persist, or
forward renderer-attachment output, terminal checkpoints, interactive input,
resize frames, or stream credit. A test must prove that the Main process relays
zero bytes from the renderer terminal attachment data plane.

CLI and future Agent Team `send_text`/`send_key` are bounded control commands rather
than renderer interactive frames. Main may authenticate and route them with a
request/operation ID and resource key through the selected terminal control
provider. The provider obtains the keeper's current writer capability and
returns the PTY-boundary acknowledgement. Injected input uses the common input
size limit, never enters stream-credit accounting, and is not written verbatim
to logs. Main does not proxy the resulting terminal output.

An explicitly authorized `surface.capture` result may also return through Main
because it is a request-scoped product/CLI response, not a live attachment.
Remote capture is capped at 1 MiB plus the requested line limit and carries
sequence/geometry/truncation metadata. Main never subscribes to subsequent
output after returning it.

### Target Service Registry

Desktop features select target behavior through one composition root, not
feature-local SSH conditionals. `TargetServiceRegistry` returns a set of small,
target-bound capabilities:

```ts
interface TargetServiceSet<TPath extends LocalPath | RemotePath> {
  terminal: TerminalControlProvider<TPath>;
  git: GitProvider<TPath>;
  files: FileProvider<TPath>;
  metadata: MetadataProvider<TPath>;
  history: HistoryProvider<TPath>;
  ports: PortProvider;
  attachments: AttachmentProvider<TPath>;
}

type ResolvedTargetServices =
  | { target: { kind: "local" }; services: TargetServiceSet<LocalPath> }
  | {
      target: { kind: "ssh"; targetId: Id };
      services: TargetServiceSet<RemotePath>;
    };

interface TargetServiceRegistry {
  resolve(target: WorkspaceTarget): ResolvedTargetServices;
}
```

Each capability is intentionally narrow and may degrade independently. The
registry is the only desktop feature-composition layer that branches on local
versus SSH. A bound SSH capability also captures its verified `targetId`, so a
bare `RemotePath` cannot be reused against another target. Feature modules call
the capability they need; they do not receive a giant remote-runtime facade and
do not contain `if (kind === "ssh")` fallbacks.

The Main command composition root resolves the registry once and injects the
needed capability. Feature modules do not import a process-global registry as a
service locator.

`TerminalControlProvider` owns authorized create/attach/injected-input/capture
control only. Terminal bulk bytes still use the direct `MessagePort` data
plane. The SSH file provider can download and verify a remote file, then return
a newly validated `LocalPath` to the local opener; no opener accepts a
`RemotePath` directly.

The existing worktree, metadata, terminal-file-open, image-attachment,
usage/history, and port/browser runtimes become capability consumers during the
migration. Their public methods accept a resolved capability plus opaque paths,
not a workspace object that they re-inspect to choose an implementation. Direct
local `fs`, `shell.openPath`, or local Git calls remain inside local capability
implementations only.

### RemoteOperationCoordinator

Main's `RemoteOperationCoordinator` is the sole admission point for the
durable operations defined above. It:

- authorizes an external command against product state and target binding
- allocates stable operation/resource IDs before any effect
- writes the intent, canonical pending fact, and outbox admission through the
  fsync-backed durable operation store
- dispatches Main-only pending/result facts to the core reducer
- lets `RemoteReconciler` execute admitted intents and persists each
  authoritative result before applying it
- compacts only after the terminal product fact is present in a durable product
  snapshot and the descriptor/tombstone/resource revision retains the
  idempotency identity required after ledger GC

This coordinator is not in the terminal data path. It serializes state changes
per `desktopInstallationId + targetId + workspaceId`, while unrelated
workspaces and read-only provider operations may proceed concurrently. The
expected workspace revision makes an out-of-order internal fact a typed
conflict instead of letting it overwrite a newer layout.

The coordinator implements admission, durability, ordering, and fact
projection only. Kind-specific request construction/execution remains in small
reconciler/provider handlers, so the coordinator does not become a second giant
feature service.

### `remote-host`: Remote Data Plane

Run one dedicated Electron `UtilityProcess` for remote transport. It owns:

- system OpenSSH master and channel subprocesses
- askpass/authentication integration and connection diagnostics
- target authority handshake and remote-wire validation
- one `SshTransportPool`
- adapters between remote keeper streams and `TerminalDataPlane`
- direct renderer `MessagePort` endpoints

`remote-host` has no product-layout or durable-state authority. Main sends
serializable authorization and desired-operation commands. For an attach, Main
creates and authorizes a message channel, transfers one port to
`remote-host` and the other to the renderer, then leaves the data path.

The UtilityProcess event loop performs only bounded frame validation, channel
state transitions, and scheduled buffer transfer. Bulk hashing, decompression,
large metadata decoding, and file staging use bounded worker tasks or the
purpose-specific subprocess and return chunks; no synchronous whole-file work
runs on the transport loop. A byte/time-sliced scheduler services terminal
input/output before continuing bulk callbacks, without dropping or reordering
either stream. Independent SSH channels do not by themselves satisfy this
event-loop isolation requirement; the normative event-loop-delay gate does.

A `remote-host` crash closes desktop attachments but not SSH-independent remote
keepers or their agent processes. Main restarts it, re-verifies authority,
reconciles control state, and reattaches by keeper generation and mutation
sequence.

### SshTransportPool

The pool is keyed by verified `targetId`. Each entry records its
`effectiveConnectionPolicyHash`, runs exactly one system OpenSSH
`ControlMaster`, and opens independent OpenSSH channel subprocesses through
that master. This is a v1 architecture contract, not an optional optimization.

Each explicit `ControlPath` lives in a randomized, owner-only local directory
created by `remote-host`, is short enough for Unix-socket limits, and is never
derived from remotely supplied text. Before reuse, kmux rejects a symlink,
wrong owner, unexpected file type, or socket outside the current pool
generation.

Before the helper handshake reveals a target, bootstrap uses a provisional
entry keyed by `connectionAttemptId + effectiveConnectionPolicyHash`. Its SFTP,
doctor, and handshake channels obey the same mux-only rule, but no workspace or
feature operation may bind to it yet. Main atomically promotes that master to
the verified `targetId`; if another concurrent attempt has already installed a
master for the same authority/policy, the loser closes its provisional master
and reuses the winner. A policy mismatch requires explicit re-verification.
This admits the unavoidable fact that two not-yet-identified aliases can
briefly reach the same machine, while still guaranteeing one assigned master
as soon as authority is known and before product mutation.

Ordinary OpenSSH multiplex clients are insufficient because OpenSSH documents
that they may continue with a direct connection when the control socket is
missing or unusable; see
[ssh_config(5) `ControlMaster`](https://man.openbsd.org/ssh_config#ControlMaster).
Every terminal, control, metadata, SFTP, and forwarding launcher therefore uses
a single `MuxOnlyOpenSshChannel` adapter with:

- the pool's explicit private `ControlPath` and master-generation token
- a direct-connect guard that exits without network access if mux attachment
  fails; `BatchMode=yes` or a preceding `ssh -O check` alone is not sufficient
- no askpass or authentication path for a feature channel
- a per-target state gate that excludes channel creation while a master is
  starting, stopping, or being replaced
- post-open master-generation validation, closing and reconciling a channel
  that raced with replacement

The transport spike must select and prove the exact system-OpenSSH invocation
for all required channel types. A mux control operation such as the documented
[`ssh -O proxy`](https://man.openbsd.org/ssh#-O), or an explicit fail-closed
`ProxyCommand` guard combined with the private control socket, is acceptable
only when absence of the master is proven to exit before TCP connection or
authentication. If any supported OpenSSH version
cannot provide a safe mux-only path for terminal, SFTP, metadata, and forwarding
channels, that platform/version is unsupported for v1 and release is blocked;
kmux does not silently use a direct client.

If the effective policy changes, the entry becomes unusable until explicit
re-verification. kmux may use a one-shot non-master probe to verify the new
route, but it stops the old master before assigning a replacement master to the
target. It never keeps two active masters for one target. The probe is not a
feature transport and is never concurrent with an assigned replacement master.

### RemoteReconciler

The reconciler is the only desktop component that converges persisted remote
intent with authoritative observed remote state. It does not own transports or
terminal bytes.

It maintains:

```ts
interface RemoteDesiredState {
  workspaces: DesiredRemoteWorkspace[];
  sessions: DesiredRemoteSession[];
  forwards: DesiredPortForward[];
}

interface RemoteObservedState {
  targetStatus: "unknown" | "offline" | "ready" | "mismatch";
  bridgeGeneration?: Id;
  keepers: ObservedSessionKeeper[];
  lastObservedAt?: string;
}

interface RemoteOutboxOperation {
  operationId: Id;
  resourceKey: RemoteResourceKey;
  kind: RemoteOperationKind;
  payload: RemoteOperationPayload;
  canonicalPayloadHash: string;
  createdAt: string;
  attempt: number;
}
```

`RemoteOperationPayload` is a kind-discriminated, schema-validated union; an
unvalidated arbitrary object is never admitted to the durable outbox.

Remote mutations use `operationId` idempotency keys. The bridge persists a
bounded result cache or operation ledger so retrying after an ambiguous
disconnect returns the original result instead of creating duplicate sessions,
watchers, or forwards.

Create descriptors and termination tombstones retain their originating
operation ID and canonical payload hash after the bounded ledger entry is
compacted. Reusing an operation ID with another kind, resource key, generation,
or payload hash fails as an idempotency conflict rather than returning an
unrelated result.

Every mutable remote descriptor also stores a monotonic resource revision and
the last operation ID/result digest. The reconciler serializes a resource's
mutations and sends the expected/next revision. After ledger GC, retry of the
last revision returns its retained result, an older revision returns
`operation-stale`, and a skipped/conflicting revision fails without mutation.
Thus an old restart or forward request cannot execute again merely because its
ledger row expired. Create identity remains permanently recoverable from the
live descriptor, and termination identity remains in its tombstone until the
resource's retention contract permits final GC.

Example:

```text
desktop records createSession(op-123) in outbox
  -> remote creates session S and records op-123 -> S
  -> connection drops before desktop receives response
  -> desktop reconnects and retries op-123
  -> remote returns S
  -> desktop updates observed state and clears outbox entry
```

A failed or timed-out observation does not erase previous ownership. Only an
authoritative remote response may declare a keeper absent or terminated.
Even authoritative absence does not create a replacement. Creation requires a
separate pending create or explicit restart operation.

### Common Terminal Data Plane

Renderer-facing terminal code remains transport-neutral by reusing the
`@kmux/proto` `TerminalDataPlane` contract from ADR 0002. This ADR declares no
second terminal interface. Existing typed attach, checkpoint/resume, mutation,
input, resize, credit, detach, and resync messages remain the renderer
contract.

Transport-neutral reuse is not permission to re-architect the local surface
producer or renderer hot path. For local live output, the existing
`pty-host` ring, wire coalescing, credit accounting, direct `MessagePort`,
singleton router, visible-write scheduler, and xterm application sequence stay
in place. A shared type or attach/resync contract may evolve only when it adds
no Main hop, target-kind branch, remote framing, extra scheduler, hashing,
compression, or unbounded/cumulative copy to the per-delta local path. If a
required common-contract change cannot preserve that boundary, implementation
stops under the ADR deviation process instead of accepting a local-output
redesign as an incidental SSH change.

Phase 2 evolves that shared, versioned contract so sequence fields have a
lossless `Uint64` representation and output/resize/exit share the mutation
ordering defined here:

```ts
declare const uint64Brand: unique symbol;
type Uint64 = bigint & { readonly [uint64Brand]: true };
```

Factories accept only `0n <= value <= 2n ** 64n - 1n`. In-memory TypeScript and
`MessagePort` messages use `bigint`; JSON uses canonical unsigned decimal
strings; binary protocols use network-order `uint64`. `number` is never an
accepted sequence representation. The local adapter migrates to the same
representation. This is one common data-plane version change, not a remote-only
protocol.
`remote-host` may bind the keeper's `writerLeaseId` to the authorized attach
capability internally; the renderer does not branch on SSH lease mechanics.

The same version adds checkpoint transfer messages instead of requiring one
large payload allocation:

```text
checkpoint:begin(checkpointId, metadata, totalBytes)
checkpoint:chunk(checkpointId, offset, bounded ArrayBuffer)
checkpoint:end(checkpointId, digest)
```

Chunk and total sizes are bounded by shared protocol constants and stream
credit. Local and remote adapters use the same messages. A sender never encodes
a checkpoint as a base64/string payload, and `remote-host` and the renderer do
not need to assemble an unbounded intermediate copy before validation and
application.

Electron's `MessagePortMain` transfer list accepts only `MessagePortMain`
capabilities, not `ArrayBuffer` objects. The bounded checkpoint `ArrayBuffer`
chunks therefore cross that endpoint by structured clone; implementations must
not pass them as an unsupported transfer list and silently close the terminal
attachment. This bounded attach/resync copy does not enter the local live-output
delta loop.

The local `pty-host` and remote `remote-host` adapt different runtime owners to
the same messages. The renderer's singleton `TerminalStreamRouter` owns visible
attachments, scheduling, and xterm writes for both. Remote labels and
connection state are product metadata, not reasons to branch the renderer
terminal protocol.

The remote wire is not exposed to the renderer. `remote-host` validates it and
translates keeper generation and mutation sequence into the common epoch and
sequence concepts expected by `TerminalDataPlane`.

ADR 0002's non-persisted epoch/sequence rule remains the local `pty-host`
behavior. A remote keeper persists its own generation and journal sequence, and
the desktop may persist a last acknowledged remote cursor for reconnect. Cursor
and lease ownership is explicit:

- the keeper is the sole authority for mutation sequence, writer lease, and
  applied input sequence
- the renderer owns its live applied cursor; `remote-host` keeps a transient
  per-attachment cache and receives stream credit directly
- `remote-host` sends Main only a coalesced cursor metadata update at detach,
  orderly shutdown, and on a two-second coalescing timer while the cursor
  advances; it never forwards credit or terminal payload
- Main persists that cursor as a non-authoritative reconnect optimization and
  never persists a writer lease as authority

A stale cursor after either desktop process crashes merely causes older replay;
generation/sequence deduplication removes overlap. The adapter presents these
values through the existing data-plane concepts; the renderer never invents an
epoch or guesses across a gap.

## SSH Transport Topology

Use system OpenSSH. For each connected target, `remote-host` owns one
`ControlMaster` and uses `ControlPath` clients to open purpose-specific
channels:

```text
OpenSSH master transport
  ├─ bridge control RPC channel
  ├─ one interactive terminal stream channel per attached session
  ├─ bounded metadata/index stream channel
  ├─ SFTP subsystem
  ├─ direct-tcpip channels per forwarded connection
  └─ optional dynamic-forward SOCKS listener
```

Independent terminal channels prevent a file preview, large Git response, or a
noisy unrelated PTY from building an unbounded ordered backlog in front of an
active agent's key echo.

All branches in this diagram are SSH channels on the assigned master, not
permission for ordinary SSH clients to fall back to new transports. The
`MuxOnlyOpenSshChannel` adapter is shared by exec, subsystem, and forwarding
launchers. A missing/stale socket, rejected mux request, or master-generation
race produces a typed target-disconnected result and asks the pool to reconcile
the master; it never opens a second TCP/authentication path.

Every channel has bounded application queues, maximum frames/messages, chunked
large results, cancellation, disconnect cleanup, and measurable latency
budgets. Input, resize, writer-lease, and terminate messages never use the
metadata or file lane.

v1 does not open a second bulk `ControlMaster` and does not contain a dormant
fallback that can do so. The release gate exercises one master with 16 sessions,
4 attached surfaces, and concurrent SFTP and Git load. If that topology cannot
meet the queue, continuity, and interactive-latency gates, the release is
blocked and a follow-up transport ADR is required.

The release harness records actual remote TCP connections, SSH authentication
attempts, master-generation changes, and channel-to-master assignments. It
injects master death immediately before and during each channel launch. The
expected result is a bounded failure/reconcile path and no direct feature
connection. A `ProxyJump`/`ProxyCommand` route may legitimately contain several
physical TCP legs; the measured leg graph must equal one freshly established
master baseline and must not grow when feature channels are added.

This decision does not require one TCP connection per pane: the master owns the
authenticated transport, while each terminal attach still has an independent
SSH channel and bounded application stream.

## Remote Runtime Architecture

### One Rust Binary, Separate Processes

`remote/kmuxd` is a Rust workspace that produces one `kmuxd` executable. The
executable has these subcommands:

| Subcommand | Process responsibility                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| `bridge`   | handshake, keeper discovery, bounded control/metadata work, hook/CLI replay, and opaque keeper-stream proxying |
| `keeper`   | exactly one PTY, headless terminal, journal, checkpoint state, writer lease, and session descriptor            |
| `hook`     | short-lived agent-hook client that appends to the user-only spool when the bridge is unavailable               |
| `cli`      | target-local kmux command client with structured acknowledgement                                               |
| `doctor`   | install/authority/state/runtime path and node-identity probes plus bounded diagnostics                         |

These are separate processes even though they share one binary. The bridge
never owns a keeper PTY, and no global in-process keeper registry is a liveness
source of truth.

### Bridge

The SSH bootstrap command starts or connects to the kmux bridge. The bridge:

- performs version, capability, target, and token handshake
- discovers live session keepers
- routes control and metadata requests
- starts a keeper only for an authorized pending create operation
- exposes the remote CLI endpoint
- replays the bounded hook/CLI event spool
- starts restartable metadata/index workers
- reports persistence capabilities and health
- proxies each keeper socket as an opaque bounded stream

The bridge does not interpret terminal frames. The keeper descriptor records
the executable generation, `keeperLocalProtocolMajor`, and
`terminalWireVersion`. An updated bridge directly proxies an older compatible
keeper. When the local protocol major is incompatible, the current bridge acts
as supervisor and starts the pinned generation's `kmuxd bridge` in a
terminal-only cohort-proxy mode. There is at most one restartable proxy per
target and incompatible protocol cohort, not one per keeper.

The cohort proxy performs only the version-specific keeper-socket attach and
opaque byte forwarding for keepers of its own major. The current bridge remains
the sole metadata, hook/CLI, authorization, and discovery control endpoint and
returns the selected cohort endpoint in the authorized attach result.
`remote-host` then opens the terminal channel directly to that endpoint; the
current bridge does not become a terminal byte relay.

Before returning the endpoint, the current bridge sends the cohort proxy a
single-use, deadline-bound attach capability over their user-only local control
socket. It is scoped to desktop installation, resource key, keeper generation,
and requested access mode. The cohort proxy rejects a terminal connection that
cannot redeem that capability, so pinning an old executable does not create a
second authorization authority.

The v1 terminal wire envelope remains compatible across these local-protocol
cohorts. Any future incompatible terminal-wire major requires a follow-up ADR,
a bundled desktop adapter, and update-activation rules for live descriptors;
local-protocol pinning does not pretend to solve arbitrary wire incompatibility.
Updating the current bridge is never a reason to terminate a keeper.

### Session Keeper

Each keeper owns one remote terminal session:

- PTY master and child process lifetime
- deterministic `RemoteResourceKey` with the existing `sessionId`
- opaque `keeperGeneration` and pinned executable generation
- `keeperLocalProtocolMajor` and `terminalWireVersion`
- exactly one fenced writer lease
- input and resize validation, deduplication, and PTY-boundary acknowledgement
- authoritative applied PTY rows/columns
- ordered output/resize/exit mutation journal
- headless terminal materialization
- bounded checkpoint and replay state
- cwd/title/foreground-process metadata
- process-exit status
- local user-only control socket
- detached terminal-query replies, OSC cwd/title, bell, and terminal
  notification handling

Keeper identity is not a process-local integer. It is generated as a durable
generation and stored with the deterministic resource key in the session
descriptor before the success response is returned.

Keepers survive bridge and SSH-channel loss. On bridge restart, it discovers
keeper descriptors and proves liveness through their local sockets before
reporting observed state.

The implementation must avoid parent-death signals, inherited SSH stdio, or
process-group behavior that ties keeper lifetime to the bootstrap channel.

The PTY owner/journal loop and headless parser are separate keeper threads
connected by a bounded mutation channel. The parser owns no lock, file
descriptor, or mutable state required by PTY read, journal append, or live
delivery. Remote release builds use Rust unwind semantics, and the parser worker
boundary catches a parser unwind, discards its state, and reports a typed
`parser-rebuilding` status. It rebuilds from a compatible checkpoint plus the
retained journal and then catches up through a frozen mutation boundary.

If the parser channel fills, the owner discards only that derived parser feed,
marks the worker behind, and starts the same journal-based rebuild; it does not
block PTY/journal/live delivery behind headless parsing. The journal, not the
worker queue, is the recovery source of truth.

A parse error or caught unwind therefore does not terminate the PTY owner;
journal recording and live output continue. This guarantee does not claim to
catch process abort, allocator abort/OOM, `SIGKILL`, or memory-unsafety. Such a
keeper-process failure affects only its own session because every other session
has another process. A separate parser process is rejected for v1 because the
unwind-safe worker boundary provides the required common failure containment
without doubling per-session process overhead.

### Writer Lease and Input Boundary

A keeper grants one active `writerLeaseId` for one attachment. Granting a new
lease atomically fences the old one; stale input and resize are rejected
immediately.

The lease fences all external/user/injected input and resize. A terminal query
reply generated by the keeper's own headless model is a separate internal
protocol action, not a second user writer. It is serialized through the same PTY
write queue and deduplicated by its source mutation/action identity.

Each non-idempotent input is identified by:

```text
writerLeaseId + attachmentId + inputSequence
```

The keeper maintains enough deduplication state for its live generation to
apply each input at most once; this is not a per-keystroke fsync path. It records
acceptance before writing the bytes and acknowledges only after the PTY write
boundary. A disconnect after the write but before the ack may leave the caller
uncertain, but retrying the same tuple cannot type the input again. A keeper
crash ends that generation, and no input is replayed into a new one.

### Initial Launch Input

`SessionLaunchConfig.initialInput` is not embedded in `session.create`. Shell
creation and the first command are two different idempotency domains: a retry
must not create a second shell, and an ambiguous command must not be typed twice.

After the create descriptor is durable and shell readiness succeeds, the
coordinator admits a separate `launch-input` operation linked to the create
operation, resource key, and keeper generation. The keeper temporarily grants a
reserved launch attachment its writer lease, records the launch-input operation
as accepted before the PTY write, and records `written` only after the PTY write
boundary. A normal user attachment then obtains a new lease and fences the
reserved one. Payload hash/offset and partial-write handling are the same as
ordinary keeper input.

Retrying the same launch-input operation against the same live generation
returns its recorded result and never writes twice. A disconnect can be retried
with that ID. A keeper crash between acceptance and the durable written result
is reported as `outcome-unknown`; kmux does not guess and does not replay the
command into a new generation or a vendor-resume shell. The created session
remains visible with an actionable launch-input status. Exactly-once delivery
across an unrecoverable PTY-owner crash is not claimed.

The bounded in-flight payload is copied only into the protected durable
operation/outbox record; the remote descriptor, result cache, logs, and
diagnostics store its hash/redacted metadata rather than another raw copy. The
operation copy is removed after a terminal result once the resource descriptor
retains the ID/outcome needed for deduplication. If an existing user-authored
`SessionLaunchConfig` intentionally retains `initialInput` for explicit restart,
that is its canonical product copy: a user-requested restart creates a new
generation and a new launch-input operation, while retry of either operation
never writes twice.

### Metadata and Index Workers

Restartable target/workspace-scoped workers collect:

- cwd and process metadata
- Git repository, branch, worktree, and status metadata
- listening ports
- filesystem watch events
- external agent-session indexes
- usage records

Workers do not own PTYs. Worker failure degrades the relevant feature without
terminating terminal sessions.

### Hook and CLI Event Spool

`kmuxd hook` and target-local CLI producers write sequence-numbered events to a
bounded, user-only spool when the bridge is down. A reconnected bridge replays
after the desktop's last acknowledged event sequence and removes acknowledged
entries. Latest-state compaction and bounded low-value event dropping are
allowed only with explicit counters; important hook and OSC notifications are
not reported as delivered before durable spool admission.

### Remote Resource State

The desktop remains authoritative for window, pane, surface, and title layout.
The remote runtime persists only the remote execution descriptors needed to
recover and reconcile, and the keeper owns the associated generation-local
lease/deduplication state:

```text
RemoteResourceKey
remote installation id
execution node id
authenticated UID and canonical account name
LocatedPath remote cwd
conversion transaction id
create operation id
remote resource revision and last operation/result digest
provisional / committed state
keeper generations, protocol cohorts, and endpoints
keeper-owned writer-lease/input-deduplication state
launch metadata
process exit state
retained mutation journal/checkpoint metadata
executable generation and local protocol version
```

Remote layout sync across multiple desktops is a separate feature and is not
implicitly introduced by SSH support.

## Remote Runtime Deployment

### Self-Contained Artifacts

Bundle all four remote artifacts in every desktop package at the same formal
support tier:

| Artifact           | Contract                             |
| ------------------ | ------------------------------------ |
| `darwin-arm64`     | signed arm64 Mach-O                  |
| `darwin-x64`       | signed x86_64 Mach-O                 |
| `linux-arm64-musl` | statically linked arm64 musl binary  |
| `linux-x64-musl`   | statically linked x86_64 musl binary |

Bootstrap selects only after remote OS, architecture, and ABI probing. Missing,
unsupported, or ambiguous combinations fail before any workspace mutation.
Windows, ConPTY, and named-pipe targets return an actionable unsupported-target
error.

The remote user is not required to install:

- Node.js or npm
- Python
- a C/C++ compiler or `node-gyp`
- `tmux`, `screen`, or `zellij`
- a system-wide service

Unsupported platform/architecture/ABI combinations fail before mutating the
workspace and show an actionable compatibility error.

### Content-Addressed Installation

SFTP is mandatory for first bootstrap. `remote-host` uploads the selected
`kmuxd` and manifest to a staging path, closes the upload, reads the remote
bytes back through SFTP, verifies SHA-256 against the bundled manifest, and only
then atomically renames the completed directory into its content-addressed
location.

Install, authority, and execution state have separate capability checks;
sockets live in a separately probed ephemeral runtime root:

```text
host-local install root (default ~/.kmux/ when verified local)
  bin/
    <protocol-version>+<content-hash>/
      kmuxd
      manifest.json
      install-complete

host-local authority root (default under state root after locality probe)
  installation.json
  execution-node.json

host-local state root (default ~/.kmux/state/ when verified local)
  workspaces/
  sessions/
  operations/
  journals/
  checkpoints/

ephemeral runtime root (probed platform path or explicit override)
  target.sock
  keepers/
```

Installation rules:

- never overwrite an executable generation in place
- use SFTP staging and verify the bytes read back from the remote
- use an atomic per-generation install lock
- recover stale locks and partial installs
- write the completion sentinel last
- pin each live keeper to its executable generation
- garbage-collect only complete generations with no live process references
- make GC best effort and never block a connection

New bridges negotiate with older keepers through a versioned local protocol.
Compatible keepers use the current bridge directly. Incompatible local-protocol
cohorts use the pinned terminal-only bridge proxy described above. A generation
referenced by either a live keeper or a cohort proxy cannot be garbage-collected,
and its manifest/hash is revalidated before the proxy starts. New sessions
always use the current cohort. When the final old keeper terminates, the cohort
proxy stops and its generation becomes eligible for ordinary GC. If the pinned
generation is externally removed or corrupted, kmux reports an explicit
compatibility-repair state and leaves the keeper running; it never replaces or
kills the session to hide the error.

If SFTP later becomes temporarily unavailable, an already-installed compatible
helper continues to provide terminal create/attach/reconnect operations that do
not require file transfer. First bootstrap and generation installation never
fall back to `scp`, shell redirection, or base64 over the control channel.

### Install, State, and Runtime Path Probe

Persistent install, authority, execution-state, and ephemeral runtime-socket
paths are separate capabilities. Before authority state, a workspace
descriptor, or a keeper is created, `kmuxd doctor` probes:

- directory creation, atomic rename, permissions, durability, and free space
  for install/authority/state
- executable permission and mount `noexec` behavior for install
- mount/filesystem locality for install, authority, and execution state; known
  NFS, network, cluster, or shared roots are rejected even if atomic rename
  works, because generation GC and live-process references are node-scoped
- platform node observation and its binding to the persisted execution-node
  record
- Unix-socket creation, permissions, path length, and peer access for runtime
- filesystem suitability for sockets; an unsuitable NFS runtime directory is
  rejected

Read-only, `noexec`, unverified/shared install, authority, or state storage,
unsuitable runtime storage, or other failed probes require an explicit
`installPathOverride`, `authorityPathOverride`, `statePathOverride`, or
`runtimePathOverride` on the profile. The override is probed under the same
rules; it is not an assertion that bypasses verification. kmux does not guess
another persistent location after workspace mutation has started. Shared
workspace/repository paths remain valid and are not confused with kmux-owned
execution state.

### Remote Platform Capabilities

Remote platform code is composed from small Rust capabilities rather than a
single large OS interface:

```rust
trait PtyBackend { /* PTY spawn, resize, process-group control */ }
trait ProcessInspector { /* process and foreground metadata */ }
trait WatchBackend { /* bounded filesystem notifications */ }
trait PersistenceBackend { /* optional user service capability */ }
trait NodeIdentityBackend { /* host-local authority and node observation */ }
```

Both platforms share common POSIX PTY and process-group code. Linux adapters
use `/proc`, inotify, and verified `systemd --user` behavior. macOS adapters
use libproc, FSEvents/kqueue, and verified launchd behavior. Missing optional
metadata/watch/service capabilities degrade those features, not terminal
ownership.

The Linux node-identity adapter binds the host-local random
`executionNodeId` to a validated `/etc/machine-id`; the macOS adapter binds it
to `IOPlatformUUID`. Only a one-way binding digest is stored and returned for
verification, never the raw platform value. Empty, known-generic, unreadable,
or changed observations fail closed. A future container/cluster environment
whose execution namespace is not faithfully represented by these signals needs
another `NodeIdentityBackend` and capability flag rather than hostname-based
guessing.

ADR 0004's “no headless Linux desktop release” scope applies to the Electron
desktop package. It does not prohibit this user-scoped remote Linux runtime.
ADR 0002's single local `pty-host` decision also remains unchanged; per-session
Rust keepers are specific to SSH targets.

### Persistence Levels

`nohup &` alone is not treated as a universal guarantee. Remote login managers,
`systemd-logind`, account policies, host reboot, or administrator cleanup can
terminate user processes.

The bridge reports an observed persistence level such as:

```ts
type RemotePersistenceLevel = "ssh-disconnect" | "user-logout" | "host-reboot";
```

The baseline contract is survival across SSH disconnect and desktop restart.
Survival across logout or reboot is advertised only when kmux has verified an
appropriate user service or equivalent platform mechanism. Reboot does not
imply process-memory checkpointing; a service may restart the bridge and expose
retained history while previous PTY processes are correctly reported exited.

## Remote Shell and Environment Semantics

Bootstrap and interactive session launch are separate concerns.

The bootstrap shell adapter runs only the minimal commands needed to probe the
platform, locate an installed generation, and start `kmuxd doctor` or
`kmuxd bridge`. Known macOS/Linux shells have explicit, quoted adapters. A
custom or unknown login shell requires `bootstrapShellOverride`; without one,
bootstrap stops before mutation and reports the detected shell and the required
profile setting. kmux does not guess Bourne-shell syntax through an unknown
interpreter.

After the helper is running, keepers launch the actual authenticated account
shell without replacing it with the bootstrap shell. An explicit
workspace/session or profile shell override remains a user choice; otherwise
the account shell is used as configured. Unknown and custom interactive shells
are supported because `kmuxd` performs PTY setup directly and does not need to
parse their startup files.

The two adapter contracts are distinct:

```ts
interface BootstrapShellAdapter {
  shellPath: string;
  buildProbeCommand(): ShellCommand;
  buildHelperLaunch(): ShellCommand;
}

interface InteractiveShellAdapter {
  shellPath: string;
  buildPtyLaunch(): ShellLaunch;
  readinessStrategy: "marker" | "prompt" | "delay" | "none";
}
```

Agent startup commands should normally be delivered through the initialized
interactive shell after readiness, so they receive the user's actual shell
environment. Starting an agent directly from the bridge's minimal SSH exec
environment is not equivalent. For a remote session this delivery is the
separate durable `launch-input` operation, never an untracked suffix of keeper
creation.

Environment fingerprints may invalidate cached metadata for known interactive
shells, but are not required for correctness. Probes are bounded and
cancellable. An unsupported optional environment probe may degrade metadata;
only an unsafe or unspecified bootstrap command blocks initial installation.

## Terminal Continuity Protocol

### Output Identity

The raw-output-only sequence is rejected. Every keeper commits output, resize,
and exit through one mutation sequence:

```ts
type TerminalMutation =
  | { sequence: Uint64; kind: "output"; data: Uint8Array }
  | { sequence: Uint64; kind: "resize"; cols: number; rows: number }
  | { sequence: Uint64; kind: "exit"; exitCode?: number };

interface RemoteTerminalMutationEnvelope {
  resourceKey: RemoteResourceKey;
  keeperGeneration: Id;
  mutation: TerminalMutation;
  emittedAt: string;
}
```

`sequence` increases monotonically for the keeper generation and is encoded as
an unsigned 64-bit integer on the wire. TypeScript must preserve it without
unsafe JavaScript-number coercion. A new generation has a new sequence
namespace.

PTY resize, headless-terminal resize, output parsing, checkpoint boundaries, and
exit all commit in this order. Consequently `checkpoint -> resize -> output`
replay has the same geometry and screen as live execution.

### Journal and Materialization

Each keeper maintains:

1. a bounded mutation journal
2. a compatible headless terminal state
3. atomic materialization checkpoints
4. retained-range metadata

```ts
interface TerminalCheckpoint {
  checkpointId: Id;
  keeperGeneration: Id;
  format: "xterm-vt/1";
  parserVersion: string;
  lastMutationSequence: Uint64;
  cols: number;
  rows: number;
  createdAt: string;
  byteLength: Uint64;
  sha256: string;
}
```

`xterm-vt/1` is a versioned restore stream, not an opaque Rust parser snapshot.
It materializes xterm-compatible VT state at the checkpoint's recorded
geometry. Rust headless-parser and xterm.js conformance fixtures cover parser
version, restore stream, mutation tail, and final geometry.

`TerminalCheckpoint` is metadata; its bytes follow the common
`checkpoint:begin/chunk/end` bounded `ArrayBuffer` stream. The digest and total length
are validated before the checkpoint is committed for application. Neither the
renderer-facing message nor control JSON contains one monolithic byte array.

If conformance or version negotiation fails, the renderer discards the
checkpoint and replays the retained mutation journal. It never applies a
possibly incompatible materialization. The keeper journal remains
authoritative; no renderer checkpoint can acknowledge an unrecorded mutation.

A parser error/caught unwind marks headless state `parser-rebuilding` and stops
checkpoint generation until a fresh worker reaches the mutation boundary. The
keeper's owner thread retains authoritative geometry and can continue bounded
geometry-query replies while detached. Parser-dependent query replies are
queued only to a small deadline-bound limit and otherwise expire with an
observable counter and typed headless-degraded status; the keeper never
synthesizes a guessed terminal reply. cwd/title, bell, and
terminal-notification updates resume from journal replay without being falsely
reported as processed during the gap. Normal detached operation continues to
handle all of them.

Parser-derived side effects are proposals tagged with
`mutationSequence + actionIndex`. The keeper owner, not the parser worker,
maintains the applied side-effect cursor and admits each query reply, OSC
metadata change, bell, or notification exactly once. Rebuild runs in replay
mode: it suppresses actions already admitted and emits still-unprocessed actions
from the parser downtime once it reaches them. A query reply is serialized into
the owner's PTY write queue only after this deduplication. Thus rebuilding the
screen cannot retype an old device-status reply or duplicate a notification.

Parser recovery does not stop journal append, live delivery, the PTY, or the
agent process. If no compatible checkpoint plus retained range can rebuild the
model, checkpoint and model-dependent headless features remain degraded while
the journal/live terminal continue; the UI exposes that state rather than
claiming a complete capture.

### Attach and Replay Barrier

```ts
interface AttachRemoteSessionRequest {
  resourceKey: RemoteResourceKey;
  expectedKeeperGeneration?: Id;
  lastReceivedSequence?: Uint64;
  expectedSurfaceId?: Id;
}

interface AttachRemoteSessionResult {
  keeperGeneration: Id;
  checkpoint?: TerminalCheckpoint;
  earliestAvailableSequence: Uint64;
  replayFromSequence: Uint64;
  liveStartsAfterSequence: Uint64;
  truncatedBeforeSequence?: Uint64;
}
```

Attach order:

1. verify desktop installation, target, workspace, session, and optional
   surface identity
2. prove keeper liveness
3. freeze a `liveStartsAfterSequence` boundary
4. return a compatible checkpoint when available
5. replay journal mutations through that boundary
6. begin live delivery strictly after the boundary

The renderer deduplicates by generation and sequence. It never infers that an
empty replay means the process is alive.

If the journal was compacted, the UI applies the best checkpoint or retained
tail and exposes a normal `earlier output unavailable` state. It does not merge
stale renderer content with an unrelated new shell.

The replay/live barrier is enforced inside the keeper's ordered mutation path.
Bridge and `remote-host` buffering cannot manufacture, skip, renumber, or merge
mutations. Each layer has a bounded queue and closes the attachment on a
protocol gap rather than guessing.

### Input, Resize, and Geometry Ordering

Input is non-idempotent and requires the active writer lease. Every input frame
carries `writerLeaseId`, `attachmentId`, and a monotonic
`inputSequence`. The keeper records the highest applied sequence for the
lease/attachment pair and returns it in acknowledgements and reconnect state.
Retrying an ambiguously acknowledged frame is deduplicated.

```ts
interface RemoteTerminalInput {
  resourceKey: RemoteResourceKey;
  keeperGeneration: Id;
  writerLeaseId: Id;
  attachmentId: Id;
  inputSequence: Uint64;
  data: Uint8Array;
}

interface RemoteTerminalInputAck {
  writerLeaseId: Id;
  attachmentId: Id;
  highestAppliedInputSequence: Uint64;
  boundary: "pty-write";
}
```

The contract is at-most-once within a live keeper generation. The keeper marks
the tuple accepted before writing it to the PTY and acknowledges after the PTY
write boundary. A keeper crash may leave the last outcome unknown, but kmux
never replays input into a new keeper generation or replacement shell.

Acceptance records the payload length/hash and current written offset. PTY
writes may be partial; the live keeper continues only the unwritten suffix and
a retry with another payload is an idempotency conflict. A write error after a
partial boundary returns a typed partial/outcome-unknown result and never
retypes the prefix.

Granting a new writer lease atomically revokes the previous lease. Input and
resize carrying a stale lease fail with a typed fenced result before PTY or
headless state changes. Read-only attachments do not have an implicit writer
capability.

The lease transition is ordered after input frames already accepted by the
owner; those frames finish or return their partial result, while any subsequent
frame from the old attachment is rejected. Bytes from old and new leases cannot
interleave inside one accepted frame.

PTY geometry is keeper authority, not renderer guesswork. A resize is ordered
with output as a `TerminalMutation` and also carries the writer lease. The
keeper applies PTY resize, updates headless dimensions in the same ordered
transition, and acknowledges the committed mutation sequence and dimensions.

Checkpoints include their rows and columns. On attach, the renderer first
materializes the checkpoint at its recorded dimensions, replays the ordered
delta, and then requests the current visible size. A resize or reflow cannot be
applied to a stale checkpoint as if it had already represented the new geometry.

The system distinguishes:

```text
renderer measured size
desktop requested size
keeper applied PTY size
headless parser size
checkpoint size
```

These values may converge, but they are not interchangeable sources of truth.

The keeper's headless terminal remains active while detached. It owns replies
for terminal-state queries, consumes OSC cwd/title updates, records bells, and
spools terminal notifications. Renderer visibility never changes which side
answers a terminal query.

### Backpressure and Fairness

Each attached terminal stream has bounded queues and acknowledgements. Active
input echo and interactive redraw receive priority, but output is never silently
dropped solely because a pane is hidden.

The v1 hard defaults are a 4 MiB outbound queue per terminal attachment, a
64 KiB aggregate pending-input limit per attachment or injected-input request,
and an 8 MiB metadata/control queue per target. File/SFTP transfer windows are
separate and cannot borrow terminal queue capacity. Reaching a limit applies
credit/backpressure or fails the affected bounded request; it never grows a
process-global queue.

If a renderer cannot keep up:

- the desktop bounds each attachment with stream credit and a bounded renderer
  parse backlog; terminal bulk data does not require a Main-process relay
- the keeper retains journal authority
- the renderer can request a fresh checkpoint and sequence delta
- one noisy session cannot exhaust all target or desktop memory

Journal admission is upstream of normal live delivery, but the hot path does
not `fsync` every mutation. The keeper distinguishes:

```text
journal-admitted  append/write completed without a storage error
journal-synced    fdatasync/fsync completed through this mutation sequence
```

Normal live delivery may begin only after `journal-admitted`. A bounded group
commit advances `journal-synced` at least every 50 ms or 1 MiB of newly admitted
records, whichever occurs first. A checkpoint cannot claim a sequence beyond
`journal-synced`, and compaction cannot remove the only synced representation
of a retained mutation. Identity, create/result records, conversion decisions,
and descriptor replacement still use immediate file-and-directory fsync; they
are not governed by this terminal-journal group policy.

This contract survives bridge, SSH, desktop, and ordinary keeper-process loss
without acknowledging an append error. Sudden host power loss may remove only
the group-commit tail that had never reached `journal-synced`; recovery reports
the missing tail boundary instead of pretending it was durable. The baseline
does not claim that a PTY survives host reboot.

When storage reaches quota, sync completion exceeds two seconds, or the
filesystem reports full:

1. remove the oldest eligible checkpoints and compacted journal ranges under
   the documented per-target/per-session quota policy
2. expose `storage-degraded` to the UI and keep at most 4 MiB of in-memory
   emergency mutation data per keeper
3. if durable append still cannot proceed before that buffer fills, stop reading
   the PTY and let operating-system backpressure reach the child

The keeper never sends unrecorded output as if it were safely retained. It never
drops an unjournaled mutation and advances the acknowledged sequence. Recovery
resumes durable append before normal live delivery.

Default retained-data limits are 256 MiB per session and 2 GiB per target, with
cleanup beginning at 90% and stopping at or below 75%. Profiles may lower or
raise them within 64 MiB–4 GiB per session and 256 MiB–32 GiB per target; the
target limit must be at least the session limit and `unbounded` is not valid.
Checkpoint chunks are at most 256 KiB and a checkpoint is at most 16 MiB unless
a negotiated future protocol raises both endpoints' hard limits.

Typing, focus, pane switch, resize, and render paths must not trigger broad
remote session inventory scans.

## Lifecycle and Restore

### Desktop Restart

When `Restore workspaces after quitting` is enabled:

1. load product state, durable WAL/outbox state, and remote bindings
2. rebuild layouts without creating replacement PTYs
3. resolve and re-verify each authority
4. start/connect the bridge and reclaim provisional operations first
5. reconcile known resource keys against keeper descriptors
6. attach live sessions through the replay barrier
7. mark a session exited only from an authoritative matching descriptor/status
8. offer vendor-native resume only after the keeper is authoritatively gone

When the setting is disabled, kmux does not rebuild the prior workspace layout,
but it also does not terminate keepers. Their descriptors appear in a retained
session inventory keyed by target/workspace/session. The user can reattach,
adopt into a workspace, or explicitly terminate each retained session.

An unreachable target leaves surfaces in a reconnectable state. It does not
clear bindings, close tabs, or start a local shell.

### Disconnect and Reconnect

```text
SSH transport drops
  -> desktop marks target observation unknown
  -> keepers continue running
  -> outbox mutations remain pending
  -> reconnect and reverify authority
  -> observe bridge/keepers
  -> retry idempotent outbox operations
  -> reattach by generation and sequence
```

Authentication cancellation does not start an automatic prompt loop. The
workspace remains reconnectable and lets the user explicitly retry.

### Close and Terminate

- desktop quit: detach
- window close: detach unless the user explicitly requests termination
- workspace close/remove: retain keepers by default and show them in retained
  inventory; an explicit termination choice may terminate them
- surface/session close: terminate that keeper through an idempotent operation
- surface restart: explicit operation that fences the writer and replaces only
  that session's keeper generation
- `Terminate all sessions on target`: explicit destructive action
- profile disconnect: close transports but preserve keepers
- remote-runtime reset: never implied by ordinary reconnect

Retention is explicit and bounded by disk quotas. The default favors preserving
live work until explicit termination; v1 has no general live-keeper idle TTL.
The separate 24-hour rule applies only to uncommitted provisional keepers that
never granted a writer lease. Journal/checkpoint retention can be shorter than
process retention as long as truncation is visible and does not affect PTY
lifetime.

An authoritative inventory that omits a known keeper may change its observed
process state only after generation/resource-key checks and the platform's
liveness rules succeed. It never causes replacement creation, binding removal,
or future Agent Team cleanup as a side effect.

## Feature Contracts

Every contract in this section is implemented through the selected
`TargetServiceSet`; the feature module does not choose local versus SSH itself.
Optional capability absence yields a typed degraded/unavailable result. It
never invokes the other target's provider as a fallback.

| Area                  | Remote contract                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Pane/surface          | Split creates a new keeper; restart changes generation only through an explicit operation                                    |
| Restore               | Disabling layout restore does not kill keepers; they remain in retained-session inventory                                    |
| CLI/future Agent Team | Alias routing, `send_text`/`send_key` PTY-boundary acknowledgement, and bounded `surface.capture` execute on the same target |
| Hooks/notifications   | `kmuxd hook` writes a bounded user-only spool while bridge/desktop is absent and replays without duplicates                  |
| Git/worktree          | Operations run through the target provider with dirty checks and dedicated-worktree policy; there is no local fallback       |
| Usage/history         | Target-local history and account-wide subscription usage are distinct scopes                                                 |
| Files/attachments     | SFTP is required for bootstrap; remote paths reach local openers only through download/staging providers                     |
| Ports/browser         | Loopback forwards are desired state; local collisions update the URL and port mapping                                        |
| Retained sessions     | Sessions are reattachable and terminable independently of workspace layout                                                   |

### Pane Splits and Surfaces

Splitting a pane creates another keeper in the same SSH workspace scope. It
does not create another user-visible SSH profile or TCP SSH connection.

The product continues to use kmux identities:

```text
workspaceId
paneId
surfaceId
sessionId
```

The keeper descriptor uses those identities directly through
`RemoteResourceKey` and records the expected surface identity for attach
validation. Restarting a surface is an explicit operation that replaces only
its keeper generation. Attach, restore, and split failure never trigger an
implicit restart.

### Agent Hooks, Resume, and Notifications

Remote agent hooks invoke `kmuxd hook` against a user-only remote endpoint or
spool, never a local desktop socket path. The short-lived hook process can
durably admit a bounded event while the bridge is absent.

Remote shell environment includes scoped values:

```text
KMUX_TARGET_ID
KMUX_WORKSPACE_ID
KMUX_SURFACE_ID
KMUX_SESSION_ID
KMUX_KEEPER_GENERATION
KMUX_AGENT_HOOK_ENDPOINT
KMUX_AUTH_TOKEN
```

The spool stores bounded, sequence-numbered important events and latest state
per live session. On reconnect, the desktop requests replay after its last
acknowledged event sequence. Duplicate sequence/event IDs are ignored.
Low-value high-volume events may be compacted with observable counters.
Detached OSC terminal notifications use the same acknowledgement model.

Restore priority:

1. reattach a live keeper
2. if the keeper is authoritatively gone, run the vendor's native resume command
   on the same target and recorded `LocatedPath` cwd
3. otherwise show an explicit recoverable dead-session state

All notifications include target, workspace, surface, session, and event
identity required for deduplication.

If Agent Team aliases are introduced, they remain desktop product state, but
routing resolves to a `RemoteResourceKey` and executes on that target. Phase 6
implements only the reusable route/input/capture primitives and compatibility
seams; it does not introduce aliases or a Team runtime. `send_text` and
`send_key` carry a bounded request/operation ID and succeed only after the
keeper's PTY-boundary ack. Main authorizes and routes the command, but
`remote-host`/the target terminal provider obtains a one-shot injection
delegation scoped to the keeper's current writer-lease epoch. The delegation
does not grant a second lease: it is serialized in the same PTY input queue and
becomes fenced if the lease changes before acceptance. If no writer attachment
exists, the keeper may grant a short-lived operation attachment the sole lease
and revoke it after the ack. The request ID is deduplicated independently from
renderer input sequence, and an ambiguous accepted request is never reissued
under a new lease or generation.

`surface.capture` reads bounded plain text from that keeper's headless terminal
and returns its target, generation, mutation sequence, geometry, and truncation
state. The UTF-8 text uses bounded metadata chunks when it exceeds one control
frame and never exceeds the 1 MiB request cap. It never substitutes a local
session with the same IDs or cwd.

### Remote kmux CLI

Expose the `kmuxd cli` subcommand through a small `kmux` shim in the
generation's kmux-owned bin directory and prepend that directory only to
kmux-managed PTY environments.

```text
remote kmux command
  -> user-only bridge socket
  -> bridge handles remote-local operation or routes to connected desktop
  -> structured result returns to remote shell
```

Commands declare whether they require a connected desktop. Target-local
commands such as session status may run while detached; UI commands such as
focus/open return an actionable offline error when no desktop is attached.
Create, restart, adopt, terminate, managed-worktree, and forward mutations
always require Main's durable coordinator. Bounded target-local capture or input
may execute through the keeper with the same request-ID, authorization, fencing,
and acknowledgement contracts but does not mutate product layout. All
surface/session commands resolve their resource key on the current target and
return structured acknowledgement; cross-target alias routing is rejected.

### Usage and External Session History

Remote index workers read remote vendor storage and send normalized records:

```text
targetId
workspaceId, when known
LocatedPath cwd
vendor
vendor session id
timestamp
title/summary when available
```

The desktop may cache results, but target identity remains part of record
identity and filtering. Matching by cwd alone is invalid.

Restoring a remote history record resolves the same immutable target, creates
or focuses an SSH workspace, and launches the vendor resume command remotely.

Target-local history and token/activity records are scoped by target and
principal. Account-wide subscription quota/entitlement data is a separate
scope and may aggregate across targets only when the provider defines it that
way. kmux never attributes account-wide subscription usage to a machine merely
because that machine supplied credentials.

### Files, Links, and Attachments

Remote files use SFTP rather than the terminal control channel. Text previews,
binary downloads, uploads, and attachments all preserve byte identity and use
bounded transfers.

```ts
interface TerminalFileRef {
  location: LocatedPath;
  line?: number;
  column?: number;
}
```

Remote file references are never passed directly to a local OS opener. A remote
download provider first stages and verifies a local copy and returns a new
opaque `LocalPath` for the local opener provider. Attachments use the inverse
SFTP staging provider with bounded retention, then insert only the remote
provider's path into the terminal.

Filesystem watchers and small metadata may use the bridge, but their queues are
bounded and independent from terminal streams.

SFTP absence fails first bootstrap before remote workspace mutation. A
temporary later SFTP outage degrades file/attachment features but does not
interrupt an already-installed helper's terminal core.

### Git and Worktrees

Git commands execute on the target containing the repository.

- local workspace actions use local Git providers
- SSH workspace actions use remote Git providers/workers
- repositories and worktree paths are `LocatedPath` values
- worktree IDs and paths include target scope
- remote failure never falls back to a local worktree with the same path
- dirty checks run on the target before removal, conversion, or reuse
- future Agent Team dedicated-worktree allocation and dirty-removal protection
  must reuse the same durable contract as local operation
- large diff/history responses use a chunked bounded stream, not one giant
  control response

### Ports and Browser Context

Listening-port discovery runs remotely. Forwarding uses SSH network channels:

```text
remote localhost service
  -> SSH direct-tcpip
  -> local 127.0.0.1 ephemeral or selected port
  -> browser pane
```

Use dynamic SOCKS forwarding when a browser must resolve arbitrary hostnames or
access a broader remote/private network context. Direct forwards are preferred
for known workspace ports because they are narrower and easier to persist.

Port records include:

```text
targetId
workspaceId
remoteHost
remotePort
localBindHost
localPort
forward identity and status
```

Local listeners bind to loopback by default. Saved forwards are desired state
and are reconciled after reconnect; their underlying sockets/processes are not
assumed to survive transport loss.

If the requested local port is occupied during initial bind or restoration,
kmux selects an allowed loopback port, atomically updates the forward mapping,
and updates every generated browser URL to the actual local port. It does not
silently point an existing URL at the colliding local service.

### Retained Session Inventory

Retained sessions are execution resources, not workspace-layout children. The
inventory shows target, workspace/session IDs, title/cwd, process and
observation status, last attachment, journal retention, storage degradation,
and persistence capability. It supports:

- reattach to an existing or newly adopted surface
- explicit termination of one keeper
- explicit target-wide termination with confirmation
- cleanup of exited descriptors after retained data policy permits

Closing a layout or disabling restore never removes an inventory entry while a
keeper may still be live.

## Protocol

### Remote Wire and Schema Source of Truth

Every remote-wire frame has a fixed envelope:

```text
uint32_be frameLength  // kind + payload bytes
uint8     frameKind
byte[]    payload
```

`frameLength` is checked against the local hard maximum and the negotiated
limit before allocation. Zero, unknown kinds, oversized frames, invalid chunk
offsets, and truncated frames close the affected channel with a typed protocol
error.

The v1 outer-frame hard maximum is 1 MiB. Control JSON is at most 256 KiB;
terminal and checkpoint chunks are at most 256 KiB; metadata/file-like content
larger than one frame must use the offset-checked chunk stream. Negotiation may
lower a limit but cannot raise either endpoint's compiled hard maximum.

Frame kinds separate:

- schema-validated control JSON
- terminal-mutation binary chunks
- checkpoint binary chunks
- bounded metadata binary chunks
- stream completion/error

Control JSON is never accepted as an unvalidated arbitrary object. Versioned
JSON Schemas under `packages/proto/schema/remote` and language-neutral positive
and negative conformance fixtures are the source of truth. Rust and TypeScript
both validate the same fixtures in their existing protocol test suites. Binary
frame layout, integer encoding, maximum sizes, and chunk rules are specified
beside the schema.

`Uint64` values in control JSON use canonical unsigned base-10 strings; binary
terminal/checkpoint metadata uses network-order unsigned 64-bit integers.
TypeScript exposes the branded `bigint` representation defined by the common
data plane and never accepts or coerces these values through a JavaScript
`number`.

Terminal and checkpoint payloads are binary and chunked; they are not base64
inside JSON. The bridge treats keeper terminal frames as opaque after validating
the outer stream bounds and authorization established by the control plane.

### Handshake

Every bridge connection performs:

```text
hello
protocol version range
content/runtime version
capabilities
remote installation id
execution node id
authenticated UID and canonical account name
platform/arch/ABI
persistence level
connection token proof
```

Protocol incompatibility is a typed non-retryable state until a compatible
bridge is installed or selected. Capability negotiation allows additive
features without pretending an older runtime supports them.

### RPC and Mutation Semantics

- requests have bounded payloads and deadlines
- long operations support cancellation
- mutating requests require `operationId`
- resource mutations carry deterministic `RemoteResourceKey`
- responses identify bridge generation
- session responses identify keeper generation
- terminal input is deduplicated by writer lease, attachment, and input sequence
- resize requests require the current writer lease and return mutation sequence
  plus authoritative applied size
- unknown fields are forward-compatible where safe
- authorization is checked per target/workspace/session scope
- ambiguous transport failure does not imply mutation failure
- operation-ledger compaction cannot remove create identity from its resource
  descriptor
- expected/next resource revision rejects stale or skipped mutations after
  operation-ledger compaction

### Stream Semantics

- terminal data is binary, not base64 JSON
- large metadata/file-like results are chunked
- each stream has identity, offset/sequence, credits, and terminal status
- output, resize, and exit use one unsigned 64-bit mutation sequence
- stream producers stop on cancellation or client detach
- disconnect releases blocked writers
- frame limits are enforced before allocation
- replay and live delivery meet at one frozen keeper-owned barrier

## Security

### SSH Trust

Use system OpenSSH as the v1 transport and delegate trust evaluation to it on
every connection.

- never force `StrictHostKeyChecking=no`
- surface first-use and changed-host-key prompts/failures clearly
- where supported, capture `KnownHostsCommand` `%f`/`%K` as an optional audit
  observation; do not synthesize a fingerprint when unavailable
- let OpenSSH block a changed host key and require authority re-verification
- respect OpenSSH agent, certificates, `Include`, `Match`, ProxyJump, and
  ProxyCommand behavior
- keep agent forwarding off unless explicitly enabled
- do not persist private-key passphrases in profile storage
- verify the complete installation ID, execution-node ID, UID, and canonical
  account-name authority tuple before attach or mutation
- fail closed on installation ID, execution node, UID/account, node-locality,
  profile/effective-policy, and authority mismatch

If a future in-process SSH implementation is added, it must implement equivalent
host-key verification and OpenSSH configuration behavior before becoming the
default, and requires a follow-up ADR.

### Remote Runtime Boundary

- run as the authenticated SSH user, never root
- remote runtime directories are user-only
- POSIX sockets are created atomically with `0600`-equivalent access
- state directories use `0700`-equivalent access
- no unauthenticated TCP listener is exposed
- SSH plus a rotating scoped kmux token authenticates bridge RPC
- tokens are not placed in exported logs or ordinary persisted workspace state
- hook tokens are scoped to target/session and rotated
- remote CLI requests pass an allowlisted environment, not arbitrary remote
  environment variables into desktop processes
- `LocatedPath` kind/target is authorized before the selected provider
  canonicalizes a path; remote values never enter a local provider
- after bootstrap, remote paths/arguments use structured kmuxd requests and
  argv APIs; providers do not interpolate them into a login-shell command
- terminal capture, journal, checkpoint, file, and agent data are treated as
  sensitive user content

Same-user remote processes may be able to inspect user-owned files or process
state; the scoped token and socket permissions are defense in depth, not a
claim to isolate mutually untrusted processes running as the same OS account.

### Logging and Diagnostics

Logs redact secrets and exported diagnostics minimize host, user, and path
details. A bounded lifecycle trace should include identities and transitions
needed to diagnose:

- profile resolution and authority verification
- bridge/keeper generations
- desired/observed/outbox transitions
- attach, replay boundary, and sequence gaps
- queue/backpressure metrics
- transport/channel closure reason
- retention and GC decisions

## Failure Model

| Failure                                      | Required behavior                                                                                                     |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| SSH unreachable                              | Keep workspace/session bindings; show reconnectable state                                                             |
| Authentication canceled                      | Stop retry prompts; preserve desired state                                                                            |
| Host key changed                             | Block before attach; require explicit resolution                                                                      |
| Profile resolves to another authority        | Block as target mismatch                                                                                              |
| Shared/copy-detected authority or state root | Block before mutation; require a verified host-local override                                                         |
| Execution node or UID/account changes        | Block as authority mismatch; require explicit rebind                                                                  |
| Bridge crashes                               | Keepers continue; restart bridge and rediscover                                                                       |
| `remote-host` crashes                        | Keepers continue; restart host, reverify, and reattach                                                                |
| One keeper crashes                           | Only that session exits; other sessions continue                                                                      |
| Headless parser errors/unwinds               | Mark parser rebuilding; keep journal, PTY, and live output; degrade model-dependent headless features until caught up |
| Metadata worker crashes                      | Degrade metadata feature; do not affect PTYs                                                                          |
| Desktop crashes/restarts                     | Keepers continue; restore through reconciliation                                                                      |
| Replay journal truncated                     | Apply checkpoint/tail and show earlier-output-unavailable                                                             |
| Checkpoint incompatible                      | Ignore checkpoint and use retained mutation replay                                                                    |
| Mutation response lost                       | Retry same operation ID and return original result                                                                    |
| Target observation times out                 | State remains unknown; do not destroy bindings                                                                        |
| Remote host reboots                          | Keep observation unknown until boot/session evidence authoritatively proves exit; never replacement-spawn             |
| Disk quota/full reached                      | Compact eligible retained data, use bounded emergency memory, then backpressure PTY reads                             |
| First-bootstrap SFTP unavailable             | Fail before workspace mutation                                                                                        |
| SFTP fails after install                     | Keep terminal core; degrade file/attachment operations                                                                |
| Old writer sends input/resize                | Reject as fenced before PTY/headless mutation                                                                         |
| Runtime version changes                      | Side-by-side install; do not kill old keepers                                                                         |
| Keeper local protocol is incompatible        | Start/reuse its pinned cohort proxy; do not kill the keeper                                                           |
| Windows remote requested                     | Fail before mutation with explicit unsupported-target state                                                           |

## Storage

### Local Desktop

Persist:

- SSH profiles without secrets
- authority, locator, platform observation, and optional fingerprint records
- workspace locations and title provenance
- pane/surface layout
- target-scoped launch configurations
- deterministic resource keys and expected keeper generations
- desired remote state
- durable conversion WAL and idempotent outbox operations
- last authoritative observed state and timestamps
- coalesced last-received mutation/event cursors as non-authoritative reconnect
  hints; writer-lease authority is never desktop-persisted
- target-aware usage/history caches
- retained-session inventory metadata

Remote checkpoint bytes remain in keeper storage and travel only through the
direct terminal data plane to the renderer. Main persists neither checkpoint
payloads nor a duplicate terminal materialization.

The conversion WAL and durable remote-operation store are separate from the
ordinary debounced product snapshot. Their admission/decision/result records
use the file-fsync, atomic-rename, and parent-directory-fsync primitive defined
by Transactional Conversion. Each record contains the canonical product fact
needed to repair a lagging snapshot. Compaction writes a new bounded store with
the same durability sequence; it never edits an acknowledged record in place.

### Remote Runtime

Keep durable artifacts and records under the user-owned
install/authority/state roots and recreate sockets under the probed ephemeral
runtime root:

- installation/authority identity
- versioned runtime generations and manifests
- keeper descriptors; live sockets are ephemeral and rediscovered/recreated
- workspace/session execution descriptors
- conversion/create/provisional identity in each resource descriptor
- idempotency operation ledger
- bounded mutation journals
- terminal checkpoints
- agent-hook event/state outbox
- metadata indexes
- attachment staging files
- bounded diagnostic logs

Writes that establish identity, session creation, checkpoint replacement, or
operation results use file-and-directory fsync and are atomic/crash recoverable.
Terminal mutation journals use the separately specified bounded group-commit
policy; no implementation may accidentally apply debounced product-state
semantics to either class.

Provisional resource descriptors outlive operation-ledger entries. Cleanup
records whether any writer lease was ever granted, so the 24-hour automatic TTL
cannot terminate a provisional session that a user may have interacted with.

## Package Layout

Source and package ownership:

```text
packages/proto/
  schema/remote/
    <version>/
      control.schema.json
      binary-frames.md
      fixtures/
  src/
    terminalDataPlane.ts
    remoteControl.ts
    remoteFrames.ts

packages/core/src/
  locatedPath.ts
  locatedPathCodec.ts
  workspaceTarget.ts
  runtimeTarget.ts
  remoteOperation.ts
  remoteDesiredState.ts
  remoteObservedState.ts
  remoteOutbox.ts
  main/
    remoteOperationFacts.ts

apps/desktop/src/main/remote/
  authorization.ts
  durableRemoteOperationStore.ts
  remoteOperationCoordinator.ts
  conversionWal.ts
  remoteReconciler.ts
  retainedSessions.ts

apps/desktop/src/main/targets/
  targetServiceRegistry.ts
  capabilities.ts
  pathAccess.ts
  local/
  ssh/

apps/desktop/src/remote-host/
  sshTransportPool.ts
  openSshProcess.ts
  muxOnlyOpenSshChannel.ts
  channelScheduler.ts
  bulkWorkers.ts
  remoteBootstrap.ts
  remoteWire.ts
  terminalDataPlane.ts

tests/e2e/fixtures/
  remote-performance-gates.v1.json

remote/kmuxd/
  Cargo.toml
  crates/
    bridge/
    compat/
    keeper/
    terminal/
    journal/
    platform/
    metadata/
    hook/
    cli/
    doctor/
```

The Rust workspace produces the single `kmuxd` binary. TypeScript owns desktop
control/transport adaptation and Rust owns the remote PTY runtime. The schema
and fixtures, rather than either language's generated types, are the remote
control source of truth. `@kmux/proto` remains the source of truth for the
renderer-facing `TerminalDataPlane`.

## Relationship to Earlier ADRs

- [ADR 0002](./0002-electron-xterm-mvp-architecture.md) remains canonical for
  the local `pty-host` and renderer data plane. This ADR adds a remote runtime
  owner behind the same direct-port contract; it does not turn the local runtime
  into Rust or a process per session. ADR 0002's “Main does not relay input”
  rule continues to cover renderer interactive data-plane frames. The bounded
  request-ID-based CLI/future-Agent-Team input and request-scoped capture described by
  ADR 0003 are control operations, not a live stream relay.
- [ADR 0003](./0003-agent-team-workspaces.md) remains the future product contract
  for aliases, route logs, input acknowledgement, capture, and worktree safety;
  it is not implemented by this ADR. A later implementation resolves those
  operations through `RemoteResourceKey` and a target provider instead of
  assuming the local `pty-host`.
- [ADR 0004](./0004-linux-platform-support-and-os-neutral-architecture.md)
  remains the desktop macOS/Linux platform boundary. Its headless-Linux and
  Windows non-goals concern the Electron desktop phase; this ADR independently
  supports a user-scoped Linux remote runtime and explicitly rejects Windows
  remote support. `TargetServiceRegistry` selects execution location; each
  local capability is still composed from ADR 0004's platform-specific Main
  services rather than replacing that OS boundary.

## Implementation Plan

The order is staged delivery, not staged architectural approval.

### 1. Transport and Runtime Spikes

- prove system OpenSSH identity, askpass, effective-config, host-key observation,
  mux-only fail-closed channel creation for terminal/SFTP/metadata/forwarding,
  and one-`ControlMaster` behavior under creation races
- establish a hermetic integration harness that invokes the host system
  `ssh`/`sftp` clients against a real OpenSSH `sshd`, records physical
  connections and authentication attempts, and can interrupt the transport
  without terminating the remote target or keeper; this harness must be a
  required Linux CI job before phase 3 is complete
- prove Rust PTY ownership, process-group detachment, mutation journal,
  group-sync policy, unwind-contained parser rebuilding, `xterm-vt/1`
  checkpoint generation, and xterm.js conformance
- prove host-local authority/node identity on ordinary and shared-home targets
- commit the normative benchmark manifest and measured baseline before phase 3
- if a spike requires a core decision to change, stop and write a follow-up ADR

### 2. Domain, Command, Provider, and Common Data Plane Migration

- introduce branded `LocalPath`/`RemotePath`, `WorkspaceTarget`, and
  `LocatedPath` across cwd, Git/worktree, files, diagnostics, attachments,
  sessions, and usage/history
- separate authority identity, mutable locator, and runtime observation
- introduce `TargetServiceRegistry` and the small target-bound capability
  interfaces before migrating individual features
- introduce the three independent session-status axes
- add the fsync-backed durable operation primitive,
  `RemoteOperationCoordinator`, external command allowlist, and Main-only
  reducer facts before any SSH mutation path is enabled
- reuse existing `workspaceId`/`sessionId` and common
  chunked-checkpoint `TerminalDataPlane`; remove parallel remote IDs/protocol
  concepts and fix `Uint64` to branded `bigint`

### 3. Linux x64 Vertical Slice

- build `linux-x64-musl` `kmuxd` and `remote-host` integration
- implement create, attach, input, resize, detach, reconnect, and terminate
- route split/create/restart/adopt/terminate exclusively through the durable
  coordinator and implement launch-input as a separate operation
- prove keeper survival across bridge, SSH, `remote-host`, and desktop loss

### 4. Four-Artifact Parity

- build and bundle `darwin-arm64`, `darwin-x64`,
  `linux-arm64-musl`, and `linux-x64-musl`
- validate macOS/Linux and x64/arm64 PTY, reconnect, bridge update, and keeper
  isolation parity on actual targets
- validate compatible direct bridge proxy and incompatible pinned cohort proxy

### 5. Durable Lifecycle and Conversion

- extend the durable operation store with the conversion
  `commit-decided` WAL and resource descriptors
- implement transactional conversion and crash recovery
- add provisional reclaim/TTL and retained-session inventory

### 6. Hook, CLI, Capture, and Future Agent Team Compatibility

- implement user-only hook/notification spool and duplicate-free replay
- implement `kmuxd cli` alias routing and PTY-boundary input acknowledgements
- implement bounded remote `surface.capture` and keep these target-scoped
  primitives compatible with a future Agent Team consumer; do not implement
  Team UI, state, orchestration, lifecycle, aliases, or team-specific routing

### 7. Target-Local Product Providers

- migrate Git/worktree and target-local usage/history to registry-selected
  capabilities with no feature-local SSH branch
- route managed worktree create/remove and dirty-protected cleanup through the
  durable coordinator
- add SFTP file/download/staging/attachment providers
- add desired-state loopback forwards and browser URL remapping

### 8. Hardening and Release Gates

- finalize quota/backpressure and storage-degraded UX
- validate remote-host scheduling/worker isolation under simultaneous terminal,
  SFTP, Git, and checkpoint traffic
- validate update compatibility and executable-generation pinning
- validate persistence capability reporting
- complete security, queue-bound, latency, and performance gates

## Test Strategy

Tests protect durable behavior and security boundaries, not incidental dialog
markup or pixel details.

### Verification Layers and Harness Boundary

Unit, property, schema-conformance, and reducer tests remain the fastest owners
of protocol, journal, lease, WAL, provider, and lifecycle state-machine
contracts. A mocked transport is useful at those layers, but it does not count
as verification of an SSH transport contract.

Automated SSH integration must invoke the same system OpenSSH `ssh` and `sftp`
executables used by the product against a real OpenSSH `sshd`. The target may be
ephemeral and container-orchestrated, but it must exercise real key exchange,
host-key verification, authentication, PTY allocation, multiplexed channels,
SFTP, process detachment, and the built `kmuxd` artifact. Test identities,
host keys, `ssh_config`, `known_hosts`, control sockets, home, state, and runtime
paths are isolated per suite. Trust tests must not bypass verification with
`StrictHostKeyChecking=no` or an equivalent option.

Transport-loss tests keep the target and keeper processes alive while severing
or degrading the TCP route, killing the local master, or crashing the local
transport owner. Stopping the target container or VM is a target-loss/reboot
test, not evidence that a keeper survives an SSH disconnect. The harness must
also count accepted TCP connections and authentication attempts so a missing or
racing control socket cannot hide OpenSSH's normal direct-connection fallback.

The Linux x64 real-OpenSSH integration suite is a required, separately named CI
job once phase 3 is enabled. It must fail clearly when its container/runtime
prerequisite is missing rather than silently skipping. The default fast unit
suite may remain container-independent. The concrete container orchestration
and fault-proxy libraries are implementation choices recorded in the execution
plan rather than architectural dependencies of this ADR.

Container tests are not platform-parity or performance substitutes. They may
exercise Linux x64/arm64 artifacts functionally, including under CPU
emulation, but emulation, Docker Desktop virtualization, and shared CI hosts do
not satisfy native architecture, macOS, launchd/libproc, signing, persistence,
or normative latency/resource gates. The four supported artifacts must still
run on actual matching targets for the integration, isolation, and performance
acceptance criteria below.

### Local Surface Versioned Baseline Regression Gate

SSH work must preserve the already-optimized local surface path independently
of whether one historical per-run latency assertion happens to pass on a busy
developer machine. The immutable pre-SSH source is measured for the repeat
count fixed in `local-terminal-regression-gates.v1.json`; its raw samples,
environment, exact failures, and every emitted latency percentile, including
p95 and p99, form the versioned baseline. A separately built five-run
repeatability batch from that exact same pre-SSH revision is also retained, and
its declared medians are checked against the raw `phase3Exit` entry samples. No
post-SSH candidate value participates in the baseline. These immutable batches
are captured once and are not silently replaced by a later phase-entry tree.

The protected live-output path remains `pty-host` ring/coalescing/credit → a
direct renderer `MessagePort` → the singleton `TerminalStreamRouter` → the
existing scheduler/xterm path. SSH support may adapt remote attachments to the
common data-plane contract, but it must not insert Main relay, remote selection,
extra buffering, serialization, or instrumentation into that local path.

For every implementation phase, run `npm run gate:terminal-data-plane` on the
same host, OS, architecture, Electron/Node versions, build mode, terminal
geometry, workload, profiler settings, and documented background-load policy.
The runner smoke-checks and builds the immutable candidate exactly once before
the repeat set, then executes only the unchanged measurement workload for the
manifest's fixed repeat count. Builds, typechecks, smoke checks, and other
preparation never run between measured samples; their load is not part of the
baseline workload. For each metric, take the greater median of the immutable
pre-SSH capture and repeatability batches as `baselineCenter`, then derive the
fixed limit as
`baselineCenter + max(abs(baselineCenter) * relative allowance, absolute noise allowance)`.
The candidate passes numerically only when the median of its repeated samples
is less than or equal to that limit. A latency outlier that emitted valid
metrics remains in the sample set; runs may be replaced only when an
infrastructure failure prevented complete metric evidence.

Functional and resource contracts are not averaged. Every candidate run must
preserve non-blank/non-stalled output, mutation order and uniqueness, input
echo, ring-gap continuity, fixed queue/cache limits, and zero bound violations.
The workload's old single-run absolute latency assertions remain available as
an explicit diagnostic command, but they are not a phase acceptance gate
because the immutable pre-SSH source itself produced isolated failures under
external load. Changing either baseline source revision, its raw repeatability
evidence, the workload, repeat count, aggregation, relative allowance, or
absolute allowance requires immutable pre-change evidence and an ADR review.

The fixed candidate gate is the sole local-surface performance acceptance
result after calibration. An adjacent immutable pre-SSH/final-candidate run may
be retained as a diagnostic for environment drift, but pair ordering, an entry
outlier, or a candidate outlier must not change acceptance, replace a sample,
or recalibrate the fixed envelope. No implementation phase rebuilds and
remeasures its entry source for acceptance. This local procedure neither
replaces nor loosens the absolute remote limits below. The remote normative
workload must still pass every fixed maximum on every supported artifact.

### Normative Performance and Resource Gates

Before the Linux vertical slice begins, the transport spike writes the exact
hardware, OpenSSH versions, network shaping, fixture repository, and generators
to `tests/e2e/fixtures/remote-performance-gates.v1.json`. The reference target
has at least 4 physical CPU cores, 8 GiB RAM, SSD-backed state, and a controlled
20 ms RTT with less than 1 ms injected jitter. Every supported artifact must
meet these v1 maxima:

| Metric under the 16-keeper / 4-attached workload                          | Gate                                                                                                                                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Added key-echo latency versus a direct muxed OpenSSH PTY on the same link | p95 <= 8 ms; p99 <= 20 ms                                                                                                                  |
| `remote-host` event-loop delay                                            | p99 <= 10 ms; no single stall > 100 ms attributable to kmux                                                                                |
| Terminal mutation continuity                                              | zero missing, duplicate, or reordered mutations                                                                                            |
| Steady-state keeper RSS                                                   | p95 <= 32 MiB per keeper                                                                                                                   |
| `remote-host` RSS including channel subprocess overhead                   | <= 192 MiB for the workload                                                                                                                |
| Journal group-sync completion                                             | p99 <= 250 ms; a 2 s completion enters storage-degraded backpressure                                                                       |
| SSH feature transports after master establishment                         | one target-authenticated master route; physical TCP legs equal the resolved-route baseline; zero feature-triggered authentication attempts |
| SFTP throughput during terminal load                                      | >= 80% of direct SFTP baseline on the same master/link                                                                                     |

The workload keeps four attached sessions producing 256 KiB/s each, twelve
detached sessions producing 64 KiB/s each, sends interactive echo probes at
10 Hz, transfers a 512 MiB SFTP fixture, and repeatedly runs the versioned Git
status/diff fixture. It runs long enough to cross journal group commits and at
least one checkpoint. The harness records p50 as diagnostic data in addition to
the gated p95/p99 values. The steady terminal generator emits its deterministic
binary stream in 4 KiB application chunks. After the steady measurement, one
attached keeper emits a 4 MiB ASCII burst in 64 KiB application chunks paced at
20 ms while twenty interactive echo probes run. The burst must complete through
the existing attachment without a mutation gap, duplicate, reorder, or hidden
reattach; burst timings are retained as diagnostic data.

The manifest may tighten a limit or add platform-specific stricter gates.
Loosening a limit, reducing the workload, or changing the topology or generator
shape requires an explicit ADR amendment with benchmark evidence. A slow or
unsuitable state filesystem may fail capability probing instead of weakening
the terminal continuity contract.

### Required Automated Contracts

- `checkpoint -> resize -> output` replay produces the same screen and geometry
  as the live keeper
- replay/live transition has no missing, duplicate, or reordered mutation
- instrumentation proves Main relays zero renderer-attachment terminal bytes;
  separately, bounded CLI/future-Agent-Team injection crosses only authorized control
  IPC and returns the keeper's PTY-boundary ack, and request-scoped capture
  returns no more than its line/1 MiB limits
- bridge crash, `remote-host` crash, SSH disconnect, and desktop restart leave
  keeper and agent processes alive
- a keeper failure or parser failure cannot terminate another session; a parser
  error/caught unwind does not terminate its own PTY owner
- a new writer lease fences stale input/resize, and ambiguous input retry is
  applied at most once with a PTY-boundary ack; injected partial PTY writes
  never duplicate an already written prefix
- `initialInput` is a separate durable launch-input operation; create retry
  cannot duplicate it and an unrecoverable ambiguous outcome is never replayed
  into a new generation
- forced desktop termination at every WAL transition cannot terminate local
  sessions early, duplicate a keeper, or leave an untraceable orphan
- forced termination around intent admission, remote result persistence, and
  product-fact projection for split/create/restart/adopt/terminate/worktree
  operations recovers the same operation; a renderer cannot dispatch Main-only
  result facts
- an offline termination remains `termination-pending` and retained until an
  authoritative tombstone is durable
- retrying create after operation-ledger GC returns the descriptor identified by
  create operation ID and deterministic resource key
- retrying a stale restart/forward revision after ledger GC fails without a new
  mutation, while the last revision returns its retained result
- `observationState: "unknown"` cannot infer exit, spawn a replacement, or
  remove a binding
- type/runtime boundary tests prove a local capability cannot accept
  `RemotePath`, a bound SSH capability rejects another target, and remote values
  cannot reach `existsSync`, `shell.openPath`, or other local filesystem APIs;
  feature packages cannot import internal `PathAccess`
- host alias/config changes, host-key change/rotation, principal mismatch, and
  installation-ID/execution-node mismatch fail closed
- two nodes sharing the same home/workspace storage cannot resolve to one target;
  copied authority state and UID/account-name mismatch fail closed
- restore-disabled, explicit restart, and retained-workspace close each preserve
  their distinct lifecycle contract
- CLI input acknowledgement, remote capture, and dedicated-worktree/dirty
  protection expose the target-scoped contracts required by a future Agent Team
  without implementing that product surface
- detached/bridge-down hook and OSC notifications spool and replay exactly once
- first bootstrap without SFTP fails before mutation; an installed helper's
  terminal core survives a temporary SFTP failure
- incompatible checkpoints fall back to retained mutation replay, and journal
  truncation exposes retained-range state
- quota/full-disk handling never acknowledges unrecorded output and eventually
  backpressures PTY reads
- a caught parser unwind rebuilds headless state without stopping its PTY;
  replay does not duplicate query replies/bells/notifications, and aborting one
  keeper process affects no other session
- old executable generations are not collected while referenced by live
  keepers, and an incompatible local-protocol keeper reconnects through exactly
  one pinned cohort proxy
- every channel type fails closed when the master dies before/during creation;
  instrumentation observes no direct fallback TCP connection or authentication
- concurrent provisional connections that verify as the same authority/policy
  converge to one assigned target master before any workspace mutation

### Integration and Manual Validation

- run PTY, reconnect, bridge restart/update, and keeper-isolation E2E on actual
  `darwin-arm64`, `darwin-x64`, `linux-arm64-musl`, and
  `linux-x64-musl` targets
- validate OpenSSH aliases using `Include`, `Match`, ProxyJump, ProxyCommand,
  agent, certificate, passphrase-protected key, custom port, authentication
  cancellation, first-use trust, and changed-host-key recovery
- validate known bootstrap shells, unknown account shells with and without an
  explicit bootstrap override, and actual account-shell preservation
- validate read-only/noexec install paths, shared-home install/authority/state
  rejection, unsuitable NFS runtime sockets, verified host-local overrides,
  concurrent install, read-back hash verification, and generation GC
- validate app quit/reopen, sleep/wake, bridge/`remote-host` crash, hook replay,
  attachments, Git/worktrees, port remapping, and retained inventory

The transport release gate runs the normative workload above on every artifact.
Failure blocks v1; it does not enable a hidden second master, loosen a queue, or
reduce load without an explicit recorded decision. A different topology
requires a follow-up transport ADR.

### Validation of This ADR Change

This accepted-status edit is documentation-only. It does not add automated
tests merely because prose changed. Validate the change with:

- `git diff --check`
- internal heading, type-name, and reference searches
- an explicit contradiction review against ADR 0002, ADR 0003, and ADR 0004

## Rejected Alternatives

### App-Global SSH Mode

Rejected because local and multiple remote targets must coexist in one app.

### Surface-Level SSH Settings

Rejected because workspace location is the correct default inheritance and
per-surface connection configuration makes splits and restore ambiguous.

### Raw SSH Inside a Local PTY

Rejected because kmux cannot own remote process lifetime, output replay, Git,
files, ports, hooks, history, or target identity through an opaque foreground
`ssh` process.

### Mutable Profile ID as Target Identity

Rejected because an SSH alias or profile can later resolve to another authority.
Existing remote workspaces must fail closed instead of silently switching hosts.

### Separate Remote Workspace and Session IDs

Rejected because parallel IDs create ambiguous mapping and restore paths. The
existing UUID `workspaceId` and `sessionId` are sufficient when scoped by
desktop installation and target through `RemoteResourceKey`.

### Implicit Replacement on Missing Inventory

Rejected because observation can be incomplete and a replacement shell can
silently detach the user from a live coding agent. Only a persisted pending
create or explicit restart operation may spawn a keeper.

### Renderer-Dispatched Remote Reducer Effects

Rejected because an in-memory `session.spawn`/terminate effect can race product
persistence and cannot recover an ambiguous remote result. Renderer-visible
commands stop at Main's `RemoteOperationCoordinator`; only Main projects
durable operation facts into product state.

### Feature-Local SSH Branches or One Giant Remote Service

Both are rejected. Feature-local branches leak paths and create inconsistent
fallback behavior, while a giant service couples unrelated degradation and is
difficult to test. One registry composes small target-bound terminal, Git,
files, metadata, history, ports, and attachment capabilities.

### Shared-Home Installation Identity as Execution Authority

Rejected because a shared installation ID and account can name several nodes
whose PTYs, ports, runtime sockets, and processes are distinct. v1 uses a
verified host-local execution-node identity and rejects shared execution state.

### One Relay Process Owns Every PTY

Rejected because bridge updates or crashes would terminate all sessions on the
target. Per-session keepers provide the required failure isolation.

### One Ordered RPC Stream for All Traffic

Rejected because file, Git, or search traffic can head-of-line block terminal
input/output. SSH already provides purpose-specific channels and SFTP.

### Second Bulk ControlMaster Fallback in v1

Rejected because an unadvertised fallback makes the tested topology different
from the product architecture. The one-master load gate either passes or blocks
release and produces a follow-up ADR.

### Main-Relayed Remote Terminal Bytes

Rejected because Main is the product-state control plane and must not become a
hot-path bulk broker. Direct `MessagePort` transfer preserves ADR 0002's
terminal-data-plane boundary.

Bounded, authorized CLI/future-Agent-Team injection is not a terminal-byte relay: it
is a deduplicated control operation with a PTY-boundary result, and output still
bypasses Main.

### Per-Mutation Terminal Journal fsync

Rejected because it places storage latency directly on agent output and key
echo. Append admission remains before live delivery, while a bounded group
commit defines the power-loss window and immediate fsync remains mandatory for
identity and operation decisions.

### Killing Incompatible Keepers During Update

Rejected because update must not destroy active agent conversations. A pinned
terminal-only cohort proxy pays extra process cost only while an incompatible
local-protocol generation still has live keepers.

### Separate Renderer Protocol for SSH

Rejected because local and remote terminals have the same renderer semantics.
Both adapt to `@kmux/proto` `TerminalDataPlane` and the existing
`TerminalStreamRouter`.

### Remote npm/native Dependency Installation

Rejected because it creates first-connect latency and failures based on remote
network access, registry state, Node versions, compilers, libc, and build tools.

### Terminal Multiplexer Dependency

Rejected as a product contract. Users may run multiplexers inside a remote
shell, but kmux does not depend on them for restore or session ownership.

### Desktop-Only Raw Output Tail

Rejected because a short in-memory tail cannot provide reliable long-running
agent scrollback or survive remote broker failure.

### VS Code Remote Component Reuse

Rejected because those components are not reusable product dependencies. Only
the local-UI/remote-runtime architecture pattern is adopted.

### Windows Remote, ConPTY, or Named Pipes in v1

Rejected from this ADR's support matrix. They require separate process, terminal,
IPC, packaging, persistence, and conformance decisions and therefore a later
ADR.

## Consequences

Positive:

- SSH becomes a native workspace location rather than a terminal convenience.
- local and multiple remote targets coexist safely.
- remote identity cannot silently follow a changed alias or shared home to
  another execution node.
- bridge, transport, and desktop restarts do not terminate healthy keepers.
- one keeper failure is isolated from other agent sessions.
- terminal replay has explicit sequence, checkpoint, and live-transition rules.
- local and remote terminals share one renderer data-plane contract while Main
  stays out of both bulk paths.
- deterministic resource keys avoid a second workspace/session identity system.
- file and browser traffic cannot occupy the terminal control stream by design.
- one target-service composition boundary keeps path enforcement and feature
  selection out of individual Git/file/history/port modules.
- every remote mutation has one recoverable command/result projection rather
  than renderer-triggered optimistic effects.
- custom interactive shells remain supported; unsafe unknown bootstrap syntax
  requires an explicit override.
- restore, agent resume, usage, history, hooks, Git, files, and ports share one
  target-aware model.

Costs:

- requires four bundled Rust artifacts and an equal-tier compatibility matrix
- requires per-session process and disk-lifecycle management
- requires a durable reconciler and idempotency ledger
- requires a fsync-backed low-frequency operation store distinct from ordinary
  debounced product persistence
- requires a target-aware migration across core and metadata models
- requires careful terminal parser/checkpoint compatibility work
- requires OpenSSH process/channel management across desktop platforms
- requires security review for remote runtime, hooks, files, journals, and
  forwarding
- requires realistic remote reliability and latency testing
- may temporarily run one extra terminal-only bridge per incompatible live
  keeper protocol cohort

Limits:

- Windows remote, ConPTY, and named pipes remain unsupported.
- logout/reboot persistence is conditional on verified platform capability.
- one `ControlMaster` per target is a release gate rather than a fallback-rich
  topology.
- sudden host power loss can lose only the explicitly bounded unsynced terminal
  journal tail; it cannot roll back acknowledged identity/operation decisions.

These costs are intentional. A simpler implementation can open a remote shell,
but it cannot satisfy kmux's core requirement that multiple coding-agent
sessions remain stable, correctly identified, and recoverable across surface
changes, application restarts, and network failure.
