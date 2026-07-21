import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { posix, resolve } from "node:path";

import { decodeLocalPath, type RemotePath } from "@kmux/core";
import type { Id } from "@kmux/proto";

import {
  IMAGE_ATTACHMENT_MAX_TOTAL_BYTES,
  IMAGE_ATTACHMENT_RETENTION_MS,
  MAX_IMAGE_ATTACHMENT_BYTES
} from "../imageAttachments";
import type { RemoteHostManager } from "../remoteHost";
import { REMOTE_ATTACHMENT_FILE_PREFIX } from "../../shared/remoteHostProtocol";
import type { AttachmentProvider, FileProvider } from "./contracts";
import type {
  RemotePathDecoder,
  RemotePathResolver
} from "./targetServiceRegistry";

const MAX_TRANSFER_BYTES = 1024 ** 3;
const MAX_REMOTE_PATH_BYTES = 32 * 1024;
const LINE_COLUMN_SUFFIX_RE = /^(.+?):\d+(?::\d+)?$/u;
const URL_PROTOCOL_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/u;

export interface CreateRemoteFileProvidersOptions {
  host: Pick<
    RemoteHostManager,
    | "fileExists"
    | "statFile"
    | "downloadFile"
    | "uploadFile"
    | "releaseFile"
    | "pruneRemoteAttachments"
  >;
  targetId: Id;
  transferRoot: string;
  remoteStateRoot: string;
  resolveRemotePath: RemotePathResolver;
  decodeRemotePath: RemotePathDecoder;
  remoteHomeDir?: string;
  createTransferId?: () => Id;
  now?: () => number;
}

export interface RemoteFileProviders {
  files: FileProvider<RemotePath>;
  attachments: AttachmentProvider<RemotePath>;
}

export function createRemoteFileProviders(
  options: CreateRemoteFileProvidersOptions
): RemoteFileProviders {
  const transferId =
    options.createTransferId ?? (() => `file_${randomUUID()}` as Id);
  const now = options.now ?? Date.now;
  const decode = (value: string): RemotePath =>
    options.decodeRemotePath(validateRemotePath(value));
  const raw = (value: RemotePath): string =>
    validateRemotePath(options.resolveRemotePath(value));

  const files: FileProvider<RemotePath> = {
    async exists(path) {
      return await options.host.fileExists(options.targetId, raw(path));
    },
    async stat(path) {
      return await options.host.statFile(options.targetId, raw(path));
    },
    async read(path, readOptions) {
      assertTransferBound(readOptions.maxBytes);
      const downloaded = await options.host.downloadFile({
        targetId: options.targetId,
        transferId: transferId(),
        remotePath: raw(path),
        maxBytes: readOptions.maxBytes
      });
      try {
        const bytes = await readVerifiedStage(
          downloaded.localPath,
          readOptions.maxBytes,
          downloaded.byteLength,
          downloaded.sha256
        );
        return new Uint8Array(bytes);
      } finally {
        await options.host
          .releaseFile(options.targetId, downloaded.localPath)
          .catch(() => rm(downloaded.localPath, { force: true }));
      }
    },
    join(base, ...segments) {
      validatePathSegments(segments);
      return decode(posix.join(raw(base), ...segments));
    },
    dirname(path) {
      return decode(posix.dirname(raw(path)));
    },
    basename(path) {
      return posix.basename(raw(path));
    },
    display(path) {
      return raw(path);
    },
    async resolveTerminalPath(request) {
      const cwd = request.cwd === undefined ? undefined : raw(request.cwd);
      for (const candidate of terminalPathCandidates(request.rawPath)) {
        const resolved = resolveRemoteTerminalPath(
          candidate,
          cwd,
          options.remoteHomeDir
        );
        if (
          resolved &&
          (await options.host.fileExists(options.targetId, resolved))
        ) {
          return { path: decode(resolved), displayPath: resolved };
        }
      }
      return null;
    },
    async stageForLocalOpen(path, stageOptions) {
      assertTransferBound(stageOptions.maxBytes);
      const downloaded = await options.host.downloadFile({
        targetId: options.targetId,
        transferId: transferId(),
        remotePath: raw(path),
        maxBytes: stageOptions.maxBytes
      });
      try {
        await assertDownloadedStage(
          downloaded.localPath,
          stageOptions.maxBytes,
          downloaded.byteLength
        );
        if (
          (await hashBoundedStage(
            downloaded.localPath,
            stageOptions.maxBytes
          )) !== downloaded.sha256
        ) {
          throw new Error(
            "staged remote file failed byte-identity verification"
          );
        }
      } catch (error) {
        await options.host
          .releaseFile(options.targetId, downloaded.localPath)
          .catch(() => rm(downloaded.localPath, { force: true }));
        throw error;
      }
      return {
        localPath: decodeLocalPath(downloaded.localPath),
        byteLength: downloaded.byteLength,
        sha256: downloaded.sha256
      };
    }
  };

  const attachments: AttachmentProvider<RemotePath> = {
    async store(request) {
      if (
        request.bytes.byteLength < 1 ||
        request.bytes.byteLength > MAX_IMAGE_ATTACHMENT_BYTES
      ) {
        throw new Error("remote attachment is outside the 20 MiB bound");
      }
      const id = transferId();
      const uploadRoot = resolve(options.transferRoot, "uploads");
      await mkdir(uploadRoot, { recursive: true, mode: 0o700 });
      await assertPrivateUploadRoot(uploadRoot);
      const localPath = resolve(uploadRoot, `${safeId(id)}.upload`);
      const sha256 = createHash("sha256").update(request.bytes).digest("hex");
      const extension = safeExtension(request.name);
      const createdAtUnixMs = now();
      if (!Number.isSafeInteger(createdAtUnixMs) || createdAtUnixMs < 0) {
        throw new Error("remote attachment clock is invalid");
      }
      const attachmentDirectory = posix.join(
        validateRemotePath(options.remoteStateRoot),
        "attachments"
      );
      await options.host.pruneRemoteAttachments({
        targetId: options.targetId,
        remoteDirectory: attachmentDirectory,
        nowUnixMs: createdAtUnixMs,
        maxAgeMs: IMAGE_ATTACHMENT_RETENTION_MS,
        maxTotalBytes:
          IMAGE_ATTACHMENT_MAX_TOTAL_BYTES - request.bytes.byteLength
      });
      const attachmentId = createHash("sha256")
        .update(request.workspaceId)
        .update("\0")
        .update(request.sessionId)
        .update("\0")
        .update(id)
        .digest("hex")
        .slice(0, 32);
      const remotePath = posix.join(
        attachmentDirectory,
        `${REMOTE_ATTACHMENT_FILE_PREFIX}${createdAtUnixMs}-${attachmentId}${extension}`
      );
      await writeFile(localPath, request.bytes, {
        flag: "wx",
        mode: 0o600
      });
      try {
        await options.host.uploadFile({
          targetId: options.targetId,
          transferId: id,
          localPath,
          remotePath,
          maxBytes: MAX_IMAGE_ATTACHMENT_BYTES,
          sha256
        });
      } finally {
        await rm(localPath, { force: true }).catch(() => undefined);
      }
      return {
        path: decode(remotePath),
        terminalReference: remotePath
      };
    }
  };

  return Object.freeze({
    files: Object.freeze(files),
    attachments: Object.freeze(attachments)
  });
}

