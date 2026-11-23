import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { decodeLocalPath, type LocalPath } from "@kmux/core";
import {
  resolveGitRepository,
  type GitRepositoryMetadata
} from "@kmux/metadata";

import { resolveTerminalFilePathCandidates } from "../terminalFileOpen";
import type {
  AttachmentProvider,
  FileProvider,
  GitProvider
} from "./contracts";
import type { LocalPathResolver } from "./targetServiceRegistry";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_DIRTY_LIMIT = 8;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

interface DirtyPatchBundleV1 {
  readonly version: 1;
  readonly indexPatchBase64?: string;
  readonly worktreePatchBase64?: string;
}

type UntrackedMaterializationEntry =
  | {
      readonly path: string;
      readonly kind: "file";
      readonly sizeBytes: number;
      readonly sha256: string;
      readonly mode: number;
      readonly contentBase64: string;
    }
  | {
      readonly path: string;
      readonly kind: "symlink";
      readonly sizeBytes: number;
      readonly sha256: string;
      readonly targetBase64: string;
    };

export function createLocalFileProvider(options: {
  resolveLocalPath: LocalPathResolver;
  homeDir: string;
}): FileProvider<LocalPath> {
  const raw = (value: LocalPath): string =>
    options.resolveLocalPath({ kind: "local", path: value });
  const decode = (value: string): LocalPath => decodeLocalPath(value);
  const provider: FileProvider<LocalPath> = {
    async exists(value) {
      try {
        await stat(raw(value));
        return true;
      } catch {
        return false;
      }
    },
    async stat(value) {
      try {
        const metadata = await stat(raw(value));
        return {
          kind: metadata.isFile()
            ? "file"
            : metadata.isDirectory()
              ? "directory"
              : "other",
          size: metadata.size,
          modifiedAtMs: metadata.mtimeMs
        };
      } catch (error) {
        if (isMissingFileError(error)) return null;
        throw error;
      }
    },
    async read(value, readOptions) {
      assertTransferBound(readOptions.maxBytes);
      const filePath = raw(value);
      const metadata = await stat(filePath);
      if (!metadata.isFile() || metadata.size > readOptions.maxBytes) {
        throw new Error("local file is not regular or exceeds its read bound");
      }
      const bytes = await readFile(filePath);
      if (bytes.byteLength > readOptions.maxBytes) {
        throw new Error("local file grew beyond its read bound");
      }
      return new Uint8Array(bytes);
    },
    join(base, ...segments) {
      validatePathSegments(segments);
      return decode(path.join(raw(base), ...segments));
    },
    dirname(value) {
      return decode(path.dirname(raw(value)));
    },
    basename(value) {
      return path.basename(raw(value));
    },
    display(value) {
      return raw(value);
    },
    async resolveTerminalPath(request) {
      const cwd = request.cwd === undefined ? undefined : raw(request.cwd);
      for (const resolved of resolveTerminalFilePathCandidates({
        rawPath: request.rawPath,
        cwd,
        homeDir: options.homeDir
      })) {
        const decoded = decode(resolved);
        const metadata = await provider.stat(decoded);
        if (metadata?.kind === "file") {
          return { path: decoded, displayPath: resolved, metadata };
        }
      }
      return null;
    },
    async stageForLocalOpen(value, stageOptions) {
      assertTransferBound(stageOptions.maxBytes);
      const filePath = raw(value);
      const metadata = await stat(filePath);
      if (!metadata.isFile() || metadata.size > stageOptions.maxBytes) {
        throw new Error("local file is not regular or exceeds its open bound");
      }
      const digest = await hashBoundedFile(filePath, stageOptions.maxBytes);
      return {
        localPath: value,
        byteLength: metadata.size,
        sha256: digest
      };
    }
  };
  return Object.freeze(provider);
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR")
  );
}

