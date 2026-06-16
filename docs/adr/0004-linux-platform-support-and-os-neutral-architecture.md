# 0004: Linux Platform Support and OS-Neutral Architecture

## Status

Proposed

## Purpose

kmux should support Linux desktop environments while preserving the current macOS experience and keeping the codebase ready for future Windows work. The implementation should not scatter `process.platform` checks through terminal, pane, restore, rendering, or agent workflow code. Platform-specific behavior should live behind explicit boundaries so agent output continuity remains the primary product requirement.

The first supported Linux target is GUI desktop Linux, not headless Linux. Ubuntu Desktop LTS is the baseline validation target. Fedora Workstation and other desktop distributions can be treated as follow-up validation targets.

## Decision Summary

- Linux initial target is packaged GUI desktop Linux, validated first on Ubuntu Desktop LTS.
- macOS behavior remains compatibility-preserving during the platform refactor.
- POSIX socket wire/env remains `KMUX_SOCKET_PATH` for the macOS/Linux phase.
- Platform behavior is composed in main, while renderer and pty-host receive only serializable policies and descriptors.
- pty-host protocol becomes desktop-owned; `packages/core` emits desktop-neutral spawn effects.
- Linux paths use XDG roots, with safe `/run/user/${uid}` and private `tmpdir()` fallbacks for runtime sockets.
- Subscription usage is required for providers with verified Linux credential sources; unverified provider quotas can show normal unavailable states.
- Linux stable publishing stays gated until packaged AppImage, updater, notification identity, hook, shell, socket, and output-continuity checks pass.

## Goals

- Keep macOS behavior stable.
- Add Linux desktop support for kmux's core workflows, not a reduced feature slice.
- Move macOS-biased shell, path, IPC, hook, credential, opener, updater, native module, desktop identity, keyboard, font, and packaging decisions into explicit boundaries.
- Share POSIX behavior between macOS and Linux where it is genuinely common.
- Keep Windows unsupported in this phase while reserving a bounded extension point for later named pipe, shell, and hook work.
- Protect kmux's core product requirement: agent terminal output must remain stable and continuous while users switch surfaces, split panes, restore sessions, and run multiple agents.
- Keep agent notifications working as a first-class Linux requirement, not a follow-up polish item.
- Keep Linux update, external session, and usage/subscription workflows in the required release scope.

## Non-Goals

- No Windows release in this phase.
- No headless Linux/server support.
- No WSL-only support.
- No `KMUX_IPC_ENDPOINT` env/wire migration in the initial Linux phase unless Windows work starts. Linux and macOS both use Unix sockets, so the existing POSIX wire contract can stay `KMUX_SOCKET_PATH` for now.
- No attempt to force macOS-only UX concepts, such as Dock reopen behavior or notarization, into Linux.

## Linux Support Baseline

Linux support is a feature-complete desktop target for kmux's main workflows. A feature may show a normal unavailable state when an agent CLI is not installed, the user is not authenticated, or a vendor API returns no data. That is different from platform-level degradation. Platform-level gaps in the required areas below are release blockers.

| Area                                                                    | Linux initial release requirement |
| ----------------------------------------------------------------------- | --------------------------------- |
| Shell spawn and pty sessions                                            | Required                          |
| CLI and socket control path                                             | Required                          |
| Terminal restore, split panes, surface switching, and output continuity | Required                          |
| Codex, Claude, Gemini, and Antigravity hook notifications               | Required                          |
| External agent session discovery and resume                             | Required                          |
| Usage history and verified subscription usage providers                 | Required                          |
| Desktop notifications and app identity                                  | Required                          |
| Linux packaged updater                                                  | Required                          |
| Windows named pipe, shell, hook, and updater behavior                   | Out of scope for this phase       |

In this document, "Linux initial release" means the public stable packaged Linux release. Internal/dev Linux builds may exist earlier with known gaps for spike work, but those gaps must not be described as acceptable stable-release behavior. The stable release gate is the baseline table above.

Subscription usage is required for providers whose Linux credential source has been verified during the Linux spike. If a vendor does not expose a stable Linux credential source, that provider's subscription quota can show the normal disconnected/unavailable state while terminal sessions, hooks, local usage history, external session discovery, and restore workflows remain release requirements.

Linux dev and internal packaged builds may be produced before the stable gate passes. Public stable Linux publishing remains disabled until the stable release candidate milestone passes.

The macOS compatibility baseline for this refactor is:

- existing macOS config/runtime path defaults remain unchanged.
- existing `KMUX_SOCKET_PATH` wire/env behavior remains unchanged.
- existing macOS shell env and login-shell behavior remain unchanged unless covered by an explicit compatibility-reviewed change.
- existing macOS hook installation, notification, and Codex wrapper behavior remain unchanged.
- existing macOS terminal restore, split pane, surface switching, and output continuity checks remain valid.

## Implementation Milestones

Separate the product release gate from implementation milestones. Linux can be enabled incrementally for development while the stable packaged release remains held to the required baseline above.

| Milestone                | Purpose                                             | Exit criteria                                                                                                                                                                                                                                   |
| ------------------------ | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux spike              | Prove unknown Linux facts before broad abstractions | Ubuntu Desktop window launch, dev `node-pty` shell spawn, AppImage native loading, shell PATH recovery strategy, credential/storage facts, hook env visibility, packaging sanity, and Linux subprocess audit are known                          |
| Walking skeleton         | Establish the minimum vertical slice                | Linux app launches, resolves shared CLI/desktop socket paths, claims socket safely, spawns pty sessions, injects hook runtime env, exposes renderer platform descriptor, and preserves terminal output through basic split/switch/restore flows |
| Agent workflow complete  | Bring kmux's main workflows to parity               | Codex, Claude, Gemini, and Antigravity hooks fire when installed; external session discovery/resume works; usage/subscription providers work for authenticated users; agent storage roots are verified                                          |
| Stable release candidate | Validate public Linux release quality               | packaged updater, desktop identity, notifications, font/rendering continuity, X11/Wayland smoke, updater metadata, docs, and macOS behavior-preserving checks all pass                                                                          |

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
- Linux credential and storage sources are known for Codex, Claude, Gemini, and Antigravity.
- Linux hook env is actually visible in pty sessions and hook notifications fire for the installed agents.
- Linux packaging config can build AppImage without invoking macOS signing/notarization artifact hooks.
- Linux subprocess assumptions are checked for subscription and metadata paths, including `security`, `script`, `lsof`, and `ps` behavior.

The spike can be throwaway. Its job is to prevent building abstractions around unverified AppImage, native module, and desktop environment assumptions.

## Architecture

Do not put shared process/package contracts under `apps/desktop/src/main/platform/`. Anything that crosses a process boundary or package boundary must live outside main-only modules.

Recommended layout:

