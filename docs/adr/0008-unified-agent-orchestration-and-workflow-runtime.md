# ADR 0008: Native local Agent orchestration and Workflow runtime

- Status: Accepted
- Date: 2026-09-17
- Scope: local kmux execution

## Context

kmux already owns the terminal behavior required for reliable local coding-Agent work: catalog command resolution, PTYs, split panes, terminal Surfaces, session restore, ordinary Agent hooks, input, and output history. Orchestration must build on that behavior instead of introducing a second headless provider runtime.

The previous design launched provider-specific processes through private protocols: Codex app-server, AGY stream JSON, Copilot ACP, launch JSON, bridge sockets, and reconstructed output. It also required a replacement Coordinator or a special agent launcher, treated private provider handshakes as readiness, held Dispatch-wide input ownership, and exposed Graph Patch, revision, yield, and seal as ordinary ad hoc orchestration steps.

That design conflicts with the product behavior we want. A user should see ordinary Agent CLI terminals, interact with them normally, and receive their explicit results back in the Agent conversation where orchestration started.

This feature has not shipped. No compatibility layer, migration, or version branch is required for the removed design.

## Decision

### 1. The invoking Agent is the Coordinator

The current authenticated Agent terminal attaches to a Run. kmux does not launch a second Coordinator and does not require kmux agent run, ambient approval, or an input takeover handshake.

The Coordinator first inspects the request and repository and writes its own analysis and work list. It may then create Tasks and start Workers. Worker evidence returns to this same conversation for fact-checking and synthesis.

Every catalog Agent can be a Coordinator or Worker. The contract is vendor-neutral.

### 2. Workers are ordinary catalog Agent CLIs

worker-start resolves the selected Agent through the same catalog and command construction used by Sessions. A fresh Worker is placed beside the attached Coordinator Surface, in a new split pane in the Run's originating workspace. Its PTY starts in the attached Coordinator terminal's live working directory, matching an ordinary new Surface rather than falling back to the workspace default or home directory. The PTY executes the ordinary CLI with the user's existing environment, login, model, effort, configuration, and output behavior.

When an ordinary CLI persists workspace trust in its public user configuration, kmux may prepare that same trust entry before launch. The update must preserve unrelated configuration and use the exact canonical Worker directory. If it cannot be applied safely, kmux leaves the configuration untouched and reports the visible trust prompt as needs-attention; it never pastes a Task into that prompt.

Unsupported launch preferences fail visibly. kmux does not silently substitute a model, effort, or provider mode.

Exact reuse is explicit. It may target only the selected settled Dispatch and its exact live terminal generation. Reuse is rejected if identity, Agent, launch preferences, worktree, unresolved effects, or ownership cannot be proven, or if the terminal received new user input after settlement.

### 3. Readiness uses ordinary hooks and visible TUI state

Authenticated Agent lifecycle hooks tied to the exact Surface, session, and PTY generation may establish or invalidate input readiness. A process-start hook alone is not readiness. Initial delivery requires a later input-ready lifecycle state or the exact catalog Agent process plus a visible input-ready TUI. When hooks are unavailable, kmux observes the actual terminal TUI.

Stable login, authentication, permission, and access approval prompts are blocked states, not input-ready states. Transient automatic-login progress is observed until it reaches either a stable prompt or an input-ready screen.

Provider-specific screen recognition belongs to the Agent's optional `terminalReadiness` capability. The desktop registry owns receipt consumption and exact-generation fencing; it does not select vendors or classify conversation keywords. Classifiers inspect the current input screen, excluding raw output history. An already consumed hook receipt does not prevent a later TUI observation from establishing readiness.

After initial Task readiness:

1. kmux sends one bracketed paste containing the Task and a unique marker;
2. kmux verifies that the exact marker newly appeared after the paste, or that a newly numbered native TUI collapsed-paste receipt is reflected in the terminal;
3. kmux sends Enter as a separate write.

If reflection or the write acknowledgement is uncertain, delivery becomes uncertain and kmux does not automatically resend it. Operation IDs and payload hashes prevent duplicate starts and duplicate input.

User keyboard input continues through the normal terminal path throughout a Dispatch. kmux serializes only its own individual paste/verification/Enter operation.

Follow-up guidance and replies never paste their body into the Worker terminal. The body is committed to the durable mailbox first. When the exact Worker generation is idle and input-ready, kmux may best-effort paste only a pointer telling the Worker to run `check --dispatch`, with a unique operation marker. The pointer uses the same operation, generation, and direct-input-revision fences as initial Task delivery. Pointer success is not mailbox acknowledgement, and an uncertain pointer is never automatically resent.

