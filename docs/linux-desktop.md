# Linux Desktop Support

Linux desktop support is implemented behind the stable release gate, but the Ubuntu Desktop/AppImage RC has not passed yet. The supported target is a packaged GUI AppImage on Ubuntu Desktop LTS. Public Linux publishing remains gated until the stable RC checklist in [linux-release-validation.md](./linux-release-validation.md) passes.

This is not a headless Linux, server, WSL-only, Windows, Flatpak, Snap, or deb support statement. Those environments are out of scope for this Linux phase.

## Supported Baseline

The Linux stable release must support the same core kmux workflows as macOS:

- terminal sessions through `node-pty`
- split panes, surface switching, restore, foreground resize, and readable agent output continuity
- CLI/socket control through `KMUX_SOCKET_PATH`
- Codex, Claude, Gemini, and Antigravity hook notifications when the corresponding CLI is installed and configured
- external session discovery and resume for verified vendor storage roots
- usage history and subscription usage for providers with verified Linux credential sources
- native desktop notifications, app identity, and window grouping
- packaged AppImage updates through `electron-updater`

Feature rows can show normal unavailable states when a user is signed out, a provider CLI is missing, or a vendor does not expose a verified Linux credential source. That is different from platform degradation: shell spawn, sockets, hooks, restore/output continuity, packaged updates, and desktop identity are release blockers.

## AppImage Builds

Maintainers can build the local Linux AppImage with:

```bash
npm run package:linux
```

The build uses electron-builder's AppImage target and writes artifacts under `apps/desktop/release`. The Linux package command uses `--publish never`; generated AppImage files and Linux update metadata (`latest-linux.yml` for x64, `latest-linux-<arch>.yml` for non-x64) are local or internal-only until the stable RC gate passes.

Before packaged AppImage signoff, run the Linux walking-skeleton gate on Ubuntu Desktop LTS:

```bash
npm run gate:walking-skeleton:linux
```

That command requires a real Ubuntu Desktop session and must run the complete dev smoke, build, and selected Playwright checks for socket identity, shell/pty hook env, terminal cell metrics, split panes, surface switching, restore, foreground resize, and readable agent output continuity. Its output includes `Gate mode: Ubuntu Desktop Linux gate` and `RC evidence: walking-skeleton component only`, so maintainers still need the remaining Ubuntu Desktop/AppImage ledger observations before the stable RC can pass. `--skip-e2e` and `--skip-build` are only for portable local preflight through `npm run gate:walking-skeleton`; they are rejected by the Linux desktop gate, print `RC evidence: no`, and do not count as RC evidence.

On Ubuntu Desktop, validate the packaged build with:

```bash
npm run smoke:packaged:linux
```

The packaged smoke requires Ubuntu Desktop LTS with a real desktop session through `DISPLAY` or `WAYLAND_DISPLAY` plus session env such as `XDG_CURRENT_DESKTOP`, `XDG_SESSION_DESKTOP`, `DESKTOP_SESSION`, or `GDMSESSION` identifying Ubuntu/GNOME/Unity. It validates the AppImage, Linux update metadata, non-empty AppImage blockmap sidecar, extracted AppImage `.desktop` identity, and packaged `resources/notificationIcon.png` before launching the shared packaged Playwright smoke that covers app startup, shell spawn, CLI socket access, notifications, split panes, surface switching, foreground resize output continuity, relaunch, and persisted settings. Its preflight summary includes `Smoke mode` and `Passing RC evidence: no automatic pass` lines so maintainers must still record real Ubuntu Desktop/AppImage observations in the RC ledger. That summary records the selected AppImage artifact, non-empty AppImage blockmap sidecar, metadata path/version/AppImage entry, update metadata top-level sha512, AppImage file-entry sha512, packaged AppImage sha512, size/checksum match status, desktop identity, notification icon, AppImage runtime env facts, and that `--no-sandbox` was not injected; release visibility and updater check/download/install remain separate manual observations, and notification delivery/window grouping remains a separate manual observation. The smoke launches the AppImage with `APPIMAGE` set to the artifact path so updater code sees the same runtime path shape it expects from a normal AppImage launch, even when `APPIMAGE_EXTRACT_AND_RUN=1` is used for CI-friendly execution. `node scripts/smoke-packaged-linux.mjs --allow-any-linux-desktop` is only for non-RC diagnostics on other Linux desktops.

