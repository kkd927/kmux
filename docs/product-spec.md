# kmux Product Spec

Date: 2026-04-09

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

- `electron-main`: single writer, persistence, socket API, metadata scheduling
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
- Persist ordering

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

- Workspace row name
- Cwd/path summary
- Git branch
- Up to three local ports
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

## 4. Validation Criteria

- Preserve a polished window chrome, sidebar, pane header, split geometry, and dark palette baseline with strong readability.
- Treat pane body content as a functional verification target; it may be masked in visual diffing.
- Pass `npm run test` and `npm run build`.
- After launch, verify workspace, split, surface, notification, socket, and restore behavior.
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
2. Workspace, pane, and surface state plus persistence remain consistent.
3. Automation and notifications work correctly.
4. The UI remains visually coherent, polished, and easy to read at normal working sizes.
