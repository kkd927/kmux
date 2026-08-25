import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { format, resolveConfig } from "prettier";

import {
  builtinAgentModules,
  createInternalAgentModuleRegistry,
  createPortableAgentManifest
} from "@kmux/agents/composition";

const root = resolve(import.meta.dirname, "..");
const check = process.argv.includes("--check");
createInternalAgentModuleRegistry(builtinAgentModules);
const manifest = createPortableAgentManifest(builtinAgentModules);
const prettierOptions = (await resolveConfig(root)) ?? {};

const commandTemplate =
  '{marker}; KMUX_AGENT_INTEGRATION_CONTRACT_VERSION=2; _kmux_agent_hook=; if [ -n "${KMUX_AGENT_BIN_DIR:-}" ] && [ -x "${KMUX_AGENT_BIN_DIR}/kmux-agent-hook" ]; then _kmux_agent_hook="${KMUX_AGENT_BIN_DIR}/kmux-agent-hook"; else _kmux_agent_hook="$(command -v kmux-agent-hook 2>/dev/null || true)"; fi; if [ -n "$_kmux_agent_hook" ] && [ -x "$_kmux_agent_hook" ]; then KMUX_AGENT_HOOK_OUTPUT_MODE={outputMode} "$_kmux_agent_hook" {agent} {event} || {fallback}; else {fallback}; fi';
const commandWrappers = generatedCommandWrappers();

const integrationContract = {
  contractVersion: 2,
  commandTemplate,
  commandWrappers,
  vendors: Object.fromEntries(
    manifest.agents.flatMap((agent) => {
      const hook = agent.hook;
      if (!hook) return [];
      return [
        [
          agent.id,
          {
            format: hook.format,
            ...(hook.pathRoot ? { pathRoot: { ...hook.pathRoot } } : {}),
            relativePath: hook.relativePath,
            ...(hook.namespace ? { namespace: hook.namespace } : {}),
            marker: hook.marker,
            managed: hook.managed,
            deprecated: hook.deprecated,
            outputMode: hook.outputMode,
            fallback: responseShell(hook.fallbackResponse, hook.outputMode),
            ...(hook.fallbackByEvent
              ? {
                  fallbackByEvent: Object.fromEntries(
                    Object.entries(hook.fallbackByEvent).map(
                      ([event, response]) => [
                        event,
                        responseShell(response, hook.outputMode)
                      ]
                    )
                  )
                }
              : {})
          }
        ]
      ];
    })
  )
};

const metadataSources = manifest.agents.flatMap((agent) =>
  (agent.metadata?.sources ?? []).map((source) => ({
    vendor: agent.id,
    role: source.role,
    format: source.format,
    purposes: source.purposes
      .map((purpose) => (purpose === "externalSessions" ? "history" : purpose))
      .filter((purpose, index, values) => values.indexOf(purpose) === index),
    ...(source.claimScope === undefined
      ? {}
      : { claimScope: source.claimScope }),
    pattern: source.pattern
  }))
);
const metadataContract = {
  version: 2,
  capability: "agent-metadata-sources-v2",
  limits: {
    sourceReadBytes: 262_144,
    responseBytes: 1_048_576,
    queryRows: 512,
    queryExecutionMs: 250
  },
  sources: metadataSources,
  queries: Object.fromEntries(
    manifest.agents.flatMap((agent) =>
      (agent.metadata?.sources ?? []).flatMap((source) =>
        (source.queryPlanIds ?? []).map((id) => [
          queryContractKey(id),
          { id, sourceRole: source.role }
        ])
      )
    )
  )
};

const hookResponses = Object.fromEntries(
  manifest.agents.flatMap((agent) => {
    if (!agent.hook) return [];
    const policy = {
      success: agent.hook.successResponse,
      fallback: agent.hook.fallbackResponse,
      fallbackByEvent: agent.hook.fallbackByEvent ?? {}
    };
    return [agent.id, ...agent.aliases].map((id) => [id, policy]);
  })
);

function generatedCommandWrappers() {
  return builtinAgentModules.flatMap((agent) =>
    agent.commandWrapper && agent.command && agent.hooks
      ? [
          {
            agentId: agent.descriptor.id,
            executable: agent.command.executable,
            ...agent.commandWrapper,
            integrationManagedMarker: agent.hooks.portable.marker
          }
        ]
      : []
  );
}

await emitGenerated(
  "packages/agents/generated/portable-agent-manifest.json",
  JSON.stringify(manifest)
);
await emitGenerated(
  "packages/agents/generated/hook-responses.json",
  JSON.stringify(hookResponses)
);
await emitGenerated(
  "packages/agents/generated/command-wrappers.json",
  JSON.stringify(commandWrappers)
);
await emitGenerated(
  "packages/agent-integration/contract.json",
  JSON.stringify(integrationContract)
);
await emitGenerated(
  "packages/metadata/source-contract.json",
  JSON.stringify(metadataContract)
);

function responseShell(
  response: Readonly<Record<string, unknown>>,
  outputMode: "silent" | "json"
): string {
  const encoded = JSON.stringify(response);
  if (outputMode === "silent" && encoded === "{}") return "true";
  return encoded === "{}"
    ? "printf '%s\\n' '{}'"
    : `printf '%s\\n' '${encoded.replaceAll("'", "'\\''")}'`;
}

function queryContractKey(id: string): string {
  const parts = id.split(".").filter((part) => !/^v\d+$/u.test(part));
  return parts
    .map((part, index) =>
      index === 0 ? part : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`
    )
    .join("");
}

async function emitGenerated(
  relativePath: string,
  content: string
): Promise<void> {
  const path = resolve(root, relativePath);
  emit(
    relativePath,
    await format(content, { ...prettierOptions, filepath: path })
  );
}

function emit(relativePath: string, content: string): void {
  const path = resolve(root, relativePath);
  if (check) {
    let current = "";
    try {
      current = readFileSync(path, "utf8");
    } catch {
      current = "";
    }
    if (current !== content) {
      throw new Error(`generated agent artifact is stale: ${relativePath}`);
    }
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}
