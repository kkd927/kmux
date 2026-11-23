import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { AgentSkillPlacementCapability } from "@kmux/agents";
import {
  KMUX_ORCHESTRATION_SKILL_NAME,
  KMUX_ORCHESTRATION_SKILL_DOCUMENT
} from "@kmux/orchestration";

const SKILL_FILES = {
  "SKILL.md": KMUX_ORCHESTRATION_SKILL_DOCUMENT
} as const;

export interface OrchestrationSkillCoverage {
  readonly agentId: string;
  readonly support: "supported" | "unsupported";
  readonly state:
    | "not-installed"
    | "installed"
    | "update-available"
    | "needs-attention"
    | "unsupported";
  readonly path?: string;
  readonly reason?: string;
}

export class OrchestrationSkillManager {
  constructor(
    private readonly options: {
      readonly homeDir: string;
      readonly env?: NodeJS.ProcessEnv;
      readonly resolveSkillPlacement: (
        agentId: string
      ) => AgentSkillPlacementCapability | undefined;
    }
  ) {}

  async inspect(
    agentIds: readonly string[]
  ): Promise<OrchestrationSkillCoverage[]> {
    return Promise.all(agentIds.map((agentId) => this.inspectOne(agentId)));
  }

  async installExplicit(
    agentIds: readonly string[]
  ): Promise<OrchestrationSkillCoverage[]> {
    const unique = [...new Set(agentIds)];
    for (const agentId of unique) {
      const root = this.skillRoot(agentId);
      if (!root) continue;
      for (const [relativePath, content] of Object.entries(SKILL_FILES)) {
        const destination = join(root, relativePath);
        await assertSafeDirectoryChain(
          dirname(destination),
          this.options.homeDir
        );
        await writeAtomic(destination, content);
      }
    }
    return this.inspect(unique);
  }

  private async inspectOne(
    agentId: string
  ): Promise<OrchestrationSkillCoverage> {
    const root = this.skillRoot(agentId);
    if (!root) {
      return {
        agentId,
        support: "unsupported",
        state: "unsupported",
        reason: "this Agent has no reviewed kmux skill installation target"
      };
    }
    try {
      const directoryExists = await assertExistingDirectoryChainSafe(
        root,
        this.options.homeDir
      );
      if (!directoryExists) {
        return {
          agentId,
          support: "supported",
          state: "not-installed",
          path: root
        };
      }
      const current = await installedFilesAreCurrent(root);
      return {
        agentId,
        support: "supported",
        state: current ? "installed" : "update-available",
        path: root
      };
    } catch (error) {
      if (isMissing(error)) {
        return {
          agentId,
          support: "supported",
          state: "not-installed",
          path: root
        };
      }
      return {
        agentId,
        support: "supported",
        state: "needs-attention",
        path: root,
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private skillRoot(agentId: string): string | undefined {
    const placement = this.options.resolveSkillPlacement(agentId);
    if (!placement?.supportedScopes.includes("global")) return undefined;
    const root = placement.resolveRoot({
      scope: "global",
      homeDir: this.options.homeDir,
      env: this.options.env
    });
    return root ? join(root, KMUX_ORCHESTRATION_SKILL_NAME) : undefined;
  }
}

async function installedFilesAreCurrent(root: string): Promise<boolean> {
  for (const [relativePath, expected] of Object.entries(SKILL_FILES)) {
    const path = join(root, relativePath);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("installed skill contains an unsafe entry");
    }
    if ((await readFile(path, "utf8")) !== expected) return false;
  }
  return true;
}

async function assertSafeDirectoryChain(
  targetPath: string,
  homeDir: string
): Promise<void> {
  const { resolvedHome, segments } = pathSegmentsWithinHome(
    targetPath,
    homeDir
  );
  let current = resolvedHome;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error("skill installation path contains an unsafe entry");
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
}

async function assertExistingDirectoryChainSafe(
  targetPath: string,
  homeDir: string
): Promise<boolean> {
  const { resolvedHome, segments } = pathSegmentsWithinHome(
    targetPath,
    homeDir
  );
  let current = resolvedHome;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error("skill installation path contains an unsafe entry");
      }
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }
  return true;
}

function pathSegmentsWithinHome(
  targetPath: string,
  homeDir: string
): { resolvedHome: string; segments: string[] } {
  const resolvedHome = resolve(homeDir);
  const relativeTarget = relative(resolvedHome, resolve(targetPath));
  if (
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    throw new Error(
      "skill installation target is outside the user home directory"
    );
  }
  return {
    resolvedHome,
    segments: relativeTarget.split(sep).filter(Boolean)
  };
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(content, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
  } finally {
    await file?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
