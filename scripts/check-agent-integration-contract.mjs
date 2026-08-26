import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const contract = JSON.parse(
  await readFile(join(root, "packages/agent-integration/contract.json"), "utf8")
);
const docs = await readFile(join(root, "docs/agent-signal-matrix.md"), "utf8");

const rendered = [
  "<!-- agent-integration-contract:v3:start -->",
  "| Agent | Installed hooks | Removed legacy kmux hooks |",
  "| --- | --- | --- |",
  ...Object.entries(contract.vendors).map(([vendor, definition]) => {
    const managed = definition.managed
      .map(
        (hook) =>
          `\`${hook.event}${hook.matcher ? `(${hook.matcher.replaceAll("|", "\\|")})` : ""}\``
      )
      .join(", ");
    const deprecated = definition.deprecated
      .map((event) => `\`${event}\``)
      .join(", ");
    const label = vendor
      .split(/[._-]+/u)
      .filter(Boolean)
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join(" ");
    return `| ${label} | ${managed} | ${deprecated} |`;
  }),
  "<!-- agent-integration-contract:v3:end -->"
].join("\n");

if (!docs.includes(rendered)) {
  throw new Error(
    "docs/agent-signal-matrix.md does not match the agent integration contract"
  );
}
