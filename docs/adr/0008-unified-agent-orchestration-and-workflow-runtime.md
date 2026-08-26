# 0008: Unified Agent Orchestration and Declarative Workflow Runtime

- Status: Proposed
- Date: 2026-08-26
- Scope: agent coordination, reusable workflows, natural-language
  orchestration, task graphs, scheduling, dispatch lifecycle, messages, gates,
  Surface/session/worktree binding, recovery, FlowGram Studio integration,
  local/SSH execution, CLI, and Electron IPC

## Context

kmux is a terminal application for running coding-agent CLIs such as Claude
Code, Codex CLI, and Gemini-compatible agents. It already has durable product
identities for workspaces, panes, Surfaces, and terminal sessions; agent hooks;
worktree-aware workspaces; local and SSH target services; and a terminal data
plane that survives renderer changes and app restarts.

Users need two related orchestration experiences on top of those primitives.

The first is an ad hoc, agent-driven experience similar to Orca
orchestration. A user should be able to write a natural-language request such
as:

```text
/orchestration
Have Claude research and plan this change, Codex implement it, and two other
agents review it. Reuse the implementer for fixes and keep reviewing until no
important findings remain.
```

An Agent Coordinator may decompose that request, create Tasks and dependencies,
choose workers and placement, react to questions or failures, add follow-up
work, and supervise completion. The graph may be incomplete when execution
starts and may grow as evidence arrives.

The second is a reusable, declarative workflow experience. A user should be
able to build, publish, and run a workflow in a FlowGram Free Layout-based
Studio:

```text
Trigger -> Plan -> Implement -> Parallel reviews -> Judge -> Condition
                                                ^                 |
                                                |---- Fix --------|
```

The workflow must retain explicit prompts, agent roles, dependencies, result
contracts, branch ports, loops, retry policies, approval gates, target and
worktree policies, and input/output mappings. It should run the same way from
the Studio, CLI, command palette, API, or an orchestration skill.

These experiences express the same underlying idea: work is decomposed into
steps, results flow between steps, and agent terminals perform some of those
steps. They differ primarily in how the graph is authored and how much it may
change during a Run.

A naive implementation would create two execution systems:

1. an LLM Coordinator that directly launches terminals and tracks state for
   natural-language requests; and
2. a separate DAG engine embedded in the workflow editor for saved workflows.

That split would duplicate task, terminal, worktree, retry, completion,
message, and recovery semantics. The two paths would drift, and a workflow
created from natural language would not be inspectable or reusable in the
Studio.

The opposite naive implementation would treat a saved workflow as a long
prompt and ask one Agent Coordinator to interpret it on every execution. That
would make routing, retries, branches, loop bounds, and recovery probabilistic.
It would also make an application restart depend on reconstructing hidden LLM
reasoning rather than persisted product state.

kmux therefore needs one orchestration domain and runtime that supports both
declarative and agent-authored graphs without putting orchestration control in
the renderer or terminal byte path.

## Relationship to Existing ADRs

- [ADR 0002](./0002-electron-xterm-mvp-architecture.md) remains authoritative
  for the local terminal control plane, `pty-host` data plane, renderer client,
  input ordering, output continuity, and terminal restore. Orchestration is
  control-plane behavior and must not enter the PTY output hot path.
- [ADR 0003](./0003-agent-team-workspaces.md) is still Proposed. If this ADR is
  accepted, it supersedes ADR 0003 as the orchestration authority model. A Team
  Workspace may remain as a preset and presentation layer that materializes
  named Agent bindings, Surfaces, and worktree policies through this Runtime;
  it is not a second router or scheduler.
- [ADR 0004](./0004-linux-platform-support-and-os-neutral-architecture.md)
  remains authoritative for platform services, shell policy, subprocesses,
  agent storage roots, and OS-neutral composition.
- [ADR 0005](./0005-ssh-remote-workspaces.md) remains authoritative for target
  identity, located paths, SSH authority, remote capability negotiation,
  terminal continuity, and `TargetServiceRegistry`. A Workflow node selects a
  target policy; it does not implement SSH or bypass target services.
- [ADR 0006](./0006-extensible-surfaces-and-markdown-preview.md) remains
  authoritative for Surface state, Surface registries, and cross-process
  boundaries. Orchestration binds to Surface IDs and session IDs but does not
  create a second Surface model.
- [ADR 0007](./0007-extensible-coding-agent-integrations.md) remains
  authoritative for open `AgentId`, agent descriptors, capabilities, command
  resolution, hooks, model/provider separation, and local/remote agent
  composition. Workflow definitions reference agents through those contracts;
  they do not introduce a closed vendor enum.

Terminal output continuity is a product invariant across all of these ADRs. A
Workflow transition, coordinator change, app restart, editor close, or Studio
navigation must not recreate a live PTY merely to refresh orchestration state.

## Decision Summary

Adopt one durable kmux Orchestration Runtime for both natural-language
coordination and saved workflows.

1. Define a canonical, serializable `WorkflowDefinition` independent of
   FlowGram's editor document format.
2. Separate an immutable, reusable `WorkflowVersion` from the mutable,
   Run-specific `RunGraph` that is actually executed.
3. Compile a published FlowGram Studio workflow into a validated
   `WorkflowVersion`, then materialize a pinned `RunGraph` for each Run.
4. Let a natural-language Agent Coordinator create and patch an ephemeral
   `RunGraph` through the same Runtime API. It does not have to produce the
   complete graph before work begins.
5. Use one native Scheduler as the only component that advances node state,
   creates Dispatch attempts, evaluates deterministic control flow, and
   settles Runs.
6. Treat an Agent Coordinator as an optional graph author and semantic decision
   maker, not as a second scheduler. It proposes typed commands and Graph
   Patches; the Runtime validates and applies them.
7. Represent runtime coordination with durable Runs, Run Nodes/Tasks, Node
   Attempts/Dispatches, messages, questions, replies, gates, Agent bindings,
   results, artifacts, and lifecycle events.
8. Execute each node through a trusted `NodeExecutor` selected by node kind.
   Agent nodes use ADR 0007 agent capabilities and ADR 0002/0005 terminal and
   target services.
9. Separate semantic judgment from control-flow evaluation. An Agent or Judge
   node may decide whether a finding is important; a Condition node only
   evaluates persisted structured data.
10. Require explicit, attempt-bound completion through one provider-neutral
    Runtime submission protocol with idempotent receipts. Terminal idle and an
    agent `Stop` hook are liveness/turn signals, not sufficient proof of Task
    success.
11. Preserve free-form summaries and transcripts while optionally enforcing a
    bounded structured result schema for downstream mappings and conditions.
12. Support supervised Dispatch and full handoff as distinct lifecycle modes.
13. Make Graph Patches revisioned, capability-scoped, validated, and durable.
    Completed or active work is not silently rewritten.
14. Give every Run Graph an explicit `open` or `sealed` authoring state.
    Adaptive Runs persist Coordinator turns and consumed event cursors; an open
    graph with no runnable work is waiting for coordination, not complete.
15. Bind each supervised Dispatch to one concrete terminal execution
    generation and persist prompt delivery through an idempotent, acknowledged
    outbox with a same-generation status/reconciliation interface. A logical
    session ID alone is never delivery authority.
16. Route Scheduler, injected, and user input through one generation-fenced
    input broker with explicit orchestrated, recorded-interactive, and takeover
    modes.
17. Admit at most one active supervised Dispatch to a concrete interactive
    Agent session, fence worktree access with revisioned durable resource
    leases, preserve external ownership after a full handoff, and require
    confirmed cancellation, reclaim, or reconciliation before reusing the same
    resources. Lease timeout or heartbeat loss is never sufficient proof of
    release.
18. Have the trusted Runtime capture the exact repository/code state consumed
    and produced by coding nodes rather than trusting an Agent's self-report,
    and make failure, skip, mapping, join, retry, and timer propagation explicit
    Scheduler semantics. A terminal Run failure or cancellation drains or
    explicitly transfers every Runtime-owned active attempt first.
19. Linearize Graph Patches, Scheduler admission, result settlement, and graph
    sealing at one authoritative transactional boundary. Freeze the effective
    node definition and resource requirements when an attempt enters
    preparation.
20. Persist authoritative orchestration state and an append-only audit/event
    record transactionally. Recovery reconciles uncertain Dispatches instead
    of blindly sending prompts again.
21. Enforce hard Run bounds on graph growth, Dispatch count, concurrency,
    Coordinator activity, loops, and elapsed execution before adaptive graph
    authoring is enabled.
22. Define product-visible host lifecycle semantics. Closing Studio does not
    stop the Runtime while Electron Main remains alive, but the initial local
    architecture does not claim execution continues after the kmux host exits.
23. Keep command, network, Git publication, and other external-effect executors
    disabled until their deny-by-default policy and reconciliation contracts
    are implemented.
24. Use FlowGram Free Layout as the Studio's authoring and visualization
    toolkit, not as kmux's authoritative production Runtime or persistence
    schema.
25. Keep the built-in Runtime and saved-workflow catalog independent from the
    optional Agent-facing orchestration skill. Install that skill only after an
    explicit user setup action for selected Agent runtimes; never as a side
    effect of opening or running a workflow.
26. Add `Workflows` beside `Usage` and `Sessions` in the existing right
    dashboard. The tab owns workflow listing and creation, while a large modal
    owns read-only diagram viewing, editing, publishing, and Run initiation.

## Non-goals

This ADR does not:

- guarantee identical outputs from the same LLM, model, prompt, or Agent
  session across Runs
- require natural-language orchestration to plan the complete graph before any
  worker starts
- automatically save every ad hoc orchestration as a reusable workflow
- make FlowGram's runtime engine or raw editor JSON authoritative
- require wire, database, or CLI compatibility with Orca
- implement every Orca feature in the first milestone; it preserves the domain
  model needed for equivalent workflows
- execute arbitrary JavaScript, native code, or renderer components embedded in
  an imported workflow
- infer filesystem safety, merge correctness, or semantic conflicts from node
  positions or prompts
- provide OS-level filesystem sandboxing for read-only review agents
- introduce an active-active multi-host scheduler in the first implementation
- replace existing coding-agent CLIs with direct model API calls
- change terminal rendering, scrollback, hydration, attach, or restore
  semantics
- store terminal byte streams or full transcripts in the core application
  reducer

## Terminology

### Workflow Studio

The **Workflow Studio** is the FlowGram Free Layout-based editor and Run
visualizer. It authors drafts, validates and publishes versions, starts Runs,
and projects runtime state over nodes. It does not own execution state.

### Editor Document

An **Editor Document** contains FlowGram-specific layout, positions, groups,
collapsed state, and form values. It may temporarily be invalid while a user is
editing. It is stored as authoring metadata and never executed directly.

### Workflow Definition and Version

A **Workflow Definition** is the canonical, editor-independent declarative
form. A published **Workflow Version** is immutable, validated, content-hashed,
and suitable for execution.

### Run Graph

A **Run Graph** is the durable graph for one execution. It contains the
materialized nodes, control edges, data mappings, policies, and graph revision.
It may originate from a Workflow Version or be created incrementally by an
Agent Coordinator.

Changing a Run Graph never mutates its source Workflow Version.

### Graph Authoring State

Every Run Graph has an explicit authoring state:

- `open` accepts authorized, revisioned Graph Patches
- `sealed` rejects graph-authoring mutations while allowing the Scheduler to
  finish already-defined work

Lack of runnable work is a derived quiescence observation, not an authoring
state and not proof of Run completion.

### Workflow Run

A **Workflow Run** owns one Run Graph, inputs, status, coordination authority,
runtime policies, messages, results, artifacts, and provenance.

### Coordinator Turn

A **Coordinator Turn** is one durable activation of an Agent Coordinator. It
records the authority epoch, triggering objective or event range, consumed
inbox cursor, starting and resulting graph revisions, status, and any Patch or
seal receipt. Coordinator progress is not reconstructed from terminal prose.

### Run Node or Task

A **Run Node** is the runtime work item corresponding to a declarative node or
an ad hoc Task. `Task` is the user- and agent-facing coordination term; `Run
Node` is the scheduler term. They share one durable identity.

### Node Attempt or Dispatch

A **Node Attempt** is one attempt to execute a Run Node. An Agent attempt has a
**Dispatch** that binds the attempt to a concrete Agent
Surface/session/generation and supplies attempt-scoped lifecycle authority.
Retries create new attempts; they do not rewrite prior attempts.

### Scheduler

The **Scheduler** is deterministic application code that calculates ready
nodes, invokes executors, applies policies, and records transitions. It is the
only authority that advances Run and Run Node state.