```text
packages/proto/src/
  index.ts                 # app-wide cross-package contracts; keep ShellIdentity.socketPath for Linux phase

packages/persistence/src/
  index.ts                 # extend defaultAppPaths and shared POSIX socket defaults for desktop/CLI

packages/ui/src/
  index.ts                 # existing shortcut catalog; platform policy must cover the full catalog

apps/desktop/src/shared/
  ptyProtocol.ts           # desktop-only pty-host IPC and ShellLaunchPolicy

apps/desktop/src/shared/platform/
  env.ts                   # pure env helpers for desktop processes
  keyboardPolicy.ts        # renderer-safe shortcut policy builders
  rendererPlatform.ts      # renderer-safe desktop capability descriptor

apps/desktop/src/main/platform/
  runtime.ts               # thin composition root only
  posix.ts                 # shared POSIX factories/helpers
  darwin.ts
  linux.ts
```

Cross-package helpers used by both `packages/cli` and desktop should live in `@kmux/proto`, `@kmux/persistence`, or another small shared package only when they are actual package contracts. Desktop-only helpers used by main, renderer preload, pty-host, and tests can live in `apps/desktop/src/shared`.

Recommended decision for this phase:

- Extend `@kmux/persistence.defaultAppPaths()` instead of creating a new app-local path service. It already owns config/runtime defaults and should grow Linux XDG state/data/cache paths plus the shared POSIX socket default used by CLI and desktop.
- Treat pty-host IPC as desktop-internal protocol. Move pty-host request/event types and `ShellLaunchPolicy` toward `apps/desktop/src/shared/ptyProtocol.ts`, while letting `packages/core` emit a desktop-neutral session spawn effect that main maps into a pty-host spawn request.
- Keep shortcut policy tied to the existing `@kmux/ui` shortcut catalog. New `ShortcutCommandId` and `KeyChord` types are part of the policy work; they are not pre-existing proto contracts.

The pty protocol migration is an intentional architecture milestone, not an incidental Linux patch. Current ownership is split: `PtySessionSpec`, `PtyRequest`, and `PtyEvent` live in `@kmux/proto`, while `packages/core` currently constructs `PtySessionSpec` directly. The desired boundary is: core emits a desktop-neutral session spawn effect, main composes shell/path/runtime policy, and only then maps the effect into desktop-owned pty-host IPC.

Because this is a broad boundary change, it should be reviewed as its own behavior-preserving step with compatibility adapters where useful. The migration should first add characterization tests for the current spawn/resize/input/snapshot/notification protocol, then move the protocol types, then update core/main mapping, and only then remove the old direct construction path. Linux enablement can depend on the new boundary once those tests prove macOS behavior is unchanged.

Windows does not need a full adapter file in this phase. The main composition root should reject unsupported platforms with a clear message. Shared contracts can reserve Windows-oriented shapes, such as named pipe IPC, but Linux should not pay the env/wire migration cost before Windows can validate it.

`posix.ts` exports helpers and factories. `darwin.ts` and `linux.ts` compose those helpers with object spread or factory calls. Avoid class inheritance; platform behavior should be assembled from named pieces so overrides are visible and testable.

### Shared Contracts

`@kmux/proto` should own contracts that cross package boundaries and are not desktop implementation details. For Linux phase, keep the existing POSIX socket wire contract and introduce endpoint types only where they are consumed by a real boundary. Do not add a new exported `platform.ts` file just to host a Windows-shaped union before anything consumes it across a real boundary.

```ts
// internal helper shape, not a new Linux-phase wire contract
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

`IpcEndpoint` is still useful internally because it documents the future Windows boundary. Initial Linux work should not add `KMUX_IPC_ENDPOINT`, dual env parsing, or `ShellIdentity.ipcEndpoint` unless the Windows implementation begins. `KMUX_SOCKET_PATH` remains the tested POSIX wire/env contract for macOS and Linux. The CLI should import the narrow POSIX socket resolver from the shared path package instead of duplicating `$HOME/.kmux/control.sock` or importing desktop app modules.

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
  hookEnv: ShellLaunchHookEnv;
}

interface ShellLaunchHookEnv extends Record<string, string> {
  KMUX_SOCKET_PATH: string;
  KMUX_AGENT_BIN_DIR: string;
  KMUX_NODE_PATH: string;
}
```

`ShellLaunchPolicy` must be self-contained. pty-host should not ask "am I on Linux?" or fall back to `/bin/zsh` internally. It should consume resolved shell path, args, env stripping, integration mode, and agent PATH policy. Session-specific data such as cwd, user env overrides, terminal size, pane/surface/session ids, and initial input remains in the session launch spec.

`ShellLaunchPolicy` must also define env precedence so hook behavior does not depend on incidental object spread order. The recommended merge order is:

1. resolved base env from shell env recovery.
2. session launch env, user overrides, and session identity env for workspace, pane, surface, session, and agent context.
3. hook runtime env from `ShellLaunchPolicy.hookEnv`, including authoritative `KMUX_SOCKET_PATH`, `KMUX_NODE_PATH`, and `KMUX_AGENT_BIN_DIR`.
4. agent wrapper PATH prepend applied to the effective `PATH`.
5. shell integration env for the selected wrapper mode.

Session identity env must not be allowed to replace the hook runtime socket, helper-bin, or node-runtime values. Those values are owned by main's serialized launch policy so pty-host and hooks use the same socket and wrapper runtime even if launch or session env contains stale copies.

If shell integration needs to change `KMUX_AGENT_BIN_DIR` or `PATH`, that behavior must be represented in the serialized policy as `helperBinDir`, `wrapperBinDir`, and `prependWrapperToPath`; it should not be hidden in pty-host platform checks. Tests should cover the final env for macOS and Linux with shell integration both enabled and disabled.

## Platform Areas

### Paths and IPC

Replace raw socket path construction with central POSIX endpoint resolution, but keep the Linux phase wire/env contract as `KMUX_SOCKET_PATH`.

Path rules:

- `KMUX_CONFIG_DIR` always overrides config location.
- `KMUX_RUNTIME_DIR` overrides volatile runtime location only. It must not become the data/state root.
- `KMUX_CACHE_DIR` overrides cache/native extraction location only.
- `KMUX_STATE_DIR` and `KMUX_DATA_DIR` should be added if Linux state/data separation lands. If too many per-root overrides become hard to reason about, add a single `KMUX_PROFILE_DIR` for dev/test profile isolation and derive config/runtime/state/data/cache under it unless a narrower override is explicitly set.
- macOS keeps the current config default, `$HOME/.config/kmux`, to preserve behavior.
- Linux uses `$XDG_CONFIG_HOME/kmux` when `XDG_CONFIG_HOME` is set, otherwise `$HOME/.config/kmux`.
- macOS keeps the current runtime default, `$HOME/.kmux`, to preserve behavior until a separate macOS migration is chosen.
- Linux uses `$XDG_RUNTIME_DIR/kmux` when `XDG_RUNTIME_DIR` is set, otherwise an existing safe `/run/user/${uid}/kmux` runtime root when available, otherwise a deterministic private fallback under `tmpdir()`.
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

`PlatformPathService` should return explicit roots and files for every existing storage consumer instead of letting each module derive from `socketPath` or `KMUX_RUNTIME_DIR`:

- `socketPath` and `runtimeDir` for volatile IPC only.
- `statePath`, `windowStatePath`, `usageHistoryPath`, `shellEnvCachePath`, and `diagnosticsRoot`.
- `captureRoot` and `attachmentRoot`.
- `agentHookBinDir` and stable agent wrapper bin dir.
- `rawOutputRoot` for pty-host raw output history.
- `nativeCacheRoot` for rebuildable native module extraction.
- `antigravitySessionsPath` and other app-owned indexes.

