# Agent Signal Matrix

Date: 2026-04-20

## Purpose

This document defines how `kmux` collects agent lifecycle signals from Claude, Codex, and Antigravity, and how those signals are consumed by:

- notifications and sidebar attention
- usage binding and attribution
- external session indexing and deterministic resume

The goal is to prevent the same signal from being reused for incompatible purposes.

## Core Rules

1. `pty-host` only parses generic terminal protocols.
   It must not decide vendor-specific meaning beyond raw OSC protocol parsing.
2. `electron-main` is the only place that may promote a raw signal into agent semantics.
3. Usage binding must only consume lifecycle signals that are safe for attribution.
4. UI-only attention signals must never affect usage binding.

## Signal Paths

### Hook path

Producer:

- external agent hook command

Flow:

- hook command
- `kmux-agent-hook`
- socket `agent.hook` or `agent.event`
- [`apps/desktop/src/main/socketServer.ts`](../apps/desktop/src/main/socketServer.ts)
- [`packages/proto/src/agentHooks.ts`](../packages/proto/src/agentHooks.ts)
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
- [`apps/desktop/src/pty-host/terminalNotifications.ts`](../apps/desktop/src/pty-host/terminalNotifications.ts)
- `PtyEvent { type: "terminal.notification" }`
- [`apps/desktop/src/main/terminalBridge.ts`](../apps/desktop/src/main/terminalBridge.ts)

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
- [`apps/desktop/src/main/terminalBridge.ts`](../apps/desktop/src/main/terminalBridge.ts)
- internal `agent.attention.clear` for the visible surface when that surface currently has an agent `needs input` status entry

Two trigger kinds:

- **dismiss** (`Esc`, `Ctrl-C`, `Ctrl-D`)
- **submit** (`Enter` / `Return`)

Primary use:

- clear visible `needs_input` attention when the user dismisses the prompt locally with `Esc`, `Ctrl-C`, or `Ctrl-D`
- clear visible `needs_input` attention as soon as the user submits input on that surface, without waiting for a lifecycle hook
- cover all agents by scanning `workspace.statusEntries` for entries scoped to the surface where `entry.text === "needs input"` and the status key starts with `agent:`

Not allowed:

- usage binding from this fallback
- cross-surface clearing — a keypress on one surface must never clear status on a different surface
- hard-coded agent lists — any agent with a surface-scoped `needs input` status is affected
- clearing on non-Enter, non-dismiss keys (e.g. arrow keys) — navigation inside a prompt must not clear attention

## Vendor Matrix

### Claude

Installed hooks:

- [`apps/desktop/src/main/claudeIntegration.ts`](../apps/desktop/src/main/claudeIntegration.ts)
- `PermissionRequest`
- `PreToolUse` with matcher `AskUserQuestion|ExitPlanMode`
- `SessionStart`
- `SessionEnd`
- `Stop`

Canonical notification signals:

- hook `PermissionRequest` / `PreToolUse AskUserQuestion|ExitPlanMode` -> `agent.event(needs_input)`
- kmux no longer installs Claude `Notification`, `PostToolUse`, or `UserPromptSubmit` hooks. Older kmux-managed entries for those hooks are removed on startup while user-defined hooks are preserved.
- if a legacy/user-defined generic `Notification` hook reaches kmux, it is suppressed in `main` before reducer dispatch when a recent (`< 5min`) structured notification (`kind = "needs_input"` or `"turn_complete"`) for the same agent and surface still exists.
- the reducer performs the reverse cleanup: when a structured `needs_input` arrives, or when `clearAgentAttentionUi` runs (on `idle`/`turn_complete`/`session_end`), any generic `source = "agent"` notification for the same agent and surface is removed. This covers the case where a generic hook arrived first and the structured hook arrived afterwards.
- hook `SessionStart` -> `agent.event(session_start)`
- hook `SessionEnd` -> `agent.event(session_end)`
- hook `Stop` -> `agent.event(turn_complete)`
- visible-surface submit/dismiss input -> `agent.attention.clear` for that surface

Important:

- Claude prompt response and dismissal are both handled by the visible-input attention clear path for visible surfaces.

Usage consumption:

- real `agent.event` values are consumed by [`apps/desktop/src/main/usageRuntime.ts`](../apps/desktop/src/main/usageRuntime.ts)
- legacy/user-defined generic Claude `Notification` hook entries must not affect usage binding
- `agent.attention.clear` is UI-only and is ignored by `usageRuntime`

OSC policy:

- raw terminal notifications may still exist
- if a Claude input request also arrives as a structured `agent.event`, reducer dedupe prefers the structured signal over terminal chatter

### Codex

Installed hooks:

- [`apps/desktop/src/pty-host/shellIntegration.ts`](../apps/desktop/src/pty-host/shellIntegration.ts)
- `SessionStart`
- `PermissionRequest`
- `Stop`

Canonical notification signals:

- hook `SessionStart` -> `agent.event(session_start)`
- kmux no longer installs Codex `UserPromptSubmit` hooks. Older kmux-managed entries for that hook are removed when the wrapper updates while user-defined hooks are preserved.
- hook `PermissionRequest` -> `agent.event(needs_input)`
- hook `Stop` -> `agent.event(turn_complete)`
- filtered terminal OSC attention -> synthetic `agent.event(needs_input)` with `details.uiOnly = true`
- visible-surface submit/dismiss input -> `agent.attention.clear` for that surface