### Agent Coordinator

An **Agent Coordinator** is an LLM-backed Agent that interprets an objective,
decomposes work, proposes Graph Patches, answers or routes questions, and makes
semantic decisions when requested. It calls the Runtime through typed,
authorized commands. It does not directly write orchestration storage or own
the Scheduler loop.

### Node Executor

A **Node Executor** is trusted kmux code registered for a canonical node kind,
such as Agent, Condition, Loop, Human Gate, Command, HTTP, or GitHub Pull
Request. Executable adapters stay in process composition roots and never cross
IPC.

### Agent Binding

An **Agent Binding** maps a workflow-level role such as `author` or
`security-reviewer` to an `AgentId`, launch preferences, target, cwd/worktree
policy, Surface policy, session policy, and restricted or ambient authority
mode. During a Run it may resolve to an exact target, worktree, Surface, logical
terminal session, concrete terminal generation, foreground Agent instance,
readiness receipt, and provider session claim.

### Node Result

A **Node Result** is the authoritative settled output of an attempt. It includes
an explicit outcome and summary, and may include bounded structured data,
artifacts, modified-file references, usage, and transcript references.

### Repository State Reference

A **Repository State Reference** identifies the exact target, repository,
worktree or immutable snapshot, Git HEAD, and bounded dirty-state artifact seen
or produced by a coding node. It is target-aware and content-hashed; it is not
an unqualified host path.

### Supervised Dispatch and Full Handoff

A **supervised Dispatch** retains lifecycle ownership and waits for an explicit
settlement. A **full handoff** transfers work to another Agent, confirms prompt
delivery, and stops supervising its completion. These are separate node and
command semantics.

## Architecture

```text
Natural-language /orchestration        FlowGram Workflow Studio
            |                                     |
            v                                     v
   Agent Coordinator                      Workflow Compiler
            |                                     |
            +---------- typed commands -----------+
                              |
                              v
                   kmux Orchestration Runtime
                 +-----------------------------+
                 | Run store and Run Graph     |
                 | Scheduler and validation    |
                 | Messages, gates, lifecycle  |
                 | NodeExecutor registry       |
                 +-----------------------------+
                    |            |            |
                    v            v            v
                 local        SSH target    integrations
                 Target       services      Git/HTTP/etc.
                    |
                    v
            Surface -> terminal session -> coding-agent CLI
```

The Studio and Agent Coordinator are two graph-authoring surfaces. They do not
create two runtime modes. A Run may be:

1. **declarative**: materialized from a published Workflow Version
2. **ad hoc**: created from an objective and expanded by an Agent Coordinator
3. **hybrid**: materialized from a Workflow Version and extended through
   explicitly authorized, Run-scoped Graph Patches

All three use the same Scheduler, entities, lifecycle, target services, and
recovery rules.

## Authority and Process Boundaries

### Orchestration Host

Every Run has one authoritative **Orchestration Host**. In the first local
implementation this is Electron Main. It owns scheduling, persistence,
executor composition, and command authorization.

Remote workers may run through ADR 0005 target services while the Run remains
authoritative on the local Orchestration Host. Remote completion and hook
events use the existing authenticated, durable remote event path. A future
headless or remote authoritative host may implement the same contracts, but a
Run has only one authoritative scheduler at a time.

The first implementation does not synchronize two independently writable Run
databases and does not elect active-active schedulers.

### Electron Main

Electron Main:

- accepts trusted renderer IPC and authenticated CLI/socket commands
- owns the local Orchestration Runtime and durable store
- composes the NodeExecutor registry
- routes target-local work through `TargetServiceRegistry`
- sends bounded renderer projections and runtime events
- reconciles nonterminal Runs during startup

### `pty-host`

`pty-host` remains the local terminal data plane. It owns live PTYs, input
ordering, terminal buffers, and terminal output continuity. It may report
session/process facts and acknowledged input delivery, but it does not:

- store Workflow Definitions or Run Graphs
- decide which node runs next
- evaluate branches or retries
- parse arbitrary agent prose into workflow state

### Renderer

The renderer owns FlowGram views and editing interaction. It sends commands to
Main and renders serializable projections. Closing the Studio or switching
workspaces cannot pause the Scheduler or detach a terminal session.

On load or reconnect, the renderer requests an authoritative revisioned Run
snapshot. If incremental runtime events are supported, a detected revision gap
causes a new snapshot request rather than local graph repair. The exact
snapshot/delta transport is a follow-up protocol decision.

### Agent Processes

Agent processes are untrusted execution participants. An Agent may call
capability-scoped orchestration commands, but its terminal output and generated
JSON are data subject to validation. An Agent does not gain storage mutation
authority merely because its prompt says it is a coordinator.

### Host Lifecycle and Quit Semantics

Durable orchestration means state can be recovered; it does not by itself mean
that local work continues without an Orchestration Host. The initial product
contract is:

| Host event                                     | Scheduler                                | Local supervised worker                       | Remote worker                          |
| ---------------------------------------------- | ---------------------------------------- | --------------------------------------------- | -------------------------------------- |
| Studio/renderer close or reload                | continues in Main                        | continues                                     | continues                              |
| last window closes while Main remains resident | continues                                | continues                                     | continues                              |
| OS suspend/sleep                               | paused until host resumes and reconciles | no progress guarantee                         | may continue                           |
| graceful kmux quit                             | stops new admission and checkpoints      | termination is confirmed or remains uncertain | may continue without new scheduling    |
| Main crash/host unavailable                    | unavailable until recovery               | no continuity guarantee                       | may continue without new scheduling    |
| Main restart                                   | reconciles before admission              | rebinds only if exact identity is proven      | reconnects and consumes durable events |

On graceful quit the Runtime first stops new Scheduler admission and commits a
shutdown/recovery checkpoint. A local attempt becomes canceled only if the
exact target/PTY boundary returns and persists a termination receipt; otherwise
its execution, delivery, cancellation, and leases remain uncertain for startup
reconciliation. Remote activity may continue, but no new graph transition is
claimed while the authoritative host is absent.

The UI must distinguish **Close Studio**, **keep kmux running in background**,
and **Quit kmux** when nonterminal Runs exist. It must not advertise “continues
after app exit” unless a future headless/remote authoritative Host has accepted
ownership through an explicit handoff protocol.

## Canonical Workflow Model

The canonical model is independent of FlowGram and conceptually contains:

```ts
interface WorkflowDefinition {
  definitionId: string;
  version: number;
  name: string;
  inputSchema?: JsonSchemaRef;
  outputSchema?: JsonSchemaRef;
  agentBindings: Record<string, AgentBindingDefinition>;
  nodes: WorkflowNodeDefinition[];
  edges: WorkflowControlEdge[];
  policies: WorkflowPolicies;
}

interface WorkflowNodeDefinition {
  id: string;
  kind: NodeKind;
  title: string;
  config: JsonValue;
  inputMapping?: InputMapping;
  resultSchema?: JsonSchemaRef;
  retryPolicy?: RetryPolicy;
  timeoutPolicy?: TimeoutPolicy;
}

interface WorkflowControlEdge {
  id: string;
  from: { nodeId: string; port?: string };
  to: { nodeId: string; port?: string };
}
```

This is illustrative rather than the final TypeScript schema. The following
semantics are normative:

- node identity is stable within one Workflow Version
- execution order comes from control edges and ports, never canvas position
- data mappings are separate from terminal transcript transport
- Agent nodes reference a role through `agentRef`
- node configuration is validated by the registered node kind
- a published version is immutable
- unknown executable node kinds cannot run
- presentation metadata does not affect execution

### Canonical Schema v1 Gate

The illustrative interfaces above are not sufficient to begin supervised
execution. Phase 1 must produce a machine-readable Canonical Schema v1 and a
matching TypeScript domain package before Phase 2 starts. Together they define
at least:

- discriminated node and executor configuration unions
- typed control and data ports, mappings, defaults, and missing-value behavior
- declared Run outputs, explicitly required side effects, and node completion
  roots used by the required-reachability algorithm
- Agent bindings, session/worktree policies, and capability requirements
- join, branch, loop, retry, timeout, failure, and cancellation policies
- result, artifact, Repository State, Dispatch, delivery, lease, message, gate,
  Coordinator Turn, and Graph Patch contracts
- Run limits and the versioned restricted-expression contract
- strict unknown-field and unsupported-version behavior at trust boundaries

Schema validation, canonical serialization, content hashing, and TypeScript
validation must agree through golden fixtures. Phase 1 also supplies migration
fixtures from every supported stored version, plus an explicit refusal path for
versions that cannot be migrated. A renderer form schema or FlowGram Editor
Document is not a substitute for this contract.

Later schema evolution remains a narrower implementation decision, but the v1
schema, validator, canonicalizer, and initial migration harness are blocking
deliverables rather than optional follow-up work.

### Draft, Publish, and Run

The Studio may save an invalid Draft. Publish performs full validation and
creates an immutable Workflow Version. Run always pins one exact version and
content hash.

Editing and republishing produces a new version. Existing and recovered Runs
continue using their pinned version plus any recorded Run-scoped patches.

Publish validates the workflow's declared requirements and compatibility
constraints; it does not require the publishing machine to currently provide
every requested Agent, model, target, or integration. Run admission resolves
those requirements against the selected environment, and each Dispatch
revalidates mutable capabilities and concrete resource identity immediately
before effects.

The Workflow Version pins compiler, canonical schema, node configuration, and
restricted-expression semantics versions. Run and attempt receipts record the
effective executor and Agent descriptor revisions plus requested/effective
launch configuration. Recovery never silently reinterprets an existing Run
under incompatible updated semantics.

### FlowGram Compilation Boundary

The FlowGram integration owns three transforms:

```text
FlowGram Editor Document -> canonical Workflow Draft
canonical Workflow Draft -> initialized FlowGram Editor Document
canonical runtime state  -> FlowGram node-state projection
```

The compiler validates:

- unique and bounded node, edge, port, and binding IDs
- known node kinds and supported configuration versions
- required Start/Input and terminal semantics where applicable
- port and result-schema compatibility
- complete input mappings
- explicit branch destinations
- explicit loop boundaries and loop limits
- unreachable nodes and unresolved joins
- well-formed target, agent, model, worktree, and capability requirements,
  without treating current machine availability as workflow validity
- imported command or integration policies

FlowGram layout coordinates, groups, selection, and visual routing are stored
with the Editor Document but excluded from the canonical execution hash unless
they carry explicit execution configuration.

The Draft-to-Editor adapter preserves node kinds, IDs, ports, edges, mappings,
bindings, and execution policies while generating only missing editor metadata
and an initial best-effort layout. Its round-trip contract is semantic:
compiling an initialized Editor Document must produce a canonical-equivalent
Draft. Pixel coordinates and edge routing are not canonical and need not be
byte-for-byte deterministic.

## Run Graphs and Natural-Language Orchestration

### Saved Workflow

Starting a saved workflow performs:

```text
Workflow Version + validated Run inputs
    -> materialized sealed Run Graph revision 1
    -> persisted Workflow Run
    -> Scheduler start
```

No Agent Coordinator is required merely to interpret known edges or policies.
Agent/Judge nodes still run wherever the workflow explicitly places them.

### Ad Hoc Request

Starting a natural-language orchestration performs:

```text
Objective
    -> Workflow Run with an empty or seeded Run Graph
       and authoringState=open
    -> Agent Coordinator receives scoped graph-authoring capability
    -> durable Coordinator turn consumes the objective/event cursor
    -> Coordinator adds Tasks, dependencies, bindings, and policies or seals
    -> Scheduler runs ready nodes as valid patches commit
```

The Coordinator may initially create the entire graph, but it is not required
to. This preserves Orca-like adaptive coordination: a coordinator can inspect
results, ask questions, add a reviewer, retry with a different Agent, or
decompose a failed Task while the Run remains durable.

Ad hoc graphs are `ephemeral` in the product sense: they belong to the Run and
are not automatically added to the reusable workflow catalog. Their complete
Run Graph and revision history are still persisted for audit and recovery.

After completion, a user may choose **Save as workflow**. That operation creates
a new Draft from the final graph after removing Run-only identity, result,
Surface, session, secret, and transient placement data, then initializes an
editable FlowGram Editor Document from that Draft. It never silently publishes
the generated workflow.

### Hybrid Run

A saved workflow may allow explicit adaptation through:

- a Coordinator Agent node with scoped patch authority
- a user-approved Run override before start
- an authorized user Patch during execution

The base Workflow Version remains immutable. The Run records its base version,
patches, authors, approvals, and resulting graph revisions.