These values must be passed into main services and serialized into pty-host launch/runtime env where the forked process owns the write, such as `rawOutputRoot`. The pty-host should not infer non-socket storage from `KMUX_RUNTIME_DIR`.

Platform path resolver algorithm:

1. Build all desktop and CLI defaults through the same pure resolver in `@kmux/persistence`; desktop and CLI must not independently concatenate `~/.kmux/control.sock`.
2. Keep resolution side-effect-free. `resolveAppPaths()` should calculate paths only. It must not create directories, chmod paths, delete stale sockets, or probe live sockets. CLI commands should call only this pure resolver.
3. Perform filesystem mutation in desktop main/server code. `ensureRuntimeSocketDir()` should create and validate runtime socket directories with `0700`; `ensureAppStorageDirs()` should create state/data/cache roots as needed; socket stale-file handling belongs to socket startup.
4. Resolve explicit env overrides first. `KMUX_CONFIG_DIR`, `KMUX_RUNTIME_DIR`, `KMUX_STATE_DIR`, `KMUX_DATA_DIR`, and `KMUX_CACHE_DIR` are authoritative for their own scopes. If an explicit runtime dir cannot be created, is not a directory, cannot be made private, or produces an overlong socket path, desktop startup fails with a specific error. Explicit runtime dirs must not silently fall back to another directory.
5. Resolve Linux runtime defaults. If `XDG_RUNTIME_DIR` is set, use `$XDG_RUNTIME_DIR/kmux`. If it is absent and `/run/user/${uid}` exists with safe ownership and permissions, use `/run/user/${uid}/kmux`. If neither is available, choose a deterministic private fallback under `tmpdir()`, such as `kmux-runtime-${uid}` when a numeric uid is available or `kmux-runtime-${hash(homeDir)}` otherwise.
6. Resolve the default socket as `control.sock` inside the runtime root. If the default, non-explicit path exceeds the supported Unix socket path length, choose a deterministic shorter socket path, such as a hashed private directory under `tmpdir()` plus a short socket filename. Do not apply this fallback to explicit `KMUX_RUNTIME_DIR`.
7. Return both the resolved root paths and the final socket path so tests can assert desktop/CLI equality, runtime root selection, and path-length behavior.

Any Linux runtime fallback outside `XDG_RUNTIME_DIR` must be validated before socket creation. Use `lstat`-style checks rather than following symlinks. The directory must be an actual directory, must not be a symlink, must be owned by the current uid where uid ownership is available, and must have `0700` permissions where POSIX modes are honored. An unsafe explicit `KMUX_RUNTIME_DIR` is a startup error. An unsafe default fallback should either be repaired safely or replaced by a deterministic shorter private fallback; if neither is possible, startup should fail with a specific runtime directory error.

IPC migration policy:

- Initial Linux phase: keep `KMUX_SOCKET_PATH` for CLI, hook scripts, generated snippets, and `ShellIdentity`.
- Centralize default socket path resolution so CLI and desktop do not duplicate `$HOME/.kmux/control.sock`.
- Introduce `IpcEndpoint` internally where it simplifies resolver/testing code.
- Defer `KMUX_IPC_ENDPOINT`, `ShellIdentity.ipcEndpoint`, and dual read/write env migration to the Windows phase, when named pipe behavior can be validated.

Unix socket paths need a length guard. If a computed default socket path is too long for common `sun_path` limits, the platform path resolver should choose a deterministic shorter runtime socket path, preferably under `$XDG_RUNTIME_DIR` on Linux or a hashed directory under `tmpdir()` when no safe runtime root exists. If an explicit `KMUX_RUNTIME_DIR` produces a too-long socket path, startup should fail with a specific error instead of silently using a different directory.

Socket robustness is a platform-neutral bug fix, not a Linux-only feature. Two mechanisms are useful, but they solve different problems and must not be treated as the same lock:

- `app.requestSingleInstanceLock()` can prevent duplicate launches for the default packaged app identity and can hand the second launch to the first instance.
- connect-first socket startup handles stale socket files after crashes. The server should first try to connect to the existing endpoint. If a live kmux instance responds, startup should stop or hand focus to the existing instance. Only `ENOENT`, `ECONNREFUSED`, or equivalent stale-socket cases should allow unlink and listen.

Socket ownership is the final authority for resolved runtime identity. Dev/test profiles and explicit `KMUX_CONFIG_DIR`/`KMUX_RUNTIME_DIR` overrides are valid ways to run isolated kmux instances side by side. Electron's single-instance lock is app-identity-scoped, not a runtime-directory-scoped mutex, so do not rely on `additionalData` to create per-runtime locks. Either use the Electron lock only for the default packaged runtime, bypass it for explicit dev/test/profile-isolated runtimes, or release/avoid it before socket ownership is resolved. In every case, connect-first socket behavior decides whether the resolved runtime is already owned by a live kmux instance.

The POSIX socket is a local control surface for kmux. The initial Linux protection model is a private, user-owned runtime directory plus connect-first live-owner probing. The app must not listen on a socket inside a shared, symlinked, wrong-owner, or overly permissive runtime directory. Peer credential checks such as `SO_PEERCRED` can be evaluated later, but the initial Linux release must at minimum prevent socket creation in attacker-controlled filesystem locations.

### Shell and PTY

`platform.shell` owns:

- default shell path.
- shell environment probe strategy.
- default shell args.
- shell-managed env stripping policy.
- shell integration support.
- session env requirements for agent hooks.
- agent PATH prepend policy.

macOS keeps the current login-shell-oriented behavior. Linux shell resolution should preserve the user preference order: configured shell, inherited `$SHELL`, account shell, then `/bin/bash` as the final fallback. This avoids treating bash as the default for users who intentionally use zsh, fish, or another shell.

Linux shell env recovery is a release blocker because agent CLI discovery is a core workflow. The Linux spike should compare the existing direct shell invocation probe with a PTY-backed probe from a GUI-launched app. The implementation should choose the strategy that reliably recovers PATH entries for nvm, pyenv, cargo, `~/.local/bin`, and installed agent CLIs on Ubuntu Desktop, with timeout/hang guards for interactive shell startup files. If direct invocation does not recover the required PATH, Linux must use a PTY-backed probe or another verified strategy before release.

The pty-host process must consume only serializable launch data. It should not import main platform services, Electron APIs, or non-serializable method objects.

### Shell Integration and Agent Hooks

Agent hook availability is a Linux release blocker. kmux's value depends on reliable multi-agent workflows, and Linux support must keep Claude, Gemini, Codex, and Antigravity notifications working.

Current hook commands for Claude and Gemini require a usable socket path and `KMUX_AGENT_BIN_DIR`. Hook helper binaries are already written to a stable app bin directory, and session spawn already injects `KMUX_SOCKET_PATH` and `KMUX_NODE_PATH`. The Linux-specific break is sharper: shell integration is currently darwin-gated, so `KMUX_AGENT_BIN_DIR` and the Codex wrapper are produced only by shell integration wrapper paths. On Linux, shell integration is skipped, so the stable helper directory is not exposed as `KMUX_AGENT_BIN_DIR` and the Codex wrapper is not placed on session `PATH`.

