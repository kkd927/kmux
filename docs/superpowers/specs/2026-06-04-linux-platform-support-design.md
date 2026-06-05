# Linux Platform Support and OS-Neutral Architecture Design

## Purpose

kmux should support Linux desktop environments while preserving the current macOS experience and keeping the codebase ready for future Windows work. The implementation should not scatter `process.platform` checks through terminal, pane, restore, rendering, or agent workflow code. Platform-specific behavior should live behind explicit boundaries so agent output continuity remains the primary product requirement.

The first supported Linux target is GUI desktop Linux, not headless Linux. Ubuntu Desktop LTS is the baseline validation target. Fedora Workstation and other desktop distributions can be treated as follow-up validation targets.

## Goals

- Keep macOS behavior stable.
- Add experimental Linux desktop support.
- Move macOS-biased shell, path, IPC, hook, credential, opener, updater, native module, desktop identity, keyboard, font, and packaging decisions into explicit boundaries.
- Share POSIX behavior between macOS and Linux where it is genuinely common.
- Keep Windows unsupported in this phase while reserving a bounded extension point for later named pipe, shell, and hook work.
- Protect kmux's core product requirement: agent terminal output must remain stable and continuous while users switch surfaces, split panes, restore sessions, and run multiple agents.
- Keep agent notifications working as a first-class Linux requirement, not a follow-up polish item.

## Non-Goals

- No Windows release in this phase.
- No headless Linux/server support.
- No WSL-only support.
- No Linux auto-update support in the initial release.
- No Linux secret-store integration beyond verified file-based fallbacks.
- No `KMUX_IPC_ENDPOINT` env/wire migration in the initial Linux phase unless Windows work starts. Linux and macOS both use Unix sockets, so the existing POSIX wire contract can stay `KMUX_SOCKET_PATH` for now.
- No attempt to force macOS-only UX concepts, such as Dock reopen behavior or notarization, into Linux.

## Recommended Approach

Use a POSIX common layer plus per-platform composition, but validate the riskiest Linux facts before doing the broad refactor.

This is more maintainable than adding Linux conditionals directly into existing modules, and less heavy than a fully plugin-like platform system. macOS and Linux share Unix sockets, POSIX shell quoting, executable permission checks, and many filesystem conventions. Windows differs enough that this phase should stop at clear unsupported handling and a reserved IPC shape.

The platform model must account for kmux's multiprocess architecture. A single object with methods is not sufficient because renderer IPC, forked pty-host IPC, and socket JSON-RPC can only move serializable data. The design therefore separates:

- shared, serializable contracts.
- desktop-only serializable launch/display policies.
- main-process services with behavior.

However, the order matters. Before a large no-behavior-change refactor, run a small Linux spike that proves the facts most likely to change the architecture:

- Electron opens a normal Ubuntu Desktop window.
- `node-pty` can spawn a shell in dev mode.
- packaged AppImage can load the `node-pty` native module and spawn a shell.
- native window chrome works on Ubuntu Desktop; custom frameless chrome is tested separately on X11 and Wayland.
- a kmux-owned session can run a common agent CLI from a GUI-launched app.

The spike can be throwaway. Its job is to prevent building abstractions around unverified AppImage, native module, and desktop environment assumptions.

## Architecture

Do not put shared process/package contracts under `apps/desktop/src/main/platform/`. Anything that crosses a process boundary or package boundary must live outside main-only modules.

Recommended layout:

```text
packages/proto/src/
  index.ts                 # existing cross-process contracts; keep ShellIdentity.socketPath for Linux phase

apps/desktop/src/shared/platform/
  shellLaunchPolicy.ts     # desktop-only serializable pty-host launch policy
  ipcEndpoint.ts           # pure POSIX endpoint helpers for desktop/CLI/tests
  env.ts                   # pure env helpers for desktop processes
  keyboardPolicy.ts        # renderer-safe shortcut policy builders
  rendererPlatform.ts      # renderer-safe desktop capability descriptor

apps/desktop/src/main/platform/
  runtime.ts               # thin composition root only
  posix.ts                 # shared POSIX factories/helpers
  darwin.ts
  linux.ts
```