An adaptive hybrid Run materializes its base graph as `open`. A non-adaptive
saved Workflow materializes as `sealed`. Merely placing an ordinary Agent or
Judge node in a saved Workflow does not make its graph open.

### Graph Authoring, Coordinator Turns, and Sealing

The Orchestration Host, not an Agent terminal, owns Coordinator activation.
For an adaptive Run it durably records a wake reason and schedules a
Coordinator Turn when policy requires semantic follow-up, including:

- the initial objective
- completion or failure of work the Coordinator is supervising
- a worker question or escalation
- a rejected Graph Patch requiring re-planning
- a Human Gate or user reply addressed to the Coordinator

Each turn records a stable turn ID, authority epoch, triggering event range,
consumed inbox cursor, starting graph revision, terminal status, and resulting
Patch, message, or seal receipts. Only one turn for the same coordination
principal and authority epoch may actively author a Run at a time. Replaying a
turn or delivery uses its idempotency identity and cannot apply the same Patch
twice.

An open Run Graph with no runnable node is `waiting_for_coordinator` or
`needs_attention` according to policy. It does not succeed merely because the
current graph is empty or quiescent. The Coordinator may leave the graph open
while waiting for worker evidence and may add follow-up work in a later turn.

Graph authoring ends through a typed command conceptually equivalent to:

```text
sealGraph(runId, expectedGraphRevision, consumedEventCursor, idempotencyKey)
```

Sealing is transactional, checks the active coordination authority and expected
revision/cursor, and records a durable receipt. The cursor must equal the
current high-water mark for Coordinator-required events; if a worker result,
question, escalation, or other wake event commits concurrently, sealing fails
with the new cursor rather than hiding that evidence. A sealed graph rejects
new nodes, edges, bindings, or authoring Patches. Existing lifecycle commands
such as reply, cancel, retry under an already-declared policy, and gate
resolution remain available.

Sealing also requires every remaining node and failure path to have a fixed
policy that does not require future graph authoring. Active work may remain, but
a node configured to require Coordinator re-planning on its future result or
failure prevents sealing until that obligation is resolved or explicitly
replaced by a fixed policy.

A Run may become `succeeded` only when all of the following hold:

- its Run Graph is sealed
- every required reachable node has reached an allowed terminal state
- no attempt is preparing, active, cancellation-pending, or uncertain
- no required question, Human Gate, delivery, or Coordinator Turn is unresolved
- the declared Run outputs are resolved and schema-valid

An Agent process or retained terminal does not have to exit, become idle, or
finish producing all future terminal output for the Run to succeed.

A failed, canceled, or settled Run is never silently reopened. Additional work
starts a new Run with explicit continuation provenance such as
`continuationOfRunId`, or starts from a newly materialized Workflow Version.

## Graph Patch Contract

Every Graph Patch includes:

- Run ID
- expected graph revision
- expected state revisions for every existing node or dependency set it touches
- author principal and capability
- bounded add/update/cancel operations
- a stable idempotency key
- optional reason and source node/attempt

The Runtime applies a Patch transactionally or rejects it without partial
effects.

The initial Patch policy is intentionally conservative:

- graph-authoring Patches require `authoringState=open`
- new pending nodes and edges may be added
- pending node configuration may be replaced when no dependent work has begun
- active, settled, skipped, or canceled attempts are immutable
- a settled node may be followed by a new correction node; it is not rewritten
- an active node may receive guidance or cancellation through lifecycle
  commands, not by editing its definition
- arbitrary graph cycles are rejected
- iteration is expressed by an explicit Loop node/container with a bound and
  termination contract
- dependencies cannot be added in a way that retroactively makes an active or
  settled node unready
- deleting history is not a Patch operation
- stale expected revisions are rejected with the current revision
- sealing is a separate authority-checked command and cannot race a Patch at
  the same expected revision

A Coordinator may re-plan after a rejected Patch, but the Runtime never asks
an LLM to resolve a storage conflict implicitly.

### Scheduler and Graph-Mutation Linearization

Graph Patches, Scheduler admission, node/result settlement, branch selection,
Coordinator event consumption, and graph sealing all commit through one
authoritative transactional mutation boundary. An implementation may use a
serialized command queue, database transactions with compare-and-set, or both;
it may not let separate renderer, skill, or executor schedulers race those
mutations.

Each materialized node has a monotonic state revision. A Patch that changes an
existing pending node, one of its dependency sets, or an edge that can affect
its readiness must match both the graph revision and the affected node state
revisions. Only a node that is still `pending` after those checks may be
changed. A `ready`, `preparing`, active, or terminal node is definition-frozen;
follow-up behavior is represented by a new node or a lifecycle command.

Scheduler admission atomically:

1. rechecks readiness, graph revision, node state revision, Run budgets, and
   resource policy
2. transitions the node from `ready` to `preparing`
3. creates the immutable attempt identity
4. records the effective node-definition hash, resolved input mappings,
   executor/configuration revisions, and requested resource requirements

No PTY, filesystem, process, network, or provider effect occurs before this
commit. A concurrent Patch therefore either commits before admission and is
part of the frozen attempt or loses its revision check and is rejected. Result
commit and the next Scheduler evaluation likewise share an ordered durable
boundary; a scheduler tick never observes a result that has not committed.

## Scheduler Semantics

The Scheduler is deterministic with respect to persisted Run state and node
results. This does not make Agent output deterministic.

Given the same graph revision, settled results, policies, and external command
receipts, the Scheduler must select the same control edges and next node states.
It does not rerun a completed Agent to reconstruct a missing decision during
recovery.

### Run Limits and Budgets

Every Run resolves a durable `RunLimits` policy before work is admitted. Fixed
workflows declare limits within host maxima; adaptive Runs receive conservative
host defaults. A Coordinator capability may consume but cannot raise its own
limits. Increasing a limit requires an independently authorized user or policy
command and an audit receipt.

The Runtime must be able to enforce at least:

- maximum nodes, edges, graph depth, fan-out, and loop iterations
- maximum active attempts and per-target/session concurrency
- maximum total Dispatch attempts, including retries
- maximum Coordinator Turns and accepted Graph Patches
- maximum wall-clock Run duration and cumulative active-execution duration
- maximum artifact and structured-result bytes retained by the Run

Provider-reported tokens, cost, or tool usage are recorded when trustworthy.
They may become hard limits only when the provider and executor expose
consistent metering; absence of reliable monetary accounting never disables
the host-enforced graph, Dispatch, time, and storage limits above.

A budget exhaustion is a typed policy event. It stops admission of new work and
selects the declared `needs_attention`, gate, seal, fail, or cancel policy. It
does not prove that an already-running external process stopped, release its
leases, or authorize an implicit retry. Budget counters and deadlines are
persisted so restart cannot reset them.

### Node State

The canonical Run Node states are conceptually:

```text
pending -> ready -> preparing -> running
                    |             +-> waiting_input/waiting_gate -> running
                    |             +-> needs_attention
                    |             +-> cancel_requested -> canceled
                    |                                     -> uncertain
                    |             +-> succeeded
                    |             +-> failed
                    +----------------> skipped/failed/uncertain
```

Exact wire names may differ, but the domain must distinguish at least:

- not yet eligible
- eligible for dispatch
- resource preparation
- active execution
- durable wait for input or a gate
- cancellation requested but not yet confirmed
- terminal success/failure/cancellation
- branch skip
- uncertain state requiring reconciliation

`blocked` may be a user-facing projection over `waiting_input`,
`waiting_gate`, or `needs_attention`. It is not both a nonterminal lifecycle
state and a settled result outcome.

Run status is derived from graph authoring state, Coordinator turns, node and
attempt state, required deliveries, and gates rather than from a terminal color
or currently focused Surface.

### Fan-out and Fan-in

When multiple successors become ready, the Scheduler may execute them in
parallel subject to explicit concurrency, target, and worktree policies.

A node with multiple incoming control dependencies has an explicit join policy.
The Studio may default ordinary multiple-input nodes to `all-successful`, but
the canonical form records the resolved policy. Supported policies can grow
from:

- `all-successful`
- `all-settled`
- `any-successful`

Branch paths not selected by a Condition are marked skipped according to
structured branch semantics so downstream joins do not wait forever on
unreachable work.

Canvas edge creation order and visual position never define sequencing.

### Failure, Skip, Join, and Dataflow Semantics

The canonical Run Graph records control dependencies and data dependencies
separately. A required input mapping from another node creates a data dependency
even if the author did not draw a separate control edge. The compiler either
materializes that dependency or rejects the workflow; the Scheduler never reads
an unfinished result opportunistically.

A node becomes ready only when its selected control policy is satisfied and
every required input mapping is resolvable. An optional mapping must declare a
default or explicit missing-value behavior. Results from failed, canceled, or
skipped nodes are unavailable to ordinary success mappings unless the target
node explicitly accepts settled outcome metadata.

The following propagation rules are normative:

| Predecessor or evaluation outcome           | Required Scheduler effect                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `succeeded`                                 | expose its validated result and selected success ports                             |
| unselected branch                           | record `skipped` with branch provenance; exclude the unselected path from its join |
| required predecessor `failed` after retries | take its error policy; skip unreachable success-only descendants                   |
| required predecessor `canceled`             | take its resolved cancel policy and mark unreachable descendants `skipped`         |
| predecessor waiting or `uncertain`          | remain nonterminal; allow no downstream readiness                                  |
| required input mapping failure              | fail before Dispatch unless an optional/default mapping applies                    |
| Condition evaluation failure                | take the declared error port or fail the Condition                                 |
| loop maximum reached                        | take the declared max-reached port/outcome; never infer success                    |
| `any-successful` with no possible success   | settle with a typed unsatisfied-join outcome                                       |

For `all-successful`, every selected required predecessor must succeed.
For `all-settled`, all selected predecessors must be terminal and the target
receives only the outcome metadata and mappings it explicitly declares. A
`skipped` node has skip provenance but no fabricated Agent `NodeResult`.

Every materialized node has resolved failure and cancellation propagation
policies. A fixed declarative workflow defaults an unhandled required failure
to beginning Run settlement toward `failed` after marking unreachable
success-only descendants skipped. An adaptive workflow may instead resolve the
policy to wake its Coordinator and enter `waiting_for_coordinator`. The Runtime
never leaves descendants pending forever because a policy was omitted.

### Run Failure and Cancellation Drain

Selecting a terminal Run failure or cancellation is a two-stage transition:

```text
running -> settling(targetOutcome=failed|canceled) -> failed|canceled
```

Entering `settling` is durable and stops admission of new work. The Scheduler
marks unreachable, not-yet-started nodes according to their resolved propagation
policy and applies each active sibling's resolved `wait`, `cancel`, or full
handoff disposition. The default for an unhandled fixed-workflow failure is to
request cancellation; waiting or handoff must be explicit.

The Run becomes terminal only after no Runtime-owned attempt remains preparing,
active, cancellation-pending, or uncertain, and all required delivery and lease
transitions have settled. A full handoff counts as drained only after its
transfer receipt and external lease ownership are durable. If cancellation or
ownership remains uncertain, the Run stays `settling` with `needs_attention`;
it is not marked failed or canceled early. Late results for exact active
attempts are recorded and used to finish the drain, but never reopen admission
or erase the selected target outcome.

### Required Reachability and Join Resolution

The compiler and Scheduler use one versioned required-reachability algorithm;
Run completion is not an ad hoc scan for nodes that happen to remain pending.
The canonical form resolves each terminal output and explicitly required
side-effect as a completion root. For the currently selected branch ports and
materialized loop iterations, the Runtime computes the reverse closure of those
roots over selected control dependencies and required data mappings.

The rules are:

- an unresolved Condition, required mapping, Loop outcome, or Coordinator
  authoring obligation remains possible and prevents premature completion
- an unselected branch is excluded from the required closure and its nodes are
  durably marked `skipped` with selection provenance
- Loop iterations have iteration-scoped node identities; only materialized
  iterations participate, while the Loop remains nonterminal until its break,
  success, failure, or max-reached outcome is recorded
- `all-successful` requires every selected predecessor to succeed
- `all-settled` requires every selected predecessor to settle and exposes only
  explicitly mapped outcome metadata
- `any-successful` remains satisfiable while at least one selected predecessor
  can still succeed, fires once after the first committed success, and produces
  a typed unsatisfied-join result only after all candidates settle without one
- after an early `any-successful` fire, other supervised attempts follow an
  explicit wait, cancel, or detach/handoff policy; they are not silently
  abandoned and their uncertain resources cannot be reused
