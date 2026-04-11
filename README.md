# kmux

`kmux` is a keyboard-first terminal workspace manager inspired by `cmux`, rebuilt as an Electron MVP around `xterm.js`, `node-pty`, and a main-process-owned state model.

The current branch is intentionally focused on:

- workspaces
- split panes
- multi-surface tabs
- notifications
- sidebar metadata
- CLI and Unix socket automation

This branch does not aim to ship an embedded browser, SSH relay, or a multi-window UI.

## Status

The app is macOS-first and optimized for a polished MVP that stays responsive across tens of workspaces and surfaces.

The architectural rule that matters most is simple:

- the renderer never owns PTYs
- hidden surfaces do not keep mounted terminal DOM nodes
- `electron-main` remains the single writer for app state

The source of truth for product scope is [`docs/spec.md`](./docs/spec.md). The Electron deviation from the original daemon-first direction is documented in [`docs/decisions/0002-electron-xterm-mvp-architecture.md`](./docs/decisions/0002-electron-xterm-mvp-architecture.md).

## Architecture

```text
apps/
  desktop/
    src/main/      Electron main process, store, persistence, socket API
    src/preload/   Typed renderer bridge
    src/pty-host/  node-pty + @xterm/headless runtime
    src/renderer/  React UI, xterm.js mounts, overlays
packages/
  core/           Reducers, domain model, selectors
  proto/          Shared types and IPC contracts
  persistence/    SQLite persistence and app paths
  metadata/       Sidebar metadata utilities
  cli/            kmux CLI over Unix domain socket JSON-RPC
  ui/             Default command and theme helpers
```

High-level flow:

1. The renderer dispatches actions through the preload bridge.
2. `electron-main` applies reducer updates and owns persistence.
3. `pty-host` owns session lifetime and scrollback using `node-pty` and `@xterm/headless`.
4. Only visible surfaces attach a live `xterm.js` instance in the renderer.

## Features

- Workspace lifecycle: create, rename, select, close, reorder persistence
- Pane lifecycle: split, resize, directional focus, close, zoom
- Surface lifecycle: create, rename, close, close others, next/prev, direct selection
- Terminal UX: live shell sessions, copy/paste, IME, find, scrollback, cwd/title/bell updates
- Sidebar detail: status pill, progress bar, log feed, workspace summaries, unread counts
- Notifications: unread tracking, jump-to-latest-unread, clear all
- Automation: `kmux` CLI plus Unix socket JSON-RPC for workspace/surface/sidebar/notification control

## Development

Install dependencies:

```bash
npm install
```

Start the desktop app in development mode:

```bash
npm run dev
```

Build the desktop app, PTY host, and CLI:

```bash
npm run build
```

Run checks:

```bash
npm run lint
npm run test
npm run test:e2e
```

If native dependencies need to be rebuilt after Node or Electron changes:

```bash
npm run rebuild:electron
```

## CLI

The CLI talks to the app over a Unix domain socket. Common commands:

```bash
node packages/cli/dist/bin.cjs system ping
node packages/cli/dist/bin.cjs workspace list
node packages/cli/dist/bin.cjs sidebar state
node packages/cli/dist/bin.cjs sidebar set-status --workspace <id> --text "Working"
node packages/cli/dist/bin.cjs sidebar set-progress --workspace <id> --value 0.4 --label "Indexing"
```

Important environment variables:

- `KMUX_SOCKET_PATH`
- `KMUX_SOCKET_MODE`
- `KMUX_WORKSPACE_ID`
- `KMUX_SURFACE_ID`
- `KMUX_AUTH_TOKEN`
- `TERM_PROGRAM=kmux`

## Design Reference

The current UI is tuned against [`cmux.png`](./cmux.png), which acts as the reference for:

- titlebar chrome
- sidebar width and density
- pane header proportions
- split geometry
- dark palette and spacing

Pane body contents are validated functionally rather than by strict pixel parity.

## Testing Strategy

The repository keeps three layers of validation:

- `vitest` for reducers, layout behavior, and shared contracts
- Playwright Electron tests for launch, restore, CLI/socket automation, and UI regressions
- manual screenshot review against `cmux.png` for visual polish passes

Recent acceptance coverage includes:

- workspace + pane + surface + notification smoke flow
- startup restore on/off behavior across relaunches
- socket capability and identify checks

## Roadmap Notes

Near-term hardening work is still focused on:

- broader e2e coverage for keyboard and sidebar automation flows
- tighter visual verification against the reference image
- packaging polish for public release

## Repository Notes

- This workspace currently has no embedded `.git` metadata in the local environment used by Codex, so branch and PR automation may be unavailable from here.
- The project is still pre-1.0 and the packaging/release story is being refined.