Cross-package helpers used by both `packages/cli` and desktop should live in `@kmux/proto` or another small shared package only when they are actual package contracts. Desktop-only helpers used by main, renderer preload, pty-host, and tests can live in `apps/desktop/src/shared/platform`.

Windows does not need a full adapter file in this phase. The main composition root should reject unsupported platforms with a clear message. Shared contracts can reserve Windows-oriented shapes, such as named pipe IPC, but Linux should not pay the env/wire migration cost before Windows can validate it.

`posix.ts` exports helpers and factories. `darwin.ts` and `linux.ts` compose those helpers with object spread or factory calls. Avoid class inheritance; platform behavior should be assembled from named pieces so overrides are visible and testable.

### Shared Contracts

`@kmux/proto` should own contracts that cross package or process boundaries. For Linux phase, keep the existing POSIX socket wire contract and introduce endpoint types primarily as desktop shared helpers. Do not add a new exported `platform.ts` file just to host a Windows-shaped union before anything consumes it across a real boundary.

```ts
// apps/desktop/src/shared/platform/ipcEndpoint.ts
export type IpcEndpoint =
  | { kind: "unix-socket"; path: string }
  | { kind: "named-pipe"; path: string };

// packages/proto/src/index.ts
export interface ShellIdentity {
  socketPath: string; // POSIX wire contract for macOS/Linux phase
  socketMode: SocketMode;
  windowId: Id;
  activeWorkspaceId: Id;
  activeSurfaceId: Id;
  capabilities: string[];
}

// apps/desktop/src/shared/platform/keyboardPolicy.ts
export interface PlatformKeyboardPolicy {
  shortcuts: Partial<Record<ShortcutCommandId, KeyChord>>;
  reservedSystemChords: KeyChord[];
  labelStyle: "mac-symbols" | "text";
}

// apps/desktop/src/shared/platform/rendererPlatform.ts
export interface RendererPlatformDescriptor {
  windowChrome: "native" | "custom";
  shortcutStyle: "mac-symbols" | "text";
  keyboard: PlatformKeyboardPolicy;
  desktop: {
    supportsDock: boolean;
    supportsTray: boolean;
    keepProcessAliveWhenLastWindowCloses: boolean;
  };
}
```

Consumers should not receive `platformId` as a reason to branch again. The producer can use `process.platform` or a main-process platform runtime to build the descriptor, but renderer and pty-host should consume concrete capability and policy values.

`IpcEndpoint` is still useful internally because it documents the future Windows boundary. Initial Linux work should not add `KMUX_IPC_ENDPOINT`, dual env parsing, or `ShellIdentity.ipcEndpoint` unless the Windows implementation begins. `KMUX_SOCKET_PATH` remains the tested POSIX wire/env contract for macOS and Linux. If the CLI needs shared default socket resolution during Linux work, export the narrow POSIX resolver it actually needs rather than a named-pipe-capable wire contract.

### Main Platform Runtime

The main process should have a thin `PlatformRuntime` composition root. It should not become a large object that every module imports or mocks.

```ts
interface PlatformRuntime {
  descriptor: MainPlatformDescriptor;
  paths: PlatformPathService;
  ipc: PlatformIpcService;
  shell: PlatformShellService;
  desktop: PlatformDesktopService;
  agentStorage: AgentStorageService;
}
```

The high-value services are `paths`, `ipc`, `shell`, and `agentStorage`. Lower-churn concerns such as updater enablement, opener behavior, and credential loading can be plain functions that receive the small platform/capability values they need. Do not force every test or module to depend on a broad runtime object.

Each service should be process-local. Service functions are never sent over IPC. The pty-host should receive serializable launch data instead of importing main services.

```ts
interface ShellLaunchPolicy {
  defaultShellPath: string;
  defaultShellArgs: string[];
  stripManagedEnv: boolean;
  integration: {
    enabled: boolean;
    mode: "none" | "posix-wrapper";
  };
  agentPath: {
    helperBinDir: string;
    wrapperBinDir: string;
    prependWrapperToPath: boolean;
  };
  hookEnv: Record<string, string>;
}
```

`ShellLaunchPolicy` must be self-contained. pty-host should not ask "am I on Linux?" or fall back to `/bin/zsh` internally. It should consume resolved shell path, args, env stripping, integration mode, and agent PATH policy. Session-specific data such as cwd, user env overrides, terminal size, pane/surface/session ids, and initial input remains in the session launch spec.

