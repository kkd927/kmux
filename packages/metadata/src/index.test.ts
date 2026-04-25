import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveGitBranch } from "./index";

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
      expect(await resolveGitBranch(repoDir, process.env, { bypassCache: true }))
        .toBe("feature/review");
    } finally {
      rmSync(repoDir, { force: true, recursive: true });
    }
  });
});
