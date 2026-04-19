# Agent Signal Matrix

Date: 2026-04-19

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
- reducer `agent.event`

Primary use:

- structured lifecycle
- sidebar status
- completion notifications
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

## Vendor Matrix

### Claude

Installed hooks:

- [`apps/desktop/src/main/claudeIntegration.ts`](/Users/kkd927/Projects/kmux/apps/desktop/src/main/claudeIntegration.ts)
- `PermissionRequest`
- `Notification`
- `PreToolUse` with matcher `AskUserQuestion`
- `Stop`

Canonical notification signals:

- hook `PermissionRequest` / `Notification` / `PreToolUse AskUserQuestion` -> `agent.event(needs_input)`
- hook `Stop` -> `agent.event(turn_complete)`

Usage consumption:

- real `agent.event` values are consumed by [`apps/desktop/src/main/usageRuntime.ts`](/Users/kkd927/Projects/kmux/apps/desktop/src/main/usageRuntime.ts)

OSC policy:

- raw terminal notifications may still exist, but reducer dedupe prefers the agent event when both overlap

### Gemini

Installed hooks:

- [`apps/desktop/src/main/geminiIntegration.ts`](/Users/kkd927/Projects/kmux/apps/desktop/src/main/geminiIntegration.ts)
- `BeforeAgent`
- `AfterAgent`
- `Notification` with matcher `ToolPermission`

Canonical notification signals:

- hook `Notification matcher=ToolPermission` -> `agent.event(needs_input)`
- hook `BeforeAgent` -> `agent.event(running)`
- hook `AfterAgent` -> `agent.event(turn_complete)`

Usage consumption:

- real `agent.event` values are consumed by `usageRuntime`

OSC policy:

- generic terminal notifications stay on the terminal-notification path

### Codex

Installed hooks:

- [`apps/desktop/src/pty-host/shellIntegration.ts`](/Users/kkd927/Projects/kmux/apps/desktop/src/pty-host/shellIntegration.ts)
- `Stop` only

Canonical notification signals:

- hook `Stop` -> `agent.event(turn_complete)`
- filtered terminal OSC attention -> synthetic `agent.event(needs_input)` with `details.uiOnly = true`

Important:

- Codex does not currently provide a reliable hook-based `needs_input` signal in `kmux`
- Codex terminal chatter must not be treated as a normal desktop notification by default

OSC policy:

- in [`terminalBridge.ts`](/Users/kkd927/Projects/kmux/apps/desktop/src/main/terminalBridge.ts), if the surface vendor is `codex`:
- allowlist known input-required patterns such as `Plan mode prompt:`, approval, permission, answer/selection prompts
- promote those to synthetic `agent.event(needs_input)`
- mark them with `details.uiOnly = true`
- suppress other Codex terminal notifications instead of showing generic chatter

Usage policy:

- [`usageRuntime.ts`](/Users/kkd927/Projects/kmux/apps/desktop/src/main/usageRuntime.ts) must ignore `agent.event` when `details.uiOnly === true`
- this prevents Codex OSC-derived attention from creating bindings, waiting state, or active session count changes

## Notification Semantics

`NotificationItem` carries extra metadata in [`packages/proto/src/index.ts`](/Users/kkd927/Projects/kmux/packages/proto/src/index.ts):

- `source`
- `kind`
- `agent`

Current structured kinds:

- `needs_input`
- `turn_complete`

Reducer behavior in [`packages/core/src/index.ts`](/Users/kkd927/Projects/kmux/packages/core/src/index.ts):

- `agent.event(needs_input)` creates an agent notification with `kind = "needs_input"`
- `agent.event(turn_complete)` creates an agent notification with `kind = "turn_complete"`
- `running`, `idle`, and `session_end` clear stale `needs_input` status and notifications for the same agent/surface
- `turn_complete` also clears stale `needs_input` UI before creating the completion notification

This cleanup is structural and must not rely only on title/message string matching.

## Delivery Policy

Notification creation and desktop delivery are not the same thing as signal collection.

- If a signal targets the surface the user is currently looking at in the focused app window, `kmux` should treat that signal as already visible to the user.
- For `agent.event`, `main` marks this with `details.visibleToUser = true`.
- Visible `needs_input` should still update sidebar status, but it should not create a notification-center entry or unread badge.
- Visible `turn_complete` should clear stale attention state, but it should not create a completion notification.
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
