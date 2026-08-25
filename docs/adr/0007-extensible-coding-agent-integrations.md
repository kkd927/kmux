# 0007: Extensible Coding-Agent Integration Architecture

- Status: Accepted
- Date: 2026-08-16
- Accepted: 2026-08-17
- Scope: agent identity, resume, hooks, terminal notifications, settings,
  external sessions, history, usage, subscription usage, Electron IPC, and
  local/SSH composition

## Context

kmux currently has first-class integrations for Claude Code, Codex CLI, and
Antigravity CLI. The terminal itself can launch any command, but kmux-specific
behavior is implemented as a closed set of known agent vendors across several
packages and processes.

Examples include:

- `AgentVendor`, `UsageVendor`, and external-session vendor literal unions in
  `@kmux/proto`
- command and native-resume switches in `@kmux/core`
- vendor-specific hook normalization and event mapping in `@kmux/proto`
- a three-vendor hook-installation contract in `@kmux/agent-integration`
- fixed storage-root, session-inventory, history, and usage branches in
  `@kmux/metadata`
- exact three-vendor validation in desktop and remote-host protocols
- renderer filters, labels, icons, and settings controls that enumerate the
  current agents
- Codex-specific terminal-notification classification in Electron Main and
  Antigravity-specific synchronous hook responses in `@kmux/cli`
- matching fixed contracts in the Rust remote runtime

This means adding a fourth first-class coding-agent CLI requires finding and
editing unrelated lists and switches. A change can appear complete locally
while silently omitting SSH metadata, session restore, subscription usage, or a
renderer filter.

The problem is not that vendor-specific code exists. Coding-agent CLIs have
genuinely different commands, hook formats, transcript layouts, session stores,
credentials, and lifecycle semantics. The problem is that ownership of those
differences is distributed among consumers instead of being composed from one
agent-owned module.

Comparable terminal products establish two useful product layers:

1. every command-line agent works as an ordinary terminal process
2. richer behavior such as hooks, session restore, history, or usage is exposed
   only when an integration supplies that capability

Some products also preserve unknown agent IDs and support data-defined custom
resume commands. Those are useful patterns. Multiple independent built-in
catalogs and name-based switches are not: they recreate the same extension
problem at a larger supported-agent count.

kmux needs the ordinary new-agent addition path defined below: agent-owned code,
one composition entry, and capability tests without another agent-name branch in
feature consumers.

## Relationship to Existing ADRs

- [ADR 0002](./0002-electron-xterm-mvp-architecture.md) remains authoritative
  for the local terminal control/data/view planes. Agent integration is control
  plane behavior and must not enter the PTY output hot path.
- [ADR 0004](./0004-linux-platform-support-and-os-neutral-architecture.md)
  remains authoritative for platform services, shell policy, credential
  access, and agent storage roots. Agent modules consume those narrow services;
  they do not branch on `process.platform` throughout vendor code.
- [ADR 0005](./0005-ssh-remote-workspaces.md) remains authoritative for target
  identity, `LocatedPath`, `TargetServiceRegistry`, remote capability
  negotiation, and restore priority. Agent modules do not select local versus
  SSH themselves.
- [ADR 0006](./0006-extensible-surfaces-and-markdown-preview.md) remains
  authoritative for Surface registries and cross-process boundaries. This ADR
  follows the same principle that behavior objects do not cross IPC.

Terminal output continuity has priority over this refactor. An agent-registry
change must not recreate, detach, reflow, or replace an existing PTY session.

## Decision Summary

Adopt an open agent identity and a capability-based built-in agent registry.

1. Replace closed agent-vendor literal unions with a validated, open `AgentId`.
2. Separate coding-agent identity from model/account provider identity.
3. Co-locate all built-in agent-specific behavior under one agent directory.
4. Represent an agent as a required serializable descriptor plus optional,
   narrow capabilities.
5. Keep one handwritten built-in registration list as the source of
   composition. Derive capability lists, renderer descriptors, and portable
   remote manifests from it.
6. Keep the complete module registry private to process composition roots.
   Expose a descriptor-only catalog and inject capability-specific resolvers or
   materialized capability lists into feature runtimes. Do not expose a broad
   registry as a process-global or constructor-injected service locator.
7. Send only serializable descriptors and resolved policies across Electron or
   remote boundaries. Never send executable adapter objects.
8. Preserve syntactically valid unknown agent IDs in settings, persisted session
   references, and compatible wire records, while refusing to execute unknown
   behavior.
9. Treat unsupported capabilities as normal, typed product states rather than
   as malformed agents.
10. When external-session, history, or usage capabilities reference the same
    metadata source, share its topology, inventory, watcher, remote listing, and
    reads.
11. Execute remote portable behavior only where the desktop composition and the
    build-embedded `kmuxd` manifest agree, while retaining principal-scoped path
    validation and framework hard limits.
