# Adding a Coding-Agent Integration

This is the contributor workflow for adding a coding-agent integration to
`kmux`. [ADR 0007](./adr/0007-extensible-coding-agent-integrations.md) defines
the normative architecture. If this guide and the ADR disagree, the ADR takes
precedence.

## Decide Whether the Addition Is Ordinary

An ordinary addition is an agent whose behavior can be expressed with the
existing capability and portable-primitive contracts.

For an ordinary addition, the only handwritten production-code changes are:

1. files under `packages/agents/src/builtins/<agent>/`
2. one import and one array entry in
   `packages/agents/src/builtins/index.ts`

Generated artifacts and agent-owned tests may also change. Shared consumers do
not need another agent-name condition.

The change is not ordinary if it requires a new reusable primitive, such as:

- a hook configuration grammar
- a metadata source format or remote locator
- a remote command or RPC operation
- a settings field type
- a credential backend
- a kmux-wide lifecycle event semantic

Add and review the generic primitive separately. Keep the agent-specific policy
inside the agent directory; do not add a one-off vendor branch to shared code.

## Create the Agent Module

Create an agent-owned directory:

```text
packages/agents/src/builtins/<agent>/
  index.ts
```

Use the closest existing built-in as a reference:

- `builtins/claude/`
- `builtins/codex/`
- `builtins/antigravity/`

Every module has a descriptor and definition revision. Add only the capabilities
that work in production.

```ts
import type { AgentModule } from "../../contracts";

export const exampleAgent = Object.freeze({
  descriptor: {
    id: "example",
    displayName: "Example",
    aliases: [],
    presentation: { shortLabel: "EXAMPLE" }
  },
  definitionRevision: "example-v1",
  command: {
    executable: "example"
  }
} satisfies AgentModule);
```

`AgentId` is already open-ended. Do not add the new ID to a Proto union or a
consumer allowlist.

Aliases are accepted only at operational ingress, such as CLI and hook input.
Declare an alias only when the agent has a real executable or hook alias that
kmux must accept. Persisted settings and session state use canonical IDs and
must never be dynamically reinterpreted through the current alias registry.

Increment `definitionRevision` when a portable definition changes in a way that
requires local and remote runtimes to agree on the new contract. Increment the
metadata revision when the declared metadata topology or interpretation changes.

## Implement Capabilities

The available optional capabilities are defined by `AgentModule` in
`packages/agents/src/contracts.ts`:

- `command` and `resume`: executable identity and argv-only resume behavior
- `commandWrapper`: reviewed version-gated executable wrapper policy
- `hooks`: portable hook installation plus agent-owned event normalization
- `metadataSources`: portable, bounded metadata source topology
- `externalSessions`: session-list projection
- `history`: conversation-history projection
- `usage`: local and remote usage projection
- `subscription`: authenticated subscription usage acquisition
- `processDetection`: executable and wrapper matching
- `terminalNotifications`: agent-specific terminal notification classification

Do not advertise a capability whose production path is absent. A capability
shown in the descriptor must work through the relevant local or remote
composition path, not only in an isolated unit test.

Keep agent-specific parsing, metadata classification, credential lookup, API
normalization, process detection, and notification policy under the agent
directory. Shared packages may expose vendor-neutral facilities such as bounded
reads, inventory coordination, HTTP deadlines, and credential interfaces.

For metadata-backed capabilities:

- declare source roles, formats, patterns, purposes, and claim scope in the
  agent module
- use `pathRoot` when an established environment variable relocates the agent
  home directory
- use the shared inventory, read, watch, and query services
- ensure every advertised remote projection can be materialized from the
  portable manifest

Do not bypass the metadata coordinator with an undeclared side file or add a
vendor switch to `@kmux/metadata` or the remote host.

## Register the Module

Add one import and one entry to
`packages/agents/src/builtins/index.ts`:

```ts
import { exampleAgent } from "./example";

export const builtinAgentModules = Object.freeze([
  claudeAgent,
  codexAgent,
  antigravityAgent,
  exampleAgent
] satisfies readonly AgentModule[]);
```

This is the only handwritten global built-in list.

## Regenerate Derived Artifacts

Run:

```bash
npm run generate:agents
```

Review the generated diff, but do not edit generated manifests or hook and
metadata contracts by hand. Check that generation is stable:

```bash
npm run check:agents
npm run check:agent-architecture
npm run check:agent-integration-contract
```

## Add Meaningful Tests

Place agent-owned tests and fixtures in the new agent directory. Test durable,
user-visible behavior such as:

- resume argv construction
- hook payload normalization
- metadata parsing and projection
- usage attribution and deduplication
- executable detection
- malformed or unsupported input handling

Test a rule at the layer that owns it and prefer observable outcomes over
implementation details. Do not duplicate generated-contract assertions or add
tests that only verify descriptor copy.

When a shared primitive is required, test that primitive at its owning layer.
The ordinary-agent architecture fixture should prove that existing consumers do
not require an agent-name branch.

## Validate the Integration

Run the narrowest relevant tests first, then:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

When portable metadata, hooks, or remote behavior changes, also run:

```bash
cargo test --workspace --manifest-path remote/kmuxd/Cargo.toml
```

Run the walking-skeleton, SSH, or terminal data-plane gates only when the change
affects those runtime boundaries. Follow the environment requirements documented
by each gate rather than treating a skipped or incompatible run as a pass.

## Do Not

An ordinary agent addition must not:

- introduce a settings schema version or settings migration
- reinterpret persisted unknown IDs through current aliases
- add the agent ID to Proto unions, IPC decoders, renderer filters, Main
  switches, metadata vendor lists, or Rust vendor matches
- expose executable adapters or the private registry over IPC
- advertise local or remote functionality that is not materialized
- hand-edit generated artifacts
- add agent-specific policy to a shared package merely to reuse its import path

Unknown persisted IDs must remain preserved but non-executable. Execution and
resume authority always come from a currently registered capability.

## Definition of Done

An ordinary integration is complete when:

- agent-specific production code is owned by its built-in directory
- `builtins/index.ts` is the only handwritten global registration change
- generated artifacts are current and drift checks pass
- declared local and remote capabilities work through production composition
- unknown IDs remain preserved and non-executable
- no settings migration or shared agent-name branch was introduced
- relevant behavioral tests, typecheck, lint, and build pass
