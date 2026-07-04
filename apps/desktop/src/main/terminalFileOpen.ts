import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { shell } from "electron";

import type { AppState } from "@kmux/core";
import type {
  TerminalFileLinkResolveCandidate,
  TerminalFileLinkResolved,
  TerminalFileLinkResolveResult
} from "@kmux/proto";

const URL_LIKE_PROTOCOL_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const PROTOCOL_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const KNOWN_PROTOCOL_RE =
  /^(?:file|https?|ftp|mailto|vscode|vscode-insiders|x-github-client):/i;
const LINE_COLUMN_SUFFIX_RE = /^(.+?):\d+(?::\d+)?$/;
const TERMINAL_FILE_LINK_MAX_CANDIDATES = 64;
const TERMINAL_FILE_LINK_MAX_PATH_LENGTH = 4096;
const TERMINAL_FILE_LINK_TRAILING_PUNCTUATION = new Set([
  "[",
  "]",
  ")",
  "}",
  ">",
  '"',
  "'",
  "`",
  ".",
  ",",
  ";",
  ":",
  "!",
  "?"
]);

interface OpenTerminalFilePathOptions {
  surfaceId: string;
  rawPath: string;
  baseCwd?: string;
  getState: () => AppState;
  openPath?: (path: string) => Promise<string>;
  fileExists?: (path: string) => boolean;
  homeDir?: string;
}

interface ResolveTerminalFileLinksOptions {
  surfaceId: string;
  candidates: TerminalFileLinkResolveCandidate[];
  getState: () => AppState;
  fileExists?: (path: string) => boolean;
  homeDir?: string;
}

interface ResolvedTerminalFileLinkTarget {
  openRawPath: string;
  resolvedPath: string;
  trimmedCharacterCount: number;
}

export async function openTerminalFilePath({
  surfaceId,
  rawPath,
  baseCwd,
  getState,
  openPath = (resolvedPath) => shell.openPath(resolvedPath),
  fileExists = existsSync,
  homeDir = homedir()
}: OpenTerminalFilePathOptions): Promise<void> {
  const state = getState();
  const surface = state.surfaces[surfaceId];
  if (!surface) {
    throw new Error(
      `Cannot open terminal file path for missing surface: ${surfaceId}`
    );
  }

  const resolvedPath = resolveTerminalFilePath({
    rawPath,
    cwd: baseCwd ?? surface.cwd,
    homeDir,
    fileExists
  });
  const result = await openPath(resolvedPath);
  if (result) {
    throw new Error(`Failed to open terminal file path: ${result}`);
  }
}

export function resolveTerminalFileLinks({
  surfaceId,
  candidates,
  getState,
  fileExists = existsSync,
  homeDir = homedir()
}: ResolveTerminalFileLinksOptions): TerminalFileLinkResolveResult {
  const surface = getState().surfaces[surfaceId];
  if (!surface || !Array.isArray(candidates)) {
    return { links: [] };
  }

  const links: TerminalFileLinkResolved[] = [];
  const cache = new Map<string, ResolvedTerminalFileLinkTarget | null>();
  for (const candidate of candidates.slice(
    0,
    TERMINAL_FILE_LINK_MAX_CANDIDATES
  )) {
    if (!isValidTerminalFileLinkCandidate(candidate)) {
      continue;
    }
    const cwd = candidate.baseCwd ?? surface.cwd;
    const cacheKey = terminalFileLinkValidationCacheKey(candidate, cwd);
    let target = cache.get(cacheKey);
    if (target === undefined) {
      target = resolveTerminalFileLinkTarget({
        candidate,
        cwd,
        homeDir,
        fileExists
      });
      cache.set(cacheKey, target);
    }
    if (target) {
      links.push({
        id: candidate.id,
        openRawPath: target.openRawPath,
        resolvedPath: target.resolvedPath,
        linkText: candidate.linkText.slice(
          0,
          candidate.linkText.length - target.trimmedCharacterCount
        ),
        startIndex: candidate.startIndex,
        endIndex: candidate.endIndex - target.trimmedCharacterCount
      });
    }
  }

  return { links };
}

export function resolveTerminalFilePath({
  rawPath,
  cwd,
  homeDir,
  fileExists = existsSync
}: {
  rawPath: string;
  cwd?: string;
  homeDir: string;
  fileExists?: (path: string) => boolean;
}): string {
  const text = rawPath.trim();
  if (!text) {
    throw new Error("Cannot open an empty terminal file path");
  }
  if (text.includes("\0")) {
    throw new Error("Cannot open a terminal file path containing NUL bytes");
  }
  if (URL_LIKE_PROTOCOL_RE.test(text) || KNOWN_PROTOCOL_RE.test(text)) {
    throw new Error("Cannot open unsupported terminal file URL protocol");
  }

  const rawCandidates = buildRawPathOpenCandidates(text);
  let lastResolvedPath = "";
  for (const candidate of rawCandidates) {
    const resolvedPath = resolveSingleRawPath(candidate, cwd, homeDir);
    lastResolvedPath = resolvedPath;
    if (fileExists(resolvedPath)) {
      return resolvedPath;
    }
  }

  throw new Error(
    `Terminal file path does not exist: ${lastResolvedPath || text}`
  );
}