## Platform Areas

### Paths and IPC

Replace raw socket path construction with central POSIX endpoint resolution, but keep the Linux phase wire/env contract as `KMUX_SOCKET_PATH`.

Path rules:

- `KMUX_CONFIG_DIR` always overrides config location.
- `KMUX_RUNTIME_DIR` overrides volatile runtime location only. It must not become the data/state root.
- `KMUX_CACHE_DIR` overrides cache/native extraction location only.
- macOS keeps the current config default, `$HOME/.config/kmux`, to preserve behavior.
- Linux uses `$XDG_CONFIG_HOME/kmux` when `XDG_CONFIG_HOME` is set, otherwise `$HOME/.config/kmux`.
- macOS keeps the current runtime default, `$HOME/.kmux`, to preserve behavior until a separate macOS migration is chosen.
- Linux uses `$XDG_RUNTIME_DIR/kmux` when `XDG_RUNTIME_DIR` is set, otherwise a deterministic private fallback.
- Runtime directories that contain sockets must be created with `0700` permissions where the filesystem honors POSIX modes.
- Sockets must live in runtime storage, not config/state/data storage.
- Capture, attachment, shell-env cache, snapshots, usage history, native module extraction cache, and other non-socket data must not be placed under Linux `XDG_RUNTIME_DIR`.

Linux storage separation:

- Socket: `$XDG_RUNTIME_DIR/kmux/control.sock`, or a private deterministic fallback when `XDG_RUNTIME_DIR` is absent.
- Config: `$XDG_CONFIG_HOME/kmux` or `$HOME/.config/kmux`.
- State: `$XDG_STATE_HOME/kmux` or `$HOME/.local/state/kmux` for snapshots, usage history, shell env cache, diagnostics, and other app state.
- Data: `$XDG_DATA_HOME/kmux` or `$HOME/.local/share/kmux` for persistent user-facing artifacts if retention expectations require it.
- Cache: `$XDG_CACHE_HOME/kmux` or `$HOME/.cache/kmux` for native module extraction and other rebuildable caches.

The current macOS implementation can continue using existing locations during the no-behavior-change refactor. Linux should not put capture/attachment directories under `dirname(socketPath)`.

IPC migration policy:

- Initial Linux phase: keep `KMUX_SOCKET_PATH` for CLI, hook scripts, generated snippets, and `ShellIdentity`.
- Centralize default socket path resolution so CLI and desktop do not duplicate `$HOME/.kmux/control.sock`.
- Introduce `IpcEndpoint` internally where it simplifies resolver/testing code.
- Defer `KMUX_IPC_ENDPOINT`, `ShellIdentity.ipcEndpoint`, and dual read/write env migration to the Windows phase, when named pipe behavior can be validated.

Unix socket paths need a length guard. If a computed default socket path is too long for common `sun_path` limits, the platform path resolver should choose a deterministic shorter runtime socket path, preferably under `$XDG_RUNTIME_DIR` on Linux or a hashed directory under `tmpdir()` when no safe runtime root exists. If an explicit `KMUX_RUNTIME_DIR` produces a too-long socket path, startup should fail with a specific error instead of silently using a different directory.

Socket robustness is a platform-neutral bug fix, not a Linux-only feature. Two mechanisms are required and they solve different problems:

- `app.requestSingleInstanceLock()` prevents two GUI instances from racing for the same runtime and can hand the second launch to the first instance.
- connect-first socket startup handles stale socket files after crashes. The server should first try to connect to the existing endpoint. If a live kmux instance responds, startup should stop or hand focus to the existing instance. Only `ENOENT`, `ECONNREFUSED`, or equivalent stale-socket cases should allow unlink and listen.

### Shell and PTY

`platform.shell` owns:

- default shell path.
- shell environment probe strategy.
- default shell args.
- shell-managed env stripping policy.
- shell integration support.
- session env requirements for agent hooks.
- agent PATH prepend policy.

macOS keeps the current login-shell-oriented behavior. Linux defaults to bash and must be validated from a GUI launcher, not only from an inherited terminal environment.

