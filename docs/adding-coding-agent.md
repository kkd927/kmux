# Adding a Coding Agent

Use this path when the new CLI fits the primitives in
[ADR 0007](./adr/0007-extensible-coding-agent-integrations.md).

## Change Boundary

Handwritten production files normally stay here:

```text
packages/agents/src/builtins/<agent>/
  index.ts          # required descriptor and capability wiring
  resume.ts         # optional argv construction
  inventory.ts      # optional metadata path classification
  sessions.ts       # optional local/SSH session projection
  usage.ts          # optional usage projection
  subscription.ts   # optional authenticated quota acquisition

packages/agents/src/builtins/index.ts  # one import and one array entry
```

Do not add the agent ID to Proto unions, IPC decoders, Main/renderer switches,
Rust branches, or settings migrations. Generated artifacts are never edited by
hand.

Stop and add a reusable primitive first if the agent needs a new hook grammar,
metadata format, credential backend, remote operation, or lifecycle semantic.

## 1. Define the Module

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
  command: { executable: "example" },
  processDetection: { executableBasenames: ["example"] }
} satisfies AgentModule);
```

- Prefer the real executable as the canonical ID.
- Aliases are only for operational executable/hook names. They never migrate or
  reinterpret persisted IDs.
- Advertise only capabilities that work in production.
- Keep parsing, credentials, and vendor policy inside this directory.
- Bump `definitionRevision` when portable hooks, metadata, or remote projection
  behavior changes.

## 2. Add Capabilities

### Resume

Return argv, never a shell command. Put agent-specific selector cleanup in
`resume.ts`, then add the exact persisted session ID.

```ts
import { buildExampleResumeArgs } from "./resume";

const resume = { build: buildExampleResumeArgs };
```

`buildExampleResumeArgs` must remove every conflicting selector form the CLI
accepts (`--resume value`, `--resume=value`, short aliases, and continue flags).

### Hooks

Describe the vendor JSON layout; the shared installer owns merge, cleanup, and
atomic writes.

```ts
hooks: {
  portable: {
    pathRoot: {
      defaultHomeRelativePath: ".example",
      environmentVariable: "EXAMPLE_HOME"
    },
    relativePath: "hooks/kmux.json",
    document: {
      eventsPath: ["hooks"],
      version: { field: "version", value: 1 } // omit if unversioned
    },
    entry: { commandField: "bash" },
    marker: "KMUX_MANAGED_EXAMPLE_HOOK=1",
    managed: [{ event: "sessionStart" }, { event: "agentStop" }],
    deprecated: [],
    outputMode: "silent",
    successResponse: {},
    fallbackResponse: {},
    sessionClaim: {
      startEvents: ["sessionStart"],
      sessionIdFields: ["sessionId", "session_id"]
    }
  },
  normalize(rawEvent, payload) {
    if (rawEvent === "sessionStart") {
      const sessionId =
        typeof payload.sessionId === "string" ? payload.sessionId : undefined;
      return {
        event: "session_start",
        ...(sessionId ? { vendorSessionId: sessionId } : {})
      };
    }
    if (rawEvent === "agentStop") return { event: "turn_complete" };
    return null;
  }
}
```

`sessionClaim` is required for SSH discovery of session-scoped metadata. Use
`claimScope: "agent"` only for a genuinely agent-global source.

Hook entry shapes:

| Vendor entry                        | Declaration                                    |
| ----------------------------------- | ---------------------------------------------- |
| `{ "type": "command", "bash": "" }` | `entry: { commandField: "bash" }`              |
| `{ "hooks": [{ "command": "" }] }`  | `wrapper: { field: "hooks", when: "always" }`  |
| Only matched entries are wrapped    | `wrapper: { field: "hooks", when: "matcher" }` |

### Metadata and Sessions

Declare every file read by a projection:

```ts
const EXAMPLE_PATH_ROOT = {
  defaultHomeRelativePath: ".example",
  environmentVariable: "EXAMPLE_HOME"
} as const;

