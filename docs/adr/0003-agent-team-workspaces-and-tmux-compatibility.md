# 0003: Agent Team Workspaces and Deferred Compatibility Adapters

## Status

Proposed

## Context

Developers are increasingly running coding agents as small teams: one session
plans, another implements, another reviews, and another researches. Today this
is commonly built on `tmux`, iTerm2 split panes, shell scripts, hooks, and
external bridges such as Telegram bots.

Those workflows prove the product need, but they also expose the weak points of
pane-number orchestration:

- `tmux send-keys` is fire-and-forget and gives weak delivery feedback.
- Pane numbers are not stable enough to be the product model.
- Multiple agents editing the same repository need explicit worktree policy.
- Users need status, route history, and readable output more than raw pane
  count.
- Claude Code Agent Teams already understands `tmux` and iTerm2-like pane
  APIs, so compatibility may matter for later adoption.

kmux already has stronger primitives than `tmux` for this use case:

- stable `workspaceId`, `paneId`, `surfaceId`, and `sessionId`
- a main-process reducer as the single writer for product state
- a socket API and CLI
- agent lifecycle signals
- worktree-aware workspaces
- a `pty-host` that owns terminal state outside the renderer

The decision here is how to absorb the community workflow without weakening the
existing terminal continuity and state ownership rules.

## Decision

Implement a narrow native kmux Agent Team Workspace MVP first. Defer fake
`tmux` and other compatibility adapters until the native workflow has usage
evidence.

The native model is:

```text
Team Workspace
  -> Team Member alias
      -> role
      -> vendor
      -> worktree policy
      -> surfaceId
      -> sessionId
```

Compatibility shims, if added later, must translate external terminal-control
conventions into native kmux commands. They must not make `tmux` pane numbers
authoritative inside kmux.

The implementation will be staged in this order:

1. Team Workspace member model
2. `team send` router with single-member targets and route logs
3. surface capture/read and pty-host input acknowledgement primitives
4. worktree-enforced team preset orchestration
5. renderer, CLI, e2e, and documentation for the native MVP

Post-MVP candidates:

- status-only broadcast for non-destructive questions
- fake `tmux` shim for Claude Code Agent Teams and similar tools
- iTerm-style split-pane compatibility

## Native Team Workspace

A workspace may carry optional team metadata. The team metadata records member
identity, target surfaces, role text, vendor, and worktree policy.

The model belongs in the core reducer because team membership affects routing,
workspace restore, sidebar state, and close/reset behavior. Async preparation,
including dedicated worktree allocation, belongs in `electron-main` before the
core team creation action is dispatched. The renderer may display team state,
but must not invent or mutate team membership outside the reducer.

Team member aliases are stable user-facing names such as `lead`, `developer`,
`reviewer`, or custom names. The alias resolves to a member record, and the
member record resolves to a `surfaceId` and `sessionId`.

Resetting a member creates a replacement surface/session and rebinds the member
alias to the replacement. The old surface is preserved by default so the
previous transcript remains available. Destructive reset that closes the old
surface can be added later as an explicit command.

## Routing

Routing is a main-process responsibility. A route request resolves the current
state, validates that the target surface still exists, writes input through the
same terminal bridge used by existing UI and socket sends, and records a route
log entry.

Supported route targets:

- one member by alias

Broadcast routing is not part of the native MVP. If added later, it must be
limited to non-destructive status questions at first. Destructive or
file-editing broadcast can be added only with explicit worktree separation or
confirmation.

Route logs should include:

- route id
- workspace id
- target aliases
- resolved surface ids
- message preview
- status: `sent` or `failed`
- failure reason per target
- created timestamp

## Surface Capture and Input Acknowledgement

`surface.send_text` currently means "request a terminal write." Team routing
needs a stronger contract:

- the target surface exists
- the target session exists and is running
- the pty-host received the request for a live session and attempted the PTY
  write
- the response includes enough identifiers for route logs

This is an acknowledgement of delivery to the PTY boundary, not proof that the
agent understood the instruction or consumed the bytes. `node-pty` does not
provide an application-level read acknowledgement from the child process.

The protocol must include a request id on text/key input requests and an
`input:ack` event from `pty-host`. The ack payload should include the request id,
surface id, session id, accepted timestamp, and an error if the session is not
live.

`surface.capture` must expose plain text captured from the headless terminal
buffer. This is separate from VT snapshots used by renderer hydration. The
first API should support bounded reads:

- target surface id
- maximum line count
- optional trim mode
- returned `sequence`, `cols`, `rows`, and `text`

Capture reads the active headless terminal buffer after flushing pending output.
For the normal buffer, it includes scrollback and returns the bottom N logical
lines. For the alternate buffer, it returns the bottom N lines available in the
active alternate buffer. The returned `sequence` is the parsed terminal sequence
at capture time. The first implementation returns plain text only, not VT
escape sequences.

The capture implementation belongs in `pty-host`, using the existing headless
terminal as the source of truth.

Capture is sensitive because it exposes terminal text. Socket `surface.capture`
must require a matching surface/session auth token in the first implementation;
`socketMode = "allowAll"` must not bypass capture auth. Renderer IPC capture
can use the existing trusted renderer path. Deferred compatibility adapters
must use the same auth boundary.