Linux should start with the existing direct shell invocation probe using login-interactive args for bash. The design must treat this as a validation target, not as a proven guarantee. If Ubuntu Desktop smoke testing shows that GUI-launched kmux does not recover PATH entries for nvm, pyenv, cargo, `~/.local/bin`, or installed agent CLIs, Linux should move to a PTY-backed probe or another verified strategy.

The pty-host process must consume only serializable launch data. It should not import main platform services, Electron APIs, or non-serializable method objects.

### Shell Integration and Agent Hooks

Agent hook availability is a Linux release blocker. kmux's value depends on reliable multi-agent workflows, and Linux support should not silently drop Claude, Gemini, Codex, or Antigravity notifications.

Current hook commands for Claude and Gemini require a usable socket path and `KMUX_AGENT_BIN_DIR`. On Linux, helpers may be installed but hooks still no-op if session env does not expose those values. The platform shell service must ensure every kmux-owned session launch receives the hook runtime env:

- `KMUX_SOCKET_PATH`.
- `KMUX_AGENT_BIN_DIR`.
- `KMUX_NODE_PATH`.
- agent/workspace/pane/surface/session identity env already used by hooks.

`KMUX_AGENT_BIN_DIR` remains the hook helper location expected by existing hook scripts. The PATH-prepended wrapper location can be the same directory or a separate `wrapperBinDir`, but the launch policy must state it explicitly so Codex wrapper behavior is not accidentally tied to shell rc integration.

Hook helper installation, agent wrapper installation, agent PATH injection, and shell rc integration are separate concerns:

- Hook helper installation writes `kmux-agent-hook` and its runner into a stable bin dir.
- Agent wrapper installation writes executable wrappers such as `codex` into a stable wrapper bin dir. The current code writes the `codex` wrapper only inside shell integration wrapper dirs; Linux support must move or duplicate that wrapper into the stable agent wrapper dir if shell rc wrapping remains disabled.
- Agent PATH injection puts the stable wrapper bin dir at the front of session `PATH` so wrappers such as `codex` are found.
- Shell rc integration handles OSC7/cwd tracking and shell-specific startup-file wrapping.

Linux can enable agent PATH injection without enabling shell rc wrapping. This is important because Codex notification forcing currently depends on the `codex` wrapper being ahead of the real `codex` on `PATH`, while OSC7/cwd rc hooks can remain disabled until Ubuntu Desktop validation proves they are safe.

macOS may still need shell rc PATH prepend after `path_helper` or login shell startup reorders `PATH`. Linux can initially prepend `KMUX_AGENT_BIN_DIR` directly in the pty launch env and validate that the shell does not undo it for bash/zsh/fish.

Hook builders should be robust even when env propagation is incomplete:

- Claude and Gemini hook builders should accept runtime paths and bake Antigravity-style fallbacks for `KMUX_SOCKET_PATH` and `KMUX_AGENT_BIN_DIR`.
- Session env values still win, so moved runtime dirs can override installed defaults.
- Managed hook installers should prune and rewrite kmux-managed commands so fallback path changes self-heal on startup.
- Antigravity already follows this pattern and should remain the reference implementation.

For Linux, POSIX shell integration for zsh, bash, and fish should be enabled only after tests show the existing wrappers are safe on Ubuntu Desktop. If that is too risky for the first Linux build, the minimum acceptable Linux behavior is:

- install hook helpers and agent wrappers.
- pass hook runtime env into every pty session.
- prepend the agent wrapper bin dir to pty session `PATH`.
- bake runtime path fallbacks into Claude/Gemini/Antigravity hook commands.
- keep hook commands POSIX-compatible.
- leave OSC7/cwd shell rc wrapping disabled until validated.

### Agent Storage Roots

Do not guess that agent CLIs use XDG paths. Today the code reads vendor-specific roots such as:

- `~/.codex/sessions`
- `~/.claude/projects`
- `~/.claude/settings.json`
- `~/.gemini/tmp`
- `~/.gemini/settings.json`
- `~/.gemini/config/hooks.json`
- `~/.gemini/antigravity-cli`

Linux support should introduce `AgentStorageRoots` as a central resolver, but the initial Linux values should remain the vendor defaults until verified otherwise. This creates one place to adjust paths later without prematurely XDG-ifying third-party tool storage.

The resolver is only useful if its output is propagated. These areas should receive `AgentStorageRoots` instead of rebuilding hard-coded home-relative paths:

- `createUsageAdapters` and metadata usage readers.
- `createExternalSessionIndexer` and external session scanners.
- Claude, Gemini, Antigravity, and Codex hook installers.
- subscription usage credential/session readers.
- agent metadata readers that inspect vendor project, temp, or config directories.

### Credentials

Credential loading is a platform capability.

macOS can use Keychain through `security find-generic-password` and keep existing file fallbacks. Linux should initially use verified file-based credential paths only. Do not add libsecret until the actual Linux storage behavior of the target agents is confirmed.

Credential service behavior:

- Claude: try file fallback such as `~/.claude/.credentials.json` on Linux.
- Antigravity: verify whether Linux stores credentials in files, keyring, or another location before claiming subscription tracking support.
- Missing credentials should degrade subscription usage rows, not break terminal/session features.

### Native Module Loading

`node-pty` native module loading is both packaging and runtime behavior. Linux support must verify the packaged AppImage path, `app.asar.unpacked`, native `.node` file location, helper permissions where applicable, and `prebuilds/${platform}-${arch}` lookup.

Do this before the broad refactor in a Linux spike. If AppImage native loading fails, the result can change how `nodePtyLoader`, packaging config, and runtime paths should be abstracted.

The macOS `spawn-helper` chmod script intentionally exits on non-darwin. Do not "fix" that for Linux. The Linux risk is the native `.node` binary and ABI/glibc compatibility, not a macOS spawn-helper permission bit.

If Linux needs native module extraction outside the packaged AppImage mount, use the platform cache path, not the socket runtime directory. Native extraction is rebuildable cache data and should be versioned by package version, platform, arch, and ABI.

Direct `process.platform` and `process.arch` usage is allowed in native module and prebuild selection code because those values describe the physical runtime being loaded. This is an explicit exception to the general rule against spreading platform checks.

### Opener

Settings file opening should be platform-aware, but it does not need to be a broad runtime service.

macOS can keep the current `open -t` preference before falling back to Electron `shell.openPath()`. Linux should use Electron `shell.openPath()` as the initial cross-platform default. If user expectations require editor-specific behavior later, the Linux opener function can add `$VISUAL`, `$EDITOR`, or `xdg-open` policy in one place.

### Desktop Behavior

Desktop behavior should be capability-driven, not forced into one shared UX.

```ts
interface PlatformDesktopService {
  rendererDescriptor: RendererPlatformDescriptor;
  keepProcessAliveWhenLastWindowCloses: boolean;
  supportsDock: boolean;
  supportsTray: boolean;
}
```

macOS uses hidden inset titlebar, Dock behavior, symbolic shortcut labels, and keeps the process alive after the last window closes.

Linux should not assume custom frameless chrome is safe as the initial default. Wayland and GNOME can make frameless drag, resize, and window controls fragile. Linux should start with `windowChrome: "native"` unless Ubuntu Desktop smoke testing proves the existing custom frameless path is stable. If product requirements need custom chrome later, gate it behind the descriptor and test X11 and Wayland separately.

Renderer platform behavior should come from `RendererPlatformDescriptor` delivered through bootstrap IPC or `identify()`, not from `navigator.userAgent` sniffing. This descriptor must cover behavior as well as display. Shortcut labels and shortcut execution should derive from keyboard policy, not from an `isMac` boolean.

### Linux Notifications and Desktop Identity

Linux desktop notifications, app identity, and packaging are connected. Agent notifications are a core kmux feature, so this needs a dedicated Linux validation item rather than a generic risk note.

Linux packaging should verify:

- `.desktop` file name, icon, display name, and category.
- `StartupWMClass` or equivalent WM class matching Electron's window identity.
- app id consistency between Electron, desktop file, notifications, and window grouping.
- AppImage behavior before and after desktop integration.
- notification title/body/icon attribution under Ubuntu Desktop.
- Wayland and X11 behavior where feasible.

On Windows, `app.setAppUserModelId()` will matter later. It should not drive the Linux phase, but the desktop identity design should keep app id handling centralized.

### Keyboard Policy

Linux keyboard support is not a simple Cmd-to-Ctrl substitution. macOS `Cmd` is mostly free for app shortcuts; Linux `Super` is often owned by the window manager and `Ctrl` conflicts with terminal control sequences.