- a Patch may alter required reachability only for nodes and dependency sets
  that remain mutable under the Graph Patch linearization rules

The algorithm version and selected predecessor set are persisted with join and
Run-settlement receipts. Recovery replays those receipts rather than deriving a
different required set from a newer implementation.

### Conditions

A Condition node evaluates a restricted expression over persisted, schema-
validated values such as:

```text
nodes.reviewJudge.result.data.acceptedImportantCount > 0
```

The evaluator:

- has no filesystem, network, process, secret, or terminal access
- does not use JavaScript `eval`
- has bounded input size and execution cost
- returns a typed port or an evaluation failure
- records the expression version, inputs, and selected port

If semantic interpretation is required, the workflow uses an explicit Agent or
Judge node before the Condition.

### Loops

Loops are explicit structured containers or node kinds. They are not arbitrary
back-edges accepted by the generic graph validator.

Every automated loop declares:

- maximum iterations
- iteration input and accumulated output mapping
- success/break and continue behavior
- behavior when the maximum is reached
- retry and cancellation interaction

A Human Gate may wait indefinitely according to retention policy; an Agent loop
cannot be unbounded by omission.

### Retry

Retry creates a new attempt with a new attempt/Dispatch identity and a link to
the previous attempt. The retry policy declares:

- maximum attempts
- retryable failure classes
- backoff, if any
- whether Agent/session/worktree placement may be reused
- whether a human or Coordinator must approve a placement change

The Runtime does not silently reuse an uncertain terminal or silently move a
write-capable Task to another worktree.

When retry backoff applies, the Runtime persists the absolute `notBefore` time,
timer class, source attempt, and policy/configuration version before waiting.
Recovery compares the persisted deadline with the current clock; it does not
restart a relative delay from application startup.

### Timeout

A timeout is a policy event, not proof that an Agent failed. Long-running Agent
nodes may still be active after a wait window expires.

Policies may:

- emit a liveness checkpoint
- request status
- move the Run to `needs_attention`
- ask for user/Coordinator action
- cancel an attempt and then retry

Only explicit policy authorizes cancellation or replacement.

Timeout policies persist an absolute `dueAt` plus the state transition and
policy version that created it. Timer firing is an idempotent Runtime command.
An app restart may delay observation of a deadline but cannot create a second
timeout effect or silently extend the deadline.

## Node Executors

Node kinds are registered through a trusted, capability-oriented registry
similar to ADR 0006 Surface kinds and ADR 0007 Agent modules.

An executor provides narrow behavior such as:

- configuration validation and version migration
- input-schema resolution
- resource preparation
- start/resume/cancel/reconcile operations
- result validation
- serializable presentation descriptors

The complete executor registry remains private to the Orchestration Host
composition root. The renderer receives descriptors and form schemas, not
executable objects. Remote execution receives a bounded portable request only
when the target advertises the required capability.

Initial canonical node families are expected to include:

- Start/Input and End/Output
- Agent
- Coordinator Agent
- Condition
- Loop, Break, and Continue
- Human Gate
- data transform or restricted Code
- Command/Tool
- HTTP/integration
- Git/Commit/Pull Request
- Notification

This list is not an MVP commitment. Unknown or unsupported executable kinds
fail validation or enter a typed unsupported state; the Runtime never asks an
LLM to guess their behavior.

Imported workflows cannot provide arbitrary executor code. Future third-party
nodes require a separate security and plugin ADR.

### Executor Enablement Policy

Listing a node descriptor in Studio does not authorize its execution. Command,
restricted Code, HTTP/network, Git publication, notification, and other
external-effect executors remain disabled until the Orchestration Host
registers both a trusted implementation and a versioned deny-by-default
`ExecutorPolicy` for that node kind.

The policy model covers, as applicable:

- executable identity and allowed argument shapes; no implicit shell-string
  interpolation
- target authority, repository/worktree identity, and allowed working roots
- environment and secret references, including which destination may receive
  each secret
- network scheme, method, host, port, path class, and redirect behavior
- Git remote, branch/ref, force-update, Commit, push, and Pull Request authority
- artifact read/write classes, payload and response size, and retention limits
- whether preview, Human Gate, organization policy, or per-Run approval is
  required

Publish validates the workflow request, Run admission intersects it with host
and target policy, and every external invocation revalidates the effective
policy immediately before the effect. Imported definitions and Coordinator
Graph Patches pass through the same checks and cannot broaden host authority.
A disabled or denied executor produces a typed unsupported/denied result; the
Runtime never asks an Agent to emulate it as an untracked command.

Agent nodes are not exempt from this boundary merely because their effects are
initiated inside a coding-agent CLI. Each Agent binding declares one authority
mode:

- `restricted` is valid only when its executor can technically enforce the
  declared filesystem, tool, network, and Git limits
- `ambient` honestly permits the Agent to use the shell and provider tools
  available in its target environment

Prompt instructions such as "review only" do not make an Agent `restricted`.
An `ambient` Agent node requires a recorded admission approval, supplied by an
independently configured host policy or an authorized user, scoped to the Run,
Agent, target, repository/worktree, and the ambient authority actually exposed
there. The UI discloses known filesystem-write, network, and Git capability
classes, but may describe a class as denied only when the executor or target can
enforce that denial. An imported definition or Coordinator Patch may request
authority but cannot grant its own approval. Without a matching approval the
node is denied or enters a Human Gate.

The Runtime does not claim per-command idempotency or interception for effects
performed inside an approved ambient Agent. Workflows that require a durable,
reconcilable Commit, push, Pull Request, HTTP mutation, or notification use the
corresponding trusted effect node instead.

### External Side Effects

Executors that create external effects, including Commit, push, Pull Request,
HTTP mutation, and notification nodes, use a durable effect intent and receipt.
The Runtime persists the operation identity, canonical payload hash, executor
and configuration version, and expected resource identity before invocation.

When a provider supports idempotency or correlation keys, the executor uses the
Runtime operation identity. Otherwise it implements bounded reconciliation,
such as finding the exact previously created Pull Request from recorded
provider metadata. A response lost after a possible external effect produces
`outcome_unknown`; it is never treated as failure followed by blind creation
retry.

All such executors implement a common durable effect state contract:

```text
intent_recorded -> executing -> applied
                             -> confirmed_absent
                             -> outcome_unknown -> reconciling
                                                -> reconciled_applied
                                                -> reconciled_absent
                                                -> needs_attention
```

`confirmed_absent` or `reconciled_absent` requires provider- or target-specific
evidence that the effect did not occur; timeout, disconnect, missing response,
or process exit is not that evidence. Only an `applied`, `confirmed_absent`, or
equivalent reconciled receipt allows the declared downstream policy to advance
or retry. The common executor interface exposes `prepare`, `invoke`,
`queryStatus`, and `reconcile` behavior with operation identity and canonical
payload hash, even when a provider adapter implements the evidence differently.

## Agent Nodes and Resource Binding

### Agent Role, Agent Process, and Task

An Agent node means “one task performed through an Agent binding.” It does not
necessarily mean “start a new Agent process.” Multiple nodes may reference the
same role and reuse one Agent session.

Example:

```yaml
agentBindings:
  author:
    agentId: codex
    surfacePolicy: create-or-reuse
    sessionPolicy: reuse
    worktreePolicy: dedicated

nodes:
  - id: implement
    kind: agent
    agentRef: author

  - id: apply-review
    kind: agent
    agentRef: author
```

The Run records the exact resolved binding:

```text
agentRef -> target authority -> repository/worktree -> Surface
         -> logical terminal session -> concrete terminal generation
                                    -> foreground Agent instance
                                    -> readiness receipt
                                    -> provider session claim, when provable
```

The second node can therefore deliver a fresh Task envelope to the exact author
Surface instead of launching another Codex process.

### Session Policies

Canonical policies include at least:

- `fresh`: create a new Agent terminal/session
- `reuse`: require the Run binding's same Agent instance to be provably ready;
  otherwise enter `needs_attention`
- `prefer-reuse`: reuse only when identity and readiness are provable;
  otherwise start a fresh Agent session
- `existing`: require an explicitly selected existing Surface and prove its
  foreground Agent before input

Provider-native session fork or resume is a capability, not a universal
assumption. A workflow that requests an unsupported policy fails validation or
requires a user-selected fallback.

Every Agent prompt injection requires a fresh executor-specific readiness
receipt. A terminal generation, PTY-write capability, shell prompt, or generic
TUI-idle signal alone does not prove that the expected Agent CLI is still in the
foreground or ready for a new turn. The receipt binds the terminal generation,
effective `AgentId`, an opaque foreground Agent instance identity, and a
monotonic ready/turn epoch. A verified provider session may strengthen that
proof but is not universally required; an inferred provider session is
observational metadata only. A fresh launch that cannot produce the receipt
fails preparation or enters `needs_attention` and receives no Task bytes.

Admitting an explicitly selected, user-owned existing Surface into supervised
input ownership requires visible user consent and records its prior owner and
input mode. A workflow cannot silently block the keyboard or take control of a
terminal merely because it knows the Surface ID. Release or handoff restores
the recorded ownership mode; if that cannot be proven, the binding enters
`needs_attention` rather than guessing.

A concrete interactive Agent session has supervised Dispatch capacity one by
default. Multiple ready nodes that resolve to the same reusable session are
queued by the Scheduler; their prompts are not injected back-to-back while an
earlier attempt remains active, cancellation-pending, or uncertain. Parallel
work requires distinct concrete sessions or an executor that explicitly
advertises and enforces higher capacity.

### Worktree and Write Policy

Workflow configuration makes placement explicit. Policies may select:

- current/exact existing worktree
- dedicated child worktree
- dedicated top-level worktree
- target-local repository plus new top-level worktree
- advisory read-only use of a shared worktree

Read-only is not an OS sandbox unless a future executor provides one. The UI
must not claim otherwise.

Parallel write-capable Agent nodes in the same worktree are rejected by default
unless the workflow explicitly opts into shared-write concurrency. An opt-in is
recorded in the Run and does not make conflicts automatically safe.

The Scheduler acquires durable resource leases before Dispatch:

- a terminal-session lease admits at most the session's declared supervised
  capacity
- a worktree read lease may be shared only with other readers
- a worktree write lease is exclusive against both readers and writers

Lease ownership is bound either to the active attempt and concrete terminal
generation or to a durable external-handoff owner. A supervised lease is
released only after settlement, confirmed cancellation, or explicit
reconciliation proving the process can no longer act on the resource. A
handoff lease remains fenced until explicit reclaim proves the external owner
can no longer act. Losing transport, requesting cancellation, completing the
handoff node, or settling its originating attempt does not release it.

Each durable lease has a stable lease ID, monotonic lease revision/owner epoch,
resource identity, owner kind and ID (`attempt` or `external-handoff`), owner
terminal generation when applicable, mode/capacity claim, and reconciliation
state. Acquisition, transfer, reclaim, and release use compare-and-set against
that revision. Recovery distinguishes at least `active`, `uncertain`,
`reconciling`, `released`, and `abandoned`; only `released` is available for
ordinary reuse. `abandoned` means kmux stopped supervising the owner, not that
the external process stopped acting.

Leases do not expire merely because a wall clock elapsed or a heartbeat was
lost. A TTL could admit a second writer while an unreachable Agent still
modifies the worktree. Heartbeats may trigger reconciliation or attention, but
only authoritative process/generation evidence or a policy-approved isolated
replacement changes resource availability.

These leases are Scheduler admission and ownership controls, not an OS
sandbox. An unrelated user process may still mutate a worktree; detected state
drift invalidates the affected Repository State reference and stops automatic
write reuse.

Worktree lineage and Git base are separate choices. Target and worktree
resolution use ADR 0005 services and never reconstruct remote paths from local
IDs.

### Repository and Code-State Provenance

Coding workflows pass code state as a first-class, target-aware reference
rather than assuming that two nodes happen to observe the same directory.
Conceptually:

```ts
interface RepositoryStateRef {
  targetId: Id;
  repositoryId: Id;
  worktreeRef?: LocatedWorktreeRef;
  headOid: string;
  indexTreeHash?: string;
  dirtyPatch?: ArtifactRef;
  dirtyPatchHash?: string;
  untrackedManifest?: ArtifactRef;
  capturedAt: string;
  consistency: "immutable-snapshot" | "fenced-live-worktree";
}
```

Canonical Schema v1 defines the exact shape; these semantics are normative:

- a trusted Runtime repository adapter, not the Agent response, captures the
  Repository State a coding attempt consumed and the state observed after its
  semantic result submission