export function createLocalGitProvider(options: {
  resolveLocalPath: LocalPathResolver;
  managedRoot: string;
  env?: NodeJS.ProcessEnv;
}): GitProvider<LocalPath> {
  const raw = (value: LocalPath): string =>
    options.resolveLocalPath({ kind: "local", path: value });
  const decode = (value: string): LocalPath => decodeLocalPath(value);
  const provider: GitProvider<LocalPath> = {
    managedWorktreeRoot: () => decode(options.managedRoot),
    async inspect(cwd, inspectionOptions = {}) {
      const rawCwd = raw(cwd);
      const repository = await resolveGitRepository(rawCwd, options.env);
      if (!repository) {
        return {
          dirtyEntries: [],
          dirtyEntriesTruncated: false,
          ...(inspectionOptions.branch === undefined
            ? {}
            : { branchExists: false })
        };
      }
      const branch = await resolveBaseRef(rawCwd, options.env);
      const dirty = await resolveDirtyEntries(
        rawCwd,
        inspectionOptions.dirtyLimit ?? DEFAULT_DIRTY_LIMIT,
        options.env
      );
      const branchExists =
        inspectionOptions.branch === undefined
          ? undefined
          : await localBranchExists(
              repository.root,
              inspectionOptions.branch,
              options.env
            );
      return {
        repository: decodeRepository(repository, decode),
        branch,
        dirtyEntries: dirty.entries,
        dirtyEntriesTruncated: dirty.truncated,
        ...(branchExists === undefined ? {} : { branchExists })
      };
    },
    async captureState(cwd, captureOptions) {
      assertTransferBound(captureOptions.maxDirtyPatchBytes);
      assertTransferBound(captureOptions.maxUntrackedManifestBytes);
      const rawCwd = raw(cwd);
      const repository = await resolveGitRepository(rawCwd, options.env);
      if (!repository) {
        throw new Error("Repository State capture requires a Git repository");
      }
      // `write-tree` takes a mandatory index lock even with optional locks
      // disabled. Capture one private index snapshot so parallel reviewers
      // never contend for or refresh the user's live index.
      const captureRoot = await mkdtemp(
        path.join(tmpdir(), "kmux-git-capture-")
      );
      try {
        const captureEnv = {
          ...options.env,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_INDEX_FILE: path.join(captureRoot, "index")
        };
        const indexPath = await runGit(
          repository.root,
          ["rev-parse", "--path-format=absolute", "--git-path", "index"],
          options.env
        );
        try {
          await copyFile(indexPath.trim(), captureEnv.GIT_INDEX_FILE);
        } catch (error) {
          if (!isMissingFileError(error)) throw error;
          // A missing index is Git's empty index, including after `git read-tree --empty`.
          await runGit(repository.root, ["read-tree", "--empty"], captureEnv);
        }
        const headOid = await runGit(
          repository.root,
          ["rev-parse", "--verify", "HEAD"],
          captureEnv
        );
        const indexTreeHash = await runGit(
          repository.root,
          ["write-tree"],
          captureEnv
        );
        const [indexPatch, worktreePatch, status, untracked] =
          await Promise.all([
            runGitBytes(
              repository.root,
              ["diff", "--cached", "--binary", "--full-index", "HEAD", "--"],
              captureOptions.maxDirtyPatchBytes,
              captureEnv
            ),
            runGitBytes(
              repository.root,
              ["diff", "--binary", "--full-index", "--"],
              captureOptions.maxDirtyPatchBytes,
              captureEnv
            ),
            runGitBytes(
              repository.root,
              ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
              captureOptions.maxUntrackedManifestBytes,
              captureEnv
            ),
            runGitBytes(
              repository.root,
              ["ls-files", "--others", "--exclude-standard", "-z"],
              captureOptions.maxUntrackedManifestBytes,
              captureEnv
            )
          ]);
        const untrackedPaths = splitNul(untracked);
        if (untrackedPaths.length > 256) {
          throw new Error("untracked Repository State exceeds 256 files");
        }
        const entries: UntrackedMaterializationEntry[] = [];
        let remaining = captureOptions.maxUntrackedManifestBytes - 3; // [] and newline
        for (const relativePath of untrackedPaths) {
          const absolutePath = path.resolve(repository.root, relativePath);
          const relative = path.relative(repository.root, absolutePath);
          if (
            relative === ".." ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)
          ) {
            throw new Error("untracked path escaped the repository root");
          }
          const metadata = await lstat(absolutePath);
          const link = metadata.isSymbolicLink();
          if (!link && !metadata.isFile())
            throw new Error(
              "untracked Repository State contains a non-file entry"
            );
          const entry: UntrackedMaterializationEntry = link
            ? {
                path: relativePath,
                kind: "symlink",
                sizeBytes: metadata.size,
                sha256: "",
                targetBase64: ""
              }
            : {
                path: relativePath,
                kind: "file",
                sizeBytes: metadata.size,
                sha256: "",
                mode: metadata.mode & 0o777,
                contentBase64: ""
              };
          remaining -=
            Buffer.byteLength(JSON.stringify(entry)) +
            64 +
            4 * Math.ceil(metadata.size / 3) +
            Number(entries.length > 0);
          if (remaining < 0)
            throw new Error(
              "untracked Repository State manifest exceeds its bound"
            );
          entries.push(entry);
        }
        const manifest: UntrackedMaterializationEntry[] = [];
        for (const entry of entries) {
          const absolutePath = path.join(repository.root, entry.path);
          const bytes =
            entry.kind === "symlink"
              ? await readlink(absolutePath, "buffer")
              : await readUntrackedFile(absolutePath, entry.sizeBytes);
          if (bytes.byteLength !== entry.sizeBytes)
            throw new Error(
              "untracked Repository State file changed during capture"
            );
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          manifest.push(
            entry.kind === "symlink"
              ? { ...entry, sha256, targetBase64: bytes.toString("base64") }
              : { ...entry, sha256, contentBase64: bytes.toString("base64") }
          );
        }
        const untrackedManifest = Buffer.from(
          `${JSON.stringify(manifest)}\n`,
          "utf8"
        );
        if (
          untrackedManifest.byteLength >
          captureOptions.maxUntrackedManifestBytes
        ) {
          throw new Error(
            "untracked Repository State manifest exceeds its bound"
          );
        }
        const dirtyPatch =
          indexPatch.byteLength > 0 || worktreePatch.byteLength > 0
            ? Buffer.from(
                `${JSON.stringify({
                  version: 1,
                  ...(indexPatch.byteLength > 0
                    ? { indexPatchBase64: indexPatch.toString("base64") }
                    : {}),
                  ...(worktreePatch.byteLength > 0
                    ? { worktreePatchBase64: worktreePatch.toString("base64") }
                    : {})
                } satisfies DirtyPatchBundleV1)}\n`,
                "utf8"
              )
            : Buffer.alloc(0);
        if (dirtyPatch.byteLength > captureOptions.maxDirtyPatchBytes) {
          throw new Error(
            "dirty Repository State patch bundle exceeds its bound"
          );
        }
        return {
          repositoryRoot: decode(repository.root),
          commonGitDir: decode(repository.commonGitDir),
          headOid: headOid.trim(),
          indexTreeHash: indexTreeHash.trim(),
          changedPaths: parseChangedPaths(status),
          ...(dirtyPatch.byteLength > 0
            ? { dirtyPatch: new Uint8Array(dirtyPatch) }
            : {}),
          ...(untrackedManifest.byteLength > 3
            ? { untrackedManifest: new Uint8Array(untrackedManifest) }
            : {})
        };
      } finally {
        await rm(captureRoot, { recursive: true, force: true });
      }
    },
    async materializeState(cwd, expected) {
      const rawCwd = raw(cwd);
      const repository = await resolveGitRepository(rawCwd, options.env);
      if (!repository) {
        throw new Error(
          "Repository State materialization requires a Git repository"
        );
      }
      const headOid = (
        await runGit(rawCwd, ["rev-parse", "--verify", "HEAD"], options.env)
      ).trim();
      if (headOid !== expected.headOid) {
        throw new Error("Repository State materialization HEAD does not match");
      }
      const status = await runGitBytes(
        rawCwd,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        MAX_GIT_OUTPUT_BYTES,
        options.env
      );
      if (status.byteLength > 0) {
        throw new Error(
          "Repository State materialization requires a clean worktree"
        );
      }
      if (expected.dirtyPatch) {
        const bundle = parseDirtyPatchBundle(expected.dirtyPatch);
        if (bundle.indexPatchBase64) {
          await runGitWithInput(
            rawCwd,
            ["apply", "--binary", "--index", "--whitespace=nowarn", "-"],
            decodeBoundedBase64(
              bundle.indexPatchBase64,
              expected.dirtyPatch.byteLength
            ),
            options.env
          );
        }
        if (bundle.worktreePatchBase64) {
          await runGitWithInput(
            rawCwd,
            ["apply", "--binary", "--whitespace=nowarn", "-"],
            decodeBoundedBase64(
              bundle.worktreePatchBase64,
              expected.dirtyPatch.byteLength
            ),
            options.env
          );
        }
      }
      if (expected.untrackedManifest) {
        await materializeUntrackedManifest(
          repository.root,
          expected.untrackedManifest
        );
      }
      if (expected.indexTreeHash) {
        const indexTreeHash = (
          await runGit(rawCwd, ["write-tree"], options.env)
        ).trim();
        if (indexTreeHash !== expected.indexTreeHash) {
          throw new Error(
            "materialized Repository State index tree does not match"
          );
        }
      }
    },
    async createWorktree(request) {
      const cwd = raw(request.cwd);
      const worktreePath = raw(request.path);
      try {
        await mkdir(path.dirname(worktreePath), {
          recursive: true,
          mode: 0o700
        });
        await runGit(
          cwd,
          [
            "worktree",
            "add",
            "-b",
            request.branch,
            "--",
            worktreePath,
            request.baseRef
          ],
          options.env
        );
        return { status: "succeeded" };
      } catch (error) {
        return {
          status: "failed",
          code: "git-failed",
          message: error instanceof Error ? error.message : String(error)
        };
      }
    },
    async removeWorktree(request) {
      const cwd = raw(request.cwd);
      const worktreePath = raw(request.path);
      try {
        if (!request.force) {
          const dirty = await resolveDirtyEntries(
            worktreePath,
            DEFAULT_DIRTY_LIMIT,
            options.env
          );
          if (dirty.entries.length > 0 || dirty.truncated) {
            return {
              status: "failed",
              code: "worktree-dirty",
              message: dirty.entries.join("\n")
            };
          }
        }
        await runGit(
          cwd,
          [
            "worktree",
            "remove",
            ...(request.force ? ["--force"] : []),
            "--",
            worktreePath
          ],
          options.env
        );
        return { status: "succeeded" };
      } catch (error) {
        return {
          status: "failed",
          code: "git-failed",
          message: error instanceof Error ? error.message : String(error)
        };
      }
    }
  };
  return Object.freeze(provider);
}

