# AGENTS.md

## Project role

This repository is a greenfield Electron MVP of `kmux`, a terminal workspace manager inspired by `cmux`.

Current product direction:

- macOS-first
- `Electron + xterm.js + node-pty`
- `workspace + pane + surface + notification + automation`
- visual target matched against `cmux.png`

Out of scope for this branch:

- embedded browser
- SSH relay
- Windows support
- multi-window UI exposure

## Release target

Ship a macOS-first Electron MVP that satisfies the core `cmux` experience for this branch:

- workspace create/select/rename/close and sidebar navigation
- pane split/focus/resize/close/zoom behavior
- multi-surface tabs per pane with stable focus and restore
- terminal typing, paste, resize, scrollback, selection, search, and attach snapshot behavior
- notifications, sidebar status/progress/logs, and automation socket/CLI flows
- startup restore and persistence that feel dependable in normal use

Open-ready quality for this project means:

- the core user journeys work by keyboard and mouse without obvious breakage
- default-density UI is readable and calm at normal window sizes
- pane chrome, sidebar rows, focus states, and active surfaces are visually legible
- drag, scroll, typing, and focus changes feel responsive and unsurprising
- `cmux.png` is the default visual baseline, and real `cmux` side-by-side comparison should be used whenever `cmux` is available locally
- there are no known blocker-level issues remaining in the requested scope

## Source of truth

Before making any code changes, read [`docs/spec.md`](/Users/kkd927/Projects/kmux/docs/spec.md) in full.
Treat [`docs/spec.md`](/Users/kkd927/Projects/kmux/docs/spec.md) as the authoritative product and architecture specification.
The baseline architecture decision is [`docs/decisions/0002-electron-xterm-mvp-architecture.md`](/Users/kkd927/Projects/kmux/docs/decisions/0002-electron-xterm-mvp-architecture.md).

If code or assumptions conflict with the spec, follow the spec unless the user explicitly says otherwise.

## Working rules

- Do not reintroduce the old Rust daemon architecture for this branch.
- Keep `electron-main` as the single writer for app state.
- Keep PTY and session lifetime outside the renderer.
- Mount visible `xterm.js` terminals only; hidden surfaces must not keep live DOM terminals around.
- Prefer incremental, buildable changes over large rewrites.
- After each meaningful change, run the narrowest relevant checks first, then broader checks.
- If a requirement is ambiguous, leave a concise decision note and a TODO instead of silently guessing.

## Definition of done

A task is not complete until all of the following are true:

1. The requested feature, fix, or configuration change is implemented end-to-end.
2. Relevant tests are added or updated when reducers, layout behavior, IPC contracts, visible-only rendering, terminal behavior, automation flows, or performance-sensitive paths are affected.
3. The narrowest relevant checks pass first, then broader checks. Default project gates are:
   - targeted Vitest or Playwright checks when a narrow scope exists
   - `npm run test`
   - `npm run lint`
   - `npm run build`
   - `npm run test:e2e` for desktop runtime, interaction, restore, automation, or renderer-facing changes
   - `npm run capture:scene` only when a task explicitly needs visual reference output
   - `npm run compare:cmux` only when a task explicitly needs live `cmux` parity review
4. UI-facing work is validated through user-like interaction paths as relevant to the change:
   - Playwright-driven interaction and assertion is the primary validation method for `kmux`
   - button and menu clicks
   - keyboard shortcuts and typing flows
   - drag and resize behavior
   - scroll, selection, and focus behavior
   - workspace, pane, and surface switching
   - notifications, sidebar state, restore, and automation behavior
5. Visual quality is checked against [`cmux.png`](/Users/kkd927/Projects/kmux/cmux.png), and against a live `cmux` window when available locally, with explicit attention to contrast, spacing, hierarchy, focus affordances, and readability.
   - Screenshot capture is a secondary visual-parity tool, not the primary behavior test for `kmux`
   - When live `cmux` comparison is available, capture both apps at the same window size and record the concrete deltas found or explicitly note parity.
6. Automation, socket, notification, or CLI changes are exercised directly when affected.
7. A review pass is completed for regressions, edge cases, state ownership violations, hidden-surface/rendering risks, and performance fan-out.
8. If a check or interaction pass fails, continue the diagnose -> patch -> re-run loop instead of stopping at analysis.
9. If a visual or usability issue is discovered during testing, treat it as remaining work for the current task when it is inside the requested scope.
10. Do not stop at "I found the issue", "next step is", or a partial patch.
11. Only stop when:

- the relevant checks pass,
- the requested user journeys are verified, and
- there is no known blocker-level issue remaining in scope,
  or you are truly blocked by a missing credential, external outage, or irreversible ambiguity.

12. Before stopping, report:

- what changed
- what was verified
- any remaining risks or TODOs

## High-level validation matrix

