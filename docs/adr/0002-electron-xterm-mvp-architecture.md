# 0002: Electron + xterm.js Terminal Architecture

## Status

Accepted

This document is the canonical description of kmux's current local-terminal
architecture.

## Context

kmux is a terminal application for running multiple coding agents across
workspaces, split panes, and surface tabs. Agent output must remain ordered and
readable while other sessions emit output, the user types or scrolls, workspaces
switch, and persisted layouts restore.

Earlier planning explored a Rust daemon-first architecture, a custom renderer,
workspace-scoped processes, and larger scale targets. Those remain possible
future directions, but they add systems and lifecycle work before measurements
justify it. The current product instead uses Electron, xterm.js, and node-pty,
while keeping product state, PTY lifetime, terminal materialization, and visible
widgets in explicit ownership domains.

The architecture must satisfy these constraints:

- `electron-main` remains the single writer for product state without relaying
  terminal bulk traffic.
- PTY and terminal-model state survive renderer widget detach and replacement.
- output work, memory, and subscriber queues are bounded.
- only surfaces the user can see consume a live renderer stream.
- input must not wait behind a large historical-output parsing backlog.
- session restore and renderer reload must recover through explicit protocol
  states rather than timing assumptions.
- protocol contracts remain transport-neutral so a future external or remote
  runtime does not require changing the domain model.

## Decision

Adopt an Electron architecture with three runtime layers:

1. `electron-main`, the product control plane
2. one `pty-host` Electron utility process, the local terminal data plane
3. renderer window(s) using `xterm.js`

Use the following technology choices:

- `Electron` for the desktop shell, packaging, process lifecycle, and
  `MessagePort` capability transfer
- `xterm.js` for visible terminal behavior, input, selection, IME, clipboard,
  accessibility, and the default DOM renderer
- `node-pty` in `pty-host` for local PTY ownership
- `@xterm/headless` in `pty-host` for terminal state independent of DOM widget
  lifetime
- synchronous file-store persistence in `electron-main` for product snapshots,
  window state, and settings

Keep these rules:

- the renderer never owns a PTY or authoritative workspace/pane/surface state
- `electron-main` authorizes and transfers terminal attach capabilities but does
  not relay output, checkpoint, input, resize, or stream credit
- one logical runtime owns ordering and recovery state for each PTY session
- React renders the active pane tree and chrome; it does not subscribe to or
  batch terminal chunks
- detached xterm widgets are caches only and have a global, explicit bound
- hidden surface tabs and inactive workspaces are not live-attached
- typed terminal messages do not depend on Electron APIs

## Deferred alternatives

This decision intentionally does not pursue:

- a Rust or external daemon as the initial local runtime
- workspace-scoped processes or a process per terminal session
- a custom terminal parser or renderer
- WebGPU or default-on WebGL rendering
- keeping every workspace terminal mounted in the renderer

These product rules remain independent of the chosen UI stack:

- stable workspace, pane, surface, and logical session identity
- bounded renderer work and explicit warm-terminal ownership
- centralized command and focus routing
- session lifetime separate from React and xterm widget lifetime
- future multi-window and transport compatibility

## Why

`xterm.js` supplies mature terminal semantics and input UX without requiring kmux
to implement a terminal renderer. `node-pty` supplies a proven PTY bridge on
macOS and Linux. Electron provides the desktop and distribution layer while its
utility process isolates PTY parsing from the Main and renderer event loops.

The direct, capability-scoped data plane removes Main-process dispatch and
reducer work from the terminal hot path. A headless model preserves authoritative
terminal state without retaining unbounded DOM terminals. Explicit queues,
credits, rings, and renderer scheduling keep the common multi-agent workload
responsive without introducing workspace or session processes prematurely.

## Runtime architecture

```text
Electron Main — control plane
  workspace / pane / surface state
  reducer, persistence, lifecycle, attach authorization
                   │ control + MessagePort transfer
                   ▼
PTY Supervisor — one Electron UtilityProcess
  SessionRuntime × N
    node-pty + headless xterm
    epoch + ordered mutation queue
    checkpoint + bounded delta ring
    input FIFO + subscriber credit
                   │ attach-specific MessagePort
                   ▼
Renderer
  singleton TerminalStreamRouter
  visible xterm widgets + bounded warm LRU
  surface pacing + renderer-wide write arbiter
```

