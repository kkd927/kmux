# 0005: SSH Remote Workspaces and the kmux Remote Runtime

## Status

Proposed

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

Implement SSH as a first-class workspace location backed by a self-contained
remote kmux runtime.

The runtime is split by responsibility and failure domain:

```text
Desktop
  SshProfileRegistry             mutable connection locators
  RemoteTargetRegistry          immutable verified authority bindings
  SshTransportPool              system OpenSSH connection/channel owner
  RemoteReconciler              desired / observed / outbox convergence
       |
       | authenticated SSH channels
       v
Remote runtime
  restartable bridge/broker
       |
       +-- session keeper A
       |     PTY + headless terminal + sequence journal
       |
       +-- session keeper B
       |     PTY + headless terminal + sequence journal
       |
       +-- metadata/index workers
       +-- agent-hook receiver
       +-- remote kmux CLI endpoint

Bulk and network transports
  files          -> SFTP
  port/browser   -> SSH direct-tcpip or SOCKS
  large metadata -> separate bounded stream channel
```

The desktop owns product state and layout. Each remote session keeper owns one
remote PTY, its terminal materialization, and its retained output history. The
bridge is a restartable routing and discovery process; it does not own PTY
lifetime.

This separation allows the bridge, SSH connection, or desktop to restart
without terminating unrelated remote sessions.

## Architectural Invariants

The implementation must preserve these invariants:

1. A workspace has exactly one location: local or one verified remote target.
2. `SshProfile.id` is a mutable locator identity, not remote-machine identity.
3. Existing remote workspaces bind to an immutable verified remote target.
4. A transport disconnect never means the remote process exited.
5. Failure to observe a remote session is `unknown`, not proof that it is dead.
6. Attaching an existing session must never silently create a replacement
   session, especially not a local one.
7. Remote mutations are idempotent and retryable through stable operation IDs.
8. Terminal output has monotonic sequence identity within a keeper generation.
9. Replay and live output have an explicit barrier; they cannot overlap or
   leave an unobserved gap.
10. Interactive terminal traffic is not queued behind bulk file, Git, search,
    or browser traffic in one ordered application stream.
11. Remote paths are never passed to local filesystem APIs as local paths.
12. Closing or restarting the desktop detaches remote sessions by default; it
    does not terminate them.
13. The remote runtime runs as the authenticated SSH user and does not require
    root or public listening ports.
14. Remote bootstrap does not depend on a user-installed language runtime,
    package manager, native build toolchain, or terminal multiplexer.

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

### Transactional Conversion

Conversion is a prepare/commit operation:

```text
prepare
  resolve SSH profile
  verify host key
  authenticate
  verify immutable remote authority
  install or connect remote runtime
  create/attach remote workspace
  create one initial remote session

commit
  persist remote workspace location
  reset the workspace's session/pane graph to one remote surface
  terminate all replaced local sessions
```

The workspace ID, user title, and non-session product metadata are preserved.
The first implementation does not archive exited local transcripts inside the
converted workspace; the user chose an explicit session cleansing operation.

No local session is terminated during `prepare`. If host verification,
authentication, bootstrap, protocol negotiation, or initial remote session
creation fails, the current workspace and all local sessions remain unchanged.

If the remote session was prepared but the local commit fails, the operation is
recorded for idempotent rollback/cleanup. It must not become an untracked remote
keeper.

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
- show host-key fingerprint and verification state
- show last connection/bootstrap error
- show verified remote target identity
- show remote runtime version, capabilities, and persistence level
- show and terminate retained remote sessions
- reset or clean kmux-owned remote runtime state

Profile fields:

```text
Name
OpenSSH config alias, or explicit host
User
Port
Identity file
Default remote cwd
Default shell override, optional
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
  env?: Record<string, string>;
  forwardAgent?: boolean;

  createdAt: string;
  updatedAt: string;
}
```

`sshConfigHost` is preferred. system OpenSSH resolves `HostName`, `User`,
`Port`, `Include`, `Match`, `ProxyJump`, `ProxyCommand`, identity, certificate,
agent, and security-key configuration.

Changing a profile is permitted. It does not change the identity of remote
workspaces already bound through that profile.

### Remote Target: Immutable Authority Binding

After SSH authentication and remote runtime handshake, kmux records what
authority was actually reached:

```ts
interface RemoteTargetBinding {
  id: Id; // stable local identity used by sessions, workspaces, and metadata
  profileId: Id; // current locator used to reach it

  remoteInstallationId: Id; // random durable id stored by remote kmuxd
  sshHostKeyFingerprint: string;
  remoteUser: string;
  remotePlatform: string;
  remoteArch: string;

  firstVerifiedAt: string;
  lastVerifiedAt: string;
}
```

The remote runtime creates `remoteInstallationId` once in its user-owned state
directory. Reconnect through a profile is accepted for an existing target only
when the verified host identity, authenticated remote user, and remote
installation identity satisfy the recorded binding policy.

Host-key rotation, remote-state deletion, account changes, or an SSH alias that
now resolves to a different server produce a target mismatch. kmux presents an
explicit rebind/migration flow and never silently treats the new authority as
the old target.

`RemoteTargetBinding.id`, not `SshProfile.id`, is used as `targetId` in durable
product records.

### Workspace Location

```ts
type WorkspaceLocation =
  | {
      kind: "local";
      cwd: string;
    }
  | {
      kind: "ssh";
      profileId: Id; // locator
      targetId: Id; // verified RemoteTargetBinding.id
      remoteWorkspaceId: Id;
      remoteCwd: string;
    };
```

Rules:

- surfaces and sessions inherit the workspace location
- local and SSH workspaces may be visible side by side
- multiple workspaces may share one remote target and SSH transport pool
- two hosts containing `/home/user/app` do not collide
- a profile locator can be replaced only after verifying the same target

### Runtime Target and Launch Location

```ts
type RuntimeTarget =
  | {
      kind: "local";
      targetId: "local";
    }
  | {
      kind: "ssh";
      targetId: Id;
      profileId: Id;
      remoteWorkspaceId: Id;
    };

type SessionLaunchLocation =
  | {
      kind: "local";
      cwd: string;
    }
  | {
      kind: "ssh";
      targetId: Id;
      remoteWorkspaceId: Id;
      cwd: string;
    };

interface SessionLaunchConfig {
  location: SessionLaunchLocation;
  shell?: string;
  args?: string[];
  initialInput?: string;
  env?: Record<string, string>;
  title?: string;
}
```

The local PTY host accepts only `kind: "local"`. Remote launches go through
`RemoteTerminalRuntime` and the verified target binding.

Every process, session, agent, usage, notification, file, Git, port, and
worktree record includes `targetId` where identity or matching is involved.

### Agent Session References

```ts
interface AgentSessionRef {
  vendor: "codex" | "claude" | "gemini" | "opencode" | string;
  id: string;
  targetId: Id;
  cwd: string;
}
```

Agent restore never matches only `vendor + id` or only `cwd`.

## Desktop Architecture

### SshProfileRegistry

Owns profile CRUD, OpenSSH alias import, locator validation, and references from
target bindings. It does not establish remote identity.

### RemoteTargetRegistry

Owns immutable verified authority bindings and explicit rebind operations. It
detects profile-to-target mismatches before any existing workspace is attached.

### SshTransportPool

Owns system OpenSSH processes and channels. The pool is keyed by verified
target and effective connection policy, not merely by display name.

Use one OpenSSH master connection where supported and open independent SSH
channels or subprocesses over it. OpenSSH connection reuse is an implementation
optimization; the product contract does not depend on a particular
`ControlMaster` configuration.

### RemoteReconciler