metadataSources: {
  revision: "example-metadata-v1",
  pathRoot: EXAMPLE_PATH_ROOT,
  defaultRoot: "session-state",
  sources: [{
    role: "example-session",
    format: "jsonl",
    pattern: "*/events.jsonl",
    purposes: ["sessions", "usage"]
  }]
},
sessions: {
  createMetadataProjection: createExampleSessionProjection,
  createSourceProjection: createExampleSessionSourceProjection
}
```

- The local sessions runtime applies `pathRoot` and
  `settings.agents[agentId].sessionRoot` automatically.
- `createMetadataProjection` is required. Add `createSourceProjection` when SSH
  Sessions are supported.
- Read only through the supplied bounded `readText`/`query` functions.
- For SQLite, declare both `localQueryPlans` and each source's `queryPlanIds`.
- Bump `metadataSources.revision` when topology or query definitions change.

### Usage

Usage needs the same target-neutral projection locally and over SSH. The local
adapter only supplies roots, classification, and watcher policy:

```ts
usage: {
  pricingVendorId: "example-pricing", // omit when cost is reported or unknown
  createSourceProjection: createExampleUsageSourceProjection,
  createLocalAdapter(options) {
    const env = options.env ?? process.env;
    const storage = options.agentStorageRoots ??
      resolveAgentStorageRoots({ homeDir: options.homeDir, env });
    const roots = resolveAgentMetadataRoots({
      agentId: "example",
      homeDir: storage.homeDir,
      env,
      pathRoot: EXAMPLE_PATH_ROOT,
      defaultRoot: "session-state",
      agentSettings: options.agentSettings
    });
    return createFileUsageAdapter({
      agentId: "example",
      roots,
      topologyRoots: roots,
      sourceProjection: createExampleUsageSourceProjection(),
      classifySource(candidate) {
        const role = classifyExampleMetadataPath(roots, candidate.path);
        return role ? { role, format: "jsonl" } : null;
      },
      metadataInventory: options.metadataInventory,
      watchRecursive: usageWatchIsRecursive(
        options.platform ?? process.platform
      )
    });
  }
}
```

The projection owns incremental state, absolute-counter deltas, deduplication,
and malformed-record handling. Do not bypass the metadata coordinator.

`pricingVendorId` is an open catalog key. Add a `standard` catalog entry to
`packages/metadata/src/modelPricing.json` only for real USD token pricing, then
run `npm run update:model-pricing` to refresh its revision. Vendor credits such
as Copilot AIC are not USD pricing and must omit this field.

### Subscription Quota

Use a stable structured API or headless RPC; do not scrape interactive terminal
output. Keep credential/network code out of the eager module bundle:

```ts
subscription: {
  createFetcher: (options) => async () =>
    (await import("./subscription")).fetchExampleSubscriptionUsage(options),
  createAuthDetector: (options) => async () =>
    (await import("./subscription")).detectExampleSubscriptionAuth(options)
}
```

The returned `SubscriptionProviderUsageVm` may select an existing
`accentTone`: `blue`, `amber`, `violet`, `emerald`, `rose`, or `slate`. Do not
add renderer vendor-color branches. If a structured quota exists but is not
implemented, document the partial support.

## 3. Register and Generate

Add one import and one array entry in
`packages/agents/src/builtins/index.ts`, then run:

```bash
npm run generate:agents
npm run check:agents
npm run check:agent-architecture
npm run check:agent-integration-contract
```

Update `docs/agent-signal-matrix.md` when hook or lifecycle semantics change.

## 4. Verify

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

For hooks, portable metadata, or remote behavior:

```bash
cd remote/kmuxd
cargo fmt --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Add agent-owned tests only for durable behavior: resume sanitization, hook
normalization, session parsing, usage deltas/deduplication, quota normalization,
process detection, and malformed input.

## Done When

- handwritten production policy is confined to the agent directory and the one
  registry entry
- no settings migration or shared agent-name branch was added
- declared local and SSH capabilities work with the same roots and IDs
- generated artifacts are current
- relevant tests, typecheck, lint, build, and Rust checks pass