Important:

- `PermissionRequest` is the primary structured signal for approval-bearing Codex tool handlers
- Codex versions and prompt types without `PermissionRequest` coverage still require the OSC fallback
- visible-input submit/dismiss is the only reliable immediate signal that the user handled an in-turn prompt before `Stop`
- Codex terminal chatter must not be treated as a normal desktop notification by default

OSC policy:

- in [`terminalBridge.ts`](../apps/desktop/src/main/terminalBridge.ts), if the surface vendor is `codex`:
- allowlist known input-required patterns such as `Plan mode prompt:`, approval, permission, answer/selection prompts
- promote those to synthetic `agent.event(needs_input)`
- mark them with `details.uiOnly = true`
- suppress other Codex terminal notifications instead of showing generic chatter
- if the surface vendor is still `unknown`, only a stricter Codex-specific subset such as `Plan mode prompt:` and answer/selection prompts may be promoted
- this fallback exists for restored Codex sessions where the app has not yet rebound usage/vendor state but Codex is already waiting for input

Usage policy:

- [`usageRuntime.ts`](../apps/desktop/src/main/usageRuntime.ts) must ignore `agent.event` when `details.uiOnly === true`
- this prevents UI-only promotions (Codex OSC-derived attention and similar synthetic events) from creating bindings

### Antigravity

Installed hooks:

- [`apps/desktop/src/main/antigravityIntegration.ts`](../apps/desktop/src/main/antigravityIntegration.ts)
- global hooks only in `~/.gemini/config/hooks.json`
- top-level managed hook entry `kmux-antigravity`
- `PreInvocation`
- `PreToolUse`
- `Stop`

Canonical notification signals:

- hook `PreInvocation` -> `agent.event(session_start)` with conversation metadata for indexing and usage binding
- hook `PreToolUse` with tool `ask_permission` or `ask_question` -> `agent.event(needs_input)`
- hook `Stop` with `fullyIdle !== false` -> `agent.event(turn_complete)`
- hook `Stop` with `fullyIdle === false` -> no-op because background work is still active and no attention state should change
- kmux no longer installs Antigravity `PostToolUse` or `PostInvocation` hooks. Older kmux-managed entries are removed on startup while user-defined hooks are preserved.

Session indexing:

- primary source is Antigravity's existing local CLI storage under `~/.gemini/antigravity-cli`:
  - `history.jsonl`
  - `cache/last_conversations.json`
  - `cache/projects.json`
  - `conversations/*.db`
- hook-recorded metadata in `antigravity-sessions.json` is only a secondary source for conversations observed while kmux hooks are installed.
- Session table resume uses `agy --conversation <conversationId>` from the resolved `cwd`; `agy --continue` is intentionally not used for row resume because it is not deterministic.

Usage policy:

- Antigravity `PreInvocation`, `SessionStart`-style lifecycle signals, and `needs_input` can bind a surface for attribution without creating live usage state.
- Usage samples come from Antigravity transcript storage under `~/.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript.jsonl`.
- If Antigravity transcript records expose explicit token metrics, kmux uses those metrics.
- If no explicit token metrics are present, kmux estimates visible transcript tokens and prices them with Gemini pricing when the Antigravity model label resolves to a Gemini model.
- Subscription remaining rows use Antigravity's local keychain auth (`service=gemini`, `account=antigravity`) and the Google Code Assist quota endpoint on `daily-cloudcode-pa.googleapis.com`.
- AGY quota rows are shown even when current usage is `0%`, because an authenticated Antigravity quota response is still the source of truth for the remaining-session panel.

## Notification Semantics

`NotificationItem` carries extra metadata in [`packages/proto/src/index.ts`](../packages/proto/src/index.ts):

- `source`
- `kind`
- `agent`

Current structured kinds:

- `needs_input`
- `turn_complete`

Other notification shapes:

- hook-driven generic notifications may use `source = "agent"` with no structured `kind`
- these generic entries do not create sidebar attention or usage state on their own

Reducer behavior in [`packages/core/src/index.ts`](../packages/core/src/index.ts):

- `agent.event(needs_input)` creates an agent notification with `kind = "needs_input"` and clears any generic `source = "agent"` reminder for the same agent/surface so the structured entry replaces stale previews
- `agent.event(turn_complete)` creates an agent notification with `kind = "turn_complete"`
- `idle` and `session_end` clear stale `needs_input` status, structured `needs_input` notifications, and generic `source = "agent"` reminders for the same agent/surface
- `agent.attention.clear` clears surface-scoped `needs_input` status entries and structured `needs_input` notifications for the handled surface
- `turn_complete` also clears stale `needs_input` UI before creating the completion notification

Pre-reducer suppression in [`apps/desktop/src/main/socketServer.ts`](../apps/desktop/src/main/socketServer.ts):

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

`usageRuntime` uses attribution-safe agent events to bind a vendor session to a surface:

- `session_start` and equivalent metadata hooks such as Antigravity `PreInvocation` bind the vendor session to the surface
- `needs_input` can also bind attribution when it is a real hook event
- `agent.attention.clear` and UI-only `agent.event` signals must not create or change usage bindings

This is safe only for real lifecycle signals.

Never feed these sources into usage binding:

- raw `terminal.notification`
- synthetic attention events marked `details.uiOnly = true`
- `agent.attention.clear`
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