### 4. Runs, Tasks, Dispatches, and results share one state machine

An ad hoc Run groups Tasks, Workers, and a durable inbox. A Task is the user's work specification. Starting it creates one Agent node and Dispatch in the existing orchestration store. Workflow Agent nodes use the same Task, Dispatch, readiness, delivery, message, result, recovery, reuse, and cleanup transitions.

Each Run owns an immutable, monotonically sequenced mailbox event ledger. `worker_done`, `question`, `escalation`, `guidance`, and `reply` events refer to the authoritative result or message record. Coordinator and Dispatch consumers each have one durable cursor and at most one active Delivery. A Delivery contains the oldest audience-specific events, up to 50. It is replayed byte-for-byte until the exact consumer acknowledges it; acknowledgement and claiming the next Delivery are one store transaction.

`check [--run]` reads the Coordinator mailbox and `check --dispatch` reads the exact Worker generation's mailbox. `--types` controls only whether a wait wakes; it never skips older FIFO events, including when the matching event lies beyond the first page. `check` never starts Workers or commits hidden scheduling work.

A Worker checks before new file work, immediately after tests, and just before completion. It processes and acknowledges each Delivery itself. `ask` and `escalate` move the Attempt to `waiting-input`; acknowledgement of the corresponding `reply` returns it to `running`. A Worker settles only by explicitly submitting worker_done from its exact authenticated terminal generation, and submission is rejected while its mailbox contains queued or active-unacknowledged mail. The submission names the Task and Dispatch, outcome, and summary. Optional structured data uses the same submission path when a Workflow schema requires it. Terminal idle, Stop hooks, process timeout, or Surface creation do not imply completion.

Inbox deliveries are acknowledged after the Coordinator processes them. Interrupted, unacknowledged deliveries remain available.

### 5. Public local CLI contract

Ordinary orchestration exposes:

- run-create, run-use, and run-current;
- task-create and task-list;
- worker-start, worker-list, worker-show, and worker-read;
- send, check, ask, escalate, and reply;
- worker-done (with an optional report-path) and heartbeat;
- worker-retain and worker-release.

worker-start accepts either an inline spec or an existing Task. Its response reports the actual reached stage and the concrete preparation issue when preparation fails or requires user attention.

Graph Patch, graph revision, yield, and seal are not part of this public ad hoc contract. Ad hoc orchestration owns its dynamically constructed task graph. Visual authoring of reusable graphs, validation, and immutable execution versioning belong to Workflow.

### 6. Lifecycle, preservation, and cleanup

A completed kmux-created Worker becomes `reclaimable` and stays visible until result review. Settings > Orchestration provides separate successful/failed task policies: Keep open (both defaults) or Close after result review. Each Run snapshots the policy at creation. Before acknowledging a reviewed `worker_done` Delivery, the Host applies that policy to remaining reclaimable Workers; explicit exact reuse or retain can precede ack. `worker-release` also respects Keep open instead of bypassing it. The low-level acknowledgement still requires settled terminals; Run completion is held while a Worker remains `reclaimable`, `release-pending`, or `release-unknown`. `worker-list --terminal-state` exposes these states and the permitted next action. Policy-based release requires an accepted success/failure result, never merely a timeout, cancellation, or uncertain outcome.

Exact reuse atomically transfers the live terminal generation to the new Attempt and records the prior Dispatch as settled by reuse. Explicit retain records preservation. Release first stores final terminal history so `worker-read` remains useful after cleanup, then closes only the exact owned generation. An uncertain close is `release-unknown`, never success.

Terminal-only results are not delivered to the Coordinator. `worker-done` carries a summary of work, findings, and remaining work; an optional `--report-path` is stored with that result. Save a report before submitting completion, then return to idle without additional reporting or polling until direct user work or a fresh Dispatch arrives. Workers check their mailbox before starting file work, including reads, after tests, and before completion. During active work they send `heartbeat --task ... --dispatch ... --phase ...` about every five minutes, except while waiting on ask/check. The last heartbeat describes liveness and never completes or retries work.

`worker-read` prefers the exact provider session transcript when supported (Codex, Claude, Copilot), with terminal output as fallback. Reads identify the source and distinguish available, empty, missing, unreadable, and truncated output. Both live and saved reads are bounded. Release must durably save this output before closing the terminal. A failed read or archive write keeps the terminal open and reports the failure; an explicitly empty archive is allowed. The optional report path remains a reference, not a required report-content contract.

