import { constants, type Dirent } from "node:fs";
import { open, opendir, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, parse } from "node:path";

const MAX_CONFIG_FILES = 128;
const MAX_INCLUDE_MATCHES = 256;
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const SAFE_ALIAS = /^[A-Za-z0-9_.:@%+[\]-]+$/u;

export async function listOpenSshAliases(options: {
  homeDir: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  if (!isAbsolute(options.homeDir)) {
    throw new TypeError("OpenSSH alias catalog home must be absolute");
  }
  const sshRoot = join(options.homeDir, ".ssh");
  const entry = options.configPath ?? join(sshRoot, "config");
  if (!isAbsolute(entry)) {
    throw new TypeError("OpenSSH alias catalog config path must be absolute");
  }
  const aliases = new Set<string>();
  const visited = new Set<string>();
  let totalBytes = 0;
  let includeMatches = 0;

  const visit = async (path: string): Promise<void> => {
    let realPath: string;
    try {
      realPath = await realpath(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (visited.has(realPath)) return;
    if (visited.size >= MAX_CONFIG_FILES) {
      throw new RangeError("OpenSSH alias catalog includes too many files");
    }
    const contents = await readBoundedConfigFile(
      realPath,
      MAX_CONFIG_BYTES - totalBytes
    );
    if (contents === undefined) return;
    totalBytes += Buffer.byteLength(contents, "utf8");
    visited.add(realPath);
    for (const rawLine of contents.split(/\r?\n/u)) {
      if (Buffer.byteLength(rawLine, "utf8") > MAX_LINE_BYTES) {
        throw new RangeError("OpenSSH config line exceeds its byte limit");
      }
      const tokens = tokenizeOpenSshConfigLine(rawLine);
      const keyword = tokens[0]?.toLowerCase();
      if (keyword === "host") {
        for (const alias of tokens.slice(1)) {
          if (
            !alias.startsWith("!") &&
            !/[*?]/u.test(alias) &&
            alias.length <= 512 &&
            SAFE_ALIAS.test(alias)
          ) {
            aliases.add(alias);
          }
        }
      } else if (keyword === "include") {
        for (const include of tokens.slice(1)) {
          const expanded = expandInclude(include, options.homeDir, options.env);
          if (!expanded || expanded.includes("%")) continue;
          const pattern = isAbsolute(expanded)
            ? expanded
            : join(sshRoot, expanded);
          await expandIncludePattern(
            pattern,
            async (match) => {
              await visit(match);
            },
            () => {
              includeMatches += 1;
              if (includeMatches > MAX_INCLUDE_MATCHES) {
                throw new RangeError(
                  "OpenSSH alias catalog includes too many matches"
                );
              }
            }
          );
        }
      }
    }
  };

  await visit(entry);
  return [...aliases].sort((left, right) => left.localeCompare(right));
}

async function readBoundedConfigFile(
  path: string,
  remainingBytes: number
): Promise<string | undefined> {
  if (remainingBytes < 0) {
    throw new RangeError("OpenSSH alias catalog exceeds its byte limit");
  }
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) return undefined;
    if (metadata.size > remainingBytes) {
      throw new RangeError("OpenSSH alias catalog exceeds its byte limit");
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (true) {
      const maximumRead = Math.min(
        READ_CHUNK_BYTES,
        remainingBytes - bytes + 1
      );
      if (maximumRead <= 0) {
        throw new RangeError("OpenSSH alias catalog exceeds its byte limit");
      }
      const chunk = Buffer.allocUnsafe(maximumRead);
      const result = await handle.read(chunk, 0, maximumRead, null);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
      if (bytes > remainingBytes) {
        throw new RangeError("OpenSSH alias catalog exceeds its byte limit");
      }
      chunks.push(chunk.subarray(0, result.bytesRead));
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function expandIncludePattern(
  pattern: string,
  visit: (path: string) => Promise<void>,
  consumeMatch: () => void
): Promise<void> {
  const root = parse(pattern).root;
  const segments = pattern
    .slice(root.length)
    .split("/")
    .filter((segment) => segment.length > 0);
  let candidates = [root];
  let usedWildcard = false;

  for (const segment of segments) {
    const matcher = compileGlobSegment(segment);
    if (!matcher) {
      candidates = candidates.map((candidate) => join(candidate, segment));
      continue;
    }
    usedWildcard = true;
    const next: string[] = [];
    for (const candidate of candidates) {
      const entries = await readMatchingDirectoryEntries(
        candidate,
        matcher,
        consumeMatch
      );
      for (const entry of entries) {
        next.push(join(candidate, entry.name));
      }
    }
    candidates = next;
    if (candidates.length === 0) return;
  }

  if (!usedWildcard) consumeMatch();
  for (const candidate of candidates.sort()) await visit(candidate);
}

async function readMatchingDirectoryEntries(
  directory: string,
  matcher: RegExp,
  consumeMatch: () => void
): Promise<Dirent[]> {
  let handle;
  try {
    handle = await opendir(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
  const entries: Dirent[] = [];
  for await (const entry of handle) {
    if (matcher.test(entry.name)) {
      consumeMatch();
      entries.push(entry);
    }
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

function compileGlobSegment(segment: string): RegExp | undefined {
  if (
    !segment.includes("*") &&
    !segment.includes("?") &&
    !segment.includes("[")
  ) {
    return undefined;
  }
  let source = segment.startsWith(".") ? "^" : "^(?!\\.)";
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index];
    if (character === "*") {
      source += ".*";
      continue;
    }
    if (character === "?") {
      source += ".";
      continue;
    }
    if (character === "[") {
      const close = segment.indexOf("]", index + 1);
      if (close > index + 1) {
        let contents = segment.slice(index + 1, close);
        const negated = contents.startsWith("!");
        if (negated) contents = contents.slice(1);
        if (contents.length > 0) {
          source += `[${negated ? "^" : ""}${escapeRegexClass(contents)}]`;
          index = close;
          continue;
        }
      }
    }
    source += escapeRegexCharacter(character);
  }
  return new RegExp(`${source}$`, "u");
}

function escapeRegexClass(value: string): string {
  return value.replace(/[\\\]^]/gu, (character) => `\\${character}`);
}

function escapeRegexCharacter(value: string): string {
  return /[\\^$.*+?()[\]{}|]/u.test(value) ? `\\${value}` : value;
}

function expandInclude(
  value: string,
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  let expanded =
    value === "~"
      ? homeDir
      : value.startsWith("~/")
        ? join(homeDir, value.slice(2))
        : value;
  let unresolved = false;
  expanded = expanded.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu,
    (_match, braced: string | undefined, plain: string | undefined) => {
      const replacement = env[braced ?? plain ?? ""];
      if (replacement === undefined) unresolved = true;
      return replacement ?? "";
    }
  );
  return unresolved ? undefined : expanded;
}

function tokenizeOpenSshConfigLine(line: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const push = (): void => {
    if (token.length > 0) tokens.push(token);
    token = "";
  };
  for (const character of line) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#") break;
    if (/\s/u.test(character)) push();
    else token += character;
  }
  if (escaped) token += "\\";
  push();
  return tokens;
}
