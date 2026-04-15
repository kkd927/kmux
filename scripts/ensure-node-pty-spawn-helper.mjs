import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

if (process.platform !== "darwin") {
  process.exit(0);
}

const nodePtyRoot = join(process.cwd(), "node_modules", "node-pty");
const candidates = [
  join(nodePtyRoot, "build", "Release", "spawn-helper"),
  join(
    nodePtyRoot,
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper"
  )
];
const prebuildsRoot = join(nodePtyRoot, "prebuilds");

if (existsSync(prebuildsRoot)) {
  for (const entry of readdirSync(prebuildsRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith("darwin-")) {
      candidates.push(join(prebuildsRoot, entry.name, "spawn-helper"));
    }
  }
}

for (const candidate of new Set(candidates)) {
  if (!existsSync(candidate)) {
    continue;
  }

  const mode = statSync(candidate).mode;
  if ((mode & 0o111) !== 0) {
    continue;
  }

  chmodSync(candidate, mode | 0o755);
  console.log(`made node-pty spawn-helper executable: ${candidate}`);
}