When the change touches a user-facing or runtime-sensitive path, validate across the relevant layers instead of relying on a single test type.

- State and contracts:
  reducers, layout tree behavior, IPC serialization, socket contracts, persistence, and restore state
- Runtime user journeys:
  workspace create/select/close, pane split/focus/resize, surface create/focus/rename/close, and notification flows
- Terminal interaction:
  typing, paste, IME-sensitive behavior when applicable, selection, scrollback, resize, and attach snapshot continuity
- Mouse and keyboard fidelity:
  buttons, shortcuts, tab focus, drag handles, scrolling, and window-resize reactions
- Visual quality:
  Playwright screenshots for `kmux`, `cmux.png` comparison, live `cmux` comparison when available, dense-but-readable layout, clear active/focused states, legible sidebar rows, and explicit delta notes between `kmux` and `cmux`
- Automation and recovery:
  CLI/socket commands, sidebar automation state, startup restore, relaunch behavior, and failure recovery where relevant

If any pass exposes a weakness, patch it, rerun the affected checks, and repeat until the slice feels production-worthy for MVP scope.

## Architecture guardrails

Assume this structure unless the user changes the spec:

- `apps/desktop/src/main`: lifecycle, reducer/store, persistence orchestration, socket API, metadata scheduling
- `apps/desktop/src/preload`: typed IPC bridge
- `apps/desktop/src/pty-host`: `node-pty` session runtime and headless terminal state
- `apps/desktop/src/renderer`: visible terminal UI, split layout, sidebar, overlays
- `packages/core`: domain state, reducers, layout transforms, selectors
- `packages/proto`: IPC and socket contracts
- `packages/persistence`: SQLite-backed persistence
- `packages/metadata`: git/ports/cwd metadata helpers
- `packages/cli`: `kmux` automation CLI
- `packages/ui`: shared UI helpers and tokens

Hard rules:

- Keep hot-path state mutations out of React component state.
- Keep terminal session lifetime independent from pane widget lifetime.
- Use visible-only rendering and virtualization wherever counts can grow large.
- Avoid full-tree recomputation when one workspace, pane, surface, or sidebar row changes.
- Metadata collection should be event-driven when possible and rate-limited when polling is unavoidable.
- Do not let renderer-only conveniences become the source of truth.

## Performance requirements

Code should preserve these goals:

- workspace switching should feel instant at human scale
- pane focus changes must not block on metadata refresh
- large workspace counts must not trigger full sidebar rerenders
- hidden surfaces must not redraw every frame
- reducers, selectors, and IPC should avoid unnecessary `O(total panes)` work

Whenever implementing a feature, ask:

1. Is this update scoped only to the affected entity?
2. Does this cause hidden panes or hidden workspaces to do work?
3. Does this introduce `O(N)` or `O(N^2)` behavior on panes, surfaces, or workspaces?
4. Can this be virtualized, cached, diffed, or deferred?

## UI guidance

- Keep UI deterministic and keyboard-first.
- Preserve stable pane identity and stable focus behavior.
- Avoid reparenting terminal views unless unavoidable.
- Treat sidebar rows as virtualized read models, not expensive live widgets.
- Keep command routing centralized.
- Match the tone of [`cmux.png`](/Users/kkd927/Projects/kmux/cmux.png): dark palette, slim chrome, macOS-style frame, dense but calm spacing.

## Terminal integration guidance

- Wrap terminal integration behind adapters and typed contracts.
- Do not leak vendor-specific terminal types across the codebase unless they are contained at the boundary.
- Preserve scrollback and session state independently from UI mount and unmount.
- Prefer attach snapshot + incremental output over renderer-owned buffering.

## Subagent usage

Project-local custom agents live in [`/Users/kkd927/Projects/kmux/.codex/agents`](/Users/kkd927/Projects/kmux/.codex/agents). Use them actively when the task benefits from delegation.

Baseline project agents:

- `electron-pro`
- `electron-debugger`
- `reviewer`
- `test-automator`
- `qa-expert`
- `ui-designer`

Keep the project-local set intentionally narrow but sufficient for release-quality work. Prefer this baseline before broader fan-out.

### Delegation policy

- The main agent remains the orchestrator and owner of the full task.
- Delegate only bounded subtasks with clear outputs and explicit success criteria.
- Do not delegate the immediate critical-path task if the main rollout is blocked on it right now.
- Prefer the loop: reproduce/map -> implement -> review/test -> QA/visual pass -> iterate.
- Prefer parallel delegation only when write scopes do not overlap.
- Review subagent output before integrating.
- Do not ask the user to manually craft delegation prompts unless they explicitly want to.
- Keep `max_depth=1`; do not build recursive delegation trees for this project.

### Recommended agent mapping