Do not document or require `--no-sandbox` for users unless the Ubuntu Desktop AppImage validation proves it is necessary and the security/product decision is recorded in the release validation doc.

For release-candidate signoff, `npm run release:check:linux` runs the Ubuntu Desktop preflight, strict `gate:walking-skeleton:linux`, AppImage package build, packaged smoke, and public-publishing gate in order. While Linux publishing is gated, public uploads must remain macOS-only. After `KMUX_ENABLE_LINUX_PUBLIC_RELEASE=1`, the public gate also requires an AppImage, matching AppImage blockmap sidecar, `latest-linux*.yml` update metadata, an AppImage artifact upload path in the release workflow, and the gate before GitHub release publishing. It still does not replace the manual ledger observations, updater check/download/install notes, notification/window-manager observations, or `release:evidence:linux` report.

When any Linux target preflight prints `RC evidence: no on this host`, that run is a handoff/blocker signal rather than signoff evidence. Re-run the command on Ubuntu Desktop LTS with the packaged AppImage target available, or keep the corresponding release-validation row blocked/manual until that environment is available.

## Desktop Identity And Notifications

The AppImage desktop entry declares the `kmux` app name, icon, freedesktop categories, startup notification, and `StartupWMClass=kmux`. Packaged builds also include `notificationIcon.png` as an extra resource. At runtime, kmux resolves the packaged notification icon first, falls back to the development icon when running from source, and attaches that icon to native desktop and updater notifications when Electron supports native notifications. Unsupported or failed native notification delivery is recorded in diagnostics without removing the in-app notification record; those diagnostics include the app id, app name, `StartupWMClass=kmux`, and resolved icon path inputs used for the attempted native notification.

These checks do not replace real desktop validation. Ubuntu Desktop RC evidence must still confirm notification title, body, icon, app attribution, successful delivery in the Ubuntu notification center, and window grouping with the app window through the notification center and window manager.

## Updates

Linux update checks are enabled only for packaged AppImage builds outside tests when the normal AppImage runtime provides `APPIMAGE`. Development, unpackaged Linux, test, and packaged Linux runs without `APPIMAGE` report a disabled updater state instead of starting an update check from an unsupported runtime shape.

The updater requires AppImage-compatible metadata:

- the AppImage artifact
- Linux update metadata (`latest-linux.yml` for x64, `latest-linux-<arch>.yml` for non-x64)
- matching version, artifact path, metadata checksums, and actual AppImage checksum
- release visibility that `electron-updater` can consume
- `APPIMAGE` environment behavior from a normal AppImage launch

The local smoke validates metadata shape, metadata filename/channel naming, metadata checksums against the selected AppImage, arch-specific metadata naming, desktop-entry identity, and packaged-launch `APPIMAGE` env wiring. kmux leaves the Linux updater channel unset so electron-updater uses its platform/arch default metadata name. It does not prove release visibility, download, or install behavior. Those remain Ubuntu Desktop RC requirements.

On Linux native window chrome, manual update actions are exposed from the application File menu. The item checks for updates while idle, downloads an available update, or installs a downloaded update and relaunches depending on updater state. The titlebar update CTA remains a state-based shortcut when an actionable update is already available or downloaded.

If a downloaded AppImage update does not apply after relaunch, kmux records the attempted version and shows a Linux-specific recovery hint on the next startup instead of using the macOS Squirrel recovery copy.