The reconciler is the only desktop component that converges persisted remote
intent with observed remote state.

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
  targetId: Id;
  kind: string;
  payload: unknown;
  createdAt: string;
  attempt: number;
}
```

Remote mutations use `operationId` idempotency keys. The bridge persists a
bounded result cache or operation ledger so retrying after an ambiguous
disconnect returns the original result instead of creating duplicate sessions,
watchers, or forwards.

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

### TerminalRuntime Boundary

Renderer-facing terminal code remains transport-neutral:

```ts
interface TerminalRuntime {
  createSession(request: CreateSessionRequest): Promise<CreateSessionResult>;
  attachSession(request: AttachSessionRequest): AsyncIterable<TerminalEvent>;
  writeInput(request: TerminalInputRequest): Promise<TerminalInputAck>;
  resizeSession(request: ResizeSessionRequest): Promise<void>;
  terminateSession(request: TerminateSessionRequest): Promise<void>;
}
```

Implementations:

- `LocalTerminalRuntime` talks to the local PTY host
- `RemoteTerminalRuntime` talks to the reconciler and remote runtime

The renderer may show remote labels, connection state, and actions, but it does
not own remote lifecycle or branch on SSH protocol details.

## SSH Transport Topology

Do not create one TCP SSH connection per pane, and do not place every operation
inside one ordered application stream.

Use one reusable OpenSSH transport per target where supported, with purpose-
specific channels:

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

Where an application-level multiplexed stream is unavoidable, its protocol
must provide:

- explicit interactive and bulk priorities
- credit-based per-stream flow control
- bounded send and receive queues
- maximum frame and message sizes
- chunked large responses
- cancellation
- disconnect cleanup for blocked producers
- sequence and acknowledgement semantics
- measurable interactive-latency budgets

Input, resize, terminate, and session-control messages are never sent through a
bulk lane.

## Remote Runtime Architecture

### Bootstrap Bridge

The SSH bootstrap command starts or connects to the kmux bridge. The bridge:

- performs version, capability, target, and token handshake
- discovers live session keepers
- routes control and metadata requests
- starts new keepers idempotently
- exposes the remote CLI endpoint
- coordinates agent-hook delivery
- starts restartable metadata/index workers
- reports persistence capabilities and health

The bridge does not own session PTYs. A bridge crash or upgrade must not kill
keepers.

### Session Keeper

Each keeper owns one remote terminal session:

- PTY master and child process lifetime
- stable `remoteSessionId`
- opaque `keeperGeneration`
- input and resize application
- deduplication and acknowledgement of client input sequence
- authoritative applied PTY rows/columns
- raw ordered output journal
- headless terminal materialization
- bounded checkpoint and replay state
- cwd/title/foreground-process metadata
- process-exit status
- local user-only control socket

Keeper identity is not a process-local integer. It is generated as a durable
random ID and stored in the session descriptor before the success response is
returned.

Keepers survive bridge and SSH-channel loss. On bridge restart, it discovers
keeper descriptors and proves liveness through their local sockets before
reporting observed state.

The implementation must avoid parent-death signals, inherited SSH stdio, or
process-group behavior that ties keeper lifetime to the bootstrap channel.

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

### Remote Workspace State

The desktop remains authoritative for window, pane, surface, and title layout.
The remote runtime persists only the remote execution descriptors needed to
recover and reconcile:

```text
remoteWorkspaceId
target installation id
remote cwd
remote session ids
keeper generations and endpoints
launch metadata
process exit state
retained journal/checkpoint metadata
```

Remote layout sync across multiple desktops is a separate feature and is not
implicitly introduced by SSH support.

## Remote Runtime Deployment

### Self-Contained Artifacts

Package signed or integrity-verified, self-contained runtime artifacts for the
supported remote platform matrix. The bootstrap selects the appropriate
artifact after remote OS, architecture, and relevant ABI detection.

The remote user is not required to install:

- Node.js or npm
- Python
- a C/C++ compiler or `node-gyp`
- `tmux`, `screen`, or `zellij`
- a system-wide service

Unsupported platform/architecture/ABI combinations fail before mutating the
workspace and show an actionable compatibility error.

### Content-Addressed Installation

Install side by side under a user-owned directory:

```text
~/.kmux/
  bin/
    <protocol-version>+<content-hash>/
      kmux-bridge
      kmux-session-keeper
      manifest.json
      install-complete
  run/
    target.sock
    keepers/
  state/
    authority.json
    workspaces/
    sessions/
    operations/
    journals/
    checkpoints/
```

Installation rules:

- never overwrite an executable generation in place
- verify content hash before marking the generation complete
- use an atomic per-generation install lock
- recover stale locks and partial installs
- write the completion sentinel last
- pin each live keeper to its executable generation
- garbage-collect only complete generations with no live process references
- make GC best effort and never block a connection

New bridges negotiate with older keepers through a versioned local protocol.
If they are incompatible, the old keeper generation remains available until
its sessions terminate; active sessions are not killed merely to update code.

### Persistence Levels

`nohup &` alone is not treated as a universal guarantee. Remote login managers,
`systemd-logind`, account policies, host reboot, or administrator cleanup can
terminate user processes.

The bridge reports an observed persistence level such as:

```ts
type RemotePersistenceLevel =
  | "ssh-disconnect"
  | "user-logout"
  | "host-reboot";
