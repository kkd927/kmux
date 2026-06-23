import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { shell } from "electron";

import type { AppState } from "@kmux/core";

const URL_LIKE_PROTOCOL_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const KNOWN_PROTOCOL_RE =
  /^(?:file|https?|ftp|mailto|vscode|vscode-insiders|x-github-client):/i;
const LINE_COLUMN_SUFFIX_RE = /^(.+?):\d+(?::\d+)?$/;

interface OpenTerminalFilePathOptions {
  surfaceId: string;
  rawPath: string;
  baseCwd?: string;
  getState: () => AppState;
  openPath?: (path: string) => Promise<string>;
  fileExists?: (path: string) => boolean;
  homeDir?: string;
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