- `headOid`, changed paths, index/worktree identity, patch/content hashes, and
  consistency mode are derived from target/repository services while the
  attempt's required lease and generation fencing still hold
- an Agent may describe files it believes it changed, but that description is
  untrusted semantic data and cannot replace the Runtime-captured changed-path
  set or Repository State reference
- parallel reviewers of one implementation receive the same content identity,
  not merely the same branch name or logical worktree ID
- parallel reviewers default to separate review worktrees materialized from one
  immutable commit/tree plus content-addressed patch artifacts
- a live-worktree review requires a held/fenced state in which no writer can
  mutate the reviewed files until the review snapshot is captured
- a fixing node verifies its expected input state before writing; drift causes
  reconciliation or an explicit rebase/refresh step rather than silent writes
- cross-target review requires explicit artifact or repository-state transfer;
  an absolute path on one target is not a portable code-state reference

Capture failure, state drift, or a result arriving after the required fencing
is lost prevents automatic successful settlement and enters reconciliation or
`needs_attention`. Snapshot and patch artifacts are content-addressed and
bounded by Run/host limits; oversize content produces a typed storage-policy
outcome rather than silently dropping provenance.

Advisory read-only prompts remain distinct from these consistency guarantees
and are not an OS sandbox. Without executor-enforced filesystem isolation, a
shared live-worktree reviewer can still modify files; the UI must not describe
that mode as an immutable review.

### Model and Effort

Agent nodes may request opaque model and effort preferences supported by the
ADR 0007 agent capability. Requested values and effective launch receipts are
recorded separately. A requested flag is not proof of what a provider actually
launched.

## Dispatch and Prompt Delivery

A supervised Agent attempt produces a Dispatch with:

- Run, node, and attempt identity
- exact Agent binding, target authority, and Repository State input
- lifecycle mode and authority capability
- bounded Task specification
- input and artifact references
- result contract
- retry ancestry
- creation and delivery idempotency keys

The Dispatch resolves a concrete execution reference rather than treating a
logical session ID as a live worker:

```ts
interface TerminalExecutionRef {
  targetId: Id;
  targetAuthority: Id;
  surfaceId: Id;
  sessionId: Id;
  generation:
    | { kind: "local"; runtimeEpoch: Id }
    | { kind: "remote"; keeperGeneration: Id };
  inputAuthorityRef: Id;
  providerSessionClaim?: {
    id: string;
    trust: "verified" | "inferred";
  };
}

interface AgentReadinessReceipt {
  receiptId: Id;
  execution: TerminalExecutionRef;
  agentId: AgentId;
  agentInstanceId: Id;
  readyEpoch: Id;
  verifiedProviderSessionId?: string;
  state: "ready-for-input";
  observedAt: string;
}

interface PromptDelivery {
  operationId: Id;
  dispatchId: Id;
  execution: TerminalExecutionRef;
  readinessReceiptId: Id;
  payloadHash: string;
  state: "pending" | "accepted" | "written" | "uncertain" | "fenced" | "failed";
}
```

The local `runtimeEpoch` and remote `keeperGeneration` both identify one
concrete terminal generation. A renderer `attachId` is not necessarily the
orchestration identity: a local implementation may use a reserved,
generation-bound programmatic input authority, while remote execution may use
ADR 0005's writer lease and attachment contract. Either implementation must
fence stale writers and acknowledge the same delivery operation.

That terminal generation is necessary but not sufficient Agent identity. The
Agent executor or a trusted provider adapter issues the readiness receipt only
after verifying the expected foreground Agent instance and its current input
epoch. A stale receipt, changed foreground process, or mismatched Agent blocks
delivery before any bytes are written.

### Input Broker and User Intervention

All Scheduler, external, user, and injected input participates in one
generation-bound input broker and writer-fencing domain. The renderer is not a
hidden second writer, and existing best-effort terminal input cannot bypass the
broker while a session is under supervised ownership. Accepted input frames
cannot interleave bytes from different authorities.

A supervised binding resolves one explicit input mode:

- `orchestrated` is the default. Raw terminal keyboard input is blocked with a
  visible explanation; the user may send a recorded guidance command or request
  takeover.
- `interactive-recorded` serializes user frames through the same broker, tags
  their principal and operation identity, and records an external intervention.
  The intervention invalidates assumptions that require an untouched Agent
  turn or unchanged repository state and may force recapture/reconciliation.
- `takeover` durably transfers input ownership to the user and fences Scheduler
  prompt/guidance writes until ownership is explicitly returned or the attempt
  settles. Takeover does not prove that the Agent process stopped and does not
  release worktree or terminal leases.

Mode changes are authenticated, idempotent Runtime commands. Every attempt and
result records the effective mode and intervention history so downstream nodes
can apply policy rather than relying on an invisible terminal interaction.

The Agent Node Executor:

1. resolves or prepares the target, worktree, Surface, and logical session
2. acquires the required terminal/worktree leases and captures the exact
   Repository State input
3. resolves the concrete terminal generation and obtains a fresh readiness
   receipt for the expected foreground Agent instance
4. persists a `pending` delivery intent, operation ID, and payload hash before
   external input
5. sends a structured lifecycle preamble and Task envelope with the current
   generation-bound input authority
6. receives an idempotent acknowledgement at the terminal/target PTY-write
   boundary
7. records the delivery receipt and Dispatch as active transactionally

The target rejects a stale generation, stale readiness receipt or ready epoch,
changed foreground Agent, stale input authority, or conflicting payload hash
before writing bytes. Retrying the same operation against the same live
generation returns its prior receipt or continues only an explicitly supported
partial write. A transport loss after a possible write leaves the delivery
`uncertain`; the Runtime reconciles it and never injects it into a new
generation.

The target boundary exposes a query equivalent to:

```ts
queryPromptDelivery({
  execution: TerminalExecutionRef;
  operationId: Id;
  payloadHash: string;
}): "not_seen" | "accepted" | "written" | "conflict" | "unknown";
```

An executor advertising supervised delivery retains its operation
deduplication/status ledger for the lifetime of that concrete terminal
generation and across an Orchestration Host reconnect. The Runtime records the
returned receipt durably. If the generation is gone and neither side has a
durable receipt, the outcome remains `unknown`; absence of a receipt does not
prove `not_seen` and does not authorize replay to a replacement generation.

This protocol resolves the unavoidable ambiguity between a durable intent and
an external PTY write; it does not claim that the database and PTY are one
atomic transaction or promise cross-generation exactly-once delivery.

The existing generic local contract
`sendText(sessionId, text): Promise<void>` does not satisfy supervised delivery
because it lacks a concrete generation, operation identity, payload hash, and
acknowledgement. It may remain suitable for explicitly unsupervised,
best-effort terminal input, but the Agent Node Executor cannot use it as proof
of Dispatch delivery until the local target/PTY boundary exposes the stronger
contract.

Acknowledged terminal input means that kmux delivered bytes to a live session
boundary. It does not prove that the Agent understood, accepted, or completed
the Task.

Guidance and corrective-result requests sent to an active Dispatch use the same
execution reference and delivery outbox rules. A generation change fences old
guidance and settlement authority. Provider-native resume, when supported, is
an explicit reconciliation or new-attempt action; it is never implicit prompt
replay.

Large data is passed through bounded artifact references rather than pasted
into terminal input. A Task envelope may include summaries, content hashes,
repository-relative references, and authorized artifact handles.

## Completion and Result Contract

Agent output is nondeterministic. The same Agent may assign different severity
to the same review on separate Runs. The Runtime must preserve that reality
without making scheduling probabilistic.

An Agent submits semantic output; the trusted Runtime assembles the authoritative
result. Conceptually:

```ts
interface AgentResultSubmission {
  outcome: "succeeded" | "failed" | "canceled";
  summary: string;
  data?: JsonValue;
  artifacts?: ArtifactRef[];
}

interface NodeResult extends AgentResultSubmission {
  filesModified?: string[];
  repositoryState?: RepositoryStateRef;
  transcriptRef?: ArtifactRef;
  usage?: UsageSummary;
  executionReceipt: {
    attemptId: Id;
    dispatchId: Id;
    execution: TerminalExecutionRef;
    readinessReceiptId: Id;
    agentInstanceId: Id;
    effectiveDefinitionHash: string;
    resultSubmissionHash: string;
  };
}
```

Canonical Schema v1 defines the exact shape; these rules are normative:

- outcome is explicit and never encoded only in prose
- summary remains human-readable
- structured data is optional unless the node declares a result schema
- structured data is bounded and schema-validated
- submitted artifacts are referenced, typed, size-bounded, target-aware, and
  authorized for the active attempt
- absolute host paths are not portable results
- `filesModified`, Repository State, execution identity, and trusted usage are
  Runtime/provider-derived fields; a worker cannot self-attest them
- coding results bind their Runtime-captured Repository State output to the
  active attempt
- completion is bound to the active attempt and cannot settle a newer retry
- completion is bound to the Dispatch's concrete terminal generation,
  foreground Agent instance, and effective Agent identity
- a settled attempt result is immutable

### Worker Result Submission Protocol

All supported coding agents use one provider-neutral Runtime operation,
conceptually:

```ts
submitAttemptResult({
  attemptId: Id;
  expectedExecution: TerminalExecutionRef;
  idempotencyKey: Id;
  submissionHash: string;
  capabilityRef: OpaqueCapabilityRef;
  result: AgentResultSubmission;
}): ResultSubmissionReceipt;
```

The Agent's lifecycle preamble explains the result schema and how to invoke a
kmux CLI/socket command such as `kmux orchestration result submit`, while the
attempt capability is supplied through a kmux-owned process/session-bound
channel rather than copied into the natural-language prompt, command-line
arguments, transcript, or result file. Agent-specific hooks or adapters may
improve ergonomics and liveness, but no provider-specific completion protocol
is required for correctness.

The Runtime authenticates the capability, attempt, effective Agent, target,
terminal generation, schema, artifact handles, and submission hash before
acceptance. It then captures trusted execution and Repository State fields,
validates the combined `NodeResult`, commits settlement, and returns a durable
receipt. An exact replay returns that receipt; reuse of an idempotency key with
a conflicting hash is rejected and audited. A stale attempt or generation can
never settle its retry.

If an Agent turn ends without a required valid submission, policy selects a
bounded same-session repair request, trusted transcript inspection,
`needs_attention`, Human Gate, or typed failure. Repair delivery uses the same
generation-bound outbox and cannot create an unbounded prompt loop. Coordinator
Agents similarly finish a Turn only by committing authenticated Patch, message,
gate, or seal commands and a terminal Turn receipt; their Stop hooks are not
completion authority.

### Completion Signals

Signals have distinct meanings:

| Signal                         | Meaning                                      | Sufficient for success |
| ------------------------------ | -------------------------------------------- | ---------------------- |
| acknowledged input             | Task bytes reached a live terminal boundary  | No                     |
| terminal/TUI idle              | delivery may be safe or Agent may be waiting | No                     |
| heartbeat/status               | worker is alive and reporting progress       | No                     |
| Agent `Stop`/turn hook         | an Agent turn ended                          | No                     |
| process exit                   | process ended; reconcile settlement          | No                     |
| valid attempt-bound completion | explicit outcome and valid NodeResult        | Yes                    |

The required completion path is the capability-bearing Runtime operation above,
emitted by the worker or a trusted agent adapter. The capability is bound to
the Run, node, attempt, target, resolved Agent identity, and concrete terminal
generation and expires when the attempt settles.

If a turn-complete hook arrives without a valid required result, the executor
does not mark the node successful. According to node policy it may:

- request a corrected structured result in the same Agent session
- collect a trusted provider transcript and present it for validation
- move the node to `needs_attention`
- open a Human Gate
- fail the attempt with a typed missing-result reason

Terminal screen scraping is a bounded fallback for inspection, not primary
completion authority.

### Semantic Judge and Deterministic Branch

For multi-Agent review, each reviewer may emit findings with its own severity.
A workflow can explicitly place a Judge Agent:

```text
Reviewer A ----+
Reviewer B ----+-> Join -> Judge Agent -> Condition
Reviewer C ----+                         | important -> Fix
                                         | clean     -> Continue
```

The Judge may nondeterministically produce:

```json
{
  "acceptedFindings": [],
  "acceptedImportantCount": 0
}
```

Once that result is persisted, the Condition deterministically evaluates
`acceptedImportantCount`. A new Run may produce a different Judge result; a
recovered existing Run does not rerun the Judge merely to choose the branch
again.

## Messages, Questions, Gates, and Guidance

The Runtime provides durable, typed coordination messages including at least:

- status and heartbeat
- worker guidance
- question and reply
- escalation
- completion
- gate request and resolution
- handoff/ownership notice

Messages carry stable IDs, origin authority, Run and optional
node/attempt/Dispatch identity, creation time, delivery state, and idempotency
information.

### Ask/Reply

A worker question is persisted before any caller waits. Disconnecting the CLI,
closing the Studio, or restarting the renderer does not lose the question.

The worker node enters a durable waiting state or continues according to its
declared policy. A reply targets the original question ID; retrying the reply is
idempotent. The Runtime does not hold one long RPC open as the source of truth.

### Human Gate

A Human Gate is a durable Run Node with an explicit question, permitted
resolutions, approver policy, and output mapping. It may be resolved from the
Studio, command palette, CLI, or an authorized integration. Resolution records
the principal and timestamp and unblocks the same Run after restart.

### Live Guidance

A user or authorized Coordinator may send guidance to an active Dispatch. The
Runtime resolves the current exact Surface/session/generation and records the
message, delivery operation, and receipt. It does not dual-send to stale and
replacement terminal handles.

Guidance does not create a new attempt unless an explicit command does so.

## Supervision, Handoff, Retention, and Ownership

### Supervised Mode

Supervised mode creates Task and Dispatch provenance and requires explicit
settlement. The Scheduler, user, or authorized Coordinator may answer
questions, provide guidance, cancel, retry, retain, or release the worker under
policy.

### Cancellation Fencing

Cancellation is a two-phase, durable lifecycle rather than an optimistic state
flip:

```text
active -> cancel_requested -> confirmed_canceled
                           -> cancel_uncertain
```

The Runtime persists `cancel_requested` and its idempotent operation before
asking the generation-bound executor to stop work. Only an authoritative
executor receipt or reconciliation proving that the exact attempt can no
longer act may produce `confirmed_canceled` and release its terminal/worktree
leases.

A timeout, disconnect, missing hook, or best-effort control character yields
`cancel_uncertain`. While cancellation is uncertain:

- the attempt remains nonterminal for resource-safety decisions
- the same concrete Agent session cannot accept another supervised Dispatch
- the same worktree cannot be reused by a retry or another writer
- automatic Task or guidance reinjection is forbidden

An explicit user abandonment records that supervision stopped; it does not
claim that the process stopped or release the same worktree as safe. A
replacement may run only in isolated resources under an explicit policy and
from a proven Repository State input.

### Full Handoff Mode

Full handoff confirms resource creation and prompt delivery, transfers
ownership, and stops monitoring completion. It does not fabricate a
`worker_done` obligation or wait on terminal output.

A handoff that gives the receiver a live managed terminal or worktree transfers
each corresponding lease from the originating attempt to a durable
external-handoff owner using the lease revision check. The transfer receipt
lists the resources transferred, or records that none were shared.

A handoff node completes when prompt delivery and all required ownership
transfers are durable, not when the receiving Agent finishes unknown future
work. Transferred resources remain fenced from later Scheduler admission until
an explicit reclaim operation proves the handed-off Agent can no longer act and
releases or transfers the leases. If later supervision is desired, it begins
through a new explicit supervised Dispatch only after that reclaim or on
isolated resources.

### Retain and Release

After a supervised Dispatch settles, the Runtime chooses one explicit terminal
ownership outcome:

- transfer the exact binding to an immediate follow-up Dispatch
- retain it under a recorded user/Workflow policy
- release only the exact Runtime-owned worker terminal

Release is post-settlement cleanup, not cancellation. It never closes unrelated
Surfaces, user-owned existing terminals, setup terminals, or identities the
Runtime cannot prove it owns. Released output remains inspectable through
archived transcript/artifact references.

### Coordinator Authority and Takeover

An ad hoc or adaptive Run may bind one active coordination principal and
authority epoch. A takeover:

- is explicit and authorized
- increments the epoch and fences stale coordinator mutation commands
- preserves live workers, Run Graph, messages, results, and terminal sessions
- moves pending coordinator-facing questions and delivery ownership
- does not restart Agents merely to change coordinators

The native Scheduler remains authoritative before and after takeover. Fixed
declarative workflow execution does not require a live Coordinator principal
unless it reaches a Coordinator or Human Gate node.

## Persistence, Idempotency, and Recovery

The Runtime uses a transactional durable store for current state plus an
append-only audit/event record. This is not required to be pure event sourcing
in the first implementation.

Authoritative durable state includes:

- Workflow Definitions, versions, hashes, and authoring references
- Runs, inputs, status, source version, resolved limits/budget counters,
  policies, settling target outcome, and continuation provenance
- Run Graph authoring state, seal receipts, revisions, and accepted Patches
- Coordinator turns, wake reasons, authority epochs, and consumed event cursors
- Run Nodes, state revisions, frozen definition hashes, dependencies, selected
  branch ports, and required-reachability/join receipts
- attempts/Dispatches, effective revisions, input modes/interventions, result
  submission receipts, and retry ancestry
- concrete target/worktree/Surface/session/generation execution references and
  Agent readiness receipts
- prompt/guidance delivery outbox entries, payload hashes, and acknowledgements
- terminal/worktree lease IDs, attempt or external-handoff owners, owner
  revisions/epochs, reconciliation, reclaim, and cancellation state
- messages, questions, replies, gates, and their delivery acknowledgements
- results, Repository State references, and bounded artifact metadata
- absolute retry/timeout deadlines, executor/configuration versions, receipts,
  and reconciliation state
- external-effect intents, ambient-Agent admission approvals, policy revisions,
  status evidence, and reconciliation receipts
- coordination principal and authority epoch

Full terminal transcripts and terminal screen buffers remain outside this
store. The Runtime records bounded references to the existing transcript or
archive owner.

### Command Idempotency

Every externally retryable mutation has a caller-scoped idempotency key. The
Runtime returns the prior committed receipt for an exact replay and rejects a
conflicting reuse.

This applies to at least:

- Run creation
- Graph Patch
- Dispatch start and prompt delivery
- result settlement
- question/reply
- gate resolution
- cancellation
- handoff/reclaim and retain/release
- graph sealing and Coordinator turn consumption
- resource lease acquisition/release
- external side-effect admission and reconciliation

### Startup Recovery

On startup the Orchestration Host loads nonterminal Runs and reconciles each
active or uncertain attempt with target and session facts.

Recovery may conclude:

- the attempt is settled and its valid result exists
- the exact worker is still running
- the worker is waiting for input
- the exact process stopped
- the target is temporarily unreachable
- terminal generation, cancellation, lease ownership, or delivery is uncertain

Uncertainty moves the attempt to a reconciliation/needs-attention state. The
Runtime never blindly injects the Task again because the app restarted or a
wait timed out.

Recovery also resumes due timers from persisted absolute deadlines and
Coordinator consumption from its durable event cursor. It does not recompute a
relative backoff, treat an open quiescent graph as complete, release uncertain
leases, or create a second Coordinator Patch for an acknowledged event range.

Remote events received after reconnect are deduplicated by attempt and event
identity. A stale completion cannot settle a replacement attempt.

## CLI, Skill, Studio, and API Entry Points

All entry points call the same Orchestration Runtime.

Representative commands are:

```text
# Natural-language, adaptive Run
/orchestration task:"Implement OAuth and have appropriate agents review it"

# Published Workflow Version
/orchestration workflow:secure-feature-delivery
task:"Implement OAuth"

# CLI equivalent
kmux workflow run secure-feature-delivery --input task="Implement OAuth"

# Run control
kmux orchestration status --run <run-id>
kmux orchestration message --run <run-id> --node <node-id> --text <text>
kmux orchestration approve --run <run-id> --gate <gate-id>
kmux orchestration retry --run <run-id> --node <node-id>
kmux orchestration cancel --run <run-id>
kmux orchestration seal --run <run-id> --expected-revision <revision>
kmux orchestration continue --from-run <settled-run-id> --task <text>

# Worker-facing capability-scoped lifecycle operations
kmux orchestration result submit --attempt <attempt-id> --file <result.json>
kmux orchestration delivery status --operation <operation-id>

# Explicit supervised input ownership
kmux orchestration guidance --attempt <attempt-id> --text <text>
kmux orchestration takeover --attempt <attempt-id>
kmux orchestration return-control --attempt <attempt-id>
```

Exact command syntax is deferred. The semantic boundary is not:

- an orchestration skill is a client and graph author, not a private runtime
- a slash command typed inside an Agent can call the kmux CLI/socket API
- a global kmux command may bypass LLM parsing for known workflow names and
  typed inputs
- Studio Run, CLI Run, API Run, and skill Run produce the same provenance

If a saved workflow is named, the skill does not need to keep a coordinator
turn alive merely to advance known edges. It may return the Run ID and later
inspect, message, approve, or cancel the Run.

The Agent-facing orchestration skill is required when an Agent must interpret a
natural-language orchestration request and author or patch a graph. It is not a
prerequisite for opening the workflow catalog or directly starting a published
Workflow Version from Studio, CLI, or API. Worker Agent nodes receive their
attempt-scoped lifecycle preamble from the Runtime; they do not need the full
Coordinator skill merely to execute and report one assigned Task. A workflow
that explicitly binds a Coordinator Agent declares that capability requirement
and resolves it at Run admission.

## Local and SSH Execution

A Run may contain nodes on multiple target locations while retaining one
authoritative Orchestration Host.

Node target policies resolve through ADR 0005 services. The Run records exact
effective target and worktree identity in each attempt receipt. It does not
assume that local and remote repository IDs or paths match.

Remote execution must preserve:

- capability negotiation before Dispatch
- explicit remote repository/worktree selection
- target-local agent and model capability validation
- durable hook/completion spooling across disconnect
- no duplicate prompt injection on reconnect
- transcript provenance or a typed bounded fallback
- authority-bound result and message delivery

The first implementation may limit Studio workflows to the local target while
retaining these contracts. Such a product limit must be surfaced as unsupported
capability, not encoded as local-only domain types.

## Security and Trust Boundaries

### Workflow Import

Workflow files and Editor Documents are untrusted data. Import validates size,
depth, IDs, schemas, node kinds, mappings, expressions, target references, and
configuration versions before publishing or running.

An imported workflow cannot:

- load executable JavaScript or native modules
- name an arbitrary renderer component
- read secrets directly from persisted JSON
- bypass command or integration permission policy
- grant itself ambient Agent authority
- forge Run, attempt, Surface, or target identity
- claim a result for another Dispatch

### Coordinator Capability

Coordinator graph-authoring authority is a scoped capability, not a prompt
role. It restricts:

- Run ID and graph revision
- allowed Patch operations
- maximum nodes, edges, depth, fan-out, and loop bounds
- allowed targets, worktrees, agents, tools, and concurrency
- whether command or network nodes may be added
- which ambient Agent capability classes may be requested, without authority to
  approve them
- expiry and authority epoch

Semantic output from an Agent becomes a mutation only after a typed command is
authenticated and validated.

### Dispatch Capability

A worker lifecycle capability is bound to one active attempt and effective
Agent identity, target authority, and concrete terminal generation. Workers do
not choose their own Run, server, target, Surface, or generation authority.
Stale, replayed, cross-attempt, or conflicting settlement is rejected and
audited.

Graph-authoring and worker-lifecycle authority are separate capabilities even
when they use the same authenticated CLI/socket transport. General socket
authentication proves the caller's transport principal but is not sufficient
authorization for either capability.

Capabilities are delivered out of band through a kmux-owned,
process/session-bound mechanism; bearer authority is never pasted into the
natural-language Task prompt or exported transcript. The authorization check
binds at least audience, Run, node/attempt or graph authority, target,
generation when applicable, expiry, and authority epoch. Completion remains an
idempotent one-time settlement even if the attempt capability also authorizes
multiple heartbeat, question, or escalation calls. Phase 2 must select and
threat-model one local encoding and transport. Portable cross-target encoding
and remote delivery remain follow-up security design, but these properties are
normative.

### Secrets and Artifacts

Workflow Definitions store secret references, not secret values. Prompt
rendering and executor invocation resolve only the secrets authorized for that
node and target. Results and logs redact secret material according to existing
kmux policies.

Artifact handles are bounded, typed, and authorized. A remote host-local path is
not automatically readable by the local renderer or another target.

## Package and Ownership Boundaries

The intended ownership is:

- `@kmux/orchestration` or an equivalent domain package
  - canonical definitions and validation
  - pure Run Graph and state-transition rules
  - Graph Patch validation
  - scheduler policy types
  - executor interfaces, not process-bound implementations