export function createLocalAttachmentProvider(options: {
  attachmentRoot: string;
}): AttachmentProvider<LocalPath> {
  const provider: AttachmentProvider<LocalPath> = {
    async store(request) {
      if (
        request.bytes.byteLength < 1 ||
        request.bytes.byteLength > MAX_ATTACHMENT_BYTES
      ) {
        throw new Error("local attachment is outside the 20 MiB bound");
      }
      const directory = path.join(
        options.attachmentRoot,
        safePathSegment(request.workspaceId),
        safePathSegment(request.sessionId)
      );
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const extension = safeAttachmentExtension(request.name);
      const filePath = path.join(directory, `${randomUUID()}${extension}`);
      await writeFile(filePath, request.bytes, { flag: "wx", mode: 0o600 });
      return {
        path: decodeLocalPath(filePath),
        terminalReference: filePath
      };
    }
  };
  return Object.freeze(provider);
}

function decodeRepository(
  repository: GitRepositoryMetadata,
  decode: (value: string) => LocalPath
) {
  return {
    root: decode(repository.root),
    gitDir: decode(repository.gitDir),
    commonGitDir: decode(repository.commonGitDir),
    linkedWorktree: repository.gitDir !== repository.commonGitDir
  };
}

async function resolveBaseRef(
  cwd: string,
  env?: NodeJS.ProcessEnv
): Promise<string> {
  const branch = await runGit(
    cwd,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    env
  ).catch(() => "");
  if (branch.trim()) return branch.trim();
  const commit = await runGit(cwd, ["rev-parse", "--short", "HEAD"], env).catch(
    () => ""
  );
  return commit.trim() || "HEAD";
}