`npm run release:evidence:linux` must run on Ubuntu Desktop LTS with `DISPLAY` or `WAYLAND_DISPLAY` and Ubuntu/GNOME/Unity desktop session env; its `--allow-any-platform` flag is only for script-development output. Generated reports include a `Report mode` line and keep `Passing RC evidence: no` until manual Ubuntu Desktop/AppImage observations pass; script-development handoff commands keep `--allow-any-platform` in the generated command field. The command records the discovered AppImage, AppImage blockmap sidecar, Linux package artifact files such as `.deb`, `.rpm`, `.snap`, and `.flatpak`, Linux update metadata filename/path/file-entry/actual-checksum/size consistency, packaging and publishing configuration facts including `package:linux`, `dist:linux --publish never`, electron-builder publish provider, Linux target, and artifact naming, runtime and packaged identity alignment facts, release workflow public-gate facts including gate-before-publish and Linux public-upload detection, extracted desktop-entry identity, installed `kmux.desktop` candidate identity fields, DBus/session desktop-integration environment, DBus notification service owner/server probes, desktop shell/display and GPU renderer probes, GNOME number-row keybinding probes when GNOME or Ubuntu desktop env is detected, X11 window-manager root properties where `DISPLAY` is available, Wayland display info when `WAYLAND_DISPLAY` is available, OpenGL renderer info, Vulkan device summary, packaged notification icon resource, AppImage extraction/sandbox environment, Linux user-namespace settings, Linux inotify watch limits, IME env plus `ibus`/`fcitx` command probes, agent CLI command and alias availability, shell/PATH context for `nvm`, `pyenv`, cargo, and `~/.local/bin` comparison, shallow agent storage root existence/counts, `script` command availability, `ps` process-table samples, bounded `lsof` listening-socket samples, distro identity, and git dirty state when those facts are present. GNOME shell/settings probes are recorded only when the session environment identifies GNOME or Ubuntu desktop; otherwise they are explicitly skipped. Use that report as ledger input, not as a substitute for the manual AppImage startup/sandbox, successful desktop notification/window grouping observations, native chrome/compositor, shortcut, filesystem watch/resync, agent workflow, output continuity, or updater check/download/install evidence.

## Paths

Linux uses XDG-style paths:

- config: `XDG_CONFIG_HOME` or `$HOME/.config/kmux`
- runtime socket: `XDG_RUNTIME_DIR`, a safe `/run/user/${uid}`, or a private temporary fallback
- state: `XDG_STATE_HOME` or `$HOME/.local/state/kmux`
- data: `XDG_DATA_HOME` or `$HOME/.local/share/kmux`
- cache: `XDG_CACHE_HOME` or `$HOME/.cache/kmux`

`KMUX_CONFIG_DIR`, `KMUX_RUNTIME_DIR`, `KMUX_STATE_DIR`, `KMUX_DATA_DIR`, and `KMUX_CACHE_DIR` override their individual roots. `KMUX_RUNTIME_DIR` is only for volatile socket/runtime data; it is not a state, data, capture, attachment, raw-output, or native-cache root.

## Agent Credentials And Unavailable States

kmux reads local agent storage roots for usage, external sessions, hooks, and metadata. On Linux, macOS-only `security` keychain calls must not run.

When credentials are missing or a provider's Linux credential source is not verified, kmux should show a normal disconnected or unavailable state instead of a platform error. Antigravity subscription usage is allowed to remain unavailable on Linux until a stable credential source is verified, while hooks, local sessions, transcript usage, terminal workflows, and notifications remain in release scope.

## Unsupported Environments

The Linux phase does not support:

- headless-only Linux or server deployments
- WSL-only operation
- Windows
- Flatpak or Snap packaging
- deb/rpm packaging
- custom frameless Linux chrome as the default

Fedora Workstation and other Linux desktops are follow-up validation targets after Ubuntu Desktop LTS passes the stable RC gate.