- `@kmux/proto`
  - serializable IPC, socket, remote, lifecycle, result, and view contracts
- `@kmux/core`
  - compact product references and pure actions needed by workspace/Surface UI
  - no full Run event log, transcript, or executor registry
- `apps/desktop/src/main`
  - local store, Scheduler host, executor composition, authorization, recovery,
    renderer IPC, CLI/socket integration, and target routing
- `apps/desktop/src/pty-host`
  - unchanged terminal data-plane ownership plus generation-bound,
    idempotent input validation and PTY-write receipts
- `apps/desktop/src/renderer`
  - FlowGram Studio, workflow forms, Run visualization, gates, and user commands
- `packages/agents`
  - ADR 0007 Agent descriptors and capabilities used by the Agent executor
- `packages/cli`
  - workflow/orchestration client commands and agent-hook forwarding
- `remote/kmuxd`
  - target-local execution capabilities, lifecycle/event spool, and remote
    receipts; not a second active scheduler in the first implementation

The exact package name is not normative. The boundary is: pure orchestration
domain logic must be reusable and testable without Electron, while process,
terminal, filesystem, target, and integration effects remain in composition
roots.

## Orca Capability Relationship

This architecture targets Orca-like orchestration capability, not protocol
compatibility.

| Orca-style capability               | kmux owner                               |
| ----------------------------------- | ---------------------------------------- |
| Run namespace and coordinator inbox | Workflow Run and message store           |
| Task DAG and dependencies           | Run Graph                                |
| worker start and injected task      | Agent Node Executor and Dispatch         |
| model/effort and worktree placement | Agent Binding and effective receipt      |
| parallel workers                    | Scheduler fan-out                        |
| explicit worker completion          | attempt-bound Node Result                |
| heartbeat/status/escalation         | lifecycle messages                       |
| ask/reply                           | durable question/reply                   |
| decision gate                       | Human Gate node                          |
| worker transcript/read              | result transcript/artifact reference     |
| exact worker reuse                  | Agent Binding with session reuse         |
| retain/release                      | binding ownership policy                 |
| retry/replacement                   | new Node Attempt                         |
| live worker guidance                | Dispatch message routing                 |
| dynamic Tasks                       | Graph Patch                              |
| coordinator takeover                | authority epoch takeover                 |
| full handoff                        | explicit handoff mode                    |
| remote worker                       | target-resolved executor                 |
| custom terminal topology            | low-level terminal/command executor path |

Feature parity depends on implementing these contracts. FlowGram alone does not
provide it. Conversely, adding the Studio does not remove ad hoc coordinator
behavior because both paths operate on the same Runtime.

## Product Behavior

### Agent Orchestration Enablement and Skill Setup

The Orchestration Runtime, workflow catalog, and direct saved-workflow entry
points are built-in kmux capabilities. Their availability is distinct from
whether any coding Agent has the optional `orchestration` skill installed.

Agent Orchestration setup is opt-in. Settings and an eligible first-use entry
point may offer to enable it, but installation begins only after an authorized
user confirms setup and selects the target Agent runtimes or installation
scope. Before confirmation the UI shows the exact selected targets and intended
installation action. Opening `Workflows`, importing, editing, publishing, or
running a workflow never silently writes to Agent skill directories.

Setup reports at least `not installed`, `partially installed`, `installed`,
`update available`, and `needs attention`, with per-Agent coverage where the
provider exposes a discoverable skill location. It provides explicit Install,
Update, and Re-check actions. The UI activation preference, detected skill
coverage, and Runtime availability are separate state; one is never inferred
from another.

Disabling the Agent Orchestration preference stops offering its natural-language
entry experience but does not uninstall skills, delete Workflow Definitions, or
cancel active Runs. Skill removal is a separate explicit operation.

### Saved Workflow UX

The existing right dashboard exposes these peer tabs:

```text
Usage | Sessions | Workflows
```

`Workflows` lists saved Workflow Definitions and their Draft/Published state.
Its `+` action creates a new Draft and opens it directly in edit mode. Selecting
an existing row opens a large, viewport-bounded modal with the FlowGram diagram
in read-only mode. The initial modal actions are `Run`, `Edit`, and close; this
ADR does not require a separate full-page route.

`Edit` switches the same modal to Studio edit mode. Save Draft may persist an
invalid in-progress Editor Document, while Publish performs the existing full
validation and creates an immutable Workflow Version. Run always selects and
pins an explicit published version; if no published version exists, the UI
requires Publish rather than silently executing the mutable Draft. Starting a
Run may project its node state over the diagram, but closing the modal or
switching right-dashboard tabs does not pause or cancel Runtime execution.

The modal and tab are presentation clients only. They do not own Scheduler,
Run, or PTY state, and reopening them reconstructs the view from the canonical
Draft/Version and Runtime projection.

Within that shell, the Studio supports:

- Draft, Validate, Publish, and version history
- node-, port-, edge-, mapping-, and policy-scoped validation errors that link
  to the offending editor element
- a Draft-to-canonical compiled-plan preview showing effective sequencing,
  implicit data dependencies, joins, loop bounds, Agent/resource bindings,
  executor support, approvals, and Run limits before Publish or Run
- a node library sourced from serializable executor descriptors
- Agent role and session/worktree policies
- prompt templates and typed input mappings
- branch ports, loops, gates, retry, timeout, and error paths
- Run with typed inputs
- node/attempt status overlay without moving the graph
- exact Surface opening for an Agent attempt
- concrete execution generation, Repository State, result, artifact,
  transcript, and message inspection
- schema-driven structured result inspection and pre-settlement repair forms
  for authorized Human Gate flows, with the original submission and every
  correction retained; settled results remain immutable
- snapshot/artifact size, capture status, retention, and expiration visibility;
  the UI never implies full code provenance when storage policy omitted content
- pause at Human Gate and resume from any authorized entry point
- Save as new version rather than editing a running version

### Natural-Language UX

Natural-language orchestration supports:

- visible objective and evolving Run Graph
- visible open/sealed state, Coordinator turns, and waiting reason
- Coordinator-authored Tasks and dependency changes
- user approval before high-risk Graph Patches according to policy
- the same live node, Surface, result, and message inspection as saved workflows
- explicit sealing and explicit continuation from a settled Run
- saving the final graph as an editable Draft and initialized Studio document

The UI must disclose when a graph is Agent-generated or has Run-scoped patches.
It must not present an adaptive Run as an unchanged execution of the base
Workflow Version.

## Implementation Phases

### Phase 1: Durable Orchestration Domain

- Canonical Schema v1, canonicalizer/content hash, validator, TypeScript domain
  types, golden fixtures, and initial migration/refusal harness
- canonical Run, Run Node, attempt/Dispatch, semantic submission, trusted
  result, message, gate, and binding contracts
- Run Graph authoring/sealing, Coordinator Turn, and consumed-cursor contracts
- Scheduler/Graph Patch linearization, node state revisions, definition freeze,
  and immutable attempt-effective revision rules
- versioned required-reachability, failure, skip, branch, join, loop,
  data-mapping, Run settlement/drain, and durable timer transition rules
- Terminal Execution, Repository State, revisioned resource lease,
  cancellation, input-mode, and host-lifecycle contracts
- Run limits, persisted budget counters, and typed exhaustion policies
- transactional local store and audit events
- pure state machine and reconciliation states
- authenticated CLI/socket API
- no FlowGram dependency

**Phase 1 exit gate:** schema and migration fixtures must round-trip through the
domain package, and pure contract tests must prove stale Patch/admission races,
required reachability, joins, loops, budget counters, revisioned leases, and
restart transitions. Phase 2 may not invent a parallel DTO or state machine in
Electron Main.

### Phase 2: Safe Supervised Agent Execution

- Agent Node Executor on existing local Surfaces and terminal services
- generation-bound, idempotent local prompt delivery with a PTY-write receipt,
  same-generation status query, and explicit unknown reconciliation
- fresh and exact-session reuse with a foreground Agent readiness receipt and
  supervised capacity one
- enforceable restricted or explicitly approved ambient Agent authority
- provider-neutral `result submit` operation, out-of-band attempt capability,
  durable idempotent receipt, and bounded missing-result repair
- one supervised input broker implementing orchestrated,
  interactive-recorded, and takeover modes
- attempt-bound questions, replies, guidance, retry, handoff/reclaim, and
  retain/release
- revisioned terminal/worktree leases, trusted Runtime Repository State/result
  assembly, and cancellation fencing
- app-restart recovery and explicit Studio-close, Main-exit, sleep, and remote
  host-unavailable behavior

**Phase 2 exit gate:** a real supported coding agent must receive a Task in a
fresh session and in an exact reused session, submit one structured result,
have trusted code state captured, survive duplicate submit/delivery calls, and
leave ambiguous delivery, user intervention, cancellation, or quit in a safe
reconcilable state. The reused delivery must be fenced when the expected
foreground Agent or ready epoch cannot be proven. Hooks, idle detection,
transcript prose, and `sendText(sessionId, text)` cannot be the success proof.

### Phase 3: Adaptive Orca-Style Vertical Slice

- objective creates an open Run and durable initial Coordinator Turn
- Coordinator Graph Patch creates a Task and supervised worker
- explicit worker result wakes a later Coordinator Turn by durable event cursor
- Coordinator may add follow-up/review work and eventually seals the graph
- host-enforced graph, fan-out, Dispatch, Coordinator Turn/Patch, loop, time,
  concurrency, and storage budgets
- Patch/admission concurrency uses the Phase 1 linearization contract and
  cannot mutate a ready, preparing, active, or settled definition
- empty/open, cancellation-uncertain, takeover, and app-restart recovery paths
- status, question/reply, guidance, retry, and explicit continuation through CLI
- optional Agent-facing orchestration skill packaging, explicit target
  selection, Install/Update/Re-check, and per-Agent coverage reporting
- no FlowGram dependency

This phase must prove the complete
`objective -> plan -> worker -> result -> coordinator follow-up -> seal` loop
before the visual Studio becomes an implementation dependency. Its exit gate
also proves that a Coordinator cannot exceed or raise its own Run limits, a
stale Turn/Patch cannot win a race, and restart does not reset a budget or
duplicate a Turn effect. Direct Runtime commands must still work with the
Agent-facing skill absent, and skill installation must require an explicit user
setup action.

### Phase 4: Declarative Workflow Runtime

- immutable Workflow Versions and Run materialization
- Start/End, Agent, Condition, explicit Loop, and Human Gate
- fan-out/fan-in and typed mappings
- CLI and command-palette workflow execution
- semantic Judge pattern through ordinary Agent nodes

### Phase 5: FlowGram Workflow Studio

- `Workflows` as the third existing right-dashboard tab beside `Usage` and
  `Sessions`, with list and `+` Draft creation
- large modal with read-only diagram, Run, and explicit Edit mode
- Editor Document compiler and canonical Draft-to-Editor initializer
- Draft/Validate/Publish
- editor-linked validation errors and canonical compiled-plan preview
- node configuration forms
- Run-state projection, structured result inspection/repair, and exact
  execution/code-state inspection
- artifact/snapshot size, capture, and retention status
- Save an ad hoc Run Graph as an editable Draft and initialized Editor Document

### Phase 6: Target and Executor Extension

- revisioned Graph Patch UI and approvals
- takeover and recovery hardening
- SSH/remote execution capability parity
- deny-by-default ExecutorPolicy enforcement for command, cwd/argv, network,
  secret egress, Git publication, artifacts, and approvals
- common durable effect state machine and provider-specific idempotency/status
  reconciliation adapters
- additional trusted Node Executors and integrations only after their policy
  and reconciliation contracts pass

**Phase 6 enablement gate:** no command, HTTP mutation, push/Pull Request,
notification, or other external-effect executor is executable merely because a
Studio descriptor exists. Import, Publish, Coordinator Patch, Run admission,
and immediate pre-effect checks must all enforce the effective deny-by-default
policy, and an `outcome_unknown` effect must reconcile before retry.

These phases are sequencing guidance, not a substitute for an implementation
plan. Each phase must preserve terminal output continuity and leave unsupported
capabilities explicit.

## Verification and Acceptance

The architecture is accepted only when implementation plans include durable
contract tests for the following behavior.

### Common Runtime

- a saved Workflow and an equivalent ad hoc graph produce the same canonical
  Run Node, attempt, message, and result semantics
- Canonical Schema v1, TypeScript validation, canonical hashing, and migration
  fixtures accept and reject the same documents
- initializing an Editor Document from a canonical Draft and compiling it again
  preserves canonical workflow semantics without asserting pixel layout
