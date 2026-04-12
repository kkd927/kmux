# Development Guide

This document is for contributors working on `kmux` locally.

## Core Docs

- Product scope: [product-spec.md](./product-spec.md)
- Architecture decision: [adr/0002-electron-xterm-mvp-architecture.md](./adr/0002-electron-xterm-mvp-architecture.md)
- Contribution guide: [../CONTRIBUTING.md](../CONTRIBUTING.md)

## Local Setup

Install dependencies:

```bash
npm install
```

Start the desktop app in development mode:

```bash
npm run dev
```

Build the PTY host, CLI, and desktop app:

```bash
npm run build
```

If native dependencies need to be rebuilt after a Node or Electron change:

```bash
npm run rebuild:electron
```

## Key Scripts

- `npm run dev`: start the desktop app in development mode
- `npm run build`: build the PTY host, CLI, and desktop app
- `npm run test`: run Vitest
- `npm run lint`: run ESLint
- `npm run test:e2e`: run Playwright Electron tests
- `npm run test:e2e:visible`: run Playwright Electron tests with a visible window
- `npm run capture:scene`: capture the current app scene for visual review
- `npm run compare:cmux`: run the local visual comparison workflow when that parity check is needed

## Release Signing

Tagged desktop releases are signed and notarized in GitHub Actions.

Required repository secrets:

- `CSC_LINK`: base64-encoded `Developer ID Application` certificate export (`.p12`)
- `CSC_KEY_PASSWORD`: password for the exported `.p12`
- `APPLE_API_KEY_P8`: App Store Connect API key contents (`AuthKey_*.p8`)
- `APPLE_API_KEY_ID`: App Store Connect API key ID
- `APPLE_API_ISSUER`: App Store Connect issuer ID

The release workflow writes `APPLE_API_KEY_P8` to a temporary file and exposes the path through the `APPLE_API_KEY` environment variable so electron-builder can notarize the build.

## Recommended Validation Flow

Run the narrowest useful checks first, then broaden out:

1. Targeted tests for the area you changed
2. `npm run test`
3. `npm run lint`
4. `npm run build`
5. `npm run test:e2e` for UI, runtime, restore, automation, or renderer-facing changes

## Repository Layout

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
  ui/             Shared UI helpers and tokens
```

## Development Notes

- `electron-main` is the single writer for product state.
- PTY and session lifetime stay outside the renderer.
- Hidden surfaces must not keep live DOM terminals mounted.
- UI-facing changes should be validated with Playwright when practical.
- Keep documentation and tests in sync with behavior changes.