function resolveTerminalFileLinkTarget({
  candidate,
  cwd,
  homeDir,
  fileExists
}: {
  candidate: TerminalFileLinkResolveCandidate;
  cwd: string | undefined;
  homeDir: string;
  fileExists: (path: string) => boolean;
}): ResolvedTerminalFileLinkTarget | null {
  if (!isValidTerminalFileLinkCandidate(candidate)) {
    return null;
  }

  for (const variant of buildTerminalFileLinkValidationVariants(candidate)) {
    const resolvedPath = resolveTerminalFileLinkRawPath(
      variant.openRawPath,
      cwd,
      homeDir
    );
    if (resolvedPath && fileExists(resolvedPath)) {
      return {
        openRawPath: variant.openRawPath,
        resolvedPath,
        trimmedCharacterCount:
          candidate.rawPath.length - variant.openRawPath.length
      };
    }
  }

  return null;
}

function terminalFileLinkValidationCacheKey(
  candidate: TerminalFileLinkResolveCandidate,
  cwd: string | undefined
): string {
  return [candidate.rawPath, cwd ?? "", candidate.hasSuffix ? "1" : "0"].join(
    "\0"
  );
}

function isValidTerminalFileLinkCandidate(
  candidate: TerminalFileLinkResolveCandidate
): boolean {
  if (
    !candidate ||
    typeof candidate.id !== "string" ||
    typeof candidate.rawPath !== "string" ||
    typeof candidate.linkText !== "string" ||
    typeof candidate.startIndex !== "number" ||
    typeof candidate.endIndex !== "number" ||
    typeof candidate.hasSuffix !== "boolean" ||
    candidate.startIndex < 0 ||
    candidate.endIndex <= candidate.startIndex ||
    candidate.rawPath.length === 0 ||
    candidate.rawPath.length > TERMINAL_FILE_LINK_MAX_PATH_LENGTH ||
    candidate.linkText.length > TERMINAL_FILE_LINK_MAX_PATH_LENGTH ||
    candidate.rawPath.includes("\0") ||
    candidate.linkText.includes("\0") ||
    URL_LIKE_PROTOCOL_RE.test(candidate.rawPath) ||
    KNOWN_PROTOCOL_RE.test(candidate.rawPath) ||
    PROTOCOL_RE.test(candidate.rawPath)
  ) {
    return false;
  }

  return true;
}

function buildTerminalFileLinkValidationVariants(
  candidate: TerminalFileLinkResolveCandidate
): Array<{ openRawPath: string; linkText: string; endIndex: number }> {
  const variants = [
    {
      openRawPath: candidate.rawPath,
      linkText: candidate.linkText,
      endIndex: candidate.endIndex
    }
  ];
  if (candidate.hasSuffix) {
    return variants;
  }

  let rawEnd = candidate.rawPath.length;
  let linkEnd = candidate.linkText.length;
  while (
    rawEnd > 0 &&
    linkEnd > 0 &&
    shouldTrimTerminalFileLinkTrailingCharacter(
      candidate.rawPath[rawEnd - 1],
      candidate.linkText[linkEnd - 1]
    )
  ) {
    rawEnd -= 1;
    linkEnd -= 1;
    const openRawPath = candidate.rawPath.slice(0, rawEnd);
    if (!openRawPath) {
      break;
    }
    variants.push({
      openRawPath,
      linkText: candidate.linkText.slice(0, linkEnd),
      endIndex: candidate.endIndex - (candidate.linkText.length - linkEnd)
    });
  }

  return variants;
}

function shouldTrimTerminalFileLinkTrailingCharacter(
  rawCharacter: string,
  linkCharacter: string
): boolean {
  return (
    rawCharacter === linkCharacter &&
    TERMINAL_FILE_LINK_TRAILING_PUNCTUATION.has(rawCharacter)
  );
}

function resolveTerminalFileLinkRawPath(
  rawPath: string,
  cwd: string | undefined,
  homeDir: string
): string | null {
  try {
    return resolveSingleRawPath(rawPath, cwd, homeDir);
  } catch {
    return null;
  }
}

function buildRawPathOpenCandidates(rawPath: string): string[] {
  const candidates = [rawPath];
  const suffixMatch = rawPath.match(LINE_COLUMN_SUFFIX_RE);
  if (suffixMatch?.[1] && suffixMatch[1] !== rawPath) {
    candidates.push(suffixMatch[1]);
  }
  return candidates;
}

function resolveSingleRawPath(
  rawPath: string,
  cwd: string | undefined,
  homeDir: string
): string {
  if (rawPath.startsWith("~/")) {
    return path.resolve(homeDir, rawPath.slice(2));
  }
  if (rawPath.startsWith("~")) {
    throw new Error("Cannot open unsupported home-relative terminal file path");
  }
  if (path.isAbsolute(rawPath)) {
    return path.normalize(rawPath);
  }
  if (!cwd) {
    throw new Error("Cannot open relative terminal file path without a cwd");
  }
  return path.resolve(cwd, rawPath);
}