12. Keep runtime third-party code plugins out of scope. A future data-only
    custom agent format may expose a safe subset of existing capabilities.

## Non-goals

This ADR does not:

- add GLM or any other fourth production agent
- require every registered agent to implement every capability
- introduce a marketplace or load third-party executable plugins
- change PTY ownership, terminal streaming, renderer attachment, or restore
  ordering
- rewrite current transcript semantics, cost attribution, hook behavior, or
  notification behavior as a side effect of moving ownership
- make arbitrary hook grammars, database queries, settings fields, or credential
  readers user-configurable
- make model pricing part of coding-agent identity

## Product Support Levels

Agent support is capability-specific rather than one boolean claim.

1. **Terminal-compatible:** Any CLI the user can launch continues to work as an
   ordinary terminal process without an agent module.
2. **Registered:** A trusted built-in or future explicit data-only configuration
   supplies identity and one or more capabilities.
3. **Capability-supported:** kmux exposes resume, hooks, history, usage, or
   another feature only when that registration implements it.
   Documentation and UI must name the relevant capability when support differs.
   Being terminal-compatible does not imply native session restore, transcript
   usage, or subscription quota support.

## Terminology

### Agent

An **agent** is the command-line coding-agent runtime whose process, hooks,
session storage, and resume semantics kmux integrates with.

Examples:

- `claude`
- `codex`
- `antigravity`, whose default executable is `agy`
- a future standalone GLM coding-agent CLI

### Provider

A **provider** is the model, account, billing, or quota authority used by an
agent.

Examples:

- `anthropic`
- `openai`
- `google`
- `zhipu`

An agent and provider are not interchangeable. OpenCode may use several model
providers. A standalone GLM CLI may use Zhipu credentials, while another agent
can expose the same GLM models through a different session format. This
refactor keeps that semantic distinction but does not introduce a new
provider/product/account persistence model:

```ts
type AgentId = Opaque<string, "AgentId">;
type ModelId = string;
```

Existing persisted or wire fields named `vendor` remain unchanged. Domain code
interprets them as `agentId` only when they identify a coding-agent runtime. A
property rename or persistence migration is not required to adopt this ADR.

### Built-in Agent

A **built-in agent** is trusted code shipped and versioned with kmux. It may
implement executable adapters and parsers.

### Configured Agent

A **configured agent** is a future data-only registration supplied by the user.
It may use a restricted declarative subset such as command, aliases, process
detection, and resume argv templates. It cannot load arbitrary JavaScript,
TypeScript, native code, or renderer components.

## Agent Identity

`AgentId` is open-world but validated at every untrusted boundary.

Canonical IDs:

- are lowercase ASCII
- are 1 through 64 bytes
- start with an ASCII letter or digit
- contain only ASCII letters, digits, `.`, `_`, and `-`
- are persisted for newly created state after operational-ingress alias
  resolution

`unknown` is not a canonical agent ID. Absence of attribution is represented by
an optional `agentId` or an explicit attribution state, not a magic agent.

Wire and persistence decoders validate syntax and bounds; they do not require
registry membership. Authorization and execution perform a separate registry
lookup. This distinction is normative:

```text
valid AgentId syntax != installed capability != authorization to execute
```

Aliases use the same normalization rules. The built-in composition validator
rejects:

- duplicate canonical IDs
- duplicate aliases
- an alias equal to another module's canonical ID
- a canonical ID equal to another module's alias
- descriptors whose declared identity differs from their registration identity

Alias handling has two distinct paths:

1. **Operational ingress**, such as a new hook event or command lookup, resolves
   aliases through the current composition before creating state. Newly written
   records use the canonical ID.
2. **Persisted or wire state** decodes ID syntax and bounds without importing or
   consulting the registry. It does not translate aliases.

Persisted unknown IDs are not dynamically reinterpreted merely because a newer
build introduces the same spelling as an alias. Only operational ingress uses
aliases; persisted settings must be edited explicitly to change their agent ID.

## Capability Model

An agent module is a static description and a collection of factories or pure
adapters. It is not a long-lived watcher, process, or cross-process object.

The initial contract is conceptually:

```ts
export type AgentCapabilityKey =
  | "resume"
  | "hooks"
  | "externalSessions"
  | "history"
  | "usage"
  | "subscription"
  | "processDetection"
  | "terminalNotifications";

export interface AgentDescriptor {
  readonly id: AgentId;
  readonly displayName: string;
  readonly aliases: readonly string[];
  readonly presentation?: AgentPresentationDescriptor;
}

export interface AgentModule {
  readonly descriptor: AgentDescriptor;
  readonly command?: AgentCommandDefinition;
  readonly resume?: AgentResumeCapability;
  readonly hooks?: AgentHookCapability;
  readonly metadataSources?: AgentMetadataSourcesCapability;
  readonly externalSessions?: AgentExternalSessionsCapability;
  readonly history?: AgentHistoryCapability;
  readonly usage?: AgentUsageCapabilityFactory;
  readonly subscription?: AgentSubscriptionCapabilityFactory;
  readonly processDetection?: AgentProcessDetectionCapability;
  readonly terminalNotifications?: AgentTerminalNotificationCapability;
}
```

