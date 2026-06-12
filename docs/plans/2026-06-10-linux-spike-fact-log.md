# Linux Desktop Spike Fact Log

Date: 2026-06-10

Host used for this pass:

- `uname -a`: Darwin 25.5.0 x86_64
- Result: this pass can inspect code/configuration and run macOS-local tests only. Real Ubuntu Desktop, AppImage, compositor/GPU, notification identity, and Linux credential checks remain manual validation blockers.

## Verified From Current Repository

- The initial spike found packaging was macOS-only and that the notarization hook was top-level. The production builder config now includes a Linux AppImage target, keeps Linux packaging on `--publish never`, and routes `artifactBuildCompleted` through `apps/desktop/build/artifact-build-completed.cjs`, which only invokes the macOS notarization hook for `.dmg` artifacts.
- The Linux public publishing gate rejects AppImage/Linux update metadata assets while the stable RC ledger is not passed, and it requires `KMUX_ENABLE_LINUX_PUBLIC_RELEASE=1` plus a passed `docs/linux-release-validation.md` before public Linux upload paths can be enabled.
- `asarUnpack` already includes `**/*.node` and `dist/pty-host/**`, which is necessary but not sufficient for AppImage `node-pty` validation.
- CLI socket fallback previously duplicated `$HOME/.kmux/control.sock`; Phase 1 now routes the fallback through `@kmux/persistence.resolveAppPaths()`.
- Desktop socket startup previously unlinked the socket path unconditionally. Phase 1 now validates a private runtime directory, probes existing sockets first, refuses live owners, and only removes stale socket files.

## Manual Linux Validation Blockers

These items were not validated on this Darwin host and must be run on Ubuntu Desktop LTS before Linux can pass the walking skeleton or stable RC gates:

- GUI-launched Electron dev build opens a normal desktop window.
- `node-pty` spawns a shell in Linux dev mode.
- AppImage starts, loads `node-pty` from `app.asar.unpacked`, and spawns a shell.
- AppImage startup sandbox behavior, including whether `--no-sandbox` is required.
- `electron-updater` AppImage metadata flow: `APPIMAGE`, `latest-linux.yml`, channel naming, checksums, artifact visibility, and download/install behavior.
- Native window frame behavior under Ubuntu Desktop before custom frameless chrome is considered.
- GUI-launched shell environment recovery for nvm, pyenv, cargo, `~/.local/bin`, and installed Codex, Claude, Gemini, and Antigravity CLIs.
- Linux credential and storage sources for Codex, Claude, Gemini, and Antigravity.
- Hook env visibility in spawned sessions: `KMUX_SOCKET_PATH`, `KMUX_AGENT_BIN_DIR`, and `KMUX_NODE_PATH`.
- Hook notifications for installed Codex, Claude, Gemini, and Antigravity CLIs.
- Linux behavior for `security`, `script`, `lsof`, and `ps` usage/subscription paths.
- Linux notification identity, icon, app name, and window grouping.
- GPU/compositor output continuity on a real desktop environment, including split, surface switch, restore, and resize flows.

## Architecture Impact

- Phase 1 should proceed with a shared pure resolver in `@kmux/persistence`; CLI and desktop must not duplicate socket defaults.
- Socket ownership should remain the runtime authority. No Electron single-instance lock is added in Phase 1 because it is app-identity scoped and could block explicit isolated runtimes. This can be revisited after the platform skeleton has a default packaged-app duplicate-launch policy.
- Linux non-socket storage must not be derived from the socket directory. The resolver now exposes explicit roots for state, data, cache, captures, attachments, diagnostics, raw output, native cache, hooks, and wrappers; later phases still need to propagate all of them to the remaining consumers.
