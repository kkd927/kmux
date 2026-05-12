import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveGitBranch, resolveGitRepository } from "./index";

describe("metadata git branch resolution", () => {
  it("bypasses the cwd cache when explicitly requested", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "kmux-branch-cache-"));

    try {
      execFileSync("git", ["init", "-b", "main"], {
        cwd: repoDir,
        stdio: "ignore"
      });
      writeFileSync(join(repoDir, "README.md"), "kmux\n", "utf8");
      execFileSync("git", ["add", "README.md"], {
        cwd: repoDir,
        stdio: "ignore"
      });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=kmux",
          "-c",
          "user.email=kmux@example.invalid",
          "commit",
          "-m",
          "initial"
        ],
        { cwd: repoDir, stdio: "ignore" }
      );

      expect(await resolveGitBranch(repoDir)).toBe("main");

      execFileSync("git", ["checkout", "-b", "feature/review"], {
        cwd: repoDir,
        stdio: "ignore"
      });

      expect(await resolveGitBranch(repoDir)).toBe("main");
      expect(
        await resolveGitBranch(repoDir, process.env, { bypassCache: true })
      ).toBe("feature/review");
    } finally {
      rmSync(repoDir, { force: true, recursive: true });
    }
  });

  it("resolves the real gitdir and worktree root from a linked worktree", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "kmux-gitdir-root-"));
    const repoDir = join(rootDir, "repo");
    const worktreeDir = join(rootDir, "worktree");
    const nestedCwd = join(worktreeDir, "packages", "app");

    try {
      mkdirSync(repoDir, { recursive: true });
      execFileSync("git", ["init", "-b", "main"], {
        cwd: repoDir,
        stdio: "ignore"
      });
      writeFileSync(join(repoDir, "README.md"), "kmux\n", "utf8");
      execFileSync("git", ["add", "README.md"], {
        cwd: repoDir,
        stdio: "ignore"
      });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=kmux",
          "-c",
          "user.email=kmux@example.invalid",
          "commit",
          "-m",
          "initial"
        ],
        { cwd: repoDir, stdio: "ignore" }
      );
      execFileSync(
        "git",
        ["worktree", "add", "-b", "feature/watched", worktreeDir],
        {
          cwd: repoDir,
          stdio: "ignore"
        }
      );
      mkdirSync(nestedCwd, { recursive: true });

      const repository = await resolveGitRepository(nestedCwd);

      expect(realpathSync(repository?.root ?? "")).toBe(
        realpathSync(worktreeDir)
      );
      expect(repository?.gitDir).not.toBe(join(worktreeDir, ".git"));
      expect(realpathSync(repository?.commonGitDir ?? "")).toBe(
        realpathSync(join(repoDir, ".git"))
      );
      expect(existsSync(join(repository?.gitDir ?? "", "HEAD"))).toBe(true);
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });
});