```

The baseline contract is survival across SSH disconnect and desktop restart.
Survival across logout or reboot is advertised only when kmux has verified an
appropriate user service or equivalent platform mechanism. Reboot does not
imply process-memory checkpointing; a service may restart the bridge and expose
retained history while previous PTY processes are correctly reported exited.

## Remote Shell and Environment Semantics

Remote terminal support is not limited to bash, zsh, or fish. Startup-file
fingerprints are cache invalidation hints, not the support boundary.

Resolution order:

1. workspace/session shell override
2. SSH profile shell override
3. authenticated account's configured login shell
4. platform fallback only when the account shell cannot be determined

kmux launches the actual selected shell inside the remote PTY and lets that
shell load its own startup environment. It does not attempt to reproduce a
custom shell's environment by parsing only known bash/zsh/fish startup files.

Shell launch uses an adapter/capability layer:

```ts
interface RemoteShellAdapter {
  shellPath: string;
  kind: "posix" | "fish" | "nushell" | "powershell" | "cmd" | "custom";
  buildInteractiveLoginLaunch(): ShellLaunch;
  buildEnvironmentProbe?(): ShellLaunch;
  readinessStrategy: "marker" | "prompt" | "delay" | "none";
}
```

Known shells may use optimized adapters. An unknown executable remains usable
through a conservative custom-shell adapter or an explicit user-supplied launch
configuration. Unsupported probe semantics may disable environment-dependent
metadata features, but must not prevent the shell itself from opening when it
can be executed safely.

Agent startup commands should normally be delivered through the initialized
interactive shell after readiness, so they receive the user's actual shell
environment. Starting an agent directly from the bridge's minimal SSH exec
environment is not equivalent.

Environment fingerprints may include selected startup files for known shells
to invalidate cached probes, but:

- they must never be required for correctness
- unknown/custom shells must not be rejected because no fingerprint adapter
  exists
- profile or user overrides must be able to disable probing
- probes have strict timeouts and cannot block remote workspace creation

## Terminal Continuity Protocol

### Output Identity

Every keeper emits output with target, session, generation, and sequence:

```ts
interface RemoteTerminalOutput {
  targetId: Id;
  remoteWorkspaceId: Id;
  remoteSessionId: Id;
  keeperGeneration: Id;
  sequence: number;
  data: Uint8Array;
  emittedAt: string;
}
```

`sequence` increases monotonically for the keeper generation and identifies the
exact raw byte range recorded in the journal. A new generation cannot reuse the
old generation's sequence namespace.

### Journal and Materialization

Each keeper maintains:

1. a bounded raw output journal
2. a compatible headless terminal state
3. atomic materialization checkpoints
4. retained-range metadata

```ts
interface TerminalCheckpoint {
  keeperGeneration: Id;
  parserVersion: string;
  lastOutputSequence: number;
  cols: number;
  rows: number;
  createdAt: string;
  payload: Uint8Array;
}
```

The remote headless terminal implementation must use a materialization format
that the desktop renderer can validate and apply. If exact shared parser
compatibility cannot be negotiated, attach falls back to raw retained replay
instead of applying a potentially incompatible checkpoint.

Desktop-generated checkpoints may be uploaded as an additional optimization,
but the keeper's output journal remains authoritative. A renderer checkpoint
cannot acknowledge output the keeper has not recorded.

### Attach and Replay Barrier

```ts
interface AttachRemoteSessionRequest {
  targetId: Id;
  remoteSessionId: Id;
  expectedKeeperGeneration?: Id;
  lastReceivedSequence?: number;
  expectedWorkspaceId?: Id;
  expectedSurfaceId?: Id;
}