Saved Worker output bodies live in the content-addressed Artifact store. A Dispatch keeps only the Artifact reference, source, availability, and truncation metadata. `worker-read` verifies and loads that one body; ordinary Run reads and transactions never hydrate every saved output. Existing inline histories are preserved as Artifacts before the compact snapshot is published. If preservation fails, the original snapshot stays intact. An unreadable Artifact is reported as unreadable rather than empty output.

A local storage measurement on 2026-10-09 used 64 distinct Worker outputs of 256 KiB each and five read/persist samples with the real File store. Moving already captured bodies out of the snapshot reduced snapshot size from 18,188,196 to 27,566 bytes, median snapshot reads from 4.99 to 0.09 ms, and median snapshot persistence from 45.95 to 7.12 ms. These are controlled fixture measurements of ordinary snapshot operations; initial Artifact capture is excluded and production workload performance is not inferred.

Release may close only a completed terminal proven to be owned by that Worker. It must preserve:

- a terminal that existed before the Dispatch;
- a terminal whose generation no longer matches;
- a terminal that received new user work after Worker settlement;
- a terminal with unresolved delivery, cancellation, or result effects.

Session exit while work is active marks the attempt lost or uncertain through the same durable transition path. Timeout alone never retries or completes work.

A pre-existing user terminal, or direct user input observed after Worker settlement, changes the terminal to `retained` automatically and prevents cleanup.

### 7. Workflow remains the graph layer

Workflow retains:

- drafts, validation, publication, and immutable Published Versions;
- Agent, Shell, Condition, Loop, and Human Gate nodes;
- typed inputs, outputs, and dataflow;
- bounded retries, timeouts, joins, and failure policies;
- Scheduler execution of saved versions.

Agent nodes call the native Worker path described above. Shell and control nodes remain Workflow-owned. Saved Workflows repeat their declared graph. Conditions select predefined paths and Loops repeat predefined bodies; Workflow execution never adds a Coordinator for graph authoring. Dynamic task planning stays in ad hoc orchestration. The editor exposes one layout-inclusive JSON document and Save/Run actions. Run validates the current draft and pins an immutable execution version internally; users do not publish versions manually.

Restricted expressions validate the entire syntax and its complexity bounds before evaluation. `&&` and `||` short-circuit data resolution, so a skipped branch may reference absent optional data. A read-only Agent Task (`--no-coding`) explicitly prohibits file and Git mutations in its prompt while retaining repository read leases and result-state verification.

Shell nodes run an executable with ordered argv or a /bin/sh script with positional arguments. Mapped values remain argv data, never interpolated script text. Commands run as the local user in the selected working directory, without an application-specific command registry or sandbox. Bounded output, persisted execution receipts, exact-generation cancellation, and uncertain-outcome recovery remain required.

Workflow authoring and execution use the trusted local Studio renderer. Existing terminal-session authentication and Worker capabilities remain scoped to their Run; they do not grant user-level Workflow authoring authority. The diagram projects actual Workflow execution state.

### 8. Removed design

Remove the following implementation, generated artifacts, dependencies, documentation, fixtures, and tests:

- agent supervise and agent run orchestration launch behavior;
- launch JSON, bridge sockets, and private supervisor protocols;
- AGY stream-JSON, Copilot ACP, and Codex app-server orchestration adapters;
- duplicate headless executors and replacement Coordinator launch paths;
- provider-private handshake gates and internal vendor session ID requirements;
- ambient approval remnants and mandatory input takeover;
- general-orchestration Graph Patch, revision, yield, and seal commands;
- manual result JSON as the normal Worker completion contract;
- tests that assert only the removed transports or handshakes.

The catalog, normal Agent hooks, Sessions, PTY, terminal history, restore, repository-state capture, exact Surface/session/generation checks, and Workflow scheduler remain shared foundations.

## Consequences

Users see the same CLI and terminal behavior whether an Agent was opened manually, by ad hoc orchestration, or by a Workflow. Provider upgrades no longer require orchestration-specific protocol adapters. Output continuity, split/resize behavior, restore, and direct user interaction stay within the terminal architecture that already owns them.

Readiness from visible TUI state is intentionally conservative. Ambiguous input becomes uncertain rather than being resent. Explicit worker_done is required even when a provider reports a completed turn.

Remote execution, multi-host scheduling, and canvas redesign are outside this ADR.

## Verification