The platform shell service must ensure every kmux-owned session launch receives the hook runtime env:

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
- `~/.gemini/antigravity-cli/history.jsonl`
- `~/.gemini/antigravity-cli/brain`
- `~/.gemini/antigravity-cli/**/.system_generated/logs/transcript.jsonl`

Linux support should introduce `AgentStorageRoots` as a central resolver, but the initial Linux values should remain the vendor defaults until verified otherwise. This creates one place to adjust paths later without prematurely XDG-ifying third-party tool storage.

External session discovery and resume are required Linux workflows. Linux validation must cover Codex, Claude, Gemini, and Antigravity session roots. If a vendor CLI is missing or has no sessions, the UI can show the normal empty/unavailable state; if kmux cannot read a verified Linux session root for an installed and authenticated vendor, that is a release blocker.

The resolver is only useful if its output is propagated. These areas should receive `AgentStorageRoots` instead of rebuilding hard-coded home-relative paths:

- `createUsageAdapters` and metadata usage readers.
- `createExternalSessionIndexer` and external session scanners.
- Claude, Gemini, and Antigravity hook installers.
- Codex wrapper installation and PATH injection.
- subscription usage credential/session readers.
- agent metadata readers that inspect vendor project, temp, or config directories.

### Credentials

Credential loading is a platform capability.

macOS can use Keychain through `security find-generic-password` and keep existing file fallbacks. Linux must use verified credential providers for each supported agent instead of invoking macOS `security`. Acceptable Linux providers include vendor-documented files, a Linux secret service/keyring integration when the vendor uses it, or a CLI/RPC status probe when it is the stable source of subscription state. Do not add speculative libsecret support unless a target agent actually stores the required credential there.

Credential service behavior:

- Codex, Claude, Gemini, and Antigravity subscription usage are required Linux workflows once their Linux credential source has been verified.
- All macOS `security` calls must be gated to `platform === "darwin"` so Linux does not spawn failing subprocesses.
- Claude should try verified Linux file fallback such as `~/.claude/.credentials.json` when that remains the Linux credential source. The current file fallback makes Claude lower risk than providers with no non-Keychain path, but the macOS `security` call should still be skipped on Linux.
- Antigravity is the highest credential risk in this phase because the current reader is Keychain-only and may depend on platform-specific Google/Antigravity credential storage. Verify whether Linux stores credentials in files, keyring, browser-backed session state, CLI-readable state, or another location before declaring Antigravity subscription usage release-ready. The existing `go-keyring-base64` parsing path is a hint to verify the actual Linux keyring backend, not proof that libsecret should be implemented speculatively.
- Missing user credentials should show a normal disconnected/unavailable subscription state and must not break terminal/session features. A missing Linux credential provider for an otherwise authenticated vendor is a release blocker only after the Linux spike verifies that the vendor exposes a stable Linux credential source kmux can reasonably read or query.

Because subscription usage depends on authenticated credential access, credential/storage verification belongs in the first Linux spike. The later implementation step can add the providers, but the spike must answer where each agent stores the data on Ubuntu Desktop and whether kmux can read or query it without macOS-only tools. If Antigravity does not expose a stable Linux credential source, Antigravity subscription usage can remain unavailable while Antigravity hooks, local session discovery, transcript usage, terminal workflows, and notifications remain required where verified.

### Platform Subprocesses

Several current metadata and subscription paths use system commands whose behavior is platform-specific. Linux support should audit these before treating usage/subscription as complete:

- `security` is macOS-only and must not be spawned on Linux.
- Codex subscription PTY fallback uses `script`; util-linux and BSD/macOS `script` have different argument shapes, so the command builder must be platform-specific or replaced with another verified PTY strategy.
- `ps` process table parsing is on a critical path for manual CLI usage attribution. Do not assume the current `ps -axo ... command=` shape is broken on Linux, but validate the accepted output format on Ubuntu Desktop and ensure failures do not break usage refresh.
- `lsof` is often absent from minimal Linux desktop installs. Listening-port metadata should either use a Linux fallback such as `/proc`, mark only that optional port detail unavailable, or declare `lsof` as a package dependency. It must not break usage/session workflows.

### Filesystem Watch and Resync

Usage history, external session discovery, and agent metadata refresh must not depend on macOS-style recursive watch behavior. Linux `fs.watch` behavior varies by filesystem and inotify limits, and recursive watching may be unavailable or incomplete.

Linux support should use a watch provider policy:

- Prefer efficient file watching when the root exists and the platform supports it.
- Treat watch setup failure, missing recursive support, inotify limit errors, and missed events as expected degradation, not fatal workflow errors.
- Keep a low-frequency resync path that can discover new transcript/session files and replay appended usage even when no watch event arrives.
- Use known-root watches, targeted non-recursive watches, or polling/resync fallbacks instead of assuming one recursive watch covers all vendor storage trees.
- Surface persistent watch failures in diagnostics without breaking terminal sessions, local usage refresh, or external session indexing.

The watch policy should be shared by usage and external-session workflows where practical. The important contract is freshness with eventual catch-up, not perfect realtime delivery from the filesystem watcher.

### Native Module Loading

`node-pty` native module loading is both packaging and runtime behavior. Linux support must verify the packaged AppImage path, `app.asar.unpacked`, native `.node` file location, helper permissions where applicable, and `prebuilds/${platform}-${arch}` lookup.

Do this before the broad refactor in a Linux spike. If AppImage native loading fails, the result can change how `nodePtyLoader`, packaging config, and runtime paths should be abstracted.

The macOS `spawn-helper` chmod script intentionally exits on non-darwin. Do not "fix" that for Linux. The Linux risk is the native `.node` binary and ABI/glibc compatibility, not a macOS spawn-helper permission bit.

If Linux needs native module extraction outside the packaged AppImage mount, use the platform cache path, not the socket runtime directory. Native extraction is rebuildable cache data and should be versioned by package version, platform, arch, and ABI.

The current macOS externalization path is coupled to `KMUX_RUNTIME_DIR`/`~/.kmux`. The Linux refactor should decide explicitly whether macOS keeps that behavior for compatibility while Linux moves extraction to cache, or whether both platforms move behind a cache resolver in a separate compatibility-reviewed change. Linux must not put native `.node` extraction under `XDG_RUNTIME_DIR`, because that directory may be tmpfs-backed and cleared between logins.

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

This is not the current non-macOS behavior. The current window creation path is frameless for every platform and the renderer draws custom controls for `!isMac`. Linux native chrome therefore requires a new `BrowserWindow` branch with `frame: true` and a matching renderer branch that suppresses custom controls when `windowChrome: "native"`.

Window chrome selection is a main-process boot decision as well as a renderer display decision. The platform descriptor must influence `BrowserWindow` creation early enough to choose `frame: true` for Linux native chrome, while the renderer uses the same descriptor to decide whether to render custom window controls.

