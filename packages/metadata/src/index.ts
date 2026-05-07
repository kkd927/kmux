import { execFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

export * from "./aiCliProcess";
export * from "./modelPricing";
export * from "./usage";

const execFileAsync = promisify(execFile);

const branchCache = new Map<
  string,
  { value: string | null; expiresAt: number }
>();
const portsCache = new Map<number, { value: number[]; expiresAt: number }>();

export interface ResolveGitBranchOptions {
  bypassCache?: boolean;
}

export interface GitRepositoryMetadata {
  gitDir: string;
  root: string;
}

export async function resolveGitRepository(
  cwd?: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<GitRepositoryMetadata | null> {
  if (!cwd) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--git-dir", "--show-toplevel"],
      {
        cwd,
        env
      }
    );
    const [gitDir, root] = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (!gitDir || !root) {
      return null;
    }
    return {
      gitDir: isAbsolute(gitDir) ? gitDir : resolve(cwd, gitDir),
      root: isAbsolute(root) ? root : resolve(cwd, root)
    };
  } catch {
    return null;
  }
}

export async function resolveGitBranch(
  cwd?: string,
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveGitBranchOptions = {}
): Promise<string | null> {
  if (!cwd) {
    return null;
  }

  const cached = branchCache.get(cwd);
  if (!options.bypassCache && cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      {
        cwd,
        env
      }
    );
    const branch = stdout.trim() || null;
    branchCache.set(cwd, { value: branch, expiresAt: Date.now() + 1500 });
    return branch;
  } catch {
    branchCache.set(cwd, { value: null, expiresAt: Date.now() + 1500 });
    return null;
  }
}

export async function resolveListeningPorts(
  pid?: number,
  env: NodeJS.ProcessEnv = process.env
): Promise<number[]> {
  if (!pid) {
    return [];
  }

  const cached = portsCache.get(pid);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  try {
    const { stdout } = await execFileAsync("lsof", [
      "-Pan",
      "-p",
      `${pid}`,
      "-iTCP",
      "-sTCP:LISTEN"
    ], {
      env
    });
    const ports = Array.from(
      new Set(
        stdout
          .split("\n")
          .map((line) => line.match(/:(\d+)\s+\(LISTEN\)/)?.[1])
          .filter(Boolean)
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value))
      )
    ).slice(0, 3);
    portsCache.set(pid, { value: ports, expiresAt: Date.now() + 2_000 });
    return ports;
  } catch {
    portsCache.set(pid, { value: [], expiresAt: Date.now() + 2_000 });
    return [];
  }
}
