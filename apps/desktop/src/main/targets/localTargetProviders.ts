import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { decodeLocalPath, type LocalPath } from "@kmux/core";
import {
  resolveGitRepository,
  type GitRepositoryMetadata
} from "@kmux/metadata";

import { resolveTerminalFilePath } from "../terminalFileOpen";
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
      try {
        const resolved = resolveTerminalFilePath({
          rawPath: request.rawPath,
          ...(request.cwd === undefined ? {} : { cwd: raw(request.cwd) }),
          homeDir: options.homeDir
        });
        return { path: decode(resolved), displayPath: resolved };
      } catch {
        return null;
      }
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