function terminalPathCandidates(rawPath: string): string[] {
  const text = rawPath.trim();
  if (
    !text ||
    Buffer.byteLength(text, "utf8") > 4_096 ||
    /[\0\r\n]/u.test(text) ||
    URL_PROTOCOL_RE.test(text)
  ) {
    return [];
  }
  const candidates = [text];
  const suffix = text.match(LINE_COLUMN_SUFFIX_RE)?.[1];
  if (suffix && suffix !== text) candidates.push(suffix);
  return candidates;
}

function resolveRemoteTerminalPath(
  candidate: string,
  cwd: string | undefined,
  homeDir: string | undefined
): string | null {
  if (candidate.startsWith("~/")) {
    return homeDir
      ? validateRemotePath(posix.resolve(homeDir, candidate.slice(2)))
      : null;
  }
  if (candidate.startsWith("~")) return null;
  if (posix.isAbsolute(candidate)) {
    return validateRemotePath(posix.normalize(candidate));
  }
  return cwd ? validateRemotePath(posix.resolve(cwd, candidate)) : null;
}

async function readVerifiedStage(
  localPath: string,
  maxBytes: number,
  expectedBytes: number,
  expectedSha256: string
): Promise<Buffer> {
  await assertDownloadedStage(localPath, maxBytes, expectedBytes);
  const bytes = await readFile(localPath);
  if (
    bytes.byteLength !== expectedBytes ||
    createHash("sha256").update(bytes).digest("hex") !== expectedSha256
  ) {
    throw new Error("staged remote file failed byte-identity verification");
  }
  return bytes;
}

async function assertDownloadedStage(
  localPath: string,
  maxBytes: number,
  expectedBytes: number
): Promise<void> {
  assertTransferBound(maxBytes);
  const metadata = await lstat(localPath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size !== expectedBytes ||
    metadata.size > maxBytes
  ) {
    throw new Error("remote download stage is not a bounded regular file");
  }
}

async function hashBoundedStage(
  localPath: string,
  maxBytes: number
): Promise<string> {
  const digest = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(localPath)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += bytes.byteLength;
    if (byteLength > maxBytes) {
      throw new Error("staged remote file exceeded its verification bound");
    }
    digest.update(bytes);
  }
  return digest.digest("hex");
}

function validateRemotePath(value: string): string {
  if (
    typeof value !== "string" ||
    !posix.isAbsolute(value) ||
    /[\0\r\n]/u.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_REMOTE_PATH_BYTES
  ) {
    throw new TypeError("remote provider path must be bounded and absolute");
  }
  return posix.normalize(value);
}

function validatePathSegments(segments: string[]): void {
  if (
    segments.length > 64 ||
    segments.some(
      (segment) =>
        typeof segment !== "string" ||
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        /[\\/\0\r\n]/u.test(segment) ||
        Buffer.byteLength(segment, "utf8") > 255
    )
  ) {
    throw new TypeError("remote path join contains an unsafe segment");
  }
}

function assertTransferBound(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TRANSFER_BYTES) {
    throw new TypeError("remote file transfer bound is outside 1..1GiB");
  }
}

function safeId(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]+/gu, "-").slice(0, 96);
  return (
    sanitized || createHash("sha256").update(value).digest("hex").slice(0, 24)
  );
}

function safeExtension(name: string | undefined): string {
  if (!name) return "";
  const extension = posix.extname(posix.basename(name)).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/u.test(extension) ? extension : "";
}

async function assertPrivateUploadRoot(path: string): Promise<void> {
  const metadata = await lstat(path);
  const uid = process.getuid?.();
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    (uid !== undefined && metadata.uid !== uid)
  ) {
    throw new Error("remote upload staging root is not private and owned");
  }
}
