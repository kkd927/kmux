# 0002: Electron + xterm.js + node-pty MVP architecture

## Context

`docs/spec.md` optimizes for a Rust daemon-first architecture, a custom renderer, and scale targets up to 100 workspaces x 4 panes.

That remains a valid long-term direction, but it front-loads a large amount of systems work before the product can validate its core UX.

For the current phase, the goal is narrower:

- cover typical single-user developer workloads
- keep terminal quality high from day one
- support tens of workspaces and surfaces comfortably
- keep an upgrade path open for a future external daemon and custom renderer

The main constraint is that this simplification must not collapse all state and PTY ownership into the renderer process. If that happens, session lifetime, focus behavior, and future multi-window support become much harder to evolve.

## Decision

Adopt an Electron-based MVP architecture built from these runtime layers:

1. `electron-main`
2. `pty-host` utility process
3. renderer window(s) using `xterm.js`

Use the following technology choices:

- `Electron` for desktop shell, packaging, and native window lifecycle
- `xterm.js` for visible terminal rendering and input UX
- `node-pty` in the `pty-host` process for PTY/session management
- `@xterm/headless` in the `pty-host` process to keep terminal state independent from DOM widgets
- `better-sqlite3` or equivalent synchronous SQLite binding in `electron-main` for persistence

Keep these architectural rules even in the Electron MVP:

- renderer never owns PTYs directly
- renderer never becomes the source of truth for workspace or pane state
- hidden surfaces must not keep active DOM terminal mounts
- sidebar updates must remain row-scoped and virtualized
- transport messages must be typed and transport-neutral so the `pty-host` can later become an external daemon

## Scope of deviation

This decision intentionally relaxes several constraints from `docs/spec.md` for the MVP phase:

- `No browser or webview dependencies`
- `No Electron/Tauri dependencies`
- `Use libghostty-vt behind an internal adapter crate named mux-term-engine`
- `Use winit + egui for desktop UI shell`
- `Use wgpu for terminal rendering, with a software fallback path`

This decision does not discard the product rules that still matter regardless of UI stack:

- stable workspace, pane, surface, and session identity
- visible-only UI work
- bounded sidebar update fan-out
- centralized command routing
- session lifetime separate from widget lifetime
- future multi-window compatibility

## Why

This stack gives the project a faster path to a usable product:

- `xterm.js` provides mature terminal behavior, selection, IME, clipboard, and accessibility without reimplementing a terminal renderer first
- `node-pty` provides a proven PTY bridge on macOS and Linux
- Electron shortens the path to a polished desktop UI and distribution story

For a target envelope measured in tens of workspaces and surfaces rather than hundreds, this is a reasonable trade.

## Runtime architecture

### 1. `electron-main`

Responsibilities:

- app lifecycle
- window creation and restore
- central reducer/store
- command routing
- persistence
- metadata scheduling
- IPC brokering between renderer and `pty-host`
- telemetry and performance counters

Non-responsibilities:

- no PTY reads
- no terminal parsing on the hot path
- no direct DOM or terminal widget logic

`electron-main` is the single writer for product state:

- windows
- workspaces
- pane tree
- active focus targets
- surface metadata
- persisted settings

Renderers subscribe to selectors, not the full store.

### 2. `pty-host`

Run PTY work in an Electron utility process or a dedicated Node child process.

Responsibilities:

- spawn and supervise `node-pty` sessions
- own session lifetime
- resize PTYs
- encode input writes
- parse output into terminal state using `@xterm/headless`
- emit snapshots and incremental output streams
- surface shell integration events such as cwd, title, and bell

Non-responsibilities:

- no layout state
- no sidebar state
- no window management
- no direct persistence writes

This process is intentionally daemon-like. It should communicate through a typed protocol package, not through renderer-specific assumptions.

### 3. renderer

Responsibilities:

- sidebar UI
- split-pane layout UI
- command palette
- focus visuals
- visible `xterm.js` instances
- keyboard and pointer input capture

Non-responsibilities:

- no PTY ownership
- no long-lived workspace source of truth
- no metadata polling loops

Only visible surfaces mount `xterm.js` DOM terminals. Hidden surfaces must be detached or disposed at the DOM layer.

## Domain model

Keep the same domain shape from the existing spec because it still supports multi-window and stable focus behavior:

```text
Window
  -> Workspace
      -> PaneTree
          -> Pane
              -> Surface
                  -> Session
```

Rules:

- `workspaceId`, `paneId`, `surfaceId`, and `sessionId` are stable
- split, close, reorder, and focus changes do not recreate existing sessions unless the user explicitly closes them
- pane/widget lifetime is separate from session lifetime

## Terminal data flow

### Session creation

1. renderer sends `workspace.createSurface` or equivalent command to `electron-main`
2. `electron-main` updates domain state and asks `pty-host` to create a session
3. `pty-host` spawns a `node-pty` instance and a paired `@xterm/headless` terminal
4. `pty-host` returns `sessionId`, size, and initial metadata

### Visible attach

1. renderer subscribes to the active workspace and visible pane set
2. for each newly visible surface, renderer requests an attach stream
3. `electron-main` forwards the request to `pty-host`
4. `pty-host` returns:
   - current serialized buffer snapshot
   - cursor and viewport state
   - monotonic stream sequence
5. renderer creates a visible `xterm.js` instance, replays the snapshot, then applies incremental updates

