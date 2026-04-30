# Agent Signal Matrix

Date: 2026-04-20

## Purpose

This document defines how `kmux` collects agent lifecycle signals from Claude, Codex, and Gemini, and how those signals are consumed by:

- notifications and sidebar attention
- usage binding and live usage state

The goal is to prevent the same signal from being reused for incompatible purposes.

## Core Rules

1. `pty-host` only parses generic terminal protocols.
   It must not decide vendor-specific meaning beyond raw OSC protocol parsing.
2. `electron-main` is the only place that may promote a raw signal into agent semantics.
3. Usage binding must only consume lifecycle signals that are safe for attribution.
4. UI-only attention signals must never affect usage binding or active session counts.

## Signal Paths

### Hook path

Producer:

- external agent hook command

Flow:

- hook command
- `kmux-agent-hook`
- socket `agent.hook` or `agent.event`
- [`apps/desktop/src/main/socketServer.ts`](/Users/kkd927/Projects/kmux/apps/desktop/src/main/socketServer.ts)
- [`packages/proto/src/agentHooks.ts`](/Users/kkd927/Projects/kmux/packages/proto/src/agentHooks.ts)
- reducer `agent.event` or `notification.create`

Primary use:

- structured lifecycle
- sidebar status
- completion notifications
- generic hook-backed notifications
- usage binding, unless the event is explicitly marked UI-only

### Terminal OSC path

Producer:

- terminal OSC 9 / 99 / 777

Flow:

- terminal output
- [`apps/desktop/src/pty-host/terminalNotifications.ts`](/Users/kkd927/Projects/kmux/apps/desktop/src/pty-host/terminalNotifications.ts)
- `PtyEvent { type: "terminal.notification" }`
- [`apps/desktop/src/main/terminalBridge.ts`](/Users/kkd927/Projects/kmux/apps/desktop/src/main/terminalBridge.ts)

Primary use:

- generic terminal notifications
- vendor-specific UI attention promotion in `main` only

Not allowed:

- direct usage binding from raw terminal notifications

### Visible terminal input fallback

Producer:

- user terminal input on the visible surface

Flow:

- renderer terminal input
- [`apps/desktop/src/main/terminalBridge.ts`](/Users/kkd927/Projects/kmux/apps/desktop/src/main/terminalBridge.ts)
- synthetic `agent.event(idle)` for every agent that has a matching visible `needs_input` status on the focused surface

Two trigger kinds:

- **dismiss** (`Esc`, `Ctrl-C`, `Ctrl-D`) — applies to `codex` and `claude`. Carries `details.dismissKey`.
- **submit** (`Enter` / `Return`) — applies to `codex` and `gemini`. Carries `details.submitKey = "enter"`.

Primary use:

- clear visible `needs_input` attention when the user dismisses the prompt locally with `Esc`, `Ctrl-C`, or `Ctrl-D`
- clear visible `needs_input` for agents that do not emit a reliable hook-based completion signal for their own prompts — Codex has no hook-based `needs_input` at all, and Gemini has no hook fired when the user responds to a `ToolPermission` notification. On submit (`Enter`) on the visible Codex/Gemini surface, kmux synthesizes an `idle` event so the sidebar attention clears immediately instead of waiting for `Stop` / `AfterAgent`.

Claude is intentionally excluded from the submit trigger because its `PostToolUse` hook (mapped to `running`) clears `needs_input` on approval; the dismiss trigger still covers `Esc` because Claude does not fire `PostToolUse` when `AskUserQuestion`, `ExitPlanMode`, or `PermissionRequest` is declined.

Not allowed:

- usage binding from this fallback (events are marked `details.uiOnly = true`)
- cross-surface clearing — a keypress on one surface must never clear status on a different surface
- clearing a different agent's status on the same surface — only agents that currently own a `needs input` status entry for this `surfaceId` are affected
- clearing on non-Enter, non-dismiss keys (e.g. arrow keys) — navigation inside a prompt must not clear attention

## Vendor Matrix

### Claude

Installed hooks:

- [`apps/desktop/src/main/claudeIntegration.ts`](/Users/kkd927/Projects/kmux/apps/desktop/src/main/claudeIntegration.ts)
- `PermissionRequest`
- `PreToolUse` with matcher `AskUserQuestion|ExitPlanMode`
- `PostToolUse`
- `SessionStart`
- `SessionEnd`
- `UserPromptSubmit`
- `Stop`

Canonical notification signals:

- hook `PermissionRequest` / `PreToolUse AskUserQuestion|ExitPlanMode` -> `agent.event(needs_input)`
- hook `PostToolUse` (any tool, including `AskUserQuestion` and `ExitPlanMode`) -> `agent.event(running)`. This clears `needs_input` as soon as the approved tool finishes, which is how plan-mode approval clears the sidebar attention without waiting for the next `PreToolUse`. Claude does not fire `PostToolUse` when the prompt is cancelled via `Esc`, so the visible-input dismiss fallback in `terminalBridge.ts` covers that case.
- kmux no longer installs Claude `Notification` hooks. Older kmux-managed `Notification` hooks are removed on startup while user-defined `Notification` hooks are preserved.
- if a legacy/user-defined generic `Notification` hook reaches kmux, it is suppressed in `main` before reducer dispatch when a recent (`< 5min`) structured notification (`kind = "needs_input"` or `"turn_complete"`) for the same agent and surface still exists.
- the reducer performs the reverse cleanup: when a structured `needs_input` arrives, or when `clearAgentAttentionUi` runs (on `running`/`idle`/`turn_complete`/`session_end`), any generic `source = "agent"` notification for the same agent and surface is removed. This covers the case where a generic hook arrived first and the structured hook arrived afterwards.
- hook `UserPromptSubmit`, plus any non-input-tool `PreToolUse` payload that reaches kmux, -> `agent.event(running)`
- hook `SessionStart` -> `agent.event(session_start)`
- hook `SessionEnd` -> `agent.event(session_end)`
- hook `Stop` -> `agent.event(turn_complete)`
- visible-surface `Esc` / `Ctrl-C` / `Ctrl-D` dismiss input -> synthetic `agent.event(idle)` with `details.uiOnly = true` (dismiss trigger of the Visible terminal input fallback signal path)

Important:

- Claude does not fire `PostToolUse` when an `AskUserQuestion`, `ExitPlanMode`, or `PermissionRequest` prompt is cancelled (e.g. the user hits `Esc`) — the tool invocation is blocked at the pre-stage, so there is no post-stage hook. The visible-input dismiss fallback is the only signal `kmux` has to clear `needs_input` in that case, so do not remove or weaken it without a replacement.
- Claude does not participate in the visible-input _submit_ trigger — approval is covered by the generic `PostToolUse` -> `running` mapping above.

Usage consumption:

- real `agent.event` values are consumed by [`apps/desktop/src/main/usageRuntime.ts`](/Users/kkd927/Projects/kmux/apps/desktop/src/main/usageRuntime.ts)
- legacy/user-defined generic Claude `Notification` hook entries must not affect usage binding or waiting state
- visible-input fallback events carry `details.uiOnly = true` and are ignored by `usageRuntime` (same rule as Codex)

OSC policy:

- raw terminal notifications may still exist
- if a Claude input request also arrives as a structured `agent.event`, reducer dedupe prefers the structured signal over terminal chatter

### Gemini

Installed hooks:

- [`apps/desktop/src/main/geminiIntegration.ts`](/Users/kkd927/Projects/kmux/apps/desktop/src/main/geminiIntegration.ts)
- `BeforeAgent`
- `AfterAgent`
- `BeforeTool`
- `AfterTool`
- `SessionStart`
- `SessionEnd`
- `Notification` with matcher `ToolPermission`

Canonical notification signals:

- hook `Notification matcher=ToolPermission` -> `agent.event(needs_input)`
- hook `BeforeAgent` / `BeforeTool` / `AfterTool` -> `agent.event(running)`. `AfterTool` is the primary way `needs_input` from a `ToolPermission` notification gets cleared once the user approves — Gemini has no dedicated "permission response" hook.
- hook `AfterAgent` -> `agent.event(turn_complete)`
- hook `SessionStart` -> `agent.event(session_start)`
- hook `SessionEnd` -> `agent.event(session_end)`
- visible-surface `Enter` submit -> synthetic `agent.event(idle)` with `details.uiOnly = true` (submit trigger of the Visible terminal input fallback). This covers cases where the `ToolPermission` was denied or where `AfterTool` is delayed, so the sidebar attention clears on the user's Enter rather than waiting for `AfterAgent`.

Usage consumption:

- real `agent.event` values are consumed by `usageRuntime`
- visible-input fallback events carry `details.uiOnly = true` and are ignored by `usageRuntime` (same rule as Codex and Claude)

OSC policy:

- generic terminal notifications stay on the terminal-notification path

### Codex

Installed hooks:

- [`apps/desktop/src/pty-host/shellIntegration.ts`](/Users/kkd927/Projects/kmux/apps/desktop/src/pty-host/shellIntegration.ts)
- `SessionStart`
- `UserPromptSubmit`
- `Stop`

Canonical notification signals:

- hook `SessionStart` -> `agent.event(session_start)`
- hook `UserPromptSubmit` -> `agent.event(running)`
- hook `Stop` -> `agent.event(turn_complete)`
- filtered terminal OSC attention -> synthetic `agent.event(needs_input)` with `details.uiOnly = true`
- visible-surface `Esc` / `Ctrl-C` / `Ctrl-D` dismiss input -> synthetic `agent.event(idle)` with `details.uiOnly = true`
- visible-surface `Enter` submit input -> synthetic `agent.event(idle)` with `details.uiOnly = true`. Codex's `UserPromptSubmit` hook only fires for outer CLI prompts, not internal plan-mode / selection prompts, so without this fallback the sidebar `needs input` would linger until the whole turn finishes (`Stop`).

