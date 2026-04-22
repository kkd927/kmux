# kmux Product Spec

Date: 2026-04-22

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

- `electron-main`: single writer, file-store persistence, socket API, metadata scheduling
- `pty-host`: `node-pty` and `@xterm/headless` session runtime
- `renderer`: visible `xterm.js` mounts, split UI, sidebar, overlays

Hard rules:

- The renderer must not own PTYs directly.
- Hidden surfaces must not keep DOM terminals mounted.
- All state mutation must flow through the main reducer.
- Stable `windowId`, `workspaceId`, `paneId`, `surfaceId`, and `sessionId` values must be preserved.
- Visible-only rendering is required.

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
- Attach snapshot plus incremental output

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
- Explicit app quit, including `Cmd+Q`, must shut down background services and start the next launch from a fresh workspace session
- Clean relaunch must preserve persisted settings and window chrome state, but must not reuse the previous workspace layout, pane graph, surface tabs, or session set
- Snapshot persistence exists for crash or unclean shutdown recovery only; a clean shutdown must not restore the previous working set on the next launch

## 4. Validation Criteria

- Preserve a polished window chrome, sidebar, pane header, split geometry, and dark palette baseline with strong readability.
- Treat pane body content as a functional verification target; it may be masked in visual diffing.
- Pass `npm run test` and `npm run build`.
- After launch, verify workspace, split, surface, notification, socket, close-window continuity, clean-quit fresh launch, and crash-recovery behavior.
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
- `TERM_PROGRAM=kmux`

## 7. Priorities

1. The app launches and visible terminals attach correctly.
2. Workspace, pane, and surface state remain consistent across live app interactions, while persisted settings, window state, and crash recovery remain predictable.
3. Automation and notifications work correctly.
4. The UI remains visually coherent, polished, and easy to read at normal working sizes.