### Hidden detach

1. when a surface becomes hidden, renderer disposes or detaches the DOM terminal instance
2. `pty-host` keeps:
   - PTY session alive
   - headless terminal state alive
   - scrollback and parser state alive
3. no further DOM rendering work happens for that surface until it becomes visible again

### Input path

1. renderer captures keyboard, paste, mouse, and resize events
2. renderer sends typed input events to `electron-main`
3. `electron-main` forwards them to `pty-host`
4. `pty-host` writes them to `node-pty`

## IPC design

Define a shared protocol package for all cross-process messages.

Suggested message groups:

- commands: create workspace, split pane, focus pane, create surface, close surface
- state selectors: visible sidebar rows, active pane tree, active surface metadata
- terminal control: attach, detach, resize, input, scrollback request
- terminal stream: snapshot, chunk, bell, title, cwd, exit
- telemetry: stream lag, dropped frames, PTY backlog, attach cost

Design rules:

- renderer and `pty-host` never talk directly without `electron-main` mediation
- channels carry typed payloads, not stringly-typed event names with ad-hoc blobs
- terminal stream messages use sequence numbers so attach/detach can recover cleanly
- the message schema should not depend on Electron APIs so it can later move to sockets

## Rendering and UI rules

### Sidebar

- use viewport virtualization from day one
- each row receives an immutable view model
- branch, cwd, unread, and status changes patch only the affected row
- metadata changes must not invalidate the active pane tree

### Pane area

- mount `xterm.js` only for visible surfaces
- keep pane identity stable across splits and resizes
- centralize key routing above the terminal widgets
- avoid remounting a visible terminal on simple focus changes

### Workspace switching

Allowed work:

- unmount old visible terminal widgets
- mount new visible terminal widgets
- request snapshots for newly visible surfaces
- update focus and selection state

Disallowed work:

- full sidebar recomputation
- reloading metadata for every workspace
- recreating sessions for panes that already exist

## Metadata strategy

Keep metadata event-driven where possible:

- cwd from OSC 7 or shell integration hooks
- title from terminal escape sequences
- bell and unread markers from terminal events
- explicit status text through a command channel

Background metadata may still be process-driven:

- git branch with debounce
- port detection with debounce

These collectors should run in `electron-main` or a helper worker, not in the renderer.

## Persistence

Persist in SQLite from `electron-main`.

Store:

- workspace order
- pane tree and ratios
- active workspace and pane
- session launch config
- window bounds
- user settings
- cached sidebar metadata

Do not persist raw DOM terminal objects. Session restore should recreate PTYs and visible terminals from saved domain state and session config.

## Performance envelope

This architecture is explicitly optimized for a smaller target than the current long-term spec.

Target envelope for the Electron MVP:

- 10 to 20 workspaces used actively
- 1 to 4 panes per workspace
- dozens of total surfaces, not hundreds
- one visible window in v1
- low to moderate concurrent output across background sessions

Acceptance goals:

- active pane focus should feel immediate
- workspace switches should not show a blank intermediate state
- hidden surfaces should contribute near-zero DOM work
- sidebar scrolling should remain smooth under dozens of rows
- CLI or automation commands should not block on renderer jank

## Guardrails

Do not take these shortcuts even in the MVP:

- do not run `node-pty` in the renderer
- do not make the renderer the only holder of terminal buffer state
- do not keep every hidden terminal mounted in the DOM
- do not couple pane identity to React component identity
- do not let metadata polling directly mutate UI component state

## Suggested repository shape

If the project moves to this architecture, a TypeScript/Electron layout like this is a good fit:

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
```

Suggested package responsibilities:

- `packages/proto`: typed IPC contracts
- `packages/core`: IDs, commands, reducer, selectors, layout tree
- `packages/persistence`: SQLite schema and data access
- `packages/metadata`: cwd/git/ports/status helpers
- `apps/desktop/src/main`: Electron app lifecycle and store host
- `apps/desktop/src/pty-host`: `node-pty` and headless terminal runtime
- `apps/desktop/src/renderer`: UI shell, sidebar, pane layout, visible terminals

## Migration path

This MVP should preserve a future path back toward the original daemon-first architecture.

To keep that option open:

- keep `pty-host` isolated behind a transport-neutral protocol
- keep reducer/state logic outside Electron-only files
- keep session lifetime separate from window/widget lifetime
- avoid renderer-owned business logic
- treat attach/detach as if they were remote stream operations, not local object sharing

If the product later needs the original scale target, the likely migration sequence is:

1. move `pty-host` into an external daemon
2. replace Electron IPC with local socket transport
3. keep the same reducer and protocol model where possible
4. reevaluate whether visible terminal rendering should stay in `xterm.js` or move to a custom renderer

## Costs and risks

- memory overhead will be higher than a native custom renderer path
- frequent snapshot replay can make workspace switching more expensive than a custom diff renderer
- the browser rendering stack limits long-term headroom for hundreds of surfaces
- Electron packaging and native module maintenance add operational cost
- multi-window remains possible, but shared session views require careful attach ownership rules

## Revisit

Revisit this decision if any of the following become true:

- the target grows back toward 100 workspaces x 4 panes
- hidden-session CPU or memory cost becomes a recurring problem
- attach/snapshot latency becomes visible during workspace switches
- multi-window session sharing becomes a core requirement
- the project decides performance itself is the main product differentiator