The exact TypeScript names may change during implementation, but these
boundaries are normative.

`command` and `metadataSources` are shared supporting definitions rather than
separate product-support claims. External-session, history, and usage
capabilities are metadata-backed projections in the current implementation.
The registry validates these invariants:

- `resume` requires `command`
- a metadata-backed projection requires `metadataSources` with at least one
  source tagged for that product purpose
- projections consuming the same metadata topology use the shared
  metadata-source coordinator

Capability support is derived from the module's implemented product-capability
properties. It is not a second handwritten list. Real operations validate their
command, credentials, target, and remote-version preconditions and return their
existing failures. This refactor does not add a separate availability
probe/cache subsystem.

### Descriptor and Presentation

The descriptor contains only serializable, non-secret metadata. Renderer-facing
presentation must come from a bounded descriptor DTO and have neutral fallbacks.

- unknown agents use their canonical ID as a label
- UI ordering is deterministic and may use registry order plus locale-aware
  display-name sorting where appropriate
- labels, aliases, capability badges, and generic settings controls do not live
  in renderer agent-name switches

Brand assets and optional localization data for a built-in agent are co-located
with that agent. They are not additional global registration points.

### Command Resolution

kmux does not add an agent-specific new-session launch feature in this refactor.
Any CLI remains launchable as an ordinary terminal command. The agent-owned
command definition exists only for capabilities that need kmux to construct a
command, currently native resume and the reviewed Codex wrapper policy.

A generic command resolver validates and merges the existing `command` and
`args` settings override and enforces executable, argument-count, and
argument-size bounds. It builds argv arrays, never shell command strings.

An unregistered `AgentId` is never executed merely because a persisted record or
remote payload contains that ID. A future configured-agent feature requires an
explicit trusted user configuration before its command becomes executable.

### Resume

The resume capability owns:

- native resume argv construction
- agent-specific session selector syntax
- safe preservation or removal of previous launch arguments
- optional fork/branch argv construction when supported

It receives the generically resolved command/argument state and returns only
the agent-specific resume transformation. It does not merge settings or repeat
generic argv bounds. The registry rejects a resume capability without a common
command definition.

Session IDs remain opaque bounded strings. Resume builders receive argv parts
and return argv parts; they do not interpolate a session ID into a shell.

ADR 0005's restore order is unchanged:

1. attach the existing live local/remote runtime
2. only when that runtime is authoritatively gone, use the agent's native resume
   capability on the same target and cwd
3. otherwise show a recoverable unavailable/dead-session state

### Hooks

The hook capability owns both declarative installation information and pure
payload normalization:

- settings/config location descriptors
- supported config merge format
- managed and deprecated hook entries
- hook command marker and output mode
- whether the caller requires a synchronous response
- bounded success and per-event fallback response payloads
- helper-unavailable, timeout, normalization-error, and helper-failure response
  policy
- raw event aliases
- raw payload validation and session ID extraction
- mapping raw events into kmux's normalized agent lifecycle events

`@kmux/proto` owns only bounded wire shapes and normalized event DTOs. It must
not contain Claude-, Codex-, Antigravity-, or future-agent payload branches.

The normalized lifecycle event set may remain closed because it represents kmux
product semantics:

```ts
type AgentEventName =
  | "session_start"
  | "needs_input"
  | "turn_complete"
  | "idle"
  | "session_end";
```

A future agent maps its native vocabulary into this set. Adding a new kmux-wide
lifecycle semantic is a capability-contract change, not an ordinary new-agent
registration.

Hook installation must continue to preserve user-owned configuration, use
atomic writes, recognize only kmux-owned markers for removal, and fail per agent
without disabling other integrations.

The portable hook definition carries the synchronous-response and fallback
policy. Generation produces bounded, parity-checked projections of that one
definition for the bundled `@kmux/cli`/local helper, the fallback embedded in
installed hook commands, and the `kmuxd` manifest/runtime. The CLI never queries
Main for response policy: it must still respond when Main or its RPC endpoint is
unavailable. Agent/event arguments select an embedded entry but cannot supply or
override response payloads through argv or environment.

`@kmux/cli` owns generic timeout, helper invocation, and stdout writing; it must
not contain a handwritten agent-ID branch deciding whether or what to emit. In
particular, the ownership move must preserve Antigravity's current synchronous allow
payload on success and on every explicitly defined helper-unavailable, timeout,
or error fallback path.

### Terminal Notifications

Terminal-originated notification classification is separate from hook payload
normalization and process detection. The optional terminal-notification
capability owns agent-specific title/message classification, known chatter
suppression, and mapping to normalized notification signals.