### 1. `electron-main`: control plane

Responsibilities:

- app, window, and utility-process lifecycle
- central reducer and product-state persistence
- workspace, pane, surface, focus, and settings commands
- session creation/close metadata and runtime-readiness coordination
- attach authorization and `MessagePort` transfer
- metadata scheduling, telemetry aggregation, and explicit settled diagnostic
  snapshots

`electron-main` is the single writer for:

- windows
- workspaces and their order
- pane trees and active focus targets
- surfaces and persisted logical session launch configuration
- user settings and cached sidebar metadata

Main validates that an attach targets a current visible surface. It creates a
dedicated `MessageChannelMain`, transfers one port to the matching
`SessionRuntime`, and transfers the other to the renderer frame. Preload transfers
that port into the renderer main world rather than proxying each terminal chunk.

Main does not receive or forward live checkpoints, output deltas, input, resize,
or stream credit. Metadata, spawn/exit domain actions, runtime readiness, bell,
notification, asynchronous input-observed signals, and diagnostic snapshots may
remain on the control channel.

### 2. `pty-host`: local terminal data plane

Run one PTY supervisor as an Electron `UtilityProcess`. It owns all local
`node-pty` instances and all headless xterm instances. It is not optional and is
not replaced by a generic Node child process.

Every PTY is represented by one logical `SessionRuntime`, not by another process
or worker. A runtime owns:

- its `node-pty` and `@xterm/headless` terminal
- a runtime epoch created on every spawn
- an ordered output/resize/checkpoint/exit mutation queue
- a monotonic committed sequence
- checkpoint materialization and cache
- a bounded, shared committed-delta ring
- an input-specific high-priority FIFO
- attach cursors and byte credit

Output and committed resize are applied to the headless terminal in mutation
order. A checkpoint's sequence is exactly the last mutation reflected by that
materialization, and exit identifies the sequence after which it occurs. Input is
validated and preserved in its own FIFO, then written to the PTY without waiting
behind historical output parsing. Input acknowledgement does not reorder later
PTY output ahead of earlier output.

The utility process has no layout, sidebar, window, or persistence ownership.
Shutdown follows session/port disposal and acknowledgement before forced process
termination. If the utility process crashes, existing sessions become
`runtime lost`; kmux may restart the supervisor for future sessions but must not
silently replace a coding agent with a new shell.

### 3. renderer: visible terminal client

Responsibilities:

- sidebar and application chrome
- active workspace pane layout and focus visuals
- visible `xterm.js` instances
- keyboard, IME, paste, mouse, selection, and scroll interaction
- bounded warm xterm cache for fast return to recently detached surfaces

One renderer-wide `TerminalStreamRouter`, outside React component ownership,
reconciles the visible surface set and owns all live ports, epochs, sequences,
credits, and xterm write scheduling. Individual `TerminalPane` components do not
subscribe to a global terminal-chunk IPC stream. React mounts the active
workspace pane tree only.

For the active workspace, only each pane's active surface is live-attached. An
inactive workspace and a hidden surface tab have no terminal stream, even if a
recent xterm widget remains warm. Moving or remounting a pane performs a short
router handoff so the same current surface attachment can be retained.

Detached xterm widgets are stored outside React in one least-recently-used cache
bounded by both:

- at most 4 terminals
- at most 4,000,000 buffer cells in total

Visible terminals are pinned. Removing a surface from product state disposes its
widget immediately. A stale epoch or unrecoverable sequence gap hydrates a fresh
xterm offscreen and atomically swaps it for the current widget, avoiding a blank
or partially replayed frame.

## Domain model

Keep the domain shape that supports stable focus and future multi-window use:

```text
Window
  -> Workspace
      -> PaneTree
          -> Pane
              -> Surface
                  -> Session
```

Rules:

- `workspaceId`, `paneId`, and `surfaceId` identify durable product objects
- a persisted `sessionId` identifies the logical launch/restoration target; its
  current runtime epoch identifies one concrete spawned PTY
- split, reorder, move, resize, and focus changes do not recreate current
  sessions
- closing or restarting a surface invalidates its old runtime epoch and every
  attached port
- pane, React component, xterm widget, and PTY-session lifetimes are separate

## Terminal protocol and data flow

The transport-neutral contract lives in `@kmux/proto`. Electron transfer
envelopes adapt the contract but are not domain types.

### Session reference and mutation sequence

Every stream message is scoped to:

```text
surfaceId + sessionId + epoch + attachId
```

The dedicated port is a capability for that exact reference. Messages repeat the
reference and are runtime-validated. A stale epoch, replaced attach, malformed
payload, or oversized input is rejected before reaching the PTY.

Output, resize, checkpoint barriers, and exit are serialized by the owning
runtime. Committed mutations advance a monotonic sequence. Runtime epoch and
sequence are deliberately not persisted; persisted layout restore recreates a
runtime with a new epoch and obtains its current sequence from the host.

### Session creation and restore

1. A renderer command asks Main to create or restore a surface.
2. Main commits the product state and asks the utility process for its session.
3. The supervisor creates a runtime, new epoch, PTY, and headless terminal.
4. Runtime readiness updates the control plane.
5. A current visible surface requests an authorized attach.

Restore may expose persisted surface state before its runtime exists.
`runtime-not-ready` is therefore a recoverable readiness result, distinct from a
stale session or denied capability. The router maintains at most one cancellable
attach attempt for a current visible surface and retries when readiness changes,
with bounded backoff as a fallback. It cancels immediately if visibility or
session identity changes or the renderer reloads. A successful attach supplies
the new epoch; the renderer never invents or restores one.

### Attach, resume, and resync

Main authorizes an attach and transfers a dedicated renderer-to-runtime
`MessagePort`. Initial stream state is one of:

1. `checkpoint@sequence`: hydrate a new widget to that exact sequence, then
   consume newer deltas.
2. `resume(epoch, sequence)`: retain a valid warm widget and consume ring entries
   after its acknowledged sequence.

Each subscriber owns a cursor into the runtime's shared delta ring, not a private
copy queue. If the requested sequence is no longer present, the host returns one
`resync-required` result with the latest checkpoint. The renderer hydrates a
replacement offscreen and swaps atomically. It does not combine an obsolete
checkpoint with overlapping deltas or guess across a gap.

Detach, workspace deactivation, surface restart, renderer reload, runtime loss,
or product-state deletion closes the corresponding port. With no subscribers,
the PTY and headless model continue committing output so a current checkpoint
can be materialized later, while renderer bulk transmission is zero.

### Input and resize

Keyboard text, key events, paste, binary mouse protocol, and xterm `onData` /
`onBinary` input travel over the same attach-specific port in the reverse
direction. Their session FIFO preserves accepted input order. Resize is sent over
the port but commits through the terminal mutation queue so checkpoint geometry
cannot overtake earlier output.

Main's usage-command and `needs input` behavior is driven by a later asynchronous
`input.observed` control event after the host accepts a PTY write. Protocol query
replies are not user input and must not trigger that event. Input payload content
is not written to diagnostics.

## Terminal query authority

The supervisor's headless xterm is always authoritative for queries whose answer
comes from terminal-model state:

- DA1 and DA2
- DSR and cursor-position reports
- ANSI and DEC DECRQM
- DECRQSS
- `CSI 18 t` character rows and columns

The headless terminal writes these replies directly to its owning PTY in terminal
output order. Replies bypass input observation, usage detection, input logging,
shell-readiness gating, and input-latency telemetry.

The renderer consumes the same model queries with parser handlers before
xterm.js's built-in response can reach its input path, preventing duplicate
answers. This rule does not change with visibility, attach, replay, checkpoint
hydration, or resync.

The renderer remains authoritative for view-dependent answers that a headless
model cannot know correctly, including rendered colors, pixel geometry, focus,
and mouse-view state.

