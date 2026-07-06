import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { UsageVendor } from "./usage";

const execFileAsync = promisify(execFile);

type KnownUsageVendor = Exclude<UsageVendor, "unknown">;

type ProcessEntry = {
  pid: number;
  parentPid: number;
  commandLine: string;
};

export interface AiCliProcessProbe {
  parentPid: number;
  vendor: KnownUsageVendor;
}

export interface AiCliProcessMatch {
  parentPid: number;
  pid: number;
  vendor: KnownUsageVendor;
  commandLine: string;
}

export async function resolveAiCliProcessMatches(
  probes: AiCliProcessProbe[],
  env: NodeJS.ProcessEnv = process.env
): Promise<Map<number, AiCliProcessMatch>> {
  const normalizedProbes = probes.filter(
    (probe) => Number.isFinite(probe.parentPid) && probe.parentPid > 0
  );
  if (normalizedProbes.length === 0) {
    return new Map();
  }

  const { stdout } = await execFileAsync(
    "ps",
    ["-axo", "pid=,ppid=,command="],
    { env, maxBuffer: 10 * 1024 * 1024 }
  );
  const entries = parseProcessTable(stdout);
  const childrenByParent = new Map<number, number[]>();
  const entriesByPid = new Map<number, ProcessEntry>();

  for (const entry of entries) {
    entriesByPid.set(entry.pid, entry);
    const siblings = childrenByParent.get(entry.parentPid) ?? [];
    siblings.push(entry.pid);
    childrenByParent.set(entry.parentPid, siblings);
  }

  const matches = new Map<number, AiCliProcessMatch>();
  for (const probe of normalizedProbes) {
    const match = findAiCliDescendant(
      probe.parentPid,
      probe.vendor,
      entriesByPid,
      childrenByParent
    );
    if (match) {
      matches.set(probe.parentPid, match);
    }
  }

  return matches;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function findAiCliDescendant(
  parentPid: number,
  vendor: KnownUsageVendor,
  entriesByPid: Map<number, ProcessEntry>,
  childrenByParent: Map<number, number[]>
): AiCliProcessMatch | null {
  const queue = [...(childrenByParent.get(parentPid) ?? [])];
  const visited = new Set<number>();

  while (queue.length > 0) {
    const currentPid = queue.shift();
    if (!currentPid || visited.has(currentPid)) {
      continue;
    }
    visited.add(currentPid);

    const entry = entriesByPid.get(currentPid);
    if (!entry) {
      continue;
    }

    if (detectVendorFromCommandLine(entry.commandLine) === vendor) {
      return {
        parentPid,
        pid: entry.pid,
        vendor,
        commandLine: entry.commandLine
      };
    }

    queue.push(...(childrenByParent.get(currentPid) ?? []));
  }

  return null;
}

function parseProcessTable(output: string): ProcessEntry[] {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/u))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      commandLine: match[3]?.trim() ?? ""
    }))
    .filter(
      (entry) =>
        Number.isFinite(entry.pid) &&
        entry.pid > 0 &&
        Number.isFinite(entry.parentPid) &&
        entry.parentPid >= 0 &&
        entry.commandLine.length > 0
    );
}

const MAX_COMMAND_TOKENS_TO_INSPECT = 12;
const SCRIPT_EXTENSIONS = [".js", ".cjs", ".mjs"] as const;

function detectVendorFromCommandLine(commandLine: string): UsageVendor {
  const commandNames = commandNameHints(commandLine);

  if (commandNames.includes("codex")) {
    return "codex";
  }
  if (
    commandNames.includes("agy") ||
    commandNames.includes("antigravity") ||
    commandNames.includes("antigravity-cli")
  ) {
    return "antigravity";
  }
  if (commandNames.includes("claude") || commandNames.includes("claude-code")) {
    return "claude";
  }
  return "unknown";
}

function commandNameHints(commandLine: string): string[] {
  return uniqueStrings(
    commandLine
      .split(/\s+/u)
      .filter(Boolean)
      .filter((token) => !token.startsWith("-"))
      .slice(0, MAX_COMMAND_TOKENS_TO_INSPECT)
      .flatMap(commandTokenNameHints)
  );
}

function commandTokenNameHints(rawToken: string): string[] {
  const token = stripShellQuotes(rawToken).trim().toLowerCase();
  if (!token || token.startsWith("-") || isEnvironmentAssignment(token)) {
    return [];
  }

  const basename = pathBasename(token);
  return uniqueStrings([
    basename,
    stripScriptExtension(basename),
    nodeModulesPackageBasename(token)
  ]);
}

function pathBasename(value: string): string {
  const segments = value.split(/[\\/]+/u).filter(Boolean);
  return segments.at(-1) ?? value;
}

function stripScriptExtension(value: string): string {
  const extension = SCRIPT_EXTENSIONS.find((candidate) =>
    value.endsWith(candidate)
  );
  return extension ? value.slice(0, -extension.length) : value;
}

function nodeModulesPackageBasename(value: string): string {
  const segments = value.split(/[\\/]+/u).filter(Boolean);
  const nodeModulesIndex = segments.lastIndexOf("node_modules");
  if (nodeModulesIndex < 0) {
    return "";
  }

  const packageName = segments[nodeModulesIndex + 1];
  if (!packageName) {
    return "";
  }

  if (packageName.startsWith("@")) {
    return segments[nodeModulesIndex + 2] ?? "";
  }

  return packageName;
}

function isEnvironmentAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(value);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean))
  );
}

function stripShellQuotes(value: string): string {
  return value.replace(/^['"]+|['"]+$/gu, "");
}
