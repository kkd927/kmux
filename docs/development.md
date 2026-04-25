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

The dev launcher uses a repo-local profile by default:

```text
.kmux/dev/config
.kmux/dev/runtime
```

This keeps local development from reading or writing the installed app's
`~/.config/kmux` workspace snapshot. Override `KMUX_CONFIG_DIR` or
`KMUX_RUNTIME_DIR` when you intentionally want a different profile.

Build the PTY host, CLI, and desktop app:

```bash
npm run build
```

If native dependencies need to be rebuilt after a Node or Electron change:

```bash
npm run rebuild:electron
```

This now rebuilds `node-pty` only. Persistence uses JSON file stores under the kmux config directory.

## Key Scripts

- `npm run dev`: start the desktop app in development mode with an isolated local profile
- `npm run build`: build the PTY host, CLI, and desktop app
- `npm run test`: run Vitest
- `npm run lint`: run ESLint
- `npm run test:e2e`: run Playwright Electron tests
- `npm run test:e2e:visible`: run Playwright Electron tests with a visible window
- `npm run smoke:packaged:mac`: mount the latest packaged DMG and run a packaged-app smoke spec
- `npm run release:check:mac`: build the macOS DMG and run the packaged-app smoke spec
- `npm run capture:scene`: capture the current app scene for visual review
- `npm run profile:smoothness`: run the opt-in smoothness profiling workload and verify JSONL profile output

## Release Signing

Tagged desktop releases are signed and notarized in GitHub Actions.

Required repository secrets:

- `CSC_LINK`: base64-encoded `Developer ID Application` certificate export (`.p12`)
- `CSC_KEY_PASSWORD`: password for the exported `.p12`
- `APPLE_API_KEY_P8`: App Store Connect API key contents (`AuthKey_*.p8`)
- `APPLE_API_KEY_ID`: App Store Connect API key ID
- `APPLE_API_ISSUER`: App Store Connect issuer ID

The release workflow writes `APPLE_API_KEY_P8` to a temporary file and exposes the path through the `APPLE_API_KEY` environment variable so electron-builder can notarize the build.

## Smoothness Profiling

Use smoothness profiling when investigating terminal output jank, React rerender churn, or sidebar/metadata patch flooding during Claude Code, Codex, Gemini, or similar agent workloads.

Profiling is disabled by default. Set `KMUX_PROFILE_LOG_PATH` to enable it:

```bash
KMUX_PROFILE_LOG_PATH=/tmp/kmux-smoothness.jsonl npm run dev
```

If `KMUX_PROFILE_LOG_PATH` points to a directory or a directory-like path, kmux writes `kmux-smoothness.jsonl` inside that directory:

```bash
KMUX_PROFILE_LOG_PATH=/tmp/kmux-profile npm run dev
```

The profile log is JSONL and may grow quickly. Do not commit generated profile logs. Summarize a captured profile with:

```bash
node scripts/analyze-smoothness-profile.mjs /tmp/kmux-smoothness.jsonl
```

The analyzer groups the main bottleneck signals:

- `react-rerender`: prioritize pane tree revision or stable renderer slice work
- `terminal-output`: prioritize stream batching, xterm write pacing, or backpressure
- `terminal-resize`: inspect `terminal.fit`, `terminal.resize.request`, `terminal.resize.ack`, `terminal.resize.apply`, and `terminal.reflow` to separate fit calculation, IPC/PTY resize round-trip, synchronous xterm resize, and next-frame reflow cost
- `patch-frequency`: prioritize shell patch coalescing or metadata frequency control

To validate the profiling path itself, run:

```bash
npm run profile:smoothness
```

That command builds kmux, launches the Electron e2e workload with profiling enabled, generates terminal/sidebar churn, and verifies that the profile JSONL file is produced.

## Recommended Validation Flow

Run the narrowest useful checks first, then broaden out:

1. Targeted tests for the area you changed
2. `npm run test`
3. `npm run lint`
4. `npm run build`
5. `npm run test:e2e` for UI, runtime, restore, automation, or renderer-facing changes
6. `npm run release:check:mac` when you need to validate the packaged macOS artifact locally

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
  persistence/    File-store persistence helpers and app paths
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