Completion requires evidence beyond unit fixtures:

1. In npm run dev, start two configured non-headless Agent CLIs in new splits from an existing Agent conversation.
2. Observe each real Agent screen, Task paste, verified Enter, and continuing user keyboard input.
3. Have each Worker ask a fixed question, receive it through filtered Coordinator `check`, queue a reply without exposing its body in the PTY, and have the Worker pull and acknowledge it through `check --dispatch`.
4. Repeat with a non-Codex Agent as the Coordinator.
5. Submit explicit results and fact-check them in the original conversation. Reuse or retain explicitly if needed; acknowledging `worker_done` applies the Run's snapshotted terminal policy to remaining reclaimable Workers before consuming the Delivery.
6. Run a published Workflow whose Agent node uses the same path and whose structured result feeds a later Condition or Loop node.
7. Run type checking and focused regression tests for FIFO pagination/replay, filtered waits, send/result races, generation fencing, result settlement, session loss, recovery, and safe reuse/cleanup.
8. With installed Agents, split and resize panes, switch workspaces, and restore a session. Check that output stays readable and that reuse, retain, and release affect the intended Worker.
9. In Studio, save and run both an executable and a Shell script. Inspect their terminal output and exit status, then cancel a running command. Check the skill installation destinations in Settings before confirming installation.

Fixture-only Surface creation does not satisfy installed-provider acceptance. Authentication blocks are reported as blocked evidence, never converted into success.

### Saved Workflow invocation from an existing Agent

`kmux workflow run --workflow "<Title or Definition ID>" --inputs <file>` resolves the latest saved draft, validates canonical/editor equivalence, and pins an immutable version. Duplicate titles require an ID. The public CLI no longer requires a publication/version choice; internal version-based RPC execution remains for pinned UI calls.

Studio execution uses the same backend preparation with the exact saved draft ID and revision. A changed or replaced draft fails before Run creation. Backend preparation owns version reuse and layout preservation; the Renderer no longer compares versions or publishes a version itself. Studio and standalone Run views share one Run query, coalesce polling with manual refresh, discard obsolete responses, and stop polling after settlement.

Orchestration RPC schemas and command response types are shared by the socket, Host, preload, and Renderer. The Renderer command subset is shared by the IPC allowlist and client types, so terminal-only commands are rejected both by TypeScript and at runtime. Runtime transitions are grouped into graph construction, mailbox, Agent input delivery, task execution, cancellation/recovery, and scheduling modules, with shared state primitives below them. Their dependency graph is acyclic. The Electron composition root wires native Worker execution; the Host delegates catalog persistence and terminal settlement to their owning services.

An Agent binding may use `{ "kind": "caller" }`. It refers to the authenticated invoking Agent process in its existing terminal generation, not a catalog Agent or new worker. The Start node remains structural. No launch model/effort override or dynamic graph capability is granted. A Workflow that uses caller rejects a run without that attachment before admission.

Caller tasks persist an attempt/request identity and emit a durable `caller_task` mailbox event with admitted inputs and result schema. A mailbox acknowledgement records receipt; only `workflow.caller.done` from the original process/generation with a validated result advances the attempt. Identical result replay is idempotent; changed, stale or foreign replies fail. A caller worktree lease fences writes until explicit settlement. Durable waits and their owning Loop attempts survive store recovery; lost generations pause with needs-attention and preserve uncertain leases. Cancellation cannot kill or relaunch the user's original Agent.

The review example runs two fresh read-only reviewers concurrently per iteration, joins both results, and breaks when both blocker counts are zero. It permits two caller revisions and up to three review rounds, so the second revision also receives an independent review. If that final review still has blockers, a local-user Human Gate exposes the unresolved outcome without authorizing another revision. `clean` and `max-reached` outputs remain distinct. Existing saved definitions are immutable per Run and require an explicit draft update to adopt the new graph.

Native Worker starts expose the same placement engine through `--worktree current|new-child|new-top-level`. Dedicated worktrees are prepared before readiness and Task input; exact retry and reuse retain the original placement. Binding-owned `worktreeInput` participates in required reachability, admission, and resolved attempt inputs, including when no node mapping repeats it.

Native decision Tasks use `gate-create` instead of `worker-start`. They materialize ordinary Human Gate nodes, persist through recovery, and block dependent Tasks through the existing dependency graph. `gate-list` returns their current state and resolution. Resolution remains an explicit local-user action in the Run UI; a Coordinator cannot approve its own operator-owned Gate.