The generic terminal notification runtime owns cross-agent deduplication,
rate-limiting, delivery, and a conservative fallback for an observed unknown
agent when the message contains a strong generic completion or input signal.
Moving Codex-specific classification into its module must not delete that
unknown-agent fallback. Classification remains on the control plane and must
not parse, delay, or transform the PTY byte stream.

### Metadata Sources, External Sessions, and History

The external-session capability derives normalized session references from a
coordinated metadata-source inventory. The history capability parses the same
declared sources when supported. They are separate because an agent may support
one without the other.

Normalized records contain an open `agentId` plus target identity. They never
match or restore by session ID or cwd alone.

When an agent uses files, SQLite databases, or another supported inventory/read
primitive, its optional `metadataSources` definition owns one topology for those
sources: storage layouts, source descriptors, role classifiers, formats, and
the product purposes served by each source. External-session, history, and usage
capabilities remain separate projections, but projections referencing the same
agent/root topology do not independently rediscover those sources.

Agent-specific parsing, parser state, title/model extraction, and deduplication
keys belong to the relevant capability. Generic inventory bounds, file-identity
rules, incremental reads, target scoping, watcher lifecycle, transport reads,
and aggregation remain in `@kmux/metadata` and target providers when those
primitives are used.

Source-role IDs are open, namespaced strings such as:

```text
codex/session-jsonl
claude/session-jsonl
claude/subagent-jsonl
antigravity/conversation-sqlite
```

Wire validation checks a returned role against the source descriptor requested
for that operation, not against a global hardcoded union.

A generic metadata-source coordinator shares inventory, watcher, file identity,
and safe read work for a topology key consisting of:

```text
target authority + authenticated principal + agent ID
+ source-definition revision + normalized root/settings revision
```

It coalesces identical in-flight bounded reads and may fan the same change event
out to multiple projections. Completed source bytes are not retained as an
unbounded cache. Projection cursors, parsing state, retention windows, and
failure diagnostics remain separate when their semantics differ. Cache entries
and watchers are never shared across authenticated principals or incompatible
source revisions. Releasing the final projection closes the shared watcher and
transport resources exactly once.

### Usage

Usage consumes declared metadata sources and owns process-local parser state.
It uses the shared source coordinator when the same source also feeds history
or external sessions.

The generic usage runtime owns adapter start/stop, refresh scheduling,
aggregation, attribution, diagnostics, and renderer DTO production. For
metadata-backed adapters, the generic metadata runtime additionally owns shared
source lifecycle, bounded incremental scans, and fan-out.

The agent module owns, when applicable:

- source descriptors in `metadataSources`, tagged with the product purposes
  that consume them
- transcript/event parsing
- agent-specific deduplication keys
- model/provider extraction
- parser or adapter state required by that format

Usage samples identify `agentId` and `modelId` when known. Missing model pricing
is a normal partial-cost state. Pricing-table updates are data coverage, not
another agent registration point.

### Subscription Usage

The subscription capability owns the existing credential lookup and quota
fetcher for that agent. The generic usage runtime discovers those fetchers from
the composition instead of a handwritten vendor list. Existing subscription
DTO identity, polling, visibility, and rendering semantics remain unchanged;
multi-account reconciliation and a new provider/product schema are out of
scope. Missing credentials must not disable terminal launch, hooks, external
sessions, or transcript usage.

### Process Detection

The process-detection capability owns executable basenames, wrapper aliases,
argument signatures, and optional prompt-state detection. Process enumeration
and platform APIs remain generic services.

Detection is evidence for presentation and status. It does not authorize
command execution or session restore.

## Registry and Composition

The built-in module list is the only handwritten global registration point:

```ts
import { antigravityAgent } from "./antigravity";
import { claudeAgent } from "./claude";
import { codexAgent } from "./codex";

export const builtinAgentModules = [
  claudeAgent,
  codexAgent,
  antigravityAgent
] satisfies readonly AgentModule[];
```

A future GLM integration changes this file only by importing `glmAgent` and
appending it to this array.

The complete registry is created explicitly but remains private to the
composition layer. The public runtime contracts are deliberately narrower:

```ts
export interface AgentCatalog {
  listDescriptors(): readonly AgentDescriptor[];
  descriptor(id: AgentId): AgentDescriptor | undefined;
  resolveOperationalIngress(input: string): AgentId | undefined;
}

export interface CapabilityResolver<K extends AgentCapabilityKey> {
  resolve(id: AgentId): AgentCapabilityFor<K> | undefined;
}

interface InternalAgentModuleRegistry {
  readonly catalog: AgentCatalog;
  resolver<K extends AgentCapabilityKey>(key: K): CapabilityResolver<K>;
  materialize<K extends AgentCapabilityKey>(
    key: K
  ): readonly AgentCapabilityBinding<K>[];
}

function createInternalAgentModuleRegistry(
  modules: readonly AgentModule[]
): InternalAgentModuleRegistry;
```

