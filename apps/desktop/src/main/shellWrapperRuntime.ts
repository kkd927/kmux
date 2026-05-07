import {
  readFileSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KMUX_ZSH_WRAPPER_DIR_ENV } from "../pty-host/shellIntegration";

const APP_ZSH_WRAPPER_PREFIX = "kmux-zsh-app-";
const OWNER_FILE_NAME = ".kmux-owner.json";
const DEFAULT_STALE_WRAPPER_AGE_MS = 24 * 60 * 60 * 1000;

export interface ShellWrapperRuntime {
  env: Record<string, string>;
  zshWrapperDir?: string;
  cleanup(): void;
}

interface CreateShellWrapperRuntimeOptions {
  platform?: NodeJS.Platform;
  tmpDir?: string;
  nowMs?: number;
  staleWrapperAgeMs?: number;
  ownerPid?: number;
  isProcessAlive?: (pid: number) => boolean;
}

export function createShellWrapperRuntime(
  options: CreateShellWrapperRuntimeOptions = {}
): ShellWrapperRuntime {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return {
      env: {},
      cleanup() {
        // no-op
      }
    };
  }

  const tempRoot = options.tmpDir ?? tmpdir();
  cleanupStaleAppZshWrapperDirs(tempRoot, {
    nowMs: options.nowMs,
    staleWrapperAgeMs: options.staleWrapperAgeMs,
    isProcessAlive: options.isProcessAlive
  });
  const zshWrapperDir = mkdtempSync(join(tempRoot, APP_ZSH_WRAPPER_PREFIX));
  writeWrapperOwner(zshWrapperDir, options.ownerPid ?? process.pid);
  let cleaned = false;

  return {
    env: {
      [KMUX_ZSH_WRAPPER_DIR_ENV]: zshWrapperDir
    },
    zshWrapperDir,
    cleanup() {
      if (cleaned) {
        return;
      }
      cleaned = true;
      rmSync(zshWrapperDir, { recursive: true, force: true });
    }
  };
}

export function cleanupStaleAppZshWrapperDirs(
  tempRoot: string,
  options: {
    nowMs?: number;
    staleWrapperAgeMs?: number;
    isProcessAlive?: (pid: number) => boolean;
  } = {}
): void {
  const nowMs = options.nowMs ?? Date.now();
  const staleWrapperAgeMs =
    options.staleWrapperAgeMs ?? DEFAULT_STALE_WRAPPER_AGE_MS;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;

  let entries: string[];
  try {
    entries = readdirSync(tempRoot);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.startsWith(APP_ZSH_WRAPPER_PREFIX)) {
      continue;
    }
    const path = join(tempRoot, entry);
    try {
      const stats = statSync(path);
      if (!stats.isDirectory()) {
        continue;
      }
      if (nowMs - stats.mtimeMs < staleWrapperAgeMs) {
        continue;
      }
      const ownerPid = readWrapperOwnerPid(path);
      if (typeof ownerPid !== "number" || isProcessAlive(ownerPid)) {
        continue;
      }
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Stale runtime cleanup is best-effort.
    }
  }
}

function writeWrapperOwner(wrapperDir: string, pid: number): void {
  writeFileSync(
    join(wrapperDir, OWNER_FILE_NAME),
    `${JSON.stringify({
      pid,
      createdAt: new Date().toISOString()
    })}\n`,
    "utf8"
  );
}

function readWrapperOwnerPid(wrapperDir: string): number | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(join(wrapperDir, OWNER_FILE_NAME), "utf8")
    ) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid)
      ? parsed.pid
      : undefined;
  } catch {
    return undefined;
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EPERM"
    );
  }
}
