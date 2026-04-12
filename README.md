# kmux

`kmux` is a keyboard-first terminal workspace manager for macOS.

It helps you organize shell sessions into workspaces, split panes, and surface tabs, with sidebar status, notifications, and automation support. The project is currently pre-release and best tried from source.

[Download the latest release](../../releases/latest)

Choose the `arm64` build for Apple Silicon Macs and the `x64` build for Intel Macs.

[All releases](../../releases)

## What You Can Do

- Create, rename, switch, and close workspaces
- Split panes and move focus by keyboard or mouse
- Open multiple surface tabs inside each pane
- Use live shell sessions with scrollback, paste, selection, and search
- Drive the app with CLI and Unix socket automation
- Track status, progress, logs, and notifications in the sidebar

## Status

- macOS-first
- Pre-1.0
- Best tried from source today

## Install And Run

Pre-release macOS builds are available on the latest release page above. To try `kmux` locally from source:

```bash
npm install
npm run dev
```

## First Steps

1. Launch the app with `npm run dev`.
2. Create a workspace.
3. Split the active pane.
4. Open additional surface tabs inside a pane.
5. Use the sidebar to monitor workspace context, notifications, and status.

To use the automation CLI, build the project first:

```bash
npm run build
node packages/cli/dist/bin.cjs system ping
node packages/cli/dist/bin.cjs workspace list
```

## Learn More

- Product scope: [docs/product-spec.md](./docs/product-spec.md)
- Architecture decision: [docs/adr/0002-electron-xterm-mvp-architecture.md](./docs/adr/0002-electron-xterm-mvp-architecture.md)
- Development guide: [docs/development.md](./docs/development.md)
- Contributing: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Code of conduct: [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
- Security reporting: [SECURITY.md](./SECURITY.md)