The renderer should consume a keyboard policy that declares actual key chords for the full shortcut catalog, not a broad `primaryModifier` that every consumer interprets independently. Linux needs an explicit UX decision for every command in `DEFAULT_SHORTCUTS`: workspace, pane, surface, command palette, notifications, usage dashboard, settings, terminal search, terminal copy/paste, and copy mode. Candidate strategies include `Alt`-based chords, `Ctrl+Shift` chords, or a leader-key style. The chosen policy must be tested against terminal input and common GNOME shortcuts.

The platform keyboard policy should generate the default shortcut map used by settings, labels, global shortcut handling, terminal shortcut handling, and native context menu accelerators. It should not only provide display labels or a few representative shortcuts.

### Terminal Font and Metrics

Terminal output continuity depends on stable xterm.js cell metrics. Linux support must verify the terminal font stack, not just the app shell.

The renderer should keep a platform-neutral preferred stack when bundled fonts are available, and Linux smoke should verify:

- the intended terminal font actually loads.
- fallback fonts are monospace.
- cell width/height measurements remain stable after first render.
- restore, split panes, and foreground resize do not reflow agent output unexpectedly.

### Updater

Updater enablement should be a small platform-aware function.

macOS remains enabled only when packaged and not under test. Linux starts disabled. This avoids pretending GitHub release update metadata is ready for Linux before Linux packaging and release policy are proven.

### Packaging

Keep macOS signing and notarization in macOS-only builder configuration. Add Linux targets without sharing macOS artifact hooks.

Initial Linux target:

- AppImage

Follow-up target:

- deb package

The build scripts should become explicit:

- `package:mac`
- `package:linux`
- `release:check:mac`
- `release:check:linux`

## Data Flow

Startup flow:

1. main process creates a thin platform runtime and capability descriptors.
2. startup exits with a clear unsupported message if no supported runtime exists for the current platform.
3. paths and POSIX socket endpoint are resolved from platform path/IPC helpers.
4. shell environment is resolved using platform shell policy.
5. agent hook helpers are installed independently of shell integration.
6. agent hook commands are installed into vendor settings using platform hook builders, runtime path fallbacks, and `AgentStorageRoots`.
7. socket server claims the POSIX socket after single-instance and stale-socket checks.
8. pty-host receives only `ShellLaunchPolicy`, session specs, and env values, never service functions.
9. renderer receives only `RendererPlatformDescriptor`, not the full platform runtime.

CLI flow:

1. CLI reads `KMUX_SOCKET_PATH`.
2. CLI resolves the same centralized POSIX default if no env endpoint is present.
3. CLI connects to Unix socket on POSIX.
4. Windows named pipe support is not implemented in this phase.

Terminal spawn flow:

1. runtime creates a session launch spec and `ShellLaunchPolicy`.
2. pty-host resolves shell path, args, env stripping, integration policy, hook env, and agent PATH prepend from serializable launch data.
3. hook runtime env is present before spawning the pty.
4. `node-pty` spawns the prepared launch.
5. terminal snapshot, hydration, resize, font metrics, and output batching logic remains platform-neutral.

## Error Handling

- Unsupported platform startup should produce a clear user-facing and log-visible message.
- Linux packaging failures should not affect macOS packaging.
- Missing shell or failed shell env probe should fall back to sanitized inherited env, matching the current defensive behavior.
- Missing agent CLIs should mark external sessions as unavailable rather than failing indexing.
- Missing credentials should degrade subscription usage tracking, not terminal behavior.
- Socket startup should distinguish second live GUI instance, live socket owner, stale socket, bind failure, and explicit runtime path length failure.
- Linux updater should report disabled, not error.
- Missing Linux notification support should degrade desktop notification delivery but should not break in-app agent event records.

## Testing Strategy

Unit tests:

- centralized POSIX socket path resolver and `KMUX_SOCKET_PATH` default behavior.
- renderer display and full shortcut keyboard descriptor formatting, including coverage for every command in `DEFAULT_SHORTCUTS`.
- main runtime composition for macOS and Linux.
- POSIX path defaults, including `XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, explicit env overrides, and `0700` runtime dir creation.
- runtime/state/data/cache separation so captures, attachments, and native caches do not live under Linux socket runtime dir.
- Unix socket endpoint generation and length guard.
- stale socket handling and live socket refusal.
- macOS and Linux shell defaults.
- Linux updater disabled.
- POSIX hook command generation with runtime path fallbacks.
- hook helper installation independent of shell integration.
- agent wrapper installation independent of shell integration.
- agent PATH prepend independent of OSC7/cwd shell rc integration.
- unsupported platform startup behavior.

Integration tests:

- CLI and socket server use the same POSIX socket resolver.
- shell environment resolution works for Linux-style bash defaults.
- pty-host launch uses `ShellLaunchPolicy` instead of hard-coded `/bin/zsh`.
- hook runtime env is present in spawned session specs.
- Claude/Gemini hook commands work with baked fallback paths when session env is missing.
- Codex wrapper is installed in the stable wrapper bin dir and reachable through pty launch PATH prepend even when shell rc integration is disabled.
- agent storage roots are passed into usage adapters, external session indexing, hook installers, and subscription usage readers.
- settings opener goes through platform-aware opener function.
- credential loading falls back cleanly on Linux.
- renderer shortcut behavior follows keyboard policy instead of userAgent-derived `isMac`.

E2E and smoke tests:

- keep existing macOS smoke/release checks.
- run an early Linux spike before the broad refactor.
- add Linux dev smoke where Electron can launch in CI or local desktop environment.
- add Linux packaged smoke for AppImage when CI environment supports it.
- test Ubuntu Desktop launch from GUI-like env, not only an interactive terminal.
- test AppImage `node-pty` native module loading and shell spawn.
- test Linux native window frame first; test custom frameless chrome separately on X11 and Wayland before enabling it by default.
- verify PATH recovery and agent wrapper discovery for common agent install locations.
- verify Linux desktop notification identity, icon/app name, and window grouping.
- verify terminal font loading and xterm.js cell metrics.
- preserve current terminal restore, split pane, surface switching, and output continuity regressions.

Manual validation:

- Ubuntu Desktop LTS.
- launch app from terminal and desktop launcher.
- create workspace.
- spawn shell.
- run Codex/Claude/Gemini where installed.
- verify agent hook notifications for Claude/Gemini/Codex/Antigravity where supported.
- verify Codex wrapper behavior with shell rc integration disabled.
- split panes.
- switch workspaces and surfaces.
- restore session.
- verify external sessions panel.
- verify CLI hook/socket communication.
- verify desktop notifications and `.desktop` identity.

## Migration Plan

1. Linux spike before broad refactor:
   - build a minimal Linux target or local dev launch.
   - prove Electron window launch on Ubuntu Desktop.
   - prove `node-pty` shell spawn in dev.
   - prove AppImage native module loading and shell spawn, or capture the exact failure.
   - test native window frame before custom frameless chrome.
2. Platform-neutral socket robustness:
   - add `app.requestSingleInstanceLock()`.
   - change socket startup to connect-first before unlink.
   - keep this as a macOS bug fix, not a Linux-only change.
3. No-behavior-change macOS refactor:
   - add desktop-only serializable launch/display helpers under `apps/desktop/src/shared/platform`.
   - add thin main platform composition.
   - keep existing `KMUX_SOCKET_PATH` wire/env behavior.
   - keep existing macOS tests green.
   - add characterization tests around shell env, paths, hooks, opener, updater, socket behavior, and terminal output continuity.
4. Move app paths and POSIX socket resolution into platform path/IPC helpers:
   - centralize CLI/desktop socket defaults.
   - add socket path length guard.
   - add Linux runtime/state/data/cache separation.
5. Move shell defaults, shell probe policy, hook runtime env construction, agent PATH prepend, and `ShellLaunchPolicy` into platform shell code.
6. Update pty-host to consume serializable shell launch data instead of hard-coded platform fallbacks.
7. Separate hook helper installation, agent wrapper installation, agent PATH injection, and OSC7/cwd shell rc integration.
8. Add Antigravity-style runtime path fallback baking to Claude and Gemini hook builders.
9. Introduce `AgentStorageRoots` and pass it into usage adapters, external session indexers, hook installers, subscription usage, and agent metadata readers.
10. Add credential and settings opener functions where platform behavior is needed.
11. Update renderer to consume `RendererPlatformDescriptor`, including concrete keyboard policy, instead of userAgent sniffing.
12. Add Linux desktop identity, notification, native window chrome, keyboard, and font validation.
13. Add Linux runtime composition and Linux package target.
14. Validate Linux shell env recovery, `node-pty` packaging, hooks, socket/CLI, desktop notifications, native window chrome, keyboard shortcuts, font metrics, and terminal output continuity.
15. Add Linux docs describing macOS stable and Linux experimental support.
16. Keep Windows unsupported with explicit startup handling and documented implementation requirements. Defer `KMUX_IPC_ENDPOINT`, `ShellIdentity.ipcEndpoint`, and named pipe wire migration until this phase.

## Success Criteria

- Existing macOS tests pass.
- macOS package and packaged smoke remain valid.
- Linux spike verifies or falsifies AppImage `node-pty` shell spawn before the broad refactor depends on it.
- The no-behavior-change refactor can be reviewed separately from Linux enablement.
- Shared contracts that cross package or process boundaries live in `@kmux/proto` or desktop shared modules, not in main-only platform modules.
- Linux phase keeps `KMUX_SOCKET_PATH` as the POSIX wire/env contract and centralizes its resolver.
- Linux app can be built and launched on Ubuntu Desktop.
- Linux can spawn a shell through `node-pty` in dev and packaged AppImage.
- pty-host receives serializable shell launch policy and has no hard-coded `/bin/zsh` platform fallback.
- Linux terminal output remains stable through pane splitting, surface switching, restore, font loading, and foreground resize.
- Linux CLI/socket communication works.
- Claude, Gemini, and Codex notification paths work on Linux experimental builds.
- Any unsupported agent notification path, including Antigravity if the Linux agent behavior is unavailable or unverified, is an explicit product decision with documented/in-app degradation rather than a silent fallback.
- Claude/Gemini hooks work through baked runtime path fallbacks even when shell env propagation is incomplete.
- Codex wrapper is installed outside shell rc wrapper dirs and can be found through agent PATH injection without requiring OSC7/cwd shell rc integration.
- Linux path resolution honors `XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME`.
- Runtime socket directories use private permissions where supported.
- Capture/attachment/state/cache data does not live under Linux `XDG_RUNTIME_DIR`.
- Socket startup does not steal a live socket from another kmux instance.
- Renderer platform behavior and shortcut behavior do not depend on `navigator.userAgent`.
- Linux default shortcuts cover the full shortcut catalog and are intentionally chosen/tested against terminal input and GNOME defaults.
- Linux desktop notifications show the correct app name/icon and group with the correct window identity.
- Linux window chrome is selected through `windowChrome` capability and validated before custom frameless mode becomes default.
- Platform service functions do not cross IPC boundaries.
- Platform-specific conditionals are concentrated in platform modules, except for physical native module/prebuild selection and narrow renderer fallbacks during bootstrap failure.
- Windows support is not implemented, but future Windows work has a bounded IPC and service surface.

## Risks

- `node-pty` packaging may need Linux-specific rebuild or native module handling.
- AppImage native module behavior may differ from macOS `.app/app.asar.unpacked` assumptions.
- Linux Electron behavior differs between X11 and Wayland.
- AppImage packaging may need extra desktop integration work.
- Linux notifications, `.desktop` identity, and window grouping may vary by desktop environment.
- Linux GUI launch may not recover user shell PATH with the direct shell env probe.
- Agent CLI storage paths and hook schemas may differ on Linux installations and need validation.
- Antigravity or Claude subscription credentials may not have a file fallback on Linux.
- Linux shortcut choices may conflict with terminal control sequences or window-manager shortcuts.
- Linux font fallback may change xterm.js cell metrics and affect output continuity.
- Native module extraction cache paths may need cleanup/versioning policy to avoid stale ABI-specific cache entries.
- Over-abstracting too early could make simple macOS/Linux POSIX behavior harder to read.

The implementation should avoid broad abstractions that do not serve Linux support or future Windows isolation. The desired end state is not zero OS-specific code; it is OS-specific code that is easy to find, test, and replace. For this phase, the best architecture is capability/policy-driven inside the app, conservative on wire/env migration, and grounded by early Linux packaging and agent-notification validation.
