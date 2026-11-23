export const KMUX_ORCHESTRATION_SKILL_NAME = "kmux-orchestration";

export const KMUX_ORCHESTRATION_SKILL_DOCUMENT = `---
name: kmux-orchestration
description: Coordinate real local Agent CLI workers from the current kmux Agent conversation using durable Runs, Tasks, messages, and explicit results.
---

# kmux orchestration

First identify your role. If your assigned prompt contains a kmux Worker Task and Dispatch, you are that Worker: execute only that Task, use check --dispatch for your mailbox, and submit worker-done from this terminal. Do not run the Coordinator flow, create a Run, or launch reviewers unless your Task explicitly requests delegation. Reading this skill does not change your role.

When the user invokes this skill to delegate work from their existing conversation, this Agent remains the Coordinator in its existing kmux terminal and conversation. The Runtime attaches that terminal to a durable Run; there is no second Coordinator process, kmux agent run, ambient approval, or takeover handshake.

## Coordinator flow

1. Analyze first

Inspect the request, relevant files, and current changes. Produce a concrete analysis and change/review list in this conversation before starting Workers. Delegation supplements that analysis; it does not replace it.

2. Attach the current terminal

    kmux orchestration run-create --objective "<objective>"

Use run-current to inspect the selected Run and run-use --run <run-id> to select an existing one. These commands attach the authenticated current terminal. They do not launch or prompt another Coordinator.

3. Create Tasks and start native Workers

    kmux orchestration worker-start --spec "<analysis, evidence, and instruction>" --agent <catalog-agent-id>

worker-start creates a Task when --spec is used and opens its terminal in the invoking workspace, using this Coordinator's live working directory. In a single-pane or horizontal-only layout, the first Worker creates a right-hand pane with a vertical split. Once a vertical layout exists, subsequent Workers open as tabs in the rightmost pane. An existing right-hand pane is reused immediately; retries reuse their exact eligible terminal instead of adding a pane or tab. The Runtime prepares any catalog-supported ordinary workspace trust, starts the catalog Agent's ordinary CLI with the user's existing login and configuration, waits for a normal hook or observed input-ready TUI, pastes the instruction, verifies either the exact dispatch marker or a newly numbered native TUI collapsed-paste receipt, and sends Enter separately. If trust cannot be prepared safely, it leaves the user's configuration untouched and reports the visible trust prompt as needs-attention without pasting the Task. It reports the furthest reached stage and any concrete failure. It never silently substitutes unsupported model or effort settings.

worker-start waits through launch, readiness, and prompt delivery. Start independent sibling Workers concurrently instead of awaiting one worker-start before invoking the next. For a read-only review or analysis Task, always pass --no-coding; omitting it requests a write-capable Task and therefore an exclusive worktree lease.

A shared dirty worktree does not require serial read-only reviews. Do not follow older notes prescribing "release AGY before starting Copilot": that workaround came from omitting --no-coding, not from a provider limitation. Create/start all requested sibling Tasks before acknowledging the final result; acknowledging all current work can seal the Run and prevent adding the next reviewer.

Use task-create followed by worker-start --task <task-id> when dependencies or a stable Task identity are useful. Use worker-list, worker-show, and worker-read to inspect exact Dispatch, Surface, session, and terminal history state. A started or idle Worker is not complete.

Use worker-start --worktree new-child or --worktree new-top-level for an isolated Git worktree before the Task prompt is delivered. Omit --worktree (or use current) for the Coordinator worktree. Exact retry and reuse inherit the original placement; omit --worktree on those commands. Separate worktrees allow write-capable A/B Workers to run concurrently without sharing a write lease.

For a human choice, precreate a decision Task and make downstream Tasks depend on it. Dispatch the decision with gate-create --task <decision-task-id> --question "<question>" --options '["A","B"]'. This Task becomes a durable Human Gate rather than an Agent Worker. Inspect gate-list --task <decision-task-id>; the user resolves it in the Run UI. Never select an operator-owned Gate yourself. A dependent Worker cannot launch before the choice. Read the resolved option before instructing the merge Task, and preserve the unselected worktree.

Never respond to a readiness timeout, login/trust/permission prompt, empty read, or a still-live Worker by calling worker-start --spec again. That creates a different Task and a different terminal. Inspect the existing Dispatch first. If its exact latest attempt is durably failed and the terminal is still reusable, retry that Task and Dispatch without changing placement:

    kmux orchestration worker-start --task <task-id> --retry-of <dispatch-id> --agent <same-catalog-agent-id>

Intentional same-Agent fan-out requires --allow-parallel-agent. A retry never uses that flag. If the original Worker is active or needs input, keep that same terminal: let the user answer the native Agent prompt there, continue waiting, send scoped guidance, or use worker-stop when the task must be canceled. Do not launch a replacement around an unresolved permission prompt.

4. Exchange messages and results

Use send --dispatch <dispatch-id> --text <text> for guidance, ask for an ordinary question, escalate for a blocking issue, and reply --reply-to <message-id> for a response. send and reply queue their bodies in the durable mailbox; they never paste those bodies into the Worker terminal. An idle, input-ready Worker may receive only a body-free pointer telling it to run check --dispatch. A pointer is best-effort and is neither a read receipt nor an acknowledgement.

Workers pull their own mailbox before starting work on a new file (including read-only review), immediately after tests, and just before completion:

    kmux orchestration check --dispatch <dispatch-id>

After actually processing a Delivery, the Worker acknowledges it from that same exact terminal generation. A blocking Worker waits without skipping earlier FIFO mail:

    kmux orchestration check --dispatch <dispatch-id> --wait --types reply,guidance

Unacknowledged mail makes worker-done fail with the exact check command. Do not resend a send/reply merely because its pointer was uncertain; the mailbox entry remains durable.

Workers complete explicitly from their own terminal:

    kmux orchestration worker-done --task <task-id> --dispatch <dispatch-id> --outcome succeeded --summary "<result>"

Terminal-only output is not delivered to the Coordinator. The completion summary must describe the work performed, findings, and remaining work (or say none). If a detailed report is useful, save it before completion and add --report-path <path>; the optional path is stored in the result and shown to the Coordinator. For read-only Tasks, save any report outside the repository. No report file is required.

During active work, report the current phase about every five minutes:

    kmux orchestration heartbeat --task <task-id> --dispatch <dispatch-id> --phase "<current phase>"

Skip heartbeat while blocked on ask or check --wait. worker-show and worker-list expose the last heartbeat time and phase for liveness assessment. Heartbeat never completes or retries a Task.

After worker-done succeeds, return to idle without further reporting or polling. Resume on a direct user instruction or a new Dispatch preamble. Use --data '<json>' only when a Workflow or Task declares structured output. A timeout, Stop hook, or quiet terminal never retries or settles a Worker. A timed-out worker-start receipt is a checkpoint: inspect its Task and Dispatch instead of creating another one.

The Coordinator receives durable inbox deliveries with check or check --wait. Use --types worker_done,question,escalation only as a wake filter; it never skips older FIFO events. Read and assess the Delivery before acknowledging it with check --ack <delivery-id> --summary "<assessment>". Reuse an exact completed Worker or explicitly retain it before ack if needed; otherwise ack applies the Run's saved Worker terminal policy before consuming the Delivery. An unacknowledged Delivery, including its exact event list and delivery ID, is replayed after interruption.

5. Review in the original conversation

Compare Worker claims with the repository and with each other. Follow up when evidence is missing. Explain the final fact-check and synthesis to the user in this same conversation.

6. Reuse and cleanup

A completed kmux-owned Worker stays reclaimable until review. Settings > Orchestration separately controls successful and failed tasks: Keep open (both defaults), or Close after result review. Each new Run snapshots these settings; changing Settings never changes existing Runs. Keep open settles the terminal as retained without blocking completion. Reuse only an exact reclaimable Dispatch with worker-start --reuse <dispatch-id>; reuse is never automatic. worker-list --terminal-state reclaimable shows unsettled Workers and each row's nextAction. Release preserves final history before closing the exact owned generation; release-unknown is not success. New user input or a pre-existing user session automatically retains the terminal. No timeout, uncertain outcome, or active Worker authorizes automatic cleanup.

worker-release respects the Run's saved policy: it retains the Surface under Keep open and removes it only under Close after result review. worker-retain always preserves a completed reclaimable Worker. Inspect the returned terminal state rather than assuming a release command closed it. A task-delivered receipt proves input delivery, not that the user saw the Surface; use the actual UI when reporting visibility.

worker-read prefers the exact provider session transcript when supported (Codex, Claude, Copilot), then falls back to terminal output. It returns source, status (available, empty, missing, or unreadable), truncated, and archived for saved reads. Reads are bounded; use the optional result.reportPath when a detailed report was attached. Release saves the history before closing the terminal; a read or save failure keeps the terminal open and reports the error in worker-show as historyIssue. Preserved history remains readable after release.

## Saved Workflows

When the user requests kmux-orchestration workflow "<Title or Definition ID>" <request>, invoke the saved Workflow from this existing Agent conversation. This is a skill request, not a shell executable called kmux-orchestration. It does not create a Coordinator or alter the graph. An assigned Worker may invoke it only when its Task explicitly authorizes this Workflow.

1. Find the requested Workflow with kmux workflow list. Use its Definition ID when titles are duplicated; never guess. Inspect its latest saved draft with kmux workflow show --draft <draft-id> to learn the declared inputs, prompts and output schemas. Capture the user's request and this conversation's completed work in a JSON inputs file outside the repository. Include the full useful work result (scope, changed files, tests and remaining work), not merely a terminal-output pointer.

2. Invoke it from this terminal:

    kmux workflow run --workflow "<Title or Definition ID>" --inputs <inputs-file>

Keep the returned runId. The Runtime validates the latest saved draft and pins an immutable execution version. No separate Publish command is needed. The authenticated current terminal, its generation and this Agent process are attached automatically. Workflows using Calling Agent require this attachment; a manual UI Run or a plain shell cannot substitute a new Agent. Workflows without Calling Agent also run independently.

3. Stay in this conversation and pull the Run's durable mailbox:

    kmux orchestration check --run <run-id> --wait --timeout-ms 30000

Process all events in FIFO order, including any Delivery returned by an acknowledgement command. worker_done contains the full explicit Worker result, including structured data and an optional reportPath; question/escalation needs a scoped reply. caller_task contains requestId, attemptId, prompt, admitted inputs and resultSchema for a task assigned to YOU in this existing conversation. Read the entire task and acknowledge its Delivery using check --run <run-id> --ack <delivery-id>. An acknowledgement records receipt only; it does not complete your task.

Perform exactly the caller_task prompt using its inputs and the current source. Preserve your conversation, CLI, model and thinking settings. Do not launch a replacement Agent, restart a reviewer manually or recursively invoke this same Workflow. Fact-check full review reports before editing. Save a JSON result outside the repository with outcome (succeeded, failed or canceled), summary, and data matching the declared resultSchema; then submit it from this same Agent process:

    kmux workflow caller-done --run <run-id> --attempt <attempt-id> --request <request-id> --result <result-file>

The Runtime validates schema, ownership, terminal generation and request identity before advancing. If transport fails, retry the same command with the identical saved result. A changed replay or stale request is rejected. Never perform the task a second time merely because delivery was replayed. A missing result, interrupted caller or lost terminal does not count as completion; inspect needs-attention and stop advancing until resolved.

4. Continue checking until the Run is terminal and all delivered results are acknowledged. Return the final result to the user in this original conversation. check returns run.status and run.outputs. The bounded review example allows two fixes and up to three fresh review rounds: every fix, including the second, is followed by review. reviewResult.outcome=clean means both reviewers reported no blockers in the final review. If the final review still has blockers, the Workflow requests user judgment without another fix and reports max-reached. Existing saved definitions keep their own declared graph; inspect them before claiming they include this final review. Do not report a failed/incomplete review as blockerCount=0.

Saved Workflows repeat only their declared fixed graph. New Agent nodes use native Worker launch, messaging, typed explicit results and saved cleanup policy. Calling Agent tasks use the existing mailbox and never paste work into or take over the caller terminal. Immutable execution versions remain internal; the public invocation uses --workflow, not --version. Dynamic graph authoring belongs to ad-hoc orchestration.

Never install or update this skill, publish a Workflow, or enable external-effect executors on the user's behalf. Those remain explicit user actions.
`;