async function localBranchExists(
  cwd: string,
  branch: string,
  env?: NodeJS.ProcessEnv
): Promise<boolean> {
  return runGit(
    cwd,
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    env
  )
    .then(() => true)
    .catch(() => false);
}

async function resolveDirtyEntries(
  cwd: string,
  limit: number,
  env?: NodeJS.ProcessEnv
): Promise<{ entries: string[]; truncated: boolean }> {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 256) {
    throw new TypeError("dirty entry limit is outside 0..256");
  }
  if (limit === 0) return { entries: [], truncated: false };
  try {
    const stdout = await runGit(
      cwd,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      env
    );
    return parseDirtyOutput(Buffer.from(stdout, "utf8"), limit, false);
  } catch (error) {
    const record = error as { code?: string; stdout?: unknown };
    if (record.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw error;
    return parseDirtyOutput(
      Buffer.from(String(record.stdout ?? ""), "utf8"),
      limit,
      true
    );
  }
}

function parseDirtyOutput(
  bytes: Buffer,
  limit: number,
  outputTruncated: boolean
): { entries: string[]; truncated: boolean } {
  const values = bytes.toString("utf8").split("\0").filter(Boolean);
  return {
    entries: values.slice(0, limit),
    truncated: outputTruncated || values.length > limit
  };
}

