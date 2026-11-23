import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeLocalPath } from "@kmux/core";

import { createLocalGitProvider } from "./localTargetProviders";
import { createLocalPathResolver } from "./targetServiceRegistry";

describe("local Git Repository State capture", () => {
  it("materializes exact staged, unstaged, and untracked state in a fresh worktree", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-repository-state-"));
    const root = join(sandbox, "source");
    const review = join(sandbox, "review");
    mkdirSync(root);
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["config", "user.name", "kmux test"], {
        cwd: root
      });
      execFileSync("git", ["config", "user.email", "kmux@example.invalid"], {
        cwd: root
      });
      writeFileSync(join(root, "tracked.txt"), "before\n");
      execFileSync("git", ["add", "tracked.txt"], { cwd: root });
      execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
      writeFileSync(join(root, "tracked.txt"), "after\n");
      writeFileSync(join(root, "staged.txt"), "staged\n");
      execFileSync("git", ["add", "staged.txt"], { cwd: root });
      writeFileSync(join(root, "new.txt"), "untracked\n");
      writeFileSync(join(root, "empty.txt"), "");
      symlinkSync("new.txt", join(root, "new-link"));

      const provider = createLocalGitProvider({
        resolveLocalPath: createLocalPathResolver(),
        managedRoot: join(sandbox, "managed")
      });
      const nested = join(root, "nested");
      mkdirSync(nested);
      const originalIndex = readFileSync(join(root, ".git", "index"));
      // Simulate another Git writer while parallel reviewers capture the same
      // immutable source index. Capture must not touch or remove this lock.
      writeFileSync(join(root, ".git", "index.lock"), "another writer");
      const [captured, parallelCapture] = await Promise.all(
        [root, nested].map((cwd) =>
          provider.captureState!(decodeLocalPath(cwd), {
            maxDirtyPatchBytes: 1024 * 1024,
            maxUntrackedManifestBytes: 1024 * 1024
          })
        )
      );
      expect(parallelCapture).toEqual(captured);
      await expect(
        provider.captureState!(decodeLocalPath(nested), {
          maxDirtyPatchBytes: 1024 * 1024,
          maxUntrackedManifestBytes: 256
        })
      ).rejects.toThrow(/manifest exceeds its bound/);
      expect(readFileSync(join(root, ".git", "index"))).toEqual(originalIndex);
      expect(readFileSync(join(root, ".git", "index.lock"), "utf8")).toBe(
        "another writer"
      );
      rmSync(join(root, ".git", "index.lock"));

      expect(captured.headOid).toMatch(/^[a-f0-9]{40}$/u);
      expect(captured.indexTreeHash).toMatch(/^[a-f0-9]{40}$/u);
      const dirtyBundle = JSON.parse(
        Buffer.from(captured.dirtyPatch ?? []).toString("utf8")
      ) as {
        indexPatchBase64: string;
        worktreePatchBase64: string;
      };
      expect(
        Buffer.from(dirtyBundle.indexPatchBase64, "base64").toString()
      ).toContain("staged.txt");
      expect(
        Buffer.from(dirtyBundle.worktreePatchBase64, "base64").toString()
      ).toContain("+after");
      const manifest = JSON.parse(
        Buffer.from(captured.untrackedManifest ?? []).toString("utf8")
      ) as unknown[];
      expect(manifest).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "empty.txt",
            kind: "file",
            sizeBytes: 0,
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
          }),
          expect.objectContaining({
            path: "new-link",
            kind: "symlink",
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
          }),
          expect.objectContaining({
            path: "new.txt",
            kind: "file",
            sizeBytes: 10,
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
          })
        ])
      );
      expect(captured.changedPaths).toEqual([
        "empty.txt",
        "new-link",
        "new.txt",
        "staged.txt",
        "tracked.txt"
      ]);

      execFileSync(
        "git",
        ["worktree", "add", "-q", "-b", "review", review, captured.headOid],
        { cwd: root }
      );
      await provider.materializeState!(decodeLocalPath(review), {
        headOid: captured.headOid,
        indexTreeHash: captured.indexTreeHash,
        dirtyPatch: captured.dirtyPatch,
        untrackedManifest: captured.untrackedManifest
      });
      const materialized = await provider.captureState!(
        decodeLocalPath(review),
        {
          maxDirtyPatchBytes: 1024 * 1024,
          maxUntrackedManifestBytes: 1024 * 1024
        }
      );

      expect(materialized).toEqual({
        ...captured,
        repositoryRoot: decodeLocalPath(review)
      });
      expect(readFileSync(join(review, "tracked.txt"), "utf8")).toBe("after\n");
      expect(readFileSync(join(review, "empty.txt"))).toHaveLength(0);
      expect(readlinkSync(join(review, "new-link"))).toBe("new.txt");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("rejects an untracked artifact that traverses a tracked parent symlink", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-repository-state-"));
    const root = join(sandbox, "source");
    const outside = join(sandbox, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["config", "user.name", "kmux test"], {
        cwd: root
      });
      execFileSync("git", ["config", "user.email", "kmux@example.invalid"], {
        cwd: root
      });
      symlinkSync(outside, join(root, "escape"));
      execFileSync("git", ["add", "escape"], { cwd: root });
      execFileSync("git", ["commit", "-qm", "tracked symlink"], {
        cwd: root
      });
      const provider = createLocalGitProvider({
        resolveLocalPath: createLocalPathResolver(),
        managedRoot: join(sandbox, "managed")
      });
      const content = Buffer.from("must stay inside\n", "utf8");
      const manifest = Buffer.from(
        `${JSON.stringify([
          {
            path: "escape/pwn.txt",
            kind: "file",
            sizeBytes: content.byteLength,
            sha256: createHash("sha256").update(content).digest("hex"),
            mode: 0o600,
            contentBase64: content.toString("base64")
          }
        ])}\n`,
        "utf8"
      );

      await expect(
        provider.materializeState!(decodeLocalPath(root), {
          headOid: execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: root,
            encoding: "utf8"
          }).trim(),
          untrackedManifest: manifest
        })
      ).rejects.toThrow("parent is not a real directory");
      expect(existsSync(join(outside, "pwn.txt"))).toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