interface AttachRemoteSessionResult {
  keeperGeneration: Id;
  checkpoint?: TerminalCheckpoint;
  earliestAvailableSequence: number;
  replayFromSequence: number;
  liveStartsAfterSequence: number;
  truncatedBeforeSequence?: number;
}
```

Attach order:

1. verify target, workspace, session, and optional surface identity
2. prove keeper liveness
3. freeze a `liveStartsAfterSequence` boundary
4. return a compatible checkpoint when available
5. replay journal bytes through that boundary
6. begin live delivery strictly after the boundary

The renderer deduplicates by generation and sequence. It never infers that an
empty replay means the process is alive.

If the journal was compacted, the UI applies the best checkpoint or retained
tail and exposes a normal `earlier output unavailable` state. It does not merge
stale renderer content with an unrelated new shell.

### Input, Resize, and Geometry Ordering

Input is non-idempotent. Every input frame carries a desktop attachment ID and
monotonic client input sequence. The keeper records the highest applied sequence
for that attachment and returns it in acknowledgements and reconnect state.
Retrying an ambiguously acknowledged input frame is therefore deduplicated
instead of typing the same character or command twice.

The contract is at-most-once within a live keeper generation. The keeper marks
an input sequence accepted before writing it to the PTY and acknowledges after
the write. A keeper crash may leave the final input outcome unknown, but kmux
never replays that input into a new keeper generation or replacement shell.

```ts
interface RemoteTerminalInput {
  remoteSessionId: Id;
  keeperGeneration: Id;
  attachmentId: Id;
  inputSequence: number;
  data: Uint8Array;
}

interface RemoteTerminalInputAck {
  attachmentId: Id;
  highestAppliedInputSequence: number;
}
```

PTY geometry is keeper authority, not renderer guesswork. A resize is ordered
with output processing and includes a monotonic resize revision. The keeper
applies PTY resize, updates the headless terminal dimensions in the same ordered
transition, and reports the applied revision and dimensions.

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

### Backpressure and Fairness

Each attached terminal stream has bounded queues and acknowledgements. Active
input echo and interactive redraw receive priority, but output is never silently
dropped solely because a pane is hidden.

If a renderer cannot keep up:

- the desktop bounds each attachment with stream credit and a bounded renderer
  parse backlog; terminal bulk data does not require a Main-process relay
- the keeper retains journal authority
- the renderer can request a fresh checkpoint and sequence delta
- one noisy session cannot exhaust all target or desktop memory

Typing, focus, pane switch, resize, and render paths must not trigger broad
remote session inventory scans.

## Lifecycle and Restore

### Desktop Restart

1. Load local product state and desired remote bindings.
2. Rebuild windows, workspaces, panes, surfaces, and tabs without creating
   replacement PTYs.
3. Resolve and verify each required target.
4. Start or connect the bridge.
5. Reconcile desired remote session IDs against observed keepers.
6. Attach live sessions using the replay protocol.
7. Mark absent sessions exited only after an authoritative observation.
8. Offer vendor-native agent resume when a PTY is gone but an agent session
   reference is available.

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
- workspace close/remove: present the remote-session retention decision
- surface/session close: terminate that keeper through an idempotent operation
- `Terminate all sessions on target`: explicit destructive action
- profile disconnect: close transports but preserve keepers
- remote-runtime reset: never implied by ordinary reconnect

Retention is explicit and bounded by disk quotas. The default favors preserving
live work until explicit termination; optional idle TTLs may be configured per
target. Journal/checkpoint retention can be shorter than process retention as
long as truncation is visible and does not affect PTY lifetime.

## Feature Contracts

### Pane Splits and Surfaces

Splitting a pane creates another keeper under the same remote workspace. It
does not create another user-visible SSH profile or TCP SSH connection.

The product continues to use kmux identities:

```text
workspaceId
paneId
surfaceId
sessionId
```

The remote binding maps the kmux session to `remoteSessionId` and records the
expected workspace/surface identity for attach validation.

### Agent Hooks, Resume, and Notifications

Remote agent hooks post to a loopback or user-only remote endpoint owned by the
bridge, not to a local desktop socket path.

Remote shell environment includes scoped values:

```text
KMUX_TARGET_ID
KMUX_WORKSPACE_ID
KMUX_REMOTE_WORKSPACE_ID
KMUX_SURFACE_ID
KMUX_SESSION_ID
KMUX_REMOTE_SESSION_ID
KMUX_KEEPER_GENERATION
KMUX_AGENT_HOOK_ENDPOINT
KMUX_AUTH_TOKEN
```

The bridge stores bounded, sequence-numbered important events and the latest
state per live session. On reconnect, the desktop requests replay after its
last acknowledged event sequence. Low-value high-volume events may be dropped
with observable counters.

Restore priority:

1. reattach a live keeper
2. if the keeper is authoritatively gone, run the vendor's native resume command
   on the same target and remote cwd
3. otherwise show an explicit recoverable dead-session state

All notifications include target, workspace, surface, session, and event
identity required for deduplication.

### Remote kmux CLI

Install a small `kmux` shim in a kmux-owned remote bin directory and prepend
that directory only to kmux-managed PTY environments.

```text
remote kmux command
  -> user-only bridge socket
  -> bridge handles remote-local operation or routes to connected desktop
  -> structured result returns to remote shell