Main and any Node utility process that requires executable adapters instantiate
their own process-local registry from the same `builtinAgentModules` source.
They do not share object identity across processes. Only composition roots and
manifest generators receive `InternalAgentModuleRegistry` or the complete
`AgentModule[]`. A feature runtime receives one capability-specific resolver, a
materialized list for one capability, or an already resolved adapter. It never
receives the internal registry or an `AgentModule`.

One handwritten composition source defines registration identity; it does not
require every process to eagerly load every runtime implementation. The same
source may derive process-specific entrypoints or use statically declared lazy
capability factories so, for example, `remote-host` does not load an unused
subscription credential implementation and a manifest generator does not
instantiate usage parsers. Lightweight descriptors and portable definitions
remain available without runtime I/O. These projections/loaders are generated
or declared in the one module entry, never maintained as another handwritten
agent list, and no import path comes from user-controlled data. An initial eager
implementation is allowed while the catalog is small, but it is not an
architectural requirement.

`builtinAgentModules`, the internal registry constructor, and executable module
types live behind a composition-only package export. Public package exports and
dependency-boundary checks prevent renderer and feature packages from importing
them. Removing `list()` alone is not considered sufficient if a broad `get()` or
generic registry can still be injected into consumers.

The renderer does not import executable modules. Main publishes a serializable
descriptor catalog through the existing trusted IPC path. The renderer combines
that catalog with observed data and uses generic views.

This is intentionally different from a self-registering plugin system:

- no module executes a global registration side effect on import
- no directory scan determines production behavior
- no load order changes alias precedence
- no static or lazy `import()` path comes from user configuration
- bundlers can see every built-in entry

## Package and Ownership Boundaries

The target source layout is:

```text
packages/agents/
  package.json
  src/
    contracts.ts
    catalog.ts
    composition.ts                # composition-only export
    manifest.ts
    builtins/
      index.ts                    # only handwritten built-in list
      claude/
        index.ts
        descriptor.ts
        command.ts
        hooks.ts
        metadata.ts
        usage.ts
        subscription.ts
        processDetection.ts
        terminalNotifications.ts
      codex/
      antigravity/
      <future-agent>/
```

Files may be combined when small. The directory, not a mandatory file count or
class hierarchy, is the ownership boundary.

Package responsibilities are:

| Area                      | Responsibility                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `@kmux/proto`             | Open agent/provider IDs, bounded wire DTOs, codecs, normalized lifecycle events, descriptor DTOs                  |
| `@kmux/core`              | Persist open IDs and generic settings/session references; no agent behavior registry or name switch               |
| `@kmux/agents`            | Public catalog/capability contracts plus composition-only registry validation, built-ins, and manifest generation |
| `@kmux/metadata`          | Vendor-neutral shared source coordination, inventory/read bounds, records, aggregation, and watcher primitives    |
| `@kmux/agent-integration` | Generic hook-config merge/apply primitives during the refactor; no handwritten built-in list                      |
| Electron Main             | Construct the internal registry, inject narrow dependencies, authorize operations, publish DTOs, select targets   |
| `pty-host`                | Consume resolved shell and hook policy; never select an agent implementation                                      |
| Renderer                  | Render descriptor/capability DTOs generically; never import Node adapters                                         |
| `remote-host`             | Compose narrow dependencies from the same built-ins for planning/parsing and negotiate remote primitive support   |
| `kmuxd`                   | Execute bounded portable manifest primitives; no independent fixed agent set                                      |

Dependency direction must avoid a cycle:

```text
@kmux/proto                 @kmux/metadata contracts/utilities
      ▲                                  ▲
      └──────────── @kmux/agents ────────┘
                           ▲
                 Main / remote-host composition

Renderer  ◀──── serializable descriptor DTOs from Main
pty-host  ◀──── resolved serializable shell policy from Main
```

`@kmux/metadata` must not import the built-in agent registry. Generic runtimes
accept resolved source topologies and metadata-backed projections supplied by
composition. `@kmux/core` must not import Node agent capabilities.

`@kmux/agents` has no Electron imports and performs no filesystem, process,
credential, watcher, or registration side effect at module import time.
Capability factories receive the narrow Node/platform/target services they need
from their process composition root.

## Settings

The normalized settings model uses explicit scopes and open agent keys:

```ts
export interface AgentSettings {
  command?: string;
  args?: string[];
  sessionRoot?: string;
}

export type AgentScopeSettingsDto = Record<string, AgentSettings>;

export interface AgentsSettingsDto {
  [agentId: string]: AgentSettings | AgentScopeSettingsDto | undefined;
  ssh?: AgentScopeSettingsDto;
}
```

Persistence and wire settings keep the existing version-6 shape. Local agent
IDs live directly under `agents`; `ssh` remains the reserved scope key. All
other syntax-valid keys are preserved as open agent IDs. After boundary
validation, feature code receives separate local and SSH
`ReadonlyMap<AgentId, AgentSettings>` values (or equivalent encapsulated
collections) rather than indexing the mixed persisted DTO. This refactor does
not change the settings version or migrate stored settings.