## Worktree Policy

Team presets must make repository write ownership explicit and safe by default.

Initial policies:

- `shared`: member uses the workspace cwd
- `dedicated`: member uses a kmux-managed worktree
- `read_only`: member uses the workspace cwd, and the role prompt tells the
  agent not to edit files

The native MVP does not attempt OS-level filesystem sandboxing. It does enforce
worktree safety at the product orchestration boundary: write-capable preset
members use dedicated worktrees by default, and the default preset must not
launch multiple write-capable members in the same shared cwd.

For `dedicated` members, `teamRuntime` allocates a worktree and resolved cwd
before dispatching the core team creation action that creates member sessions.
If allocation fails, `teamRuntime` fails workspace creation before dispatching
the core team creation action. It must not silently fall back to the shared cwd
because that removes the main safety value of the feature.

Default preset:

| Alias       | Role                              | Vendor | Worktree policy |
| ----------- | --------------------------------- | ------ | --------------- |
| `lead`      | coordinator                       | claude | read_only       |
| `developer` | implementation                    | codex  | dedicated       |
| `reviewer`  | code review and regression checks | claude | dedicated       |

The default preset should fit normal laptop screens and token budgets. Users
can create additional custom members later.

## Deferred Compatibility Adapters

A fake `tmux` shim is explicitly deferred from the native MVP. It is a useful
adapter only if native Team Workspace usage shows that Claude Code Agent Teams
users want to run those workflows inside kmux.

If built later, the shim is a small executable named `tmux` that is placed
ahead of real tmux in the environment for selected agent sessions.

It translates a supported subset of tmux commands to kmux socket requests:

| tmux command         | kmux behavior                                        |
| -------------------- | ---------------------------------------------------- |
| `split-window`       | create a native pane/surface or team member surface  |
| `send-keys`          | send text or key input to a resolved surface         |
| `capture-pane`       | call `surface.capture`                               |
| `select-pane`        | focus the resolved surface                           |
| `kill-pane`          | close the resolved surface or pane                   |
| `list-panes`         | list known compatibility pane aliases                |
| `display-message -p` | print the requested compatibility pane/session value |

The shim should support only the command subset required by the validated target
workflow. Unsupported tmux commands must fail loudly with a clear message
instead of silently doing the wrong thing.

Compatibility pane identifiers are adapter state, not core product identity.
They map to native `surfaceId` values through the socket API.

Adapter state is scoped by compatibility session. The first implementation uses
the auth token of the invoking surface as the compatibility session key. State
includes:

- compatibility session key
- workspace id
- active compatibility pane token
- tmux pane token to `surfaceId` mapping
- created timestamp
- last-used timestamp

The mapping is cleaned up when mapped surfaces close, the workspace closes, or a
compatibility session has no live mapped surfaces.

The first compatibility call for an auth token would seed the invoking surface
as the initial compatibility pane token and active pane. Compatibility commands
without a valid auth token/session must fail before creating adapter state.

## Ownership Boundaries

- `packages/proto`: typed contracts for team state, capture, send results, and
  socket methods
- `packages/core`: reducer state and pure team actions
- `apps/desktop/src/main`: team runtime, socket RPC handling, worktree
  orchestration, and terminal bridge sends
- `apps/desktop/src/pty-host`: capture from headless terminal state
- `apps/desktop/src/renderer`: team UI and command palette entry
- `packages/cli`: `kmux team ...` commands

The renderer must not own team routing state or terminal capture state.

## Alternatives Considered

### Treat tmux as the product model

Rejected. It would copy the weakest part of the community workflow into kmux:
unstable pane identifiers and command-line side effects as state.

### Only build a tmux shim

Rejected. It would help Claude Code Agent Teams, but would not cover mixed
Claude/Codex/Gemini teams, route logs, worktree policy, or native kmux UI.

### Build the native MVP before compatibility adapters

Selected. It focuses the first release on kmux's durable advantages: stable
surface/session identity, route visibility, pty-host acknowledgement, terminal
capture, and worktree-safe orchestration. Existing Claude Code Agent Teams
workflows can be revisited after native usage is measured.

## Consequences

Positive:

- kmux can support native variants of current agent-team workflows without
  becoming tmux-shaped.
- Mixed-agent teams become a first-class workflow.
- Worktree safety becomes visible at the team level.
- External bridges can use the same socket API as the native UI.

Negative:

- The CLI surface grows.
- Existing Claude Code Agent Teams workflows that require a fake `tmux`
  executable are not supported by the native MVP.
- Capture APIs can expose sensitive terminal text through the socket API, so
  existing auth-token checks remain mandatory.
- Dedicated worktree creation can fail for dirty repositories, missing git, or
  branch-name collisions.

## Validation

The feature is not complete until these pass:

- reducer tests for team workspace creation, member mapping, route logs, and
  close/reset cleanup
- socket parser tests for new team and capture methods
- pty-host capture tests for bounded plain-text reads
- pty-host input acknowledgement tests for live and missing sessions
- main-process tests for route success and failed targets
- socket security tests proving capture requires a matching auth token
- CLI tests for `kmux team send` and `kmux team list`
- e2e smoke flow that creates a team workspace, sends to one member, captures
  output, and verifies terminal continuity after workspace switches
