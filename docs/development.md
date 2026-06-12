# Development Guide

This document is for contributors working on `kmux` locally.

## Core Docs

- Product scope: [product-spec.md](./product-spec.md)
- Architecture decision: [adr/0002-electron-xterm-mvp-architecture.md](./adr/0002-electron-xterm-mvp-architecture.md)
- Linux desktop support: [linux-desktop.md](./linux-desktop.md)
- Linux release validation: [linux-release-validation.md](./linux-release-validation.md)
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
`KMUX_RUNTIME_DIR` when you intentionally want a different profile. Blank or
whitespace-only overrides are ignored, and nonblank values are trimmed before
being passed to the desktop app.

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
- `npm run package:linux`: build a local/internal Linux AppImage with publishing disabled
- `npm run gate:walking-skeleton`: run the portable walking-skeleton preflight; its output says `Gate mode: portable preflight` and `RC evidence: no`, so it is useful for local diagnostics but does not satisfy the Ubuntu Desktop Linux gate
- `npm run gate:walking-skeleton:linux`: on Ubuntu Desktop LTS with display and Ubuntu/GNOME/Unity desktop session env, run the complete walking-skeleton gate; its output includes `Gate mode: Ubuntu Desktop Linux gate` and `RC evidence: walking-skeleton component only`, so record it as one RC ledger component rather than a full RC pass
- `npm run smoke:packaged:linux`: on Ubuntu Desktop LTS with display and Ubuntu/GNOME/Unity desktop session env, validate the latest AppImage metadata against the selected AppImage, require a non-empty AppImage blockmap sidecar, desktop entry, notification icon resource, and packaged-app smoke spec covering app startup, shell spawn, CLI socket access, notifications, split panes, surface switching, foreground resize output continuity, relaunch, and persisted settings; the command prints `Smoke mode` and `Passing RC evidence: no automatic pass` in a preflight summary of artifact, non-empty AppImage blockmap sidecar, metadata path/version/AppImage entry, update metadata top-level sha512, AppImage file-entry sha512, packaged AppImage sha512, size/checksum match status, desktop identity, notification icon, AppImage runtime env facts, and that `--no-sandbox` was not injected, while stating that release visibility and updater check/download/install remain separate manual observations and that notification delivery/window grouping remains a separate manual observation; maintainers must record real Ubuntu Desktop/AppImage observations in the RC ledger
- `npm run release:evidence:linux`: on Ubuntu Desktop LTS with display and Ubuntu/GNOME/Unity desktop session env, collect host/session, distro, git dirty state, desktop integration and shell/display context, AppImage sandbox context, inotify watch limits, agent storage root facts, `script` command availability, `ps` and bounded `lsof` subprocess samples, artifact, AppImage blockmap sidecar, Linux package artifact files such as `.deb`, `.rpm`, `.snap`, and `.flatpak`, updater metadata, packaging and publishing configuration facts, runtime and packaged identity alignment facts, release workflow public-gate facts, desktop-entry, notification icon facts, and a non-passing field-scoped handoff block for the Linux RC ledger; generated reports include `Report mode`, and the `--allow-any-platform` flag is only for script-development output with `Passing RC evidence: no`; script-development handoff commands keep `--allow-any-platform` in the generated command field
- `npm run release:check:mac`: build the macOS DMG and run the packaged-app smoke spec
- `npm run release:check:linux`: on Ubuntu Desktop LTS with display and Ubuntu/GNOME/Unity desktop session env, preflight the desktop target, run the strict `gate:walking-skeleton:linux`, build the AppImage, run packaged smoke, and verify public Linux release publishing remains gated; after `KMUX_ENABLE_LINUX_PUBLIC_RELEASE=1`, the public gate also requires an AppImage, matching AppImage blockmap sidecar, `latest-linux*.yml` update metadata, an AppImage artifact upload path in the release workflow, and the gate before GitHub release publishing
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
7. `npm run release:check:linux` and `npm run release:evidence:linux` on Ubuntu Desktop LTS with display and Ubuntu/GNOME/Unity desktop session env before Linux release-candidate signoff. `release:check:linux` runs the strict `gate:walking-skeleton:linux`, `package:linux`, and `smoke:packaged:linux` stages; keep those exact command markers and outputs in the RC ledger. Do not use `--skip-e2e`, `--skip-build`, `--allow-any-linux-desktop`, or `--allow-any-platform` for RC evidence, and do not treat outputs that say `RC evidence: no`, `RC evidence: no on this host`, `Passing RC evidence: no automatic pass`, or `script-development/non-RC` as a passed RC.

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
