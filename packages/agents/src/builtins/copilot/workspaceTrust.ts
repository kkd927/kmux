import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import type {
  AgentWorkspaceTrustCapability,
  AgentWorkspaceTrustPreparation
} from "../../contracts";

export const prepareCopilotWorkspaceTrust: AgentWorkspaceTrustCapability["prepare"] =
  (input): AgentWorkspaceTrustPreparation => {
    const configuredRoot = input.env?.COPILOT_HOME?.trim();
    const copilotRoot =
      configuredRoot && isAbsolute(configuredRoot)
        ? configuredRoot
        : join(input.homeDir, ".copilot");
    const configPath = join(copilotRoot, "config.json");
    const workspacePath = canonicalize(input.cwd);
    let config: Record<string, unknown> = {};
    let leadingTrivia = "";
    try {
      if (existsSync(configPath)) {
        const source = readFileSync(configPath, "utf8");
        const parsed: unknown = JSON.parse(stripJsonComments(source));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return "unavailable";
        }
        config = parsed as Record<string, unknown>;
        leadingTrivia = source.slice(0, source.indexOf("{"));
      }
    } catch {
      // The user's config is authoritative. Leave it untouched and let the
      // visible Copilot prompt become an explicit needs-attention result.
      return "unavailable";
    }

    const existing = Array.isArray(config.trustedFolders)
      ? config.trustedFolders.filter(
          (entry): entry is string => typeof entry === "string"
        )
      : [];
    if (existing.some((entry) => canonicalize(entry) === workspacePath)) {
      return "already-trusted";
    }

    const temporaryPath = join(
      copilotRoot,
      `.config.json.kmux-${process.pid}-${randomUUID()}.tmp`
    );
    try {
      mkdirSync(copilotRoot, { recursive: true, mode: 0o700 });
      writeFileSync(
        temporaryPath,
        `${leadingTrivia}${JSON.stringify(
          { ...config, trustedFolders: [...existing, workspacePath] },
          null,
          2
        )}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 }
      );
      renameSync(temporaryPath, configPath);
      return "trusted";
    } catch {
      rmSync(temporaryPath, { force: true });
      return "unavailable";
    }
  };

function canonicalize(value: string): string {
  const absolute = resolve(value);
  try {
    return existsSync(absolute) ? realpathSync.native(absolute) : absolute;
  } catch {
    return absolute;
  }
}

function stripJsonComments(source: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index]!;
    const next = source[index + 1];
    if (inString) {
      output += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      output += current;
      continue;
    }
    if (current === "/" && next === "/") {
      output += "  ";
      index += 2;
      while (index < source.length && !/[\r\n]/u.test(source[index]!)) {
        output += " ";
        index += 1;
      }
      if (index < source.length) output += source[index];
      continue;
    }
    if (current === "/" && next === "*") {
      output += "  ";
      index += 2;
      while (
        index < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      ) {
        output += /[\r\n]/u.test(source[index]!) ? source[index] : " ";
        index += 1;
      }
      if (index < source.length) {
        output += "  ";
        index += 1;
      }
      continue;
    }
    output += current;
  }
  return output;
}