## Bounded work and backpressure

Initial terminal data-plane limits are:

- headless parsing: at most 64 KiB per runnable session before yielding
- PTY pending output: pause at 4 MiB and resume below 1 MiB
- delta ring: 2 MiB or 2,048 events per session; 64 MiB or 65,536 events across
  the supervisor
- initial subscriber credit: 128 KiB
- renderer wire coalescing: at most 16 KiB normally; a larger UTF-8-safe logical
  source segment may be sent alone
- text, binary, key-text, and paste input: at most 64 KiB per message

Output deltas consume subscriber credit. The renderer replenishes credit only
after the corresponding xterm parse-completion callback, not when work is queued
or started. A slow renderer therefore cannot create an unbounded utility-process
or port queue. Checkpoints are independently bounded and do not consume normal
delta credit.

The supervisor schedules runnable sessions fairly. It first splits PTY reads into
UTF-8-safe logical segments, yields after the per-session parsing slice, and uses
high/low watermarks to pause and resume producers. Subscriber cursors share ring
storage; the design does not allocate an unbounded chunk-copy queue per attach.

## Rendering and scheduling

### Surface presentation pacing

The default output policy is conservative adaptive pacing rather than a
character-by-character typewriter effect:

- the first plain append after idle may write immediately
- subsequent plain append output may coalesce to the next animation frame, up to
  16 KiB per write
- pacing stops and catch-up begins when pending output exceeds 32 KiB or its
  oldest item reaches 32 ms
- user input flushes pending presentation work and enables immediate mode for
  100 ms
- ANSI/control traffic, bare-CR redraw, alternate screen, mouse tracking,
  synchronized output, resize, checkpoint/replay/resync, and user scrollback
  bypass presentation pacing

Uncertain data is classified as control traffic. A large TUI redraw is not
artificially unfolded character by character.

### Renderer-wide cooperative arbiter

Every payload released by a surface pacer enters the one xterm write arbiter
owned by `TerminalStreamRouter`. A live surface is an ordered lane:

- a lane has at most one xterm parse write in flight
- each parse start receives at most 16 KiB while preserving Unicode boundaries
- ready lanes are selected round-robin
- one turn starts at most 8 parses or consumes at most 8 ms
- remaining work continues through `MessageChannel`, yielding to input, paint,
  scrolling, and peer surfaces on the renderer's single JavaScript thread

Offscreen checkpoint hydration uses the same lane, quantum, and arbiter. Cold
attach and ring-gap recovery therefore cannot monopolize the renderer. User input
goes to the PTY immediately and gives that surface one next available arbiter
quantum, without moving its output ahead of earlier bytes or starving other
lanes.

Presentation pacing and arbiter admission never change protocol sequence. Credit
is returned only after xterm's completion callback.

### DOM renderer and WebGL evidence gate

The xterm DOM renderer is the default. GPU rendering does not create terminal
output cadence and is not required for data-plane correctness.

WebGL may be evaluated separately and default-off only after three consecutive,
comparable profiles show both:

- `xterm parsed -> onRender` is more than half of visible end-to-end latency
- its p95 exceeds 34 ms

This prevents split/resize/hydration artifacts and WebGL recovery complexity from
entering the core architecture unless measurement identifies rendering itself as
the dominant cost.

## Rendering and UI rules

### Sidebar

- use viewport virtualization
- give each row an immutable view model
- patch branch, cwd, unread, and status changes at row scope
- do not invalidate the active pane tree for metadata-only changes

### Pane area and workspace switching

- mount only the active workspace pane tree in React
- live-attach only each pane's active surface
- keep pane and surface identity stable through focus, split, resize, and move
- retain detached xterm widgets only through the bounded warm LRU
- hydrate or resume returning surfaces without showing a partially replayed frame
- dispose a widget immediately when its surface leaves product state
- centralize key routing above terminal widgets
- do not perform full sidebar recomputation or all-workspace metadata reload on
  workspace switches

## Metadata strategy

Prefer event-driven terminal metadata:

