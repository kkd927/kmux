# kmux Product Spec

Date: 2026-04-22
Updated: 2026-07-11

## 1. Product Definition

`kmux` is a multi-workspace terminal app. In this phase it is implemented as a macOS-first MVP built on `Electron + xterm.js + node-pty`.

Core goals:

1. Deliver the full `workspace + pane + surface + notification + automation` loop without an embedded browser.
2. Reach a polished macOS UI baseline with calm density, clear hierarchy, and dependable focus affordances.
3. Stay responsive at human scale across tens of workspaces and surfaces.
4. Preserve an architecture where the renderer does not own PTY sessions or the source of truth for state.

Non-goals:

- Embedded browser
- SSH relay
- Exposed multi-window UI
- Windows support

## 2. Architecture

The baseline architecture is defined in [`0002-electron-xterm-mvp-architecture.md`](./adr/0002-electron-xterm-mvp-architecture.md).

Processes:

- `electron-main`: product-state control plane, file-store persistence, socket API, metadata scheduling, terminal-attach authorization, and lifecycle
- `pty-host`: one Electron utility-process supervisor containing `node-pty` and `@xterm/headless` session runtimes
- `renderer`: split UI, sidebar, overlays, visible terminals, one terminal stream router, and a bounded warm terminal cache

Hard rules:

- The renderer must not own PTYs directly.
- Main must authorize terminal attaches but must not relay terminal bulk output, input, or resize traffic. Each authorized live attach uses a dedicated renderer-to-supervisor `MessagePort` capability.
- Only each pane's active surface in the active workspace may stay live-attached. Inactive workspace pane trees and hidden surface tabs must detach from the terminal stream.
- The renderer may keep detached surface-scoped `xterm.js` widget instances in a bounded LRU across workspace and surface switches to avoid destructive remounts, blank intermediate states, lost focus, and TUI redraw churn.
- Warm terminal widgets are renderer-only caches. The `pty-host` remains the owner of PTY and headless terminal state, and `electron-main` remains the source of truth for workspace, pane, surface, and session state.
- Warm terminal widgets must be released when their surfaces leave product state.
- Any terminal surface visible in the active workspace must continue rendering live output regardless of pane focus, app focus, or interaction with other panes.
- Terminal attach and recovery must preserve epoch and mutation-sequence ordering through checkpoint, resume, and resync paths.
- All state mutation must flow through the main reducer.
- Stable `windowId`, `workspaceId`, `paneId`, `surfaceId`, and `sessionId` values must be preserved.
- Workspace switching must preserve the active pane tree's terminal continuity without making hidden workspace widgets authoritative for session state.

## 3. Feature Scope

### 3.1 Workspace

- Create, select, rename, and close
- Next/previous and direct selection with `1..9`
- Create a workspace from an open folder
- Toggle the sidebar
- Workspace switcher
- Preserve ordering while the app process remains alive, including close-window and reopen-on-activate flows

### 3.2 Pane / Surface

- Split-right and split-down UI
- Split-left, split-right, split-up, and split-down API
- Four-direction pane focus
- Pane resize
- Pane close
- Multiple surface tabs per pane
- Surface create, focus, rename, close, close-others, next/previous, and direct selection with `1..9`

### 3.3 Terminal

- Shell launch
- Resize
- Copy/paste
- IME
- Selection
- Search, find-next, and find-previous
- Copy mode
- OSC-based cwd, title, and bell handling
- Checkpoint/resume attach plus ordered incremental output and atomic resync
- Bounded surface-scoped warm terminal preservation across workspace and surface switches
- Default `xterm.js` renderer behavior across splits, surfaces, and workspace switches

### 3.4 Sidebar / Notifications

- Workspace row name; user-managed label that defaults to `new workspace` until explicitly renamed
- Representative surface summary/title
- Cwd/path summary from the representative surface
- Git branch from the representative surface
- Up to three local ports aggregated across workspace surfaces, with the active surface taking precedence when selecting which ports to show
- Unread badge
- Pane attention ring
- Status pill
- Progress bar
- Log feed
- Notification center
- Jump to the latest unread item

### 3.5 Automation

- CLI
- Unix domain socket JSON-RPC
- `workspace.list/create/select/current/close`
- `surface.split/list/focus/send_text/send_key`
- `notification.create/list/clear`
- `sidebar.set_status/clear_status/set_progress/clear_progress/log/clear_log/sidebar_state`
- `system.ping/capabilities/identify`

### 3.6 App Lifecycle / Restore

- Closing the last app window on macOS must keep the app process, PTY sessions, socket server, and in-memory workspace state alive
- Reopening the app from the Dock or `activate` flow while the process is still alive must restore the same live workspace, pane, surface, notification, and focus state without a cold boot
- Explicit app quit, including `Cmd+Q`, must shut down the PTY supervisor, sessions, socket server, and other background services cleanly.
- When `Restore workspaces after quitting` is enabled, a clean relaunch must restore the persisted workspace, pane, surface, and session launch state, then create fresh runtime epochs and respawn those sessions. Runtime epochs and terminal stream sequences are never persisted.
- When `Restore workspaces after quitting` is disabled, a clean relaunch must preserve settings and window chrome state but start with a fresh working set.
- Snapshot persistence must continue to support crash or unclean-shutdown recovery independently of the clean-quit preference.

## 4. Validation Criteria

- Preserve a polished window chrome, sidebar, pane header, split geometry, and dark palette baseline with strong readability.
- Treat pane body content as a functional verification target; it may be masked in visual diffing.
- Pass `npm run test` and `npm run build`.
- After launch, verify workspace, split, surface, notification, socket, close-window continuity, both clean-quit restore modes, and crash-recovery behavior.
- Workspace switching validation must cover terminal continuity: no blank intermediate pane body, no lost focused terminal input, no stale active surface after returning to a workspace, and no accidental reuse after a pane or workspace is closed.
- Warm terminal validation must cover resource policy: closed panes and surfaces release cached terminal widgets, and inactive tab hydration still uses the selected surface's snapshot/stream.
- If a problem is found, fix it and rerun validation.

## 5. Repository Shape

```text
apps/
  desktop/
    src/main/
    src/preload/
    src/pty-host/
    src/renderer/
packages/
  core/
  proto/
  persistence/
  metadata/
  cli/
  ui/
```

## 6. Environment Variables

- `KMUX_SOCKET_PATH`
- `KMUX_SOCKET_MODE`
- `KMUX_WORKSPACE_ID`
- `KMUX_SURFACE_ID`
- `KMUX_AUTH_TOKEN`
- `KMUX_PROFILE_LOG_PATH`
- `TERM_PROGRAM=kmux`

## 7. Priorities

1. The app launches and visible terminals attach correctly.
2. Workspace, pane, and surface state remain consistent across live app interactions, while persisted settings, window state, and crash recovery remain predictable.
3. Workspace switching preserves terminal widget continuity while PTY/session ownership stays outside the renderer.
4. Automation and notifications work correctly.
5. The UI remains visually coherent, polished, and easy to read at normal working sizes.
