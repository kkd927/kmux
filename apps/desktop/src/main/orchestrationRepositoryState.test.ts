import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createInitialState,
  decodeLocalPath,
  type LocalPath
} from "@kmux/core";
import { contentHash, type JsonValue } from "@kmux/orchestration";
import { FileOrchestrationArtifactStore } from "@kmux/orchestration/node";
import {
  OrchestrationRepositoryStateCapture,
  worktreePathToken
} from "./orchestrationRepositoryState";
import {
  createLocalFileProvider,
  createLocalGitProvider
} from "./targets/localTargetProviders";
import {
  createLocalPathResolver,
  createTargetServiceRegistry
} from "./targets/targetServiceRegistry";
import type { TargetServiceSet } from "./targets/contracts";

describe("worktree input receipt", () => {
  it("resolves a captured dedicated worktree after terminal release and host restart, and rejects replaced identities", async () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-trusted-worktree-"));
    try {
      const repo = join(root, "repo");
      const worktree = join(root, "worktree");
      mkdirSync(repo);
      const git = (args: string[]) =>
        execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
      git(["init", "-q"]);
      git([
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-qm",
        "baseline"
      ]);
      git(["worktree", "add", "--detach", worktree, "HEAD"]);
      const resolveLocalPath = createLocalPathResolver();
      const local = {
        git: createLocalGitProvider({ resolveLocalPath, managedRoot: root }),
        files: createLocalFileProvider({ resolveLocalPath, homeDir: root }),
        usage: {}
      } as TargetServiceSet<LocalPath>;
      const state = createInitialState();
      const session = Object.values(state.sessions)[0]!;
      session.runtimeMetadata.cwd = {
        kind: "local",
        path: decodeLocalPath(worktree)
      };
      const options = {
        getState: () => state,
        targetServices: createTargetServiceRegistry({
          local,
          remote: () => undefined
        }),
        artifacts: new FileOrchestrationArtifactStore({
          root: join(root, "artifacts")
        }),
        worktreeRegistryRoot: join(root, "receipts")
      };
      const capture = new OrchestrationRepositoryStateCapture(options);
      const captured = await capture.capture({
        execution: {
          targetId: "local",
          targetAuthority: "test",
          surfaceId: session.surfaceId,
          sessionId: session.id,
          generation: { kind: "local", runtimeEpoch: "test" },
          inputAuthorityRef: "test"
        },
        maxArtifactBytes: 4096
      });
      const token = captured!.state.worktreeRef!.pathToken;
      expect(
        Object.values(state.workspaces).every(
          (workspace) => !workspace.worktree
        )
      ).toBe(true);
      state.sessions = {};
      state.surfaces = {};
      state.workspaces = {};
      const restored = new OrchestrationRepositoryStateCapture(options);
      await expect(restored.resolveWorktree(token)).resolves.toEqual(
        decodeLocalPath(realpathSync.native(worktree))
      );
      await expect(
        restored.resolveWorktree(
          contentHash({ targetId: "local", path: realpathSync.native(repo) })
        )
      ).resolves.toBeUndefined();
      await expect(
        restored.resolveWorktree("../../untrusted")
      ).resolves.toBeUndefined();
      const receiptPath = join(
        options.worktreeRegistryRoot,
        `${token.slice(7)}.json`
      );
      const record = readFileSync(receiptPath, "utf8");
      writeFileSync(
        receiptPath,
        JSON.stringify({
          ...JSON.parse(record),
          repositoryId: "wrong-repository"
        })
      );
      await expect(restored.resolveWorktree(token)).resolves.toBeUndefined();
      writeFileSync(receiptPath, record);
      rmSync(join(worktree, ".git"));
      await expect(restored.resolveWorktree(token)).resolves.toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("accepts both a worktree reference and the Repository State data source", () => {
    const worktreeRef = {
      targetId: "local",
      worktreeId: "tree:1",
      pathToken: "trusted-token"
    };
    expect(worktreePathToken(worktreeRef)).toBe("trusted-token");
    expect(
      worktreePathToken({
        targetId: "local",
        repositoryId: "repo:1",
        worktreeRef,
        headOid: "head"
      })
    ).toBe("trusted-token");
  });

  it("rejects raw paths and malformed nested receipts instead of falling back", () => {
    const invalid: JsonValue[] = [
      null,
      [],
      "/tmp/project",
      { path: "/tmp/project" },
      { pathToken: "" },
      { worktreeRef: null, pathToken: "other" },
      { worktreeRef: { pathToken: 1 } }
    ];
    for (const value of invalid) {
      expect(worktreePathToken(value)).toBeUndefined();
    }
  });
});