Renderer platform behavior should come from `RendererPlatformDescriptor` delivered through a renderer-only bootstrap IPC, such as `kmux:platform:get`, not from `navigator.userAgent` sniffing and not from `identify()`. `identify()` is a socket/CLI-oriented `ShellIdentity` contract and should stay compatible with existing CLI/socket callers. The renderer descriptor must cover behavior as well as display. Shortcut labels and shortcut execution should derive from keyboard policy, not from an `isMac` boolean.

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

Shortcut defaults and settings migration:

- `@kmux/ui` should own the shortcut catalog and expose platform-specific defaults, such as a macOS default map and a Linux default map, or a pure builder that receives `PlatformKeyboardPolicy`.
- `packages/core` should not blindly persist the macOS `DEFAULT_SHORTCUTS` for Linux first-run settings. Linux first run should create settings with the Linux default map.
- Settings should record enough metadata to distinguish platform-generated defaults from user-customized shortcuts, for example `shortcutSchemeVersion` and `shortcutPlatform`, or an equivalent migration marker.
- Migration should preserve user-customized shortcuts. If an existing shortcut map exactly matches the old generated macOS defaults, or if individual commands are missing and unmodified, Linux may replace/fill those entries with Linux defaults. Do not overwrite bindings the user edited.
- macOS settings paths and existing macOS shortcut defaults should remain behavior-preserving unless the user explicitly resets shortcuts.
- Renderer hard-coded modifier handlers outside `DEFAULT_SHORTCUTS`, such as workspace digit hints or `metaKey`/`ctrlKey` special cases, must move behind keyboard policy too. The existing binding parser can remain if it already normalizes the selected chord syntax.

### Terminal Font and Metrics

Terminal output continuity depends on stable xterm.js cell metrics. Linux support must verify the terminal font stack, not just the app shell.

Font inventory is also platform-specific. The current macOS provider can use `system_profiler`, but Linux needs a capability-based provider such as `fc-list` from fontconfig, a bundled-font-only fallback, or a renderer-probe-driven fallback. Missing `system_profiler` on Linux must not break settings or terminal typography.

The renderer should keep a platform-neutral preferred stack when bundled fonts are available, and Linux smoke should verify:

- the intended terminal font actually loads.
- fallback fonts are monospace.
- cell width/height measurements remain stable after first render.
- restore, split panes, and foreground resize do not reflow agent output unexpectedly.

### Electron Runtime and Output Continuity

Terminal output continuity can fail below the font-metric layer. Linux validation should explicitly cover Electron runtime behavior that affects xterm.js paint stability:

- GPU/compositor behavior on Ubuntu Desktop, including X11 and Wayland where feasible. If terminal paint glitches, resize tearing, blank frames, or unexpected reflow appear, evaluate Electron/Chromium switches such as ozone platform selection or GPU fallback in a platform-owned startup module.
- AppImage startup and sandbox behavior. The spike should verify whether packaged AppImage launches without `--no-sandbox`, whether user namespaces are available on the baseline distro, and what the product/security decision is if only `--no-sandbox` works. Do not silently make production Linux builds less secure without an explicit decision.
- Actual desktop smoke coverage. CI `xvfb` smoke is useful for catching startup regressions, but it cannot validate Wayland, compositor/GPU behavior, real desktop notifications, tray/window identity, or AppImage desktop integration. Those items need local or VM desktop smoke before stable release.
- IME and input method behavior for common Linux setups such as ibus/fcitx should be smoke-tested as a terminal-input compatibility check, but it is lower priority than spawn, rendering continuity, hooks, and socket correctness.

### Updater

Updater enablement should be a small platform-aware function backed by packaging support.

macOS remains enabled only when packaged and not under test. Linux packaged updater support is required for the initial Linux release. Electron's built-in `autoUpdater` does not support Linux, but kmux already uses `electron-updater`, which supports Linux AppImage/deb/rpm targets. The Linux implementation must therefore validate `electron-updater` with the chosen Linux package target instead of marking updater unsupported.

Linux updater requirements:

- AppImage update metadata is generated and published for the Linux channel.
- packaged Linux builds can check, download, and install an update through `electron-updater`.
- updater state and renderer UI use the same controller surface as macOS.
- dev/unpackaged Linux builds may report updater disabled, but packaged release builds must not.
- release checks include a Linux updater smoke where CI or release infrastructure can exercise it.
- updater smoke validates `APPIMAGE` env presence for AppImage updater behavior, channel naming, `latest-linux.yml` publication, artifact/checksum consistency, and GitHub release visibility. Draft releases are not visible to update clients, so release checks must use the same visibility/channel policy intended for users.

### Packaging

Keep macOS signing and notarization in macOS-only builder configuration. Add Linux targets without sharing macOS artifact hooks.

Before the AppImage packaging spike, move any macOS artifact hooks out of top-level builder configuration. A hook implementation may guard on `.dmg`, but top-level macOS hooks are still a structural risk because Linux packaging now depends on a macOS script staying defensive. Linux builder sanity should verify that mac signing/notarization scripts are not invoked for Linux artifacts, AppImage metadata is generated, and update metadata such as `latest-linux.yml` is published with the selected channel policy.

Initial Linux target:

- AppImage

Follow-up target:

- deb package

Do not add sandboxed package targets such as Flatpak or Snap in the first phase. kmux intentionally launches user shells, discovers user-installed agent CLIs through PATH, reads vendor-managed agent storage under the user's home directory, and integrates with local sockets/hooks. Sandboxed package formats may be possible later, but they require a separate product/security design rather than a packaging flag flip.

The build scripts should become explicit:

- `package:mac`
- `package:linux`
- `release:check:mac`
- `release:check:linux`

`release:check:linux` is the Ubuntu Desktop/AppImage signoff wrapper, not a lightweight artifact-only check. It must run the strict `gate:walking-skeleton:linux`, `package:linux`, and `smoke:packaged:linux` stages in order.

## Data Flow

Startup flow:

1. main process creates a thin platform runtime and capability descriptors.
2. startup exits with a clear unsupported message if no supported runtime exists for the current platform.
3. paths and POSIX socket endpoint are resolved from platform path/IPC helpers.
4. runtime identity is checked with connect-first live socket probing before settings, hooks, or app-owned state are mutated. `requestSingleInstanceLock()` may be used as a default packaged-app duplicate-launch helper only when it does not block explicit isolated runtimes.
5. if another live instance owns the resolved runtime/socket, the second process exits or forwards focus/launch intent to the live instance.
6. runtime socket directory and app storage directories are ensured only after this process is known to be the owner for the resolved runtime.
7. shell environment is resolved using platform shell policy.
8. agent hook helpers are installed independently of shell integration.
9. agent hook commands and wrappers are installed using platform hook/wrapper builders, runtime path fallbacks, and `AgentStorageRoots`.
10. socket server claims the POSIX socket after connect-first live-owner probing and stale-socket checks.
11. pty-host receives only `ShellLaunchPolicy`, session specs, and env values, never service functions.
12. renderer receives only `RendererPlatformDescriptor`, not the full platform runtime.

CLI flow:

1. CLI reads `KMUX_SOCKET_PATH`.
2. CLI resolves the same centralized POSIX default if no env endpoint is present, using the pure resolver only.
3. CLI connects to Unix socket on POSIX.
4. CLI does not create runtime directories, chmod paths, delete stale sockets, or perform server-side startup recovery.
5. Windows named pipe support is not implemented in this phase.