async function runGit(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      env: { ...env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      encoding: "utf8"
    });
    return stdout;
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "").trim()
        : "";
    if (
      error &&
      typeof error === "object" &&
      (error as { code?: string }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
    ) {
      throw error;
    }
    throw new Error(
      stderr || (error instanceof Error ? error.message : String(error))
    );
  }
}

async function runGitBytes(
  cwd: string,
  args: string[],
  maxBuffer: number,
  env?: NodeJS.ProcessEnv
): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      env: { ...env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer,
      encoding: "buffer"
    });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  } catch (error) {
    const record = error as { code?: string; stderr?: unknown };
    if (record.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new Error("Repository State capture exceeds its byte bound");
    }
    const stderr = Buffer.isBuffer(record.stderr)
      ? record.stderr.toString("utf8").trim()
      : String(record.stderr ?? "").trim();
    throw new Error(
      stderr || (error instanceof Error ? error.message : String(error))
    );
  }
}

async function runGitWithInput(
  cwd: string,
  args: string[],
  input: Uint8Array,
  env?: NodeJS.ProcessEnv
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let exceeded = false;
    const append = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_GIT_OUTPUT_BYTES) {
        exceeded = true;
        child.kill("SIGKILL");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (exceeded) {
        reject(new Error("Git materialization output exceeds its byte bound"));
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            Buffer.concat(stderr).toString("utf8").trim() ||
              `git exited ${code ?? "without status"}`
          )
        );
        return;
      }
      resolve();
    });
    child.stdin.end(input);
  });
}

function parseDirtyPatchBundle(bytes: Uint8Array): DirtyPatchBundleV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("dirty Repository State patch bundle is invalid JSON");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as { version?: unknown }).version !== 1
  ) {
    throw new Error("dirty Repository State patch bundle version is invalid");
  }
  const bundle = parsed as Record<string, unknown>;
  const keys = Object.keys(bundle);
  if (
    keys.some(
      (key) =>
        !["version", "indexPatchBase64", "worktreePatchBase64"].includes(key)
    ) ||
    (bundle.indexPatchBase64 !== undefined &&
      typeof bundle.indexPatchBase64 !== "string") ||
    (bundle.worktreePatchBase64 !== undefined &&
      typeof bundle.worktreePatchBase64 !== "string") ||
    (bundle.indexPatchBase64 === undefined &&
      bundle.worktreePatchBase64 === undefined)
  ) {
    throw new Error("dirty Repository State patch bundle shape is invalid");
  }
  return bundle as unknown as DirtyPatchBundleV1;
}