Settings consumers use the catalog for identity and the existing common fields:
command, args, and session root. This ADR does not add a settings screen, JSON
Schema form engine, or secret editor. If a future agent needs a new shared
setting primitive, that is a deliberate capability-contract extension.

## Persistence and Unknown Agents

Open identity is a forward- and downgrade-compatibility rule.

When a snapshot or settings file contains a syntactically valid but unregistered
agent ID:

- preserve the validated stored ID spelling and bounded generic settings
- preserve an existing session reference and target/cwd identity
- render a neutral label and an unsupported-in-this-build status
- do not auto-launch, resume, install hooks, read credentials, or scan arbitrary
  paths for that agent
- do not silently substitute another registered agent
- do not drop the containing workspace or terminal Surface

This differs from unknown Surface kinds in ADR 0006. An agent ID is metadata on
an otherwise known Terminal Session; preserving it does not require rendering an
unknown Surface implementation.

Malformed IDs, malformed settings values, impossible target references, or
structurally invalid session records retain the existing strict decode policy.
Open identity does not mean permissive structure.

## Electron and Renderer Contract

Main exposes a descriptor catalog such as:

```ts
export interface AgentDescriptorDto {
  id: string;
  displayName: string;
  aliases: string[];
  capabilities: AgentCapabilityKey[];
  presentation?: AgentPresentationDto;
}
```

The DTO is bounded and decoded exactly. `id` is syntax-validated but the
renderer does not use it to execute code.

Renderer rules:

- filters are derived from descriptors and observed records, not a fixed array
- an observed unknown ID remains selectable through a generic fallback
- resume/fork/hook/subscription actions appear only for supported capabilities
- operation errors come from Main, not renderer-side binary or file probing
- the renderer never constructs native resume argv
- the renderer never imports credential, filesystem, or parser code

Existing IPC endpoints retain their names during the refactor. Their decoders
must stop enforcing a global exact vendor set and instead validate request shape,
ID syntax, capability, and authorization.

## Local and SSH Targets

Agent identity and target identity are orthogonal:

```text
CapabilityResolver<K> answers: how does this agent implement capability K?
TargetServiceRegistry answers: where does this operation execute?
```

Feature code resolves both at its composition boundary. An agent module never
contains `if (target.kind === "ssh")`, opens an SSH channel, or treats a remote
path as local. Target providers never contain Claude/Codex/Antigravity selection
logic.

For example, external history refresh resolves:

1. the workspace/selected target through `TargetServiceRegistry`
2. the agent's history projection through a history-only resolver
3. the target-bound metadata primitive declared by that capability
4. normalized records retaining both `agentId` and target identity

Capability absence for one agent or target degrades that combination only.

## Portable Remote Manifest

The TypeScript module object cannot cross into the Rust remote runtime. The
built-in registry therefore derives a versioned, serializable portable manifest
for behavior that the remote runtime can safely execute declaratively.

Initial portable primitives include:

- hook config path and supported merge format
- managed/deprecated hook entries and ownership markers
- bounded synchronous hook-response and fallback policies
- default storage-root descriptors
- bounded metadata source patterns and formats
- bounded query-plan identifiers already implemented by the remote runtime
- per-agent portable-definition revisions

The manifest does not contain secrets, arbitrary shell, arbitrary SQL, or
JavaScript callbacks.

A generated aggregate JSON artifact is checked into the repository and embedded
in `kmuxd` at build time, for example with `include_str!`. Generation and a CI
drift check are required. The artifact is not a handwritten registration point
and must not require manual agent-specific edits.

Manifest authority is deliberately two-sided:

- the desktop's built-in composition is authoritative for what that desktop
  version may request and advertise
- the manifest embedded in `kmuxd` is authoritative for what that remote binary
  may execute
- effective remote support is the compatible intersection of agent ID,
  primitive version, and per-agent definition revision/hash on both sides

The desktop never uploads an executable manifest, glob, path template, query
text, or hook merge program for `kmuxd` to trust. Wire requests carry only
bounded operation data such as agent ID, definition revision/hash, source role
or query-plan ID, claim/reference identity, and operation parameters. A
user-configured agent root may cross the wire as bounded configuration, but it
does not redefine a source pattern or escape server-side authorization and path
validation.

Before accepting metadata or hook integration operations, `kmuxd` parses,
validates, and indexes its embedded manifest once and then treats it as
immutable. A malformed aggregate schema, unsupported security-critical
primitive, or failed global invariant disables initialization of the affected
remote subsystem rather than partially executing an unvalidated manifest. A
valid aggregate with a missing or mismatched per-agent revision degrades only
that agent capability.

Portable path and source definitions use a restricted, versioned grammar:

- source patterns are relative to a validated agent root; absolute paths,
  empty/ambiguous segments, `.` and `..`, platform device prefixes, and symlink
  traversal are forbidden
