import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(
  await readFile(
    join(root, "packages/agents/generated/portable-agent-manifest.json"),
    "utf8"
  )
);
const agentIds = manifest.agents.map(({ id }) => id);
const errors = [];

const publicAgentExports = await readFile(
  join(root, "packages/agents/src/index.ts"),
  "utf8"
);
if (
  /export\s+type\s+\*\s+from\s+["']\.\/contracts["']/u.test(
    publicAgentExports
  ) ||
  /\bAgentModule\b/u.test(publicAgentExports)
) {
  errors.push(
    "packages/agents/src/index.ts exposes the composition-only AgentModule contract"
  );
}

const builtinRuntimeSource = await readFile(
  join(root, "packages/agents/src/builtinRuntime.ts"),
  "utf8"
);
if (
  /export\s+function\s+resolveBuiltinCapability\b/u.test(builtinRuntimeSource)
) {
  errors.push(
    "packages/agents/src/builtinRuntime.ts exposes a generic capability service locator"
  );
}

await forbidImports(
  "packages/core/src",
  /from\s+["']@kmux\/agents(?:\/|["'])/u
);
await forbidImports(
  "packages/metadata/src",
  /from\s+["']@kmux\/agents(?:\/|["'])/u
);
await forbidImports(
  "packages/orchestration/src",
  /from\s+["']@kmux\/agents(?:\/|["'])/u
);
await forbidImports(
  "apps/desktop/src/renderer/src",
  /from\s+["'](?:@kmux\/agents\/(?:composition|builtin-|generated-)|@kmux\/metadata)/u
);
await forbidImports(
  "apps/desktop/src/pty-host",
  /from\s+["']@kmux\/agents\/(?:composition|builtin-)/u
);

const consumerFiles = (
  await Promise.all(
    [
      "packages/core/src",
      "packages/proto/src",
      "packages/persistence/src",
      "packages/orchestration/src",
      "packages/cli/src",
      "packages/agent-integration/src",
      "packages/agents/src",
      "packages/metadata/src",
      "apps/desktop/src"
    ].map((directory) => sourceFiles(join(root, directory)))
  )
).flat();

for (const path of consumerFiles) {
  const relativePath = relative(root, path);
  if (
    agentIds.some((id) =>
      relativePath.startsWith(`packages/agents/src/builtins/${id}/`)
    )
  ) {
    continue;
  }
  // Model pricing is keyed by billing providers, not executable agents.
  if (relativePath.startsWith("packages/metadata/src/modelPricing")) {
    continue;
  }
  // UsageDashboard renders the pre-existing pricing-vendor model. Those
  // provider IDs happen to share names with agent IDs, but they do not select
  // an agent implementation.
  if (
    relativePath ===
    "apps/desktop/src/renderer/src/components/UsageDashboard.tsx"
  ) {
    continue;
  }
  const source = await readFile(path, "utf8");
  for (const id of agentIds) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const decision = new RegExp(
      String.raw`(?:case\s+["']${escaped}["']|(?:===|!==)\s*["']${escaped}["']|["']${escaped}["']\s*(?:===|!==)|\.includes\(\s*["']${escaped}["'])`,
      "u"
    );
    if (decision.test(source)) {
      errors.push(`${relativePath} contains an agent-name decision for ${id}`);
    }
  }
}

if (errors.length > 0) {
  throw new Error(
    `agent architecture boundary failed:\n- ${errors.join("\n- ")}`
  );
}

async function forbidImports(relativeDirectory, pattern) {
  for (const path of await sourceFiles(join(root, relativeDirectory))) {
    const source = await readFile(path, "utf8");
    if (pattern.test(source)) {
      errors.push(`${relative(root, path)} crosses an agent package boundary`);
    }
  }
}

async function sourceFiles(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await sourceFiles(path)));
    } else if (
      [".ts", ".tsx", ".js", ".mjs", ".css"].includes(extname(entry.name)) &&
      !/\.(?:test|spec)\.[^.]+$/u.test(entry.name)
    ) {
      paths.push(path);
    }
  }
  return paths;
}
