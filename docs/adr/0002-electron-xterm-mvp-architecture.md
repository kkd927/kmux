# 0002: Electron + xterm.js + node-pty MVP Architecture

## Context

Earlier planning explored a Rust daemon-first architecture, a custom renderer, and more ambitious scale targets.

Those remain plausible long-term directions, but they front-load a large amount of systems work before the product can validate its core UX.

For the current product phase, the goal is narrower:

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
- synchronous file-store persistence in `electron-main` for app snapshots, window state, and settings

Keep these architectural rules even in the Electron MVP:

- renderer never owns PTYs directly
- renderer never becomes the source of truth for workspace or pane state
- the renderer may preserve pane-scoped terminal widget instances across workspace switches when this is needed for terminal continuity, but those widgets are caches only
- hidden surface tabs within a pane must not remain attached to the pane widget stream
- high-cost terminal renderer resources, especially WebGL renderers, must remain bounded by a recent-pane policy
- sidebar updates must remain row-scoped and virtualized
- transport messages must be typed and transport-neutral so the `pty-host` can later become an external daemon

## Deferred alternatives

Compared with those earlier exploratory directions, this decision intentionally does not pursue:

- `No browser or webview dependencies`
- `No Electron/Tauri dependencies`
- `Use a custom internal terminal engine behind an adapter layer`
- `Use winit + egui for desktop UI shell`
- `Use wgpu for terminal rendering, with a software fallback path`

This decision does not discard the product rules that still matter regardless of UI stack:

- stable workspace, pane, surface, and session identity
- bounded renderer work and explicit warm terminal cache ownership
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
- warm pane-scoped `xterm.js` widget cache for workspace switching continuity
- keyboard and pointer input capture

Non-responsibilities:

- no PTY ownership
- no long-lived workspace source of truth
- no metadata polling loops

Renderer terminal widgets are pane-scoped UI caches. They may stay mounted while a workspace tree is hidden so that returning to the workspace does not destroy the terminal widget, blank the pane body, or force a full TUI redraw. This cache must not become product state: PTY sessions and headless terminal buffers stay in `pty-host`, and workspace/pane/surface identity stays in `electron-main`.

Within a pane, only the active surface is attached to that pane's terminal widget. Hidden surface tabs must still detach from the widget stream and hydrate from their snapshot/stream when selected.

WebGL-backed terminal renderers are treated as bounded high-cost resources. Panes outside the recent-pane WebGL policy must fall back to the default renderer while keeping terminal/session identity intact.

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

### Hidden detach and warm workspace cache

1. when a surface tab becomes hidden inside a pane, renderer detaches that surface from the pane widget stream
2. when a workspace becomes inactive, renderer may keep its pane-scoped terminal widget mounted as a warm cache
3. `pty-host` keeps:
   - PTY session alive
   - headless terminal state alive
   - scrollback and parser state alive
4. warm renderer widgets must be released when their pane leaves product state
5. WebGL renderer usage is bounded separately from terminal widget lifetime

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

- preserve pane identity and pane-scoped terminal widgets across workspace switches when needed for continuity
- attach only the active surface tab to a pane widget
- release terminal widgets when panes are closed, moved out of state, or otherwise removed from the product model
- bound WebGL renderer use to recent panes
- keep pane identity stable across splits and resizes
- centralize key routing above the terminal widgets
- avoid remounting a visible terminal on simple focus changes

### Workspace switching

Allowed work:

- hide inactive workspace pane trees while keeping their pane-scoped terminal widgets warm
- reattach or hydrate the returning workspace's active surface without resetting preserved widget content when it is still valid
- request snapshots for newly visible surfaces
- update focus and selection state

Disallowed work:

- full sidebar recomputation
- reloading metadata for every workspace
- recreating sessions for panes that already exist
- letting warm renderer widgets mutate product state outside the main reducer
- keeping unbounded high-cost renderer resources such as WebGL contexts

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

Persist with synchronous file-store writes from `electron-main`.

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

This architecture is explicitly optimized for the current MVP target envelope.

Target envelope:

- 10 to 20 workspaces used actively
- 1 to 4 panes per workspace
- dozens of total surfaces, not hundreds
- one visible window in v1
- low to moderate concurrent output across background sessions

Acceptance goals:

- active pane focus should feel immediate
- workspace switches should not show a blank intermediate state
- warm hidden workspace widgets should remove workspace-switch flicker without becoming session owners
- hidden surface tabs should stay detached from pane widget streams until selected
- high-cost renderer resources should remain bounded under normal tens-of-workspaces use
- sidebar scrolling should remain smooth under dozens of rows
- CLI or automation commands should not block on renderer jank

## Guardrails

Do not take these shortcuts even in the MVP:

- do not run `node-pty` in the renderer
- do not make the renderer the only holder of terminal buffer state
- do not confuse warm renderer widgets with authoritative session state
- do not keep unbounded WebGL-backed hidden terminals alive
- do not keep hidden surface tabs attached to the active pane stream
- do not couple pane identity to React component identity
- do not let metadata polling directly mutate UI component state

## Suggested repository shape

The repository shape for this architecture is:

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

Suggested package responsibilities:

- `packages/proto`: typed IPC contracts
- `packages/core`: IDs, commands, reducer, selectors, layout tree
- `packages/persistence`: file-store persistence helpers and app paths
- `packages/metadata`: cwd/git/ports/status helpers
- `packages/cli`: socket-based automation CLI
- `packages/ui`: shared UI helpers and tokens
- `apps/desktop/src/main`: Electron app lifecycle and store host
- `apps/desktop/src/pty-host`: `node-pty` and headless terminal runtime
- `apps/desktop/src/renderer`: UI shell, sidebar, pane layout, visible terminals

## Migration path

This MVP should preserve a future path toward an external daemon architecture if scale or product requirements change.

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
