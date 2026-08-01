import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const contract = JSON.parse(
  await readFile(join(root, "packages/agent-integration/contract.json"), "utf8")
);
const docs = await readFile(join(root, "docs/agent-signal-matrix.md"), "utf8");

const label = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity"
};
const rendered = [
  "<!-- agent-integration-contract:v2:start -->",
  "| Agent | Installed hooks | Removed legacy kmux hooks |",
  "| --- | --- | --- |",
  ...Object.entries(contract.vendors).map(([vendor, definition]) => {
    const managed = definition.managed
      .map((hook) =>
        `\`${hook.event}${hook.matcher ? `(${hook.matcher.replaceAll("|", "\\|")})` : ""}\``
      )
      .join(", ");
    const deprecated = definition.deprecated
      .map((event) => `\`${event}\``)
      .join(", ");
    return `| ${label[vendor]} | ${managed} | ${deprecated} |`;
  }),
  "<!-- agent-integration-contract:v2:end -->"
].join("\n");

if (!docs.includes(rendered)) {
  throw new Error(
    "docs/agent-signal-matrix.md does not match the agent integration contract"
  );
}