function decodeBoundedBase64(value: string, maximum: number): Buffer {
  if (value.length === 0) return Buffer.alloc(0);
  if (
    value.length > Math.ceil(maximum / 3) * 4 + 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) {
    throw new Error("Repository State artifact contains invalid base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength > maximum || decoded.toString("base64") !== value) {
    throw new Error(
      "Repository State artifact base64 is non-canonical or oversized"
    );
  }
  return decoded;
}

async function materializeUntrackedManifest(
  repositoryRoot: string,
  bytes: Uint8Array
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("untracked Repository State manifest is invalid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length > 256) {
    throw new Error("untracked Repository State manifest shape is invalid");
  }
  for (const value of parsed) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("untracked Repository State entry is invalid");
    }
    const entry = value as Record<string, unknown>;
    const relativePath = entry.path;
    if (
      typeof relativePath !== "string" ||
      !relativePath ||
      path.isAbsolute(relativePath) ||
      relativePath.includes("\0") ||
      path.normalize(relativePath) !== relativePath
    ) {
      throw new Error("untracked Repository State path is invalid");
    }
    const absolutePath = path.resolve(repositoryRoot, relativePath);
    const relative = path.relative(repositoryRoot, absolutePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("untracked Repository State path escaped the repository");
    }
    try {
      await lstat(absolutePath);
      throw new Error(
        "untracked Repository State would overwrite an existing path"
      );
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    const kind = entry.kind;
    const sizeBytes = entry.sizeBytes;
    const sha256 = entry.sha256;
    if (
      (kind !== "file" && kind !== "symlink") ||
      !Number.isSafeInteger(sizeBytes) ||
      (sizeBytes as number) < 0 ||
      typeof sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(sha256)
    ) {
      throw new Error("untracked Repository State metadata is invalid");
    }
    await ensureMaterializationParents(
      repositoryRoot,
      path.dirname(relativePath)
    );
    if (kind === "file") {
      if (
        typeof entry.contentBase64 !== "string" ||
        !Number.isSafeInteger(entry.mode) ||
        (entry.mode as number) < 0 ||
        (entry.mode as number) > 0o777
      ) {
        throw new Error("untracked Repository State file entry is invalid");
      }
      const content = decodeBoundedBase64(
        entry.contentBase64,
        bytes.byteLength
      );
      assertMaterializedBytes(content, sizeBytes as number, sha256);
      await writeFile(absolutePath, content, {
        flag: "wx",
        mode: entry.mode as number
      });
      await chmod(absolutePath, entry.mode as number);
      continue;
    }
    if (typeof entry.targetBase64 !== "string") {
      throw new Error("untracked Repository State symlink entry is invalid");
    }
    const target = decodeBoundedBase64(entry.targetBase64, bytes.byteLength);
    assertMaterializedBytes(target, sizeBytes as number, sha256);
    const targetText = target.toString("utf8");
    if (Buffer.from(targetText, "utf8").compare(target) !== 0) {
      throw new Error("untracked Repository State symlink target is not UTF-8");
    }
    await symlink(targetText, absolutePath);
  }
}

async function ensureMaterializationParents(
  repositoryRoot: string,
  relativeDirectory: string
): Promise<void> {
  if (relativeDirectory === ".") return;
  let current = repositoryRoot;
  for (const segment of relativeDirectory.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(
          "untracked Repository State parent is not a real directory"
        );
      }
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
}

function assertMaterializedBytes(
  bytes: Uint8Array,
  sizeBytes: number,
  sha256: unknown
): void {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== sizeBytes || actual !== sha256) {
    throw new Error(
      "untracked Repository State content does not match metadata"
    );
  }
}

function splitNul(bytes: Uint8Array): string[] {
  return Buffer.from(bytes).toString("utf8").split("\0").filter(Boolean);
}

function parseChangedPaths(status: Uint8Array): string[] {
  const entries = splitNul(status);
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") {
      const previous = entries[index + 1];
      if (previous) {
        paths.push(previous);
        index += 1;
      }
    }
  }
  return [...new Set(paths)].sort();
}

async function hashBoundedFile(
  filePath: string,
  maximum: number
): Promise<string> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.byteLength;
    if (bytes > maximum) {
      throw new Error("local file grew beyond its hash bound");
    }
    hash.update(data);
  }
  return hash.digest("hex");
}

async function readUntrackedFile(
  filePath: string,
  expectedSize: number
): Promise<Buffer> {
  const file = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== expectedSize)
      throw new Error("untracked Repository State file changed during capture");
    const bytes = Buffer.alloc(expectedSize);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset
      );
      if (!bytesRead)
        throw new Error(
          "untracked Repository State file changed during capture"
        );
      offset += bytesRead;
    }
    if ((await file.stat()).size !== expectedSize)
      throw new Error("untracked Repository State file changed during capture");
    return bytes;
  } finally {
    await file.close();
  }
}

function assertTransferBound(maximum: number): void {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1024 ** 3) {
    throw new TypeError("file transfer bound is outside 1..1GiB");
  }
}

function safePathSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]+/gu, "-").slice(0, 96);
  return safe || createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function safeAttachmentExtension(name: string | undefined): string {
  if (!name) return "";
  const extension = path.extname(path.basename(name)).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/u.test(extension) ? extension : "";
}

function validatePathSegments(segments: string[]): void {
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        path.isAbsolute(segment) ||
        segment.includes("/") ||
        segment.includes("\\") ||
        segment.includes("\0") ||
        Buffer.byteLength(segment, "utf8") > 32 * 1024
    )
  ) {
    throw new TypeError("path segment is invalid");
  }
}
