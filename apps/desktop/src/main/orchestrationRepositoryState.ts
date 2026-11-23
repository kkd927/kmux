import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writePrivateFileAtomic } from "@kmux/orchestration/node";
import {
  contentHash,
  type JsonValue,
  type RepositoryStateRef,
  type TerminalExecutionRef
} from "@kmux/orchestration";
import {
  decodeLocalPath,
  terminalSessionForSurface,
  type AppState,
  type LocalPath
} from "@kmux/core";

import type { TargetServiceRegistry } from "./targets/contracts";
import type { FileOrchestrationArtifactStore } from "@kmux/orchestration/node";

/** Both a worktree receipt and a captured Repository State identify the worktree.
 * The caller must still resolve this token against the trusted local registry.
 */
export function worktreePathToken(
  value: JsonValue | undefined
): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const receipt = Object.hasOwn(value, "worktreeRef")
    ? value.worktreeRef
    : value;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return;
  return typeof receipt.pathToken === "string" && receipt.pathToken.length > 0
    ? receipt.pathToken
    : undefined;
}

export interface CapturedRepositoryState {
  readonly state: RepositoryStateRef;
  readonly changedPaths: readonly string[];
}

export class OrchestrationRepositoryStateCapture {
  constructor(
    private readonly options: {
      readonly getState: () => AppState;
      readonly targetServices: TargetServiceRegistry;
      readonly artifacts: FileOrchestrationArtifactStore;
      readonly worktreeRegistryRoot: string;
      readonly now?: () => string;
    }
  ) {}

  /** Resolve only paths previously captured by this host, even after release. */
  async resolveWorktree(pathToken: string): Promise<LocalPath | undefined> {
    if (!/^sha256:[a-f0-9]{64}$/u.test(pathToken)) return;
    let record;
    try {
      record = JSON.parse(
        await readFile(
          join(this.options.worktreeRegistryRoot, `${pathToken.slice(7)}.json`),
          "utf8"
        )
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return;
      throw error;
    }
    if (!record || typeof record.path !== "string") return;
    let path: string;
    try {
      path = realpathSync.native(record.path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return;
      throw error;
    }
    if (contentHash({ targetId: "local", path }) !== pathToken) return;
    const services = this.options.targetServices.resolveLocated({
      kind: "local"
    });
    const inspected = await services.git.inspect(
      { kind: "local", path: decodeLocalPath(path) },
      { dirtyLimit: 0 }
    );
    if (!inspected.repository) return;
    const repository = realpathSync.native(
      services.files.display(inspected.repository.commonGitDir)
    );
    const worktree = realpathSync.native(
      services.files.display(inspected.repository.root)
    );
    if (
      worktree !== path ||
      contentHash({ targetId: "local", commonGitDir: repository }) !==
        record.repositoryId ||
      contentHash({ targetId: "local", repository, worktree }) !==
        record.worktreeId
    )
      return;
    return decodeLocalPath(path);
  }

  async capture(input: {
    readonly execution: TerminalExecutionRef;
    readonly maxArtifactBytes: number;
  }): Promise<CapturedRepositoryState | undefined> {
    if (
      input.execution.targetId !== "local" ||
      input.execution.generation.kind !== "local"
    ) {
      throw new Error(
        "remote Repository State capture is unsupported until the Phase 6 gate"
      );
    }
    const product = this.options.getState();
    const surface = product.surfaces[input.execution.surfaceId];
    const session = terminalSessionForSurface(
      product,
      input.execution.surfaceId
    );
    const pane = surface ? product.panes[surface.paneId] : undefined;
    const workspace = pane ? product.workspaces[pane.workspaceId] : undefined;
    if (
      !surface ||
      !session ||
      !workspace ||
      session.id !== input.execution.sessionId ||
      workspace.location.target.kind !== "local"
    ) {
      throw new Error("Repository State surface identity changed");
    }
    const services = this.options.targetServices.resolveLocated(
      workspace.location.target
    );
    if (!services.git.captureState) {
      throw new Error(
        "target does not provide trusted Repository State capture"
      );
    }
    const perArtifactBound = Math.max(
      1,
      Math.min(input.maxArtifactBytes, 16 * 1024 * 1024)
    );
    let capture;
    try {
      capture = await services.git.captureState(session.runtimeMetadata.cwd, {
        maxDirtyPatchBytes: perArtifactBound,
        maxUntrackedManifestBytes: perArtifactBound
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("requires a Git repository")
      ) {
        return undefined;
      }
      throw error;
    }
    const dirtyPatch = capture.dirtyPatch
      ? await this.options.artifacts.put({
          kind: "git-dirty-patch",
          bytes: capture.dirtyPatch,
          maxBytes: perArtifactBound,
          targetId: "local"
        })
      : undefined;
    const untrackedManifest = capture.untrackedManifest
      ? await this.options.artifacts.put({
          kind: "git-untracked-manifest",
          bytes: capture.untrackedManifest,
          maxBytes: perArtifactBound,
          targetId: "local"
        })
      : undefined;
    const repositoryDisplay = realpathSync.native(
      services.files.display(capture.commonGitDir)
    );
    const worktreeDisplay = realpathSync.native(
      services.files.display(capture.repositoryRoot)
    );
    const repositoryId = contentHash({
      targetId: "local",
      commonGitDir: repositoryDisplay
    });
    const worktreeId = contentHash({
      targetId: "local",
      repository: repositoryDisplay,
      worktree: worktreeDisplay
    });
    const pathToken = contentHash({ targetId: "local", path: worktreeDisplay });
    await writePrivateFileAtomic(
      join(this.options.worktreeRegistryRoot, `${pathToken.slice(7)}.json`),
      JSON.stringify({ path: worktreeDisplay, repositoryId, worktreeId })
    );
    return {
      state: {
        targetId: "local",
        repositoryId,
        worktreeRef: {
          targetId: "local",
          worktreeId,
          pathToken
        },
        headOid: capture.headOid,
        indexTreeHash: capture.indexTreeHash,
        ...(dirtyPatch
          ? {
              dirtyPatch,
              dirtyPatchHash: dirtyPatch.contentHash
            }
          : {}),
        ...(untrackedManifest ? { untrackedManifest } : {}),
        capturedAt: this.options.now?.() ?? new Date().toISOString(),
        consistency: "fenced-live-worktree"
      },
      changedPaths: capture.changedPaths
    };
  }
}