```

Commands declare whether they require a connected desktop. Target-local
commands such as session status may run while detached; UI commands such as
focus/open return an actionable offline error when no desktop is attached.

### Usage and External Session History

Remote index workers read remote vendor storage and send normalized records:

```text
targetId
remoteWorkspaceId
remote cwd
vendor
vendor session id
timestamp
title/summary when available
```

The desktop may cache results, but target identity remains part of record
identity and filtering. Matching by cwd alone is invalid.

Restoring a remote history record resolves the same immutable target, creates
or focuses an SSH workspace, and launches the vendor resume command remotely.

### Files, Links, and Attachments

Remote files use SFTP rather than the terminal control channel. Text previews,
binary downloads, uploads, and attachments all preserve byte identity and use
bounded transfers.

```ts
interface TerminalFileRef {
  targetId: Id;
  path: string;
  line?: number;
  column?: number;
}
```

Remote file references are never passed to a local OS opener as local paths.
Attachments upload to a kmux-owned remote staging directory with bounded
retention, then insert the remote path into the terminal.

Filesystem watchers and small metadata may use the bridge, but their queues are
bounded and independent from terminal streams.

### Git and Worktrees

Git commands execute on the target containing the repository.

- local workspace actions use local Git providers
- SSH workspace actions use remote Git providers/workers
- worktree IDs and paths include target scope
- remote failure never falls back to a local worktree with the same path
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
remoteWorkspaceId
remoteHost
remotePort
localBindHost
localPort
forward identity and status
```

Local listeners bind to loopback by default. Saved forwards are desired state
and are reconciled after reconnect; their underlying sockets/processes are not
assumed to survive transport loss.

## Protocol

### Handshake

Every bridge connection performs:

```text
hello
protocol version range
content/runtime version
capabilities
remote installation id
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
- responses identify bridge generation
- session responses identify keeper generation
- terminal input is deduplicated by attachment/input sequence
- resize requests carry revisions and return the authoritative applied size
- unknown fields are forward-compatible where safe
- authorization is checked per target/workspace/session scope
- ambiguous transport failure does not imply mutation failure
- the operation ledger is compacted only after its retry horizon expires

### Stream Semantics

- terminal data is binary, not base64 JSON
- large metadata/file-like results are chunked
- each stream has identity, offset/sequence, credits, and terminal status
- stream producers stop on cancellation or client detach
- disconnect releases blocked writers
- frame limits are enforced before allocation

## Security

### SSH Trust

Use system OpenSSH as the initial transport implementation to inherit the
user's mature trust and configuration boundary.

- never force `StrictHostKeyChecking=no`
- surface first-use and changed-host-key prompts/failures clearly
- record the verified host-key fingerprint in the target binding
- treat a changed fingerprint as a target mismatch until explicitly resolved
- respect OpenSSH agent, certificates, `Include`, `Match`, ProxyJump, and
  ProxyCommand behavior
- keep agent forwarding off unless explicitly enabled
- do not persist private-key passphrases in profile storage

If a future in-process SSH implementation is added, it must implement equivalent
host-key verification and OpenSSH configuration behavior before becoming the
default.

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
- file paths are canonicalized and authorized for the requested operation
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

| Failure | Required behavior |
| --- | --- |
| SSH unreachable | Keep workspace/session bindings; show reconnectable state |
| Authentication canceled | Stop retry prompts; preserve desired state |
| Host key changed | Block before attach; require explicit resolution |
| Profile resolves to another authority | Block as target mismatch |
| Bridge crashes | Keepers continue; restart bridge and rediscover |
| One keeper crashes | Only that session exits; other sessions continue |
| Metadata worker crashes | Degrade metadata feature; do not affect PTYs |
| Desktop crashes/restarts | Keepers continue; restore through reconciliation |
| Replay journal truncated | Apply checkpoint/tail and show earlier-output-unavailable |
| Checkpoint incompatible | Ignore checkpoint and use retained raw replay |
| Mutation response lost | Retry same operation ID and return original result |
| Target observation times out | State remains unknown; do not destroy bindings |
| Remote host reboots | Report sessions exited unless a live keeper is proved |
| Disk quota reached | Compact journals/checkpoints predictably; never corrupt live identity |
| Runtime version changes | Side-by-side install; do not kill old keepers |

## Storage

### Local Desktop

Persist:

- SSH profiles without secrets
- immutable remote target bindings
- workspace locations and title provenance
- pane/surface layout
- target-scoped launch configurations
- remote workspace/session IDs and expected keeper generations
- desired remote state
- idempotent outbox operations
- last authoritative observed state and timestamps
- last received output/event sequences
- cached compatible terminal checkpoints
- target-aware usage/history caches

### Remote Runtime

Persist under a user-owned directory:

- installation/authority identity
- versioned runtime generations and manifests
- keeper descriptors and sockets
- workspace/session execution descriptors
- idempotency operation ledger
- bounded output journals
- terminal checkpoints
- agent-hook event/state outbox
- metadata indexes
- attachment staging files
- bounded diagnostic logs

Writes that establish identity, session creation, checkpoint replacement, or
operation results are atomic and crash recoverable.

## Package Layout

Recommended source layout:

```text
packages/proto/src/
  remoteTarget.ts
  remoteRpc.ts
  remoteStreams.ts
  terminal.ts

