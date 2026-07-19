import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface DurableAtomicWriteFileSystem {
  closeSync(fd: number): void;
  existsSync(path: string): boolean;
  fsyncSync(fd: number): void;
  lstatSync(path: string): Stats;
  mkdirSync(path: string, options: { recursive: true; mode: number }): unknown;
  openSync(path: string, flags: number, mode?: number): number;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(path: string): void;
  writeSync(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number
  ): number;
}

const nodeFileSystem: DurableAtomicWriteFileSystem = {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync
};

export interface DurableAtomicWriteOptions {
  fileSystem?: DurableAtomicWriteFileSystem;
  randomSuffix?: () => string;
  uid?: number;
}

/**
 * Replaces one bounded file only after file data and the containing directory
 * have crossed their respective fsync boundaries.
 */
export function durableAtomicReplace(
  rootDirectory: string,
  fileName: string,
  bytes: Uint8Array,
  options: DurableAtomicWriteOptions = {}
): void {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const root = resolve(rootDirectory);
  assertLeafFileName(fileName);
  fileSystem.mkdirSync(root, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(root, fileSystem, options.uid ?? currentUid());

  const targetPath = join(root, fileName);
  const targetStats = tryLstat(fileSystem, targetPath);
  if (targetStats) {
    assertPrivateRegularFile(targetStats, options.uid ?? currentUid());
  }
  const suffix = options.randomSuffix?.() ?? randomUUID();
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(suffix)) {
    throw new TypeError("durable temporary-file suffix is invalid");
  }
  const temporaryPath = join(root, `.${fileName}.tmp-${suffix}`);
  let fileDescriptor: number | undefined;
  let directoryDescriptor: number | undefined;
  let renamed = false;
  try {
    fileDescriptor = fileSystem.openSync(
      temporaryPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    writeAll(fileSystem, fileDescriptor, bytes);
    fileSystem.fsyncSync(fileDescriptor);
    fileSystem.closeSync(fileDescriptor);
    fileDescriptor = undefined;

    fileSystem.renameSync(temporaryPath, targetPath);
    renamed = true;
    directoryDescriptor = fileSystem.openSync(
      root,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0)
    );
    fileSystem.fsyncSync(directoryDescriptor);
    fileSystem.closeSync(directoryDescriptor);
    directoryDescriptor = undefined;
  } finally {
    if (fileDescriptor !== undefined) {
      safelyClose(fileSystem, fileDescriptor);
    }
    if (directoryDescriptor !== undefined) {
      safelyClose(fileSystem, directoryDescriptor);
    }
    if (!renamed && fileSystem.existsSync(temporaryPath)) {
      try {
        fileSystem.unlinkSync(temporaryPath);
      } catch {
        // Preserve the primary durability failure; startup rejects stale files.
      }
    }
  }
}

function writeAll(
  fileSystem: DurableAtomicWriteFileSystem,
  fileDescriptor: number,
  bytes: Uint8Array
): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = fileSystem.writeSync(
      fileDescriptor,
      bytes,
      offset,
      bytes.byteLength - offset
    );
    if (!Number.isInteger(written) || written <= 0) {
      throw new Error("durable write made no progress");
    }
    offset += written;
  }
}

function assertLeafFileName(fileName: string): void {
  if (
    !fileName ||
    basename(fileName) !== fileName ||
    dirname(fileName) !== "." ||
    fileName === "." ||
    fileName === ".." ||
    fileName.includes("\0")
  ) {
    throw new TypeError("durable file name must be a safe leaf name");
  }
}

function assertPrivateDirectory(
  path: string,
  fileSystem: DurableAtomicWriteFileSystem,
  uid: number | undefined
): void {
  const stats = fileSystem.lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("durable store root must be a real directory");
  }
  assertOwnerAndMode(stats, uid, 0o077, "durable store root");
}

function assertPrivateRegularFile(stats: Stats, uid: number | undefined): void {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("durable store target must be a regular file");
  }
  assertOwnerAndMode(stats, uid, 0o077, "durable store target");
}

function tryLstat(
  fileSystem: DurableAtomicWriteFileSystem,
  path: string
): Stats | undefined {
  try {
    return fileSystem.lstatSync(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

function assertOwnerAndMode(
  stats: Stats,
  uid: number | undefined,
  forbiddenMode: number,
  field: string
): void {
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(`${field} has the wrong owner`);
  }
  if ((stats.mode & forbiddenMode) !== 0) {
    throw new Error(`${field} has group or other permissions`);
  }
}

function safelyClose(
  fileSystem: DurableAtomicWriteFileSystem,
  fileDescriptor: number
): void {
  try {
    fileSystem.closeSync(fileDescriptor);
  } catch {
    // Preserve the primary write/fsync error.
  }
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}