- every inventory/read is scoped to the authenticated principal, an authorized
  root/claim, agent ID, source role, and definition revision
- candidate and opened-file canonical identity, regular-file type, symlink
  status, owning UID, device, inode, root membership, and requested role are
  validated before use and revalidated around reads where races are possible
- files are opened without following symlinks, and no incompatibility falls
  back to an unscoped filesystem scan

Framework hard limits exist independently of the manifest for root count,
directory depth, visited directories, entries, bytes per file/read/response,
SQLite rows and query time, operation time, and concurrency. A manifest may
narrow but never raise these limits. Query-plan IDs select reviewed,
server-implemented read-only queries; no manifest or wire request supplies SQL.
Pattern validation occurs during generation and again when the embedded
manifest is initialized. A generic implementation must not turn a declarative
pattern such as `**/*.jsonl` into an unbounded filesystem glob.

These rules preserve the existing claim, canonical-path, no-follow,
UID/device/inode, role, bounded-read, and bounded-query guarantees while making
the agent catalog open.

The Rust implementation must not require an exact count or exact global set of
agent IDs. For request/response operations it validates returned agent IDs and
source roles against the specific embedded manifest entries and authenticated
claims selected for that request.

Adding a built-in agent that uses existing portable primitives rebuilds `kmuxd`
with the generated manifest but requires no Rust source change. If the agent
needs a genuinely new remote primitive, such as an unsupported database format
or hook merge grammar, adding that primitive is a shared framework change and is
the explicit exception to the one-directory rule.

### Remote Version Skew

Remote capability negotiation is per primitive and per agent revision.

- an older remote runtime may continue supporting existing agents
- a new agent unavailable in that runtime reports `runtime_too_old` or
  `target_unsupported`
- missing support for one agent does not invalidate the target or other agents
- an unexpected agent entry is rejected relative to the request, not because it
  is absent from a compile-time three-value union
- no remote incompatibility falls back to local filesystem access or a local
  process with the same session ID

The current fixed-three integration and metadata contracts remain behind a
compatibility adapter only for the supported remote-version window. New code
does not add a fourth branch to those legacy contracts.

## Performance Invariants

The import-time, metadata, remote-bound, and PTY hot-path rules defined in their
owning sections are normative. Descriptor IPC is additionally
bounded and revision-driven, never emitted per PTY output chunk. Map-versus-switch
dispatch is not an acceptance criterion; measure startup, metadata refresh,
remote round-trips, watcher counts, and terminal data-plane continuity
separately.

## Generated Outputs and Documentation

The following values are derived from the registry or portable manifest:

- supported-agent lists
- hook integration tables
- bounded hook-response policy artifacts for `@kmux/cli`, installed local
  helper fallbacks, and `kmuxd`
- remote portable agent contract

Human-authored documentation may explain agent-specific behavior, but it must
not be an executable source of truth. A new module can add co-located docs or
assets without editing another code registry.

## Definition of an Ordinary New-Agent Addition

An **ordinary new-agent addition** is one whose required behavior can be
expressed by existing capability and portable-primitive contracts.

For such an agent, the only handwritten production-code changes are:

1. `packages/agents/src/builtins/<agent>/...`
2. one import and one array entry in
   `packages/agents/src/builtins/index.ts`
3. capability-specific tests and fixtures owned by that directory

Generated artifacts may change after running their generator. Generic user docs
or release notes may change, but no proto union, IPC decoder, Main switch,
metadata factory, remote vendor count, settings sanitizer, or renderer filter is
edited to recognize the new ID.

The following are not ordinary additions and may change shared code:

- adding a new kmux-wide lifecycle event semantic
- adding a new hook merge grammar
- adding a new remote-readable storage/database primitive
- adding a new remote command, daemon/RPC, or provider-API acquisition primitive
- adding a new generic settings field type
- adding a new account credential backend
- changing terminal or remote transport semantics

Even in those cases, agent-specific policy remains in the agent directory. The
shared change adds a reusable primitive rather than an agent-name condition.

The executable architecture gate registers test-only fixtures through this
ordinary-addition path and verifies all of the following:

- implemented capabilities traverse settings, IPC, Main/remote dispatch, and
  renderer projections without editing a consumer whitelist or agent-name switch
- the same test composition passes through production manifest generation,
  generic CLI/wire decoding, and a Rust manifest-contract fixture
- the metadata coordinator's own contract tests verify that projections sharing
  one topology do not duplicate inventory, watcher, or in-flight read work

The refactor is complete only when this gate passes together with the existing
local and SSH terminal-continuity gates.

## Implementation and Acceptance

Implementation is staged in this order:

1. open identity, descriptor catalog, and composition-private registry
2. generic resume-command resolution, settings integration, and renderer
   descriptors