packages/core/src/
  workspaceLocation.ts
  runtimeTarget.ts
  remoteDesiredState.ts
  remoteObservedState.ts
  remoteOutbox.ts

apps/desktop/src/main/remote/
  sshProfiles.ts
  remoteTargets.ts
  sshTransportPool.ts
  remoteBootstrap.ts
  remoteReconciler.ts
  remoteTerminalRuntime.ts
  remoteMetadataRuntime.ts

apps/desktop/src/pty-host/
  localTerminalRuntime.ts

remote/kmuxd/
  bridge/
  keeper/
  terminal/
  journal/
  metadata/
  agents/
  cli/
  persistence/
```

The exact implementation language is a separate engineering choice. The
required properties are self-contained deployment, compatible terminal
materialization, durable protocol semantics, and process-lifetime separation.

## Implementation Plan

### 1. Domain and Authority Model

- add `SshProfile`, `RemoteTargetBinding`, `WorkspaceLocation`, and
  `RuntimeTarget`
- separate mutable locator identity from verified target identity
- make paths, agent refs, usage, history, notifications, Git, files, and ports
  target-aware
- define explicit target mismatch and rebind flows

### 2. Transactional UX

- add Settings > SSH Connections
- add profile CRUD, OpenSSH import, test, and target verification display
- add `Convert to SSH Workspace...`
- implement one dialog with connection picker and Convert/Create choice
- implement prepare/commit conversion without `workspace.isPristine`
- preserve user titles and generate `SSH: <connection>` for auto titles

### 3. system OpenSSH Transport

- resolve effective configuration with OpenSSH
- implement host-key and authentication UX
- build reusable target transport/channel pool
- add separate control, per-session terminal, SFTP, metadata, and forwarding
  paths
- add sleep/wake liveness probing and reconnect policy

### 4. Self-Contained Remote Bootstrap

- build supported platform artifacts
- implement content-addressed install, integrity verification, lock, sentinel,
  and safe GC
- implement target installation identity
- implement bridge handshake and capability negotiation
- report observed persistence level

### 5. Reconciler and Idempotency

- persist desired, observed, and outbox state
- add remote operation ledger
- implement target/workspace/session observation
- prohibit destructive inference from failed observation
- make create/terminate/configure operations retry-safe

### 6. Session Keeper and Terminal Continuity

- spawn one keeper per remote session
- detach keeper lifetime from SSH and bridge
- add PTY ownership, generation, journal, headless state, and checkpoints
- implement binary sequence stream, acknowledgements, attach barrier, replay,
  truncation, and compatibility fallback
- verify fair multi-session output under load

### 7. Shell and Agent Integration

- implement generic remote shell resolution and adapter capabilities
- start commands through the initialized interactive shell
- support custom user-installed shells without requiring startup fingerprints
- add remote agent hook endpoint, bounded replay, and native agent resume
- add remote kmux CLI shim

### 8. Metadata and Product Features

- add remote Git/worktree provider
- add remote cwd/process/port metadata
- add remote external session and usage indexers
- add SFTP file references, download, upload, and attachments
- add direct-tcpip and SOCKS browser networking

### 9. Lifecycle and Hardening

- add retention, termination, cleanup, and runtime reset actions
- add target/profile deletion and reassignment flows
- add quota and GC behavior
- add protocol/version compatibility UX
- add bounded diagnostics and security review

## Test Strategy

Tests protect durable behavior and security boundaries, not incidental dialog
markup or pixel details.

### Required Automated Contracts

- profile mutation cannot silently change an existing target binding
- same remote path on two targets does not collide
- conversion prepare failure leaves local sessions untouched
- conversion commit happens only after remote session creation is durable
- Create New never mutates the current workspace
- unreachable/unknown observation does not clear remote ownership
- stale existing session IDs never fresh-spawn implicitly
- operation retry returns the original mutation result
- bridge restart rediscovery preserves live keepers
- one keeper exit does not terminate another keeper
- output sequences have no duplicate or missing transition at replay/live barrier
- incompatible checkpoints fall back safely
- journal truncation produces explicit retained-range state
- hidden/background session output remains recoverable
- per-session terminal traffic remains responsive during file/Git bulk traffic
- remote paths cannot enter local filesystem operations
- file transfers use bounded SFTP paths
- port forwards bind loopback and restore through desired state
- custom shell without a known fingerprint adapter can still launch
- an ambiguously acknowledged input retry is applied at most once to the same
  live keeper generation
- PTY, headless parser, and checkpoint geometry remain ordered through resize
- remote agent resume runs on the recorded target and cwd
- hook/RPC authorization rejects wrong target, workspace, session, or token
- host-key and remote-authority mismatch fail closed
- old runtime generations are not GC'd while referenced by live keepers

### Integration and Manual Validation

- OpenSSH aliases using `Include`, ProxyJump, agent, certificate, and custom port
- passphrase-protected key and authentication cancellation
- host-key first use and changed-host-key recovery
- custom remote shells, including an unknown user-installed shell
- Linux glibc/musl, macOS, and supported Windows remote combinations
- multiple workspaces and many panes on one target
- app quit/reopen with long-running agents and servers
- network disconnect, sleep/wake, and reconnect during heavy output
- bridge process crash while keepers remain live
- first connection and concurrent content-addressed install
- remote port preview and SOCKS-only private hostname access
- binary attachment upload/download
- remote hook notification while detached and replay after reconnect
- remote journal quota/truncation behavior

Performance gates should measure active typing latency and output continuity with
simultaneous remote file reads, Git status/diff, metadata scans, and noisy
background terminals. Loopback-only timing is insufficient evidence; deterministic
queue and byte-bound assertions are also required.

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

### One Relay Process Owns Every PTY

Rejected because bridge updates or crashes would terminate all sessions on the
target. Per-session keepers provide the required failure isolation.

### One Ordered RPC Stream for All Traffic

Rejected because file, Git, or search traffic can head-of-line block terminal
input/output. SSH already provides purpose-specific channels and SFTP.

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

## Consequences

Positive:

- SSH becomes a native workspace location rather than a terminal convenience.
- local and multiple remote targets coexist safely.
- remote identity cannot silently follow a changed alias to another server.
- bridge, transport, and desktop restarts do not terminate healthy keepers.
- one keeper failure is isolated from other agent sessions.
- terminal replay has explicit sequence, checkpoint, and live-transition rules.
- file and browser traffic cannot occupy the terminal control stream by design.
- custom shells remain supported without treating known startup files as the
  product boundary.
- restore, agent resume, usage, history, hooks, Git, files, and ports share one
  target-aware model.

Costs:

- requires multiple self-contained remote artifacts and a compatibility matrix
- requires per-session process and disk-lifecycle management
- requires a durable reconciler and idempotency ledger
- requires a target-aware migration across core and metadata models
- requires careful terminal parser/checkpoint compatibility work
- requires OpenSSH process/channel management across desktop platforms
- requires security review for remote runtime, hooks, files, journals, and
  forwarding
- requires realistic remote reliability and latency testing

These costs are intentional. A simpler implementation can open a remote shell,
but it cannot satisfy kmux's core requirement that multiple coding-agent
sessions remain stable, correctly identified, and recoverable across surface
changes, application restarts, and network failure.