Terminal spawn flow:

1. runtime creates a session launch spec and `ShellLaunchPolicy`.
2. pty-host applies the resolved shell path, args, env stripping, integration policy, hook env, env precedence, and agent PATH prepend from serializable launch data.
3. hook runtime env is present before spawning the pty.
4. `node-pty` spawns the prepared launch.
5. terminal snapshot, hydration, resize, font metrics, and output batching logic remains platform-neutral.

## Error Handling

- Unsupported platform startup should produce a clear user-facing and log-visible message.
- Linux packaging failures should not affect macOS packaging.
- Missing shell or failed shell env probe should fall back to sanitized inherited env, matching the current defensive behavior.
- Missing agent CLIs should mark that vendor unavailable rather than failing indexing. Installed agent CLIs with verified Linux storage must be indexable.
- Missing credentials should show a disconnected/unavailable subscription state, not break terminal behavior. Missing Linux credential providers for authenticated supported agents are release blockers only for providers whose Linux credential source has been verified as stable and accessible.
- Socket startup should distinguish second live GUI instance, live socket owner, stale socket, bind failure, and explicit runtime path length failure.
- Linux updater should report disabled in dev/unpackaged builds, tests, or packaged Linux runs that are not executing from the AppImage runtime with `APPIMAGE` set. Packaged Linux AppImage release builds must support update checks.
- Linux notification failures should be logged and reflected in app diagnostics without breaking in-app agent event records. Ubuntu Desktop notification delivery is a release requirement.

## Testing Strategy

Unit tests:

- centralized POSIX socket path resolver and `KMUX_SOCKET_PATH` default behavior, including Linux fallback root selection, safe `/run/user/${uid}` selection, explicit `KMUX_RUNTIME_DIR` failures, and path-length fallback.
- pure path resolution is separated from desktop-only runtime directory creation, permission validation, stale socket handling, and storage directory creation. `resolveAppPaths()` tests assert calculated paths only; `ensureRuntimeSocketDir()` and startup/socket tests assert filesystem mutation and ownership behavior.
- renderer display and full shortcut keyboard descriptor formatting, including coverage for every command in `DEFAULT_SHORTCUTS`.
- Linux shortcut defaults and settings migration preserve user-edited shortcuts while replacing generated macOS defaults on Linux first-run/migration.
- main runtime composition for macOS and Linux.
- POSIX path defaults, including `XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, explicit env overrides, and `/run/user/${uid}` fallback selection.
- runtime directory creation and validation, including `0700` permissions, ownership checks, symlink rejection, unsafe fallback repair/failure, and explicit `KMUX_RUNTIME_DIR` failure behavior.
- runtime/state/data/cache separation so captures, attachments, and native caches do not live under Linux socket runtime dir.
- Unix socket endpoint generation and length guard.
- stale socket handling and live socket refusal.
- macOS and Linux shell defaults.
- `ShellLaunchPolicy` env precedence, including hook env, session identity env, PATH prepend, and shell integration env.
- Linux updater enablement for packaged AppImage builds and disabled state for dev/unpackaged builds.
- POSIX hook command generation with runtime path fallbacks.
- hook helper installation independent of shell integration.
- agent wrapper installation independent of shell integration.
- agent PATH prepend independent of OSC7/cwd shell rc integration.
- Linux font inventory provider behavior when `fc-list` is available and when only bundled/default fallbacks are available.
- Linux subprocess command builders for Codex `script` probing, `ps` process matching, and optional `lsof`/fallback metadata.
- unsupported platform startup behavior.

Integration tests:

- CLI and socket server use the same POSIX socket resolver.
- CLI resolver usage is side-effect-free and does not create/chmod/unlink runtime paths.
- shell environment resolution works for Linux-style bash defaults.
- pty-host launch uses `ShellLaunchPolicy` instead of hard-coded `/bin/zsh`.
- hook runtime env and final PATH are present in spawned session specs with the documented env precedence.
- Claude/Gemini hook commands work with baked fallback paths when session env is missing.
- Codex wrapper is installed in the stable wrapper bin dir and reachable through pty launch PATH prepend even when shell rc integration is disabled.
- agent storage roots are passed into usage adapters, external session indexing, hook/wrapper installers, and subscription usage readers.
- Antigravity `history.jsonl`, `brain`, and `.system_generated/logs/transcript.jsonl` paths are covered through `AgentStorageRoots`.
- usage and external-session refresh continue through low-frequency resync when Linux filesystem watches are unavailable, non-recursive, rate-limited, or miss events.
- settings opener goes through platform-aware opener function.
- credential loading uses Linux providers without invoking macOS `security`, and reports disconnected state when the user is not authenticated.
- Codex subscription fallback uses a Linux-compatible PTY/status probe or a verified alternative instead of macOS-only `script` arguments.
- Antigravity storage, hook, credential, and usage paths work on Linux when the CLI is installed and authenticated.
- Linux packaged updater checks release metadata through `electron-updater`.
- Linux builder config does not invoke macOS signing/notarization hooks for Linux artifacts.
- renderer receives `RendererPlatformDescriptor` through dedicated renderer IPC, not the socket/CLI `identify()` contract.
- renderer shortcut behavior follows keyboard policy instead of userAgent-derived `isMac`.
- renderer and main window chrome behavior both follow the same renderer/platform descriptor.
- Linux filesystem watch behavior handles missing recursive watch support, inotify limits, or missed events through polling/resync fallback for usage/external-session workflows.

E2E and smoke tests:

- keep existing macOS smoke/release checks.
- run an early Linux spike before the broad refactor.
- add Linux dev smoke where Electron can launch in CI or local desktop environment.
- add Linux packaged smoke for AppImage when CI environment supports it.
- keep `release:check:linux` wired as the full Ubuntu Desktop signoff command that includes `gate:walking-skeleton:linux`, `package:linux`, and `smoke:packaged:linux`.
- test Ubuntu Desktop launch from GUI-like env, not only an interactive terminal.
- test AppImage `node-pty` native module loading and shell spawn.
- test Linux credential/storage discovery for Codex, Claude, Gemini, and Antigravity before broad refactor.
- test Linux builder config sanity before relying on AppImage results.
- test Linux subprocess behavior for `script`, `lsof`, and `ps` usage paths.
- test Linux AppImage startup and sandbox behavior, including whether `--no-sandbox` is required on the baseline distro.
- test Linux GPU/compositor output continuity on real desktop environments, not only `xvfb`.
- document which smoke checks are CI-eligible and which require local/VM Ubuntu Desktop because `xvfb` cannot validate Wayland, GPU, real notifications, or desktop integration.
- test Linux native window frame first; test custom frameless chrome separately on X11 and Wayland before enabling it by default.
- verify PATH recovery and agent wrapper discovery for common agent install locations.
- verify `KMUX_SOCKET_PATH`, `KMUX_AGENT_BIN_DIR`, and `KMUX_NODE_PATH` are visible in spawned sessions.
- verify Linux desktop notification identity, icon/app name, and window grouping.
- verify Linux updater check/download/install on packaged builds where release infrastructure can provide update metadata.
- verify terminal font loading and xterm.js cell metrics.
- preserve current terminal restore, split pane, surface switching, and output continuity regressions.

Linux validation matrix:

| Environment                           | Required checks                                                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Ubuntu Desktop LTS, GUI launcher      | window launch, shell PATH recovery, pty spawn, hook env, desktop notifications, app identity, terminal output continuity          |
| Ubuntu Desktop LTS, terminal launch   | socket/CLI path equality, pty spawn, agent wrapper PATH, hook delivery, restore/split/switch flows                                |
| Ubuntu Desktop LTS, packaged AppImage | native `node-pty` loading, AppImage sandbox/startup behavior, updater metadata/check, desktop integration, notification identity  |
| Ubuntu Desktop LTS, dev build         | platform runtime composition, pty-host protocol migration checks, shared resolver behavior, macOS compatibility tests still green |
| X11 session where available           | native window frame, terminal resize/paint stability, keyboard shortcuts, notifications                                           |
| Wayland session where available       | native window frame, compositor/GPU paint stability, keyboard shortcuts, notifications                                            |

CI may cover dev launch, unit/integration tests, and `xvfb` startup smoke. Local or VM desktop validation is still required for Wayland, compositor/GPU behavior, real notifications, desktop integration, and packaged AppImage updater behavior.

Manual validation:

- Ubuntu Desktop LTS.
- launch app from terminal and desktop launcher.
- create workspace.
- spawn shell.
- run Codex/Claude/Gemini/Antigravity where installed.
- verify agent hook notifications for Claude/Gemini/Codex/Antigravity.
- verify Codex wrapper behavior with shell rc integration disabled.
- split panes.
- switch workspaces and surfaces.
- restore session.
- verify external sessions panel and resume for installed agents with known sessions.
- verify usage history and subscription usage for authenticated agents whose Linux credential source has been verified.
- verify CLI hook/socket communication.
- verify desktop notifications and `.desktop` identity.
- verify packaged updater behavior.

## Migration Plan

1. Linux spike milestone before broad refactor:
   - build a minimal Linux target or local dev launch.
   - split macOS signing/notarization artifact hooks out of top-level builder config before running Linux package validation.
   - prove Electron window launch on Ubuntu Desktop.
   - prove AppImage startup and sandbox behavior, including whether `--no-sandbox` is required.
   - prove `node-pty` shell spawn in dev.
   - prove AppImage native module loading and shell spawn, or capture the exact failure.
   - verify GPU/compositor output continuity on at least one real Ubuntu Desktop environment; do not rely only on `xvfb`.
   - test native window frame before custom frameless chrome.
   - compare direct and PTY-backed shell env probes from a GUI-launched app and choose the strategy that recovers agent CLI PATH.
   - verify credential and storage locations for Codex, Claude, Gemini, and Antigravity on Linux.
   - audit Linux subprocess behavior for `security`, Codex `script` status probing, `lsof`, and `ps` process matching.
   - verify `KMUX_SOCKET_PATH`, `KMUX_AGENT_BIN_DIR`, and `KMUX_NODE_PATH` are present in spawned pty sessions and hook notifications actually fire for installed agents.
   - prove `electron-updater` can consume Linux AppImage update metadata in a packaged smoke setup, or capture the exact release-infrastructure gap.
2. Platform-neutral socket robustness:
   - centralize pure CLI/desktop socket path resolution first, including `KMUX_RUNTIME_DIR` handling.
   - keep CLI resolution side-effect-free.
   - add `app.requestSingleInstanceLock()` only as a default packaged-app duplicate-launch helper when it does not prevent explicit dev/test/profile-isolated runtimes.
   - change socket startup to connect-first before unlink.
   - make connect-first socket ownership respect resolved runtime identity so dev/test profiles and packaged builds can run side by side when their config/runtime roots differ.
   - keep this as a macOS bug fix, not a Linux-only change.
3. No-behavior-change macOS refactor:
   - add desktop-only serializable launch/display helpers under `apps/desktop/src/shared/platform`.
   - add thin main platform composition.
   - keep existing `KMUX_SOCKET_PATH` wire/env behavior.
   - keep existing macOS tests green.
   - add characterization tests around shell env, paths, hooks, opener, updater, socket behavior, and terminal output continuity.
4. Move app paths into `@kmux/persistence` path helpers:
   - add the Linux fallback runtime algorithm, including `XDG_RUNTIME_DIR`, safe `/run/user/${uid}`, deterministic private `tmpdir()` fallback, explicit override failure behavior, runtime directory validation, and socket path length guard.
   - add Linux runtime/state/data/cache separation.
   - add `KMUX_STATE_DIR`, `KMUX_DATA_DIR`, or a broader `KMUX_PROFILE_DIR` decision for dev/test isolation.
   - expose `captureRoot`, `attachmentRoot`, `rawOutputRoot`, `nativeCacheRoot`, and `diagnosticsRoot` instead of deriving non-socket storage from socket dirname or runtime dir.
5. Move shell defaults, shell probe policy, hook runtime env construction, documented env precedence, agent PATH prepend, and `ShellLaunchPolicy` into platform shell code.
6. Move the pty-host protocol boundary:
   - add characterization tests for current spawn, resize, input, snapshot, raw output, and notification behavior.
   - move pty-host request/event types and `ShellLaunchPolicy` toward `apps/desktop/src/shared/ptyProtocol.ts`.
   - update `packages/core` to emit desktop-neutral session spawn effects instead of constructing pty-host-specific session specs.
   - map core session effects to pty-host IPC in desktop main after shell/path/runtime policy is composed.
   - ensure pty-host consumes serializable shell launch data instead of hard-coded platform fallbacks.
7. Separate hook helper installation, agent wrapper installation, agent PATH injection, and OSC7/cwd shell rc integration.
8. Add Antigravity-style runtime path fallback baking to Claude and Gemini hook builders.
9. Introduce `AgentStorageRoots` and pass it into usage adapters, external session indexers, hook/wrapper installers, subscription usage, and agent metadata readers.
10. Implement Linux credential providers for Codex, Claude, Gemini, and Antigravity subscription usage where the Linux spike verifies a stable credential source, with macOS `security` calls gated to darwin only.
11. Add settings opener functions where platform behavior is needed.
12. Update renderer to consume `RendererPlatformDescriptor` through dedicated renderer IPC, including concrete keyboard policy, instead of userAgent sniffing or `identify()`.
13. Add Linux shortcut defaults and settings migration so Linux first-run settings do not persist macOS `Meta+` defaults and existing user-edited shortcuts are preserved.
14. Add Linux desktop identity, notification, native window chrome, keyboard, and font validation. Native chrome requires replacing the current non-macOS frameless path with a `frame: true` main-process branch and suppressing custom renderer controls.
15. Add Linux runtime composition, Linux package target, and Linux updater metadata/release configuration.
16. Validate Linux shell env recovery, `node-pty` packaging, hooks, socket/CLI, external sessions, usage/subscription usage, updater, desktop notifications, native window chrome, keyboard shortcuts, font metrics, and terminal output continuity against the stable release gate.
17. Add Linux docs describing macOS stable support and Linux desktop support.
18. Keep Windows unsupported with explicit startup handling and documented implementation requirements. Defer `KMUX_IPC_ENDPOINT`, `ShellIdentity.ipcEndpoint`, and named pipe wire migration until this phase.

## Success Criteria

- Existing macOS tests pass.
- macOS package and packaged smoke remain valid.
- Linux spike verifies or falsifies AppImage `node-pty` shell spawn before the broad refactor depends on it.
- Linux spike verifies credential/storage sources, macOS-only subprocess behavior, hook env visibility, and Linux builder config sanity before the broad refactor depends on them.
- Linux spike verifies AppImage startup/sandbox behavior and GPU/compositor output continuity on a real desktop environment.
- The no-behavior-change refactor can be reviewed separately from Linux enablement.
- Shared contracts that cross package or process boundaries live in `@kmux/proto` or desktop shared modules, not in main-only platform modules.
- Linux phase keeps `KMUX_SOCKET_PATH` as the POSIX wire/env contract and centralizes its resolver.
- CLI path resolution is side-effect-free, and runtime directory creation/permission validation happens only in desktop main/server startup.
- Linux app can be built and launched on Ubuntu Desktop.
- Linux can spawn a shell through `node-pty` in dev and packaged AppImage.
- Linux shell env recovery finds user-installed agent CLIs from GUI-launched sessions.
- pty-host-specific request/event contracts are desktop-owned, and `packages/core` emits desktop-neutral session spawn effects that main maps into pty-host IPC.
- pty-host receives serializable shell launch policy and has no hard-coded `/bin/zsh` platform fallback.
- pty-host final env follows documented `ShellLaunchPolicy` precedence and includes `KMUX_SOCKET_PATH`, `KMUX_AGENT_BIN_DIR`, and `KMUX_NODE_PATH` before spawning.
- Linux terminal output remains stable through pane splitting, surface switching, restore, font loading, and foreground resize.
- Linux CLI/socket communication works.
- Claude, Gemini, Codex, and Antigravity notification paths work on Linux builds when the corresponding CLI is installed.
- Claude/Gemini hooks work through baked runtime path fallbacks even when shell env propagation is incomplete.
- Codex wrapper is installed outside shell rc wrapper dirs and can be found through agent PATH injection without requiring OSC7/cwd shell rc integration.
- Antigravity hook fallback behavior works on Linux through verified runtime paths.
- External session discovery and resume work on Linux for Codex, Claude, Gemini, and Antigravity verified storage roots.
- Usage history works on Linux, and subscription usage works for Codex, Claude, Gemini, and Antigravity when the user is authenticated and the provider's Linux credential source has been verified.
- Linux credential providers do not invoke macOS `security` and expose normal disconnected states when the user is unauthenticated.
- Linux subscription/metadata subprocesses use verified Linux-compatible commands or fallbacks for `script`, `lsof`, and `ps`.
- Linux packaged updater can check, download, and install an update through `electron-updater` using Linux release metadata.
- Linux updater validation covers `APPIMAGE` env, channel naming, `latest-linux.yml`, artifact/checksum consistency, and release visibility.
- Linux package builds do not invoke macOS signing/notarization artifact hooks.
- Linux path resolution honors `XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME`.
- Linux explicit `KMUX_RUNTIME_DIR` errors are reported specifically instead of silently falling back to another socket directory.
- Runtime socket directories use private permissions where supported.
- Capture/attachment/state/cache data does not live under Linux `XDG_RUNTIME_DIR`.
- Capture, attachment, raw pty output, diagnostics, and native extraction roots come from `PlatformPathService`, not from `dirname(socketPath)` or pty-host `KMUX_RUNTIME_DIR` inference.
- Socket startup does not steal a live socket from another kmux instance.
- Socket ownership respects resolved runtime identity so isolated dev/test profiles can run next to packaged builds; Electron single-instance behavior, if enabled, does not block explicit isolated runtimes.
- Renderer platform behavior and shortcut behavior do not depend on `navigator.userAgent`.
- Renderer platform behavior is delivered through dedicated renderer IPC and does not mutate the socket/CLI `ShellIdentity` contract.
- Linux default shortcuts cover the full shortcut catalog and are intentionally chosen/tested against terminal input and GNOME defaults.
- Linux shortcut settings migration preserves user-edited bindings and does not persist generated macOS `Meta+` defaults for Linux first-run settings.
- Linux desktop notifications show the correct app name/icon and group with the correct window identity.
- Linux window chrome is selected through `windowChrome` capability and validated before custom frameless mode becomes default.
- Linux filesystem watch behavior remains reliable for usage/external-session workflows under inotify limits or missed watch events.
- Platform service functions do not cross IPC boundaries.
- Platform-specific conditionals are concentrated in platform modules, except for physical native module/prebuild selection and narrow renderer fallbacks during bootstrap failure.
- Windows support is not implemented, but future Windows work has a bounded IPC and service surface.

## Risks

- `node-pty` packaging may need Linux-specific rebuild or native module handling.
- AppImage native module behavior may differ from macOS `.app/app.asar.unpacked` assumptions.
- AppImage startup may be blocked by Linux sandbox/user-namespace behavior, and any `--no-sandbox` fallback requires an explicit product/security decision.
- Linux Electron behavior differs between X11 and Wayland.
- GPU/compositor differences may affect xterm.js paint stability, resize behavior, or terminal output continuity even when font metrics are correct.
- AppImage packaging may need extra desktop integration work.
- Linux notifications, `.desktop` identity, and window grouping may vary by desktop environment.
- CI `xvfb` smoke can miss Wayland, GPU, notification identity, and AppImage desktop-integration failures.
- Linux GUI launch may not recover user shell PATH with the direct shell env probe.
- Agent CLI storage paths and hook schemas may differ on Linux installations and need validation.
- Agent credential storage may differ on Linux and require file, keyring, or CLI/RPC providers.
- Linux subscription and metadata subprocess behavior may differ from macOS, especially Codex PTY probing through `script`, optional `lsof`, and process table parsing through `ps`.
- Linux filesystem watch behavior may be limited by inotify settings or missing recursive watch support.
- Antigravity Linux hook, storage, and subscription behavior may differ from current macOS assumptions.
- Top-level macOS builder hooks may make early Linux packaging failures misleading until packaging config is split by platform.
- Linux updater may need channel naming, `latest-linux.yml`, AppImage blockmap, signing/checksum, and release upload policy changes.
- Sandboxed Linux packages such as Flatpak or Snap may conflict with kmux's core workflows around spawning user shells, discovering local agent CLIs, reading vendor home-directory storage, and communicating over local sockets.
- Linux shortcut choices may conflict with terminal control sequences or window-manager shortcuts.
- Linux font fallback may change xterm.js cell metrics and affect output continuity.
- Native module extraction cache paths may need cleanup/versioning policy to avoid stale ABI-specific cache entries.
- Over-abstracting too early could make simple macOS/Linux POSIX behavior harder to read.

The implementation should avoid broad abstractions that do not serve Linux support or future Windows isolation. The desired end state is not zero OS-specific code; it is OS-specific code that is easy to find, test, and replace. For this phase, the best architecture is capability/policy-driven inside the app, conservative on wire/env migration, and grounded by early Linux packaging and agent-notification validation.