3. generated hook definitions/responses and terminal-notification capabilities
4. metadata-source coordination and external-session/history projection
5. usage and subscription capability ownership without changing their product
   semantics
6. obsolete compatibility removal and the ordinary-addition architecture gate
   above

Every stage preserves current Claude, Codex, and Antigravity behavior before the
next stage begins. Detailed task tracking may evolve during implementation, but
a change that weakens or contradicts this ADR's identity, composition,
metadata, remote security, or terminal-continuity boundaries
requires an ADR amendment.

`Accepted` records approval of the architecture, not completion of the
refactor. Completion is determined by that architecture gate and the durable
behavior contracts defined in the relevant capability sections.

## Consequences

### Benefits

- Ordinary additions have one discoverable owner and require no feature-local
  agent-name branch.
- Optional capabilities let UI, local, and SSH runtimes report support honestly.
- Unknown IDs survive version skew without becoming executable, while Electron
  and remote boundaries remain serializable and testable.
- Shared metadata coordination bounds duplicate inventory, watcher, and read
  work.
- Agent identity remains independent of model-pricing identity.

### Costs

- This is a medium-to-large cross-cutting refactor across TypeScript packages,
  Electron processes, persistence, and the Rust remote runtime.
- Open IDs replace some compile-time exhaustiveness with runtime registry and
  boundary validation.
- Portable remote behavior requires a generated manifest and parity checks.
- Shared metadata coordination introduces explicit lifecycle/cache ownership
  that the current scattered implementations lack.
- Remote compatibility requires explicit version negotiation.

### Risks

- Moving parsers can accidentally change attribution or deduplication.
- A package-export mistake can re-expose the internal module registry and let
  consumers recreate a service locator despite the narrow public contracts.
- Descriptor and generated-manifest drift can create local/remote differences.
- A generic metadata implementation can multiply scans or weaken existing
  remote path and resource bounds if it treats manifest patterns as untrusted
  executable glob definitions.
- Unknown-ID preservation can become unsafe if execution checks conflate syntax
  with registration or if a new alias silently reinterprets persisted state.
- A big-bang implementation could regress session restore or terminal
  continuity even though the intended architecture is control-plane-only.

The staged implementation, package-boundary checks, shared-coordinator lifecycle
tests, generated-artifact checks, hard remote limits, and strict execution
authorization mitigate these risks.

## Rejected Alternatives

### Keep Closed Literal Unions and Add Each Agent Everywhere

Rejected because the current problem is precisely the number of independent
places that must agree. TypeScript exhaustiveness is useful inside a closed
product algebra such as normalized lifecycle events, but agent integrations are
an open catalog.

### One Required God Interface

Rejected because not every CLI exposes hooks, native resume, readable
transcripts, subscription quota, or safe process detection. Required stub
methods would hide unsupported states and couple unrelated dependencies.

### Class Inheritance Hierarchy

Rejected because inheritance does not solve process boundaries or optional
capabilities. Plain immutable objects and factories with `satisfies` preserve
structural typing and composition. A stateful adapter may use a class
internally, but registration does not require subclassing.

### Separate Handwritten Registries per Feature or Process

Rejected because hook, process-detection, external-session, usage, renderer, and
remote catalogs would drift. Processes may instantiate separate registry
objects, but all built-in composition derives from the same module list.

### Expose the Complete Module Registry to Every Feature

Rejected because a broad `list()` or `get()` recreates a service locator and
allows feature code to recover agent-name filtering and unrelated capabilities.
Only composition roots see complete modules; consumers receive a descriptor
catalog or one capability-specific dependency.

### Independent Source Acquisition per Product Capability

Rejected because history, external sessions, and usage often project the same
transcript, database, or upstream service. Independent factories would multiply
local watchers, SSH listings, identity checks, reads, or requests. Product
capabilities remain separate while identical metadata sources are coordinated
once.

### Cross-Process Plugin Objects

Rejected because functions, watchers, filesystem handles, React components, and
credentials must not cross Electron IPC or the Rust wire. Cross-process data is
limited to bounded descriptors, resolved policies, and portable manifests.

### Runtime Third-Party JavaScript Plugins

Rejected for this phase because it introduces code-signing, sandboxing, API
versioning, dependency loading, renderer isolation, and supply-chain concerns
unnecessary for first-party built-in extensibility.

### Automatic Filesystem Discovery or Import-Time Self-Registration

Rejected because it makes production composition dependent on bundler behavior,
load order, and side effects. One explicit array entry is small, reviewable, and
statically analyzable by the bundler; process-specific projection or lazy
loading remains an implementation choice under the rules above.

### Make Every Integration Data-Only

Rejected because transcript parsing, incremental deduplication, credential
access, lifecycle normalization, and some resume sanitization require trusted
code. Declarative definitions are used only where a bounded primitive is
sufficient.

### Treat Agent, Model, and Subscription Provider as One Vendor Enum

Rejected because those identities already differ in scope and will diverge
further as agents support multiple providers and models.