- `electron-debugger`: reproduce issues, map main/preload/pty-host/renderer boundaries, inspect logs, and return the smallest likely fault surface before implementation
- `electron-pro`: implement the smallest safe fix across `main`, `preload`, `pty-host`, renderer boundaries, IPC, session lifecycle, or packaging
- `reviewer`: perform a read-only regression pass focused on correctness, state ownership, hidden-surface cost, and boundary violations
- `test-automator`: add or update Vitest and Playwright coverage for reducers, layout behavior, IPC contracts, and UI/runtime regressions
- `qa-expert`: define a risk-based manual and automated validation matrix for realistic user journeys, edge cases, and release-readiness gaps
- `ui-designer`: judge visual hierarchy, readability, density, and `cmux` similarity, then suggest concrete polish targets before or after UI patches

### Recommended ownership by path

- `electron-pro`
  - `/Users/kkd927/Projects/kmux/apps/desktop/src/main`
  - `/Users/kkd927/Projects/kmux/apps/desktop/src/preload`
  - `/Users/kkd927/Projects/kmux/apps/desktop/src/pty-host`
  - `/Users/kkd927/Projects/kmux/apps/desktop/src/renderer`
- `electron-debugger`
  - reproduction steps, failing runtime boundaries, logs, socket/automation paths, PTY/session lifecycle
- `reviewer`
  - read-only review across changed files with emphasis on product/spec regressions
- `test-automator`
  - `/Users/kkd927/Projects/kmux/apps/desktop/src/renderer`
  - `/Users/kkd927/Projects/kmux/packages/core`
  - `/Users/kkd927/Projects/kmux/packages/proto`
  - `/Users/kkd927/Projects/kmux/packages/core/src`
  - `/Users/kkd927/Projects/kmux/apps/desktop`
  - `/Users/kkd927/Projects/kmux/playwright.config.ts`
- `qa-expert`
  - release-readiness matrix, high-risk interaction coverage, and manual acceptance guidance
- `ui-designer`
  - `/Users/kkd927/Projects/kmux/apps/desktop/src/renderer`
  - `/Users/kkd927/Projects/kmux/packages/ui`
  - screenshot and layout/readability feedback against [`cmux.png`](/Users/kkd927/Projects/kmux/cmux.png) and live `cmux` when available

### Recommended workflow by phase

1. Discovery

- Read the spec.
- Use `electron-debugger` first when behavior needs reproduction, log capture, or boundary tracing.

2. Implementation

- Use `electron-pro` for the smallest coherent fix, even when it crosses `main`/`preload`/`pty-host`/renderer boundaries.

3. Stabilization

- Use `reviewer` and `test-automator` in parallel when possible.
- If either finds a problem, patch and repeat the loop until clean.

4. Release-quality pass

- Use `qa-expert` to define or refresh the user-journey matrix for the slice.
- Use `ui-designer` when readability, density, focus affordances, or `cmux` similarity still feel weak.
- Run `npm run compare:cmux` when the slice is specifically about visual parity or design polish.
- Do not call a UI/runtime slice done until the relevant E2E and visual checks are clean.

## Validation workflow

When implementing a task:

1. Read [`docs/spec.md`](/Users/kkd927/Projects/kmux/docs/spec.md) and the relevant code paths.
2. Create or update a brief plan.
3. Implement the smallest coherent slice.
4. Run targeted checks.
5. If the slice is UI-facing, run app smoke and visual confirmation.
   - If local `cmux.app` exists and the task is about parity/polish, run the live comparison capture and review the deltas.
   - Treat Playwright interaction assertions as the main pass/fail signal for `kmux`; use captures to judge visual parity and polish.
6. Summarize what changed, what remains, and any open decisions.

## Testing expectations

At minimum, add or update tests for:

- reducers and state transitions
- layout tree behavior
- IPC serialization and socket contracts
- visible-only rendering or virtualization invariants
- performance-sensitive paths when practical

If a feature affects rendering, focus, layout, notifications, or automation, add a regression test or smoke script when feasible.

## Preferred checks

Run the narrowest useful checks first:

- targeted Vitest package tests
- targeted Playwright specs
- `npm run test`
- `npm run lint`
- `npm run build`
- `npm run test:e2e`
- `npm run capture:scene` when visual reference output is needed
- `npm run compare:cmux` when live `cmux` parity review is needed
- Playwright or Electron smoke for UI/runtime changes

If a change affects automation, verify the CLI or socket command directly.
If a change affects visual layout, compare against [`cmux.png`](/Users/kkd927/Projects/kmux/cmux.png) with an app screenshot before calling it done, and compare against a live `cmux` session when available locally.

## Decision notes

If you must deviate from the spec:

- keep the deviation minimal
- document it in [`docs/decisions/`](/Users/kkd927/Projects/kmux/docs/decisions/)
- explain why the spec was insufficient
- make the change easy to revisit

## Output style

In progress updates and final summaries:

- be concise
- name the files changed
- mention commands run
- mention any risks or TODOs