Important:

- Codex does not currently provide a reliable hook-based `needs_input` signal in `kmux`
- Codex does not fire `UserPromptSubmit` for in-turn prompts (plan-mode approval, selection menus, free-form answers), so the visible-input submit fallback is the only way kmux learns that the user has responded until `Stop`. Do not remove or weaken it without a replacement.
- Codex terminal chatter must not be treated as a normal desktop notification by default

OSC policy:

- in [`terminalBridge.ts`](/Users/kkd927/Projects/kmux/apps/desktop/src/main/terminalBridge.ts), if the surface vendor is `codex`:
- allowlist known input-required patterns such as `Plan mode prompt:`, approval, permission, answer/selection prompts
- promote those to synthetic `agent.event(needs_input)`
- mark them with `details.uiOnly = true`
- suppress other Codex terminal notifications instead of showing generic chatter
- if the surface vendor is still `unknown`, only a stricter Codex-specific subset such as `Plan mode prompt:` and answer/selection prompts may be promoted
- this fallback exists for restored Codex sessions where the app has not yet rebound usage/vendor state but Codex is already waiting for input

Usage policy:

- [`usageRuntime.ts`](/Users/kkd927/Projects/kmux/apps/desktop/src/main/usageRuntime.ts) must ignore `agent.event` when `details.uiOnly === true`
- this prevents UI-only promotions (Codex OSC-derived attention, visible-input clear fallbacks for any agent, and similar synthetic events) from creating bindings, waiting state, or active session count changes

## Notification Semantics

`NotificationItem` carries extra metadata in [`packages/proto/src/index.ts`](/Users/kkd927/Projects/kmux/packages/proto/src/index.ts):

- `source`
- `kind`
- `agent`

Current structured kinds:

- `needs_input`
- `turn_complete`

Other notification shapes:

- hook-driven generic notifications may use `source = "agent"` with no structured `kind`
- these generic entries do not create sidebar attention or usage state on their own

Reducer behavior in [`packages/core/src/index.ts`](/Users/kkd927/Projects/kmux/packages/core/src/index.ts):

- `agent.event(needs_input)` creates an agent notification with `kind = "needs_input"` and clears any generic `source = "agent"` reminder for the same agent/surface so the structured entry replaces stale previews
- `agent.event(turn_complete)` creates an agent notification with `kind = "turn_complete"`
- `running`, `idle`, and `session_end` clear stale `needs_input` status, structured `needs_input` notifications, and generic `source = "agent"` reminders for the same agent/surface
- `turn_complete` also clears stale `needs_input` UI before creating the completion notification

Pre-reducer suppression in [`apps/desktop/src/main/socketServer.ts`](/Users/kkd927/Projects/kmux/apps/desktop/src/main/socketServer.ts):

- a generic hook-driven `notification.create` (no structured `kind`) is dropped in `dispatchHookNotification` when a recent (`< 5min`) structured notification (`kind = "needs_input"` or `"turn_complete"`) for the same `agent + surfaceId` is still present. This prevents legacy/user-defined Claude `Notification` hook reminders from stacking on top of the structured needs-input or completion notification that already exists.

This cleanup is structural and must not rely only on title/message string matching.

## Delivery Policy

Notification creation and desktop delivery are not the same thing as signal collection.

- If a signal targets the surface the user is currently looking at in the focused app window, `kmux` should treat that signal as already visible to the user.
- For `agent.event`, `main` marks this with `details.visibleToUser = true`.
- Visible `needs_input` should still update sidebar status, but it should not create a notification-center entry or unread badge.
- Visible `turn_complete` should clear stale attention state, but it should not create a completion notification.
- Visible hook-driven generic notifications should be suppressed before they become notification-center entries.
- Visible generic terminal notifications should be suppressed before they become notification-center entries.

This keeps hook and OSC semantics separate while making delivery behavior consistent for the active surface.

## Usage Semantics

`usageRuntime` uses agent events to bind a vendor session to a surface and to derive live state:

- `running` / `session_start` -> active
- `needs_input` -> waiting
- other lifecycle events may leave the surface in `unknown`

This is safe only for real lifecycle signals.

Never feed these sources into usage binding:

- raw `terminal.notification`
- synthetic attention events marked `details.uiOnly = true`
- generic desktop chatter with no attribution-safe lifecycle meaning

## Change Checklist

When adding or changing an agent signal, answer all of these:

1. What is the producer?
2. Is the signal attribution-safe for usage, or UI-only?
3. What is the canonical event in `main`?
4. Does it create a notification, a sidebar status, both, or neither?
5. What clears it?
6. What tests prove notification behavior?
7. What tests prove usage does or does not consume it?

If the answer to item 2 is "UI-only", the event must carry an explicit marker like `details.uiOnly = true` and `usageRuntime` must ignore it.