- no separate renderer or skill scheduler exists
- direct saved-workflow execution does not depend on an initiating Agent having
  the orchestration skill installed
- workflow execution continues when the Workflows tab or Studio modal is closed
  while Electron Main remains alive, without claiming continuation after the
  Host exits

### Scheduling

- independent ready nodes fan out concurrently within policy
- an open adaptive graph does not complete when it is empty or has no runnable
  node
- a Coordinator wake and consumed event range produce at most one durable turn
  effect after retries or restart
- sealing rejects a stale graph revision/cursor and a sealed graph rejects
  authoring Patches
- a Patch racing `ready -> preparing` either commits first and appears in the
  frozen attempt definition or loses its graph/node revision check
- a `ready`, `preparing`, active, or settled node definition cannot be mutated;
  correction creates a new node or lifecycle command
- a Run succeeds only after sealing and settlement of required nodes, attempts,
  deliveries, gates, Coordinator turns, and outputs
- required reachability is versioned and excludes unselected branches while
  preserving unresolved Conditions, loops, mappings, and authoring obligations
- a join waits according to its explicit policy
- an `any-successful` join settles predictably when every candidate is terminal
  and none succeeded
- an unselected branch cannot strand a downstream join
- a Condition selects the same edge when replaying the same persisted result
- loops obey their maximum and recorded iteration state
- retries create new immutable attempts
- persisted retry/timeout deadlines are not extended or duplicated by restart
- graph, Dispatch, Coordinator, loop, time, concurrency, and storage limits are
  enforced before admission and do not reset after restart
- a Coordinator cannot raise its own limits through a Graph Patch
- a selected Run failure or cancellation stops new admission and cannot become
  terminal while a Runtime-owned attempt remains active or uncertain

### Agent Binding and Resource Safety

- two nodes with the same reusable `agentRef` address the exact same proven
  Surface/session/generation and foreground Agent instance when executed
  sequentially
- a shell prompt, generic idle signal, or inferred provider session cannot
  authorize reused delivery without a current Agent readiness receipt
- fresh policies create independent sessions
- a user-owned existing Surface cannot enter supervised input ownership without
  explicit consent, and release restores or safely refuses its prior mode
- one concrete interactive Agent session admits at most one active supervised
  Dispatch unless its executor explicitly advertises greater capacity
- a stale or ambiguous generation does not receive prompt, guidance, or
  settlement delivery
- parallel shared writes are rejected without explicit opt-in
- a terminal/worktree lease remains fenced while cancellation or execution
  outcome is uncertain
- stale lease revisions/owner epochs cannot transfer or release a resource
- heartbeat or lease age alone cannot make an uncertain terminal/worktree
  resource available to another writer
- a full handoff transfers shared terminal/worktree leases to a durable external
  owner, and successor work cannot reuse them before proven reclaim

### Lifecycle

- idle, heartbeat, and turn-complete alone cannot mark success
- prompt delivery is persisted before input and acknowledged against the same
  operation, payload hash, and terminal generation
- the exact live generation can answer a duplicate delivery status query, while
  a dead unproven generation remains unknown rather than returning `not_seen`
- an uncertain delivery is reconciled and never replayed into a replacement
  terminal generation
- the provider-neutral submit operation returns one durable receipt for exact
  replay and rejects a conflicting submission hash
- an attempt-bound valid result settles exactly one active attempt only after
  trusted Runtime result assembly
- stale completion cannot settle a retry
- cancellation remains `cancel_requested` or `cancel_uncertain` until the exact
  executor confirms the attempt can no longer act
- cancellation uncertainty prevents retry in the same session and worktree
- invalid structured output follows declared repair/failure policy
- supervised user input is blocked, serialized and recorded, or transferred by
  explicit takeover according to the binding mode; no renderer bypass exists
- question/reply and Human Gate survive renderer and app restart
- full handoff does not create a supervised completion obligation, but its node
  cannot complete before required lease ownership transfers are durable

### Code State and Dataflow

- parallel reviewers of one implementation consume the same Repository State
  content identity
- Repository State and authoritative changed paths are captured by trusted
  target/repository services rather than accepted from Agent self-report
- a live-worktree review cannot race a writer while its state is captured
- a fixing node refuses to write when its expected Repository State has drifted
- a required data mapping cannot read an unfinished, failed, canceled, or
  skipped result without an explicit settled/optional policy
- retry exhaustion, mapping failure, Condition error, loop maximum, cancel, and
  skipped-branch propagation follow their declared typed ports or policies

### Durability

- a restart does not rerun settled nodes or reinject uncertain Tasks
- accepted Graph Patches and selected branch ports survive restart
- open/sealed state, Coordinator turn cursor, Repository State references,
  settling target outcome, resource and handoff leases, delivery outbox,
  cancellation state, and due timers survive restart
- duplicate mutations return the original receipt or a typed conflict
- coordinator takeover fences stale mutations without restarting workers
- graceful Main shutdown stops admission and checkpoints active Runs; only an
  exact termination receipt releases local execution resources, and restart
  reconciles every other attempt as uncertain
- an ambiguous external side effect is reconciled before retry and cannot
  silently create a duplicate Pull Request or equivalent resource

### Terminal Continuity

- Studio navigation and Run-state updates do not recreate or reattach live PTYs
- orchestration event volume does not enter or block the terminal output stream
- opening a node resolves the existing Surface without replacing its session

### Security

- imported workflows cannot load executable code
- opening the Workflows tab, viewing/editing a diagram, importing, publishing,
  or running a workflow cannot install or update an Agent skill
- Agent skill installation requires an explicit user action and writes only to
  the selected, disclosed Agent targets or installation scope
- imported or Coordinator-authored Agent nodes cannot self-approve ambient
  filesystem-write, network, or Git authority
- restricted Condition evaluation has no ambient process or filesystem access
- graph and Dispatch capabilities reject cross-Run and stale-epoch mutations
- graph-authoring and worker-lifecycle authority remain separately scoped even
  over one authenticated transport
- bearer capabilities do not appear in Task prompts, transcripts, or exported
  logs
- secrets are represented by authorized references rather than persisted values
- remote artifact and path identity cannot be confused with a local path
- disabled external executors remain unexecutable even if imported or proposed
  by a Coordinator
- command argv/cwd, network destination, secret egress, Git authority, and
  approvals are checked against effective policy immediately before an effect

## Consequences

### Benefits

- Natural-language orchestration and visual workflows share one set of durable
  semantics.
- Saved workflows avoid paying an LLM to interpret known routing on every Run.
- Ad hoc coordination remains adaptive rather than being forced into a complete
  static DAG before execution.
- Agent nondeterminism is isolated to explicit Agent results; recovery and
  control flow remain auditable.
- The same Agent can perform multiple workflow steps through stable
  Surface/session binding.
- FlowGram can evolve or be replaced without migrating the orchestration domain.
- Orca-like messaging, questions, gates, handoff, takeover, and worker lifecycle
  are not constrained by what fits visually on a canvas.
- Runtime state can be inspected from Studio, CLI, and agent skills without
  scraping terminal output.

### Costs

- kmux must implement a durable scheduler and orchestration store rather than
  delegating production execution to FlowGram or one Coordinator prompt.
- The canonical workflow compiler and editor adapter add a versioned schema
  boundary.
- Attempt-bound results require Agent integration, lifecycle capabilities, and
  reconciliation behavior beyond terminal idle detection.
- Local supervised input requires a new generation-bound PTY acknowledgement
  path rather than the existing best-effort `sendText(sessionId, text)`
  contract.
- Resource leases, cancellation fencing, Repository State capture, and durable
  Coordinator turns add state that must survive application restarts.
- Dynamic Graph Patches, takeover, target routing, and idempotency introduce
  significant state-machine and authorization complexity.
- A visual node library must track executor capabilities without exposing
  executable process objects to the renderer.

### Risks

- Over-expanding the first milestone could delay a useful supervised Agent
  Runtime. The implementation must start without FlowGram.
- An overly permissive Graph Patch API could let generated plans create unsafe
  commands, unbounded fan-out, or write conflicts. Bounds and approvals are
  required at the Runtime boundary.
- A result schema that is too strict could make interactive coding agents
  brittle; a schema that is too loose could make branch behavior unreliable.
  Human-readable summaries and typed data must coexist.
- Incorrect binding recovery could prompt the wrong Agent session. Uncertainty
  must stop automatic delivery.
- A Coordinator that never seals an open graph can leave a Run waiting
  indefinitely. Retention, user takeover, cancel, and needs-attention policy
  must remain available without fabricating success.
- Incorrect lease or cancellation reconciliation could allow two attempts to
  mutate one worktree. Uncertainty must fence reuse.
- Weak Repository State capture could make parallel reviewers inspect different
  code while the UI presents them as one review stage.
- Treating advisory read-only prompts as a security sandbox would mislead users.

## Rejected Alternatives

### Separate Agent-Coordinator and Workflow Schedulers

Rejected because the paths would duplicate lifecycle, terminal, worktree,
message, gate, retry, and recovery behavior and eventually diverge.

### Make the Agent Coordinator the Only Scheduler

Rejected because known dependencies, branches, retries, loop bounds, and
restart recovery should not depend on an LLM remembering to call the next
command. Agent coordination remains available through typed graph-authoring and
semantic-decision nodes.

### Treat a Workflow as a Long Prompt

Rejected because a diagram encodes durable control and data contracts, not only
instructions. Reinterpreting it on every Run loses versioned routing,
idempotency, and deterministic recovery.

### Require Natural Language to Compile a Complete Static Workflow First

Rejected because investigation, failure decomposition, questions, and adaptive
review often reveal Tasks that cannot be planned honestly before execution.
Ad hoc Runs use an evolving, revisioned Run Graph.

### Use FlowGram Runtime and JSON as the Product Runtime

Rejected because editor and product execution lifecycles have different
authority, durability, target, terminal, and security requirements. FlowGram
Free Layout is an authoring toolkit behind a compiler boundary.

### Put Scheduling in the Renderer

Rejected because renderer close, reload, focus, or failure must not stop or
duplicate work. The renderer is a client of the authoritative Orchestration
Host.

### Infer Completion from TUI Idle or Agent Stop Hooks

Rejected because a turn can end without the required Task result or lifecycle
report. Idle and Stop remain useful liveness and reconciliation signals only.

### Execute Based on Canvas Position or Edge Creation Order

Rejected because visual layout is presentation. Control ports, edges, joins,
and policies define execution order.

### Allow Arbitrary Cycles in the Generic Graph

Rejected because recovery, joins, and termination become ambiguous. Repetition
uses explicit, bounded Loop semantics.

### Always Launch a Fresh Agent for Every Agent Node

Rejected because coding workflows often require the original implementer to
receive reviewer findings with its existing context. `agentRef` and explicit
session policies decide fresh versus reuse.

### Store Full Orchestration State in `AppState`

Rejected because results, messages, attempts, and audit history can be large
and long-lived. `AppState` carries compact workspace/Surface and UI projection
state; the Orchestration Runtime owns its durable store.

### Permit Imported Workflows to Register Executable Node Code

Rejected because it crosses the renderer, process, filesystem, and remote trust
boundaries. Initial node executors are trusted kmux composition.

## Follow-up Decisions

The following require implementation design or narrower follow-up ADRs without
reopening this architecture:

- post-v1 canonical schema evolution, migration support windows, and archival
  compatibility; Canonical Schema v1 itself remains a Phase 1 gate
- the local durable database technology and retention limits
- the restricted expression language
- artifact and Repository State snapshot storage, transfer, retention, and
  content-addressing details
- the first node library and detailed visual styling within the fixed
  right-dashboard Workflows tab and modal Studio shell
- provider-specific skill installation destinations and discovery adapters;
  explicit opt-in and separation from Runtime availability are not deferred
- FlowGram package/version integration and Editor Document schema
- Studio projection snapshot/delta encoding and retention
- whether and when Studio Preview Run compiles a Draft into an ephemeral,
  immutable validated version
- human approval policy and organization-level permissions
- portable/remote capability token encoding and transport beyond the required
  Phase 2 local out-of-band mechanism
- provider-specific external-effect idempotency and reconciliation adapters
- remote authoritative/headless Orchestration Host support
- third-party integration and custom-node plugin policy
- provider-specific usage/cost metering and monetary budget semantics; the hard
  graph, Dispatch, Coordinator, loop, time, concurrency, and storage limits are
  not deferred

Those decisions must preserve the single Runtime, canonical Run Graph,
Scheduler authority, attempt-bound lifecycle, editor boundary, and terminal
continuity established here.