- cwd from OSC 7 or shell integration
- title from terminal escape sequences
- bell and unread markers from terminal events
- explicit status through a control command

Git branch, port detection, and similar background collectors may be debounced in
Main or a helper worker. They do not run polling loops in renderer components and
do not mutate component-local product state directly.

## Persistence and restore

Persist from `electron-main`:

- workspace order
- pane trees and ratios
- active workspace, pane, and surface identities
- logical session launch configuration
- window bounds
- user settings
- cached sidebar metadata

Do not persist:

- DOM or xterm widget objects
- runtime epochs
- terminal stream sequence numbers or ring cursors
- attach ports or capabilities

When workspace restore is enabled, Main reconstructs product state and recreates
configured sessions. Each spawn receives a fresh epoch, and the renderer waits
for runtime readiness before obtaining a checkpoint or valid resume state. A
restored session is never considered attached merely because its persisted ids
are present.

## Performance and scale gate

The primary profile is 16 sessions with at most 4 visible surfaces. It includes
steady concurrent output, workspace switches, echo probes, and a separate 4 MiB
burst. It records:

```text
pty read -> headless commit -> port receive -> xterm parsed -> onRender
```

It also verifies queue, ring, credit, and cache bounds, and requires Main to
receive zero terminal bulk-output bytes.

Use measurement before adding processes. Only when the same environment fails
the single-supervisor host event-loop or parser limits in three consecutive clean
runs may the runtime boundary gain two fixed, consistent-hash session shards. If
two still fail, it may grow to at most four. Do not shard by workspace and do not
create a process or worker per session.

## Failure and lifecycle rules

- stale epoch input, output, and ports are rejected
- a sequence gap triggers one checkpoint resync, not overlapping replay
- renderer reload closes old capabilities and authorizes new attaches
- hiding a surface or workspace cancels its pending attach and closes its port
- utility-process loss reports current sessions as runtime lost
- shutdown disposes attach ports and sessions before terminating the utility
  process, with a bounded forced-exit fallback
- kmux does not silently respawn an agent process after runtime loss

## Guardrails

Do not:

- run `node-pty` in the renderer or Main
- send terminal bulk output through Main or preload callbacks
- make renderer widgets the only terminal-buffer authority
- keep inactive workspaces or hidden surface tabs live-attached
- keep removed-surface widgets in the warm cache
- couple pane/session identity to React component identity
- permit presentation pacing to change stream ordering
- return subscriber credit before xterm parse completion
- add workspace/session processes without the measured sharding gate

## Suggested repository shape

```text
apps/
  desktop/
    src/main/
    src/renderer/
    src/preload/
    src/pty-host/
packages/
  proto/
  core/
  persistence/
  metadata/
  cli/
  ui/
```

Package responsibilities:

- `packages/proto`: typed transport-neutral IPC and stream contracts
- `packages/core`: IDs, commands, reducer, selectors, and layout tree
- `packages/persistence`: file-store persistence helpers and application paths
- `packages/metadata`: cwd, git, ports, and status helpers
- `packages/cli`: socket-based automation CLI
- `packages/ui`: shared UI helpers and tokens
- `apps/desktop/src/main`: Electron lifecycle, control plane, store, and attach
  authorization
- `apps/desktop/src/pty-host`: utility-process supervisor, PTYs, headless terminal
  runtimes, and direct stream ports
- `apps/desktop/src/renderer`: application UI, active pane tree, singleton stream
  router, visible terminals, and bounded warm cache

## Consequences

- terminal bulk traffic does not consume Main reducer or IPC dispatch time
- renderer stream dispatch and xterm scheduling scale with visible surfaces, not
  every created surface
- session and terminal-model lifetime is independent of renderer widget lifetime
- queue, ring, port, and widget memory have explicit owners and bounds
- restore, readiness, epoch changes, and sequence gaps are protocol states rather
  than timing heuristics
- direct-port lifecycle adds explicit utility-crash, renderer-reload, and shutdown
  handling
- future SSH or external runtimes can preserve the same
  checkpoint/delta/credit/epoch contract without moving product state out of Main
