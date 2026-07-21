import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, opendir, realpath, rm } from "node:fs/promises";
import { isAbsolute, posix, resolve } from "node:path";
import type { ChildProcess } from "node:child_process";

import { REMOTE_ATTACHMENT_FILE_PREFIX } from "../shared/remoteHostProtocol";
import { spawnMuxOnlyChannel } from "./muxOnlyOpenSshChannel";
import type { AssignedSshMaster, SshTransportPool } from "./sshTransportPool";

const MAX_SFTP_OUTPUT_BYTES = 512 * 1024;
const MAX_SFTP_BATCH_BYTES = 128 * 1024;
const MAX_REMOTE_PATH_BYTES = 32 * 1024;
const MAX_TRANSFER_BYTES = 1024 ** 3;
const MAX_STAGED_FILES = 256;
const MAX_STAGED_BYTES = 1024 ** 3;
const MAX_STAGING_DIRECTORY_ENTRIES = 1_024;
const MAX_MANAGED_ATTACHMENT_ENTRIES = 8_192;
const STAGED_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_CONCURRENT_TRANSFERS = 4;
const MAX_QUEUED_TRANSFERS = 64;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const TERMINATION_GRACE_MS = 2_000;
const TERMINATION_FINAL_WAIT_MS = 250;

const childTerminations = new WeakMap<ChildProcess, Promise<void>>();

export type RemoteSftpErrorCode =
  | "invalid-request"
  | "unavailable"
  | "not-found"
  | "not-regular"
  | "limit-exceeded"
  | "integrity-failed";

export class RemoteSftpError extends Error {
  constructor(
    readonly code: RemoteSftpErrorCode,
    message: string,
    readonly retryable: boolean,
    options: { cause?: unknown; stderr?: string } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "RemoteSftpError";
    this.stderr = options.stderr ?? "";
  }

  readonly stderr: string;
}

export interface RemoteSftpTransferResult {
  transferId: string;
  localPath: string;
  remotePath: string;
  byteLength: number;
  sha256: string;
}

export interface RemoteSftpFileMetadata {
  kind: "file" | "directory" | "other";
  size: number;
}

export interface RemoteSftpUploadResult {
  transferId: string;
  remotePath: string;
  byteLength: number;
  sha256: string;
}

export interface RemoteSftpAttachmentPruneResult {
  deletedCount: number;
  deletedBytes: number;
  remainingBytes: number;
}

export interface MuxOnlyRemoteSftpClientOptions {
  pool: SshTransportPool;
  assigned: AssignedSshMaster;
  transferRoot: string;
  sftpPath?: string;
  now?: () => number;
}

interface BatchResult {
  stdout: string;
  stderr: string;
}

interface StagedEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

interface ManagedAttachmentEntry {
  name: string;
  size: number;
  createdAtUnixMs: number;
}

export class MuxOnlyRemoteSftpClient {
  private readonly now: () => number;
  private readonly targetRoot: string;
  private activeTransfers = 0;
  private readonly waiters: Array<(granted: boolean) => void> = [];
  private readonly idleWaiters: Array<() => void> = [];
  private readonly children = new Set<ChildProcess>();
  private readonly closeController = new AbortController();
  private closed = false;
  private prepared: Promise<void> | undefined;
  private canonicalTransferRoot: string | undefined;

  constructor(private readonly options: MuxOnlyRemoteSftpClientOptions) {
    if (!isAbsolute(options.transferRoot)) {
      throw new RemoteSftpError(
        "invalid-request",
        "SFTP transfer root must be absolute",
        false
      );
    }
    this.now = options.now ?? Date.now;
    this.targetRoot = resolve(
      options.transferRoot,
      createHash("sha256")
        .update(options.assigned.targetId, "utf8")
        .digest("hex")
    );
  }

  exists(remotePath: string): Promise<boolean> {
    return this.enqueue(async () => {
      const path = validateRemotePath(remotePath);
      try {
        await this.runBatch(`ls -1 ${quoteSftpPath(path)}\n`, 30_000);
        return true;
      } catch (error) {
        if (isMissingRemotePath(error)) return false;
        throw error;
      }
    });
  }

  stat(remotePath: string): Promise<RemoteSftpFileMetadata | null> {
    return this.enqueue(async () => {
      const path = validateRemotePath(remotePath);
      let result: BatchResult;
      try {
        result = await this.runBatch(
          `ls -ldn ${quoteSftpPath(path)}\n`,
          30_000
        );
      } catch (error) {
        if (isMissingRemotePath(error)) return null;
        throw error;
      }
      const metadata = parseSftpLongListingMetadata(result.stdout);
      if (!metadata) {
        throw new RemoteSftpError(
          "integrity-failed",
          "remote SFTP stat returned invalid metadata",
          true
        );
      }
      return {
        kind:
          metadata.kind === "-"
            ? "file"
            : metadata.kind === "d"
              ? "directory"
              : "other",
        size: metadata.size
      };
    });
  }

  download(request: {
    transferId: string;
    remotePath: string;
    maxBytes: number;
  }): Promise<RemoteSftpTransferResult> {
    return this.enqueue(async () => {
      await this.prepare();
      const transferId = validateTransferId(request.transferId);
      const remotePath = validateRemotePath(request.remotePath);
      const maxBytes = validateTransferLimit(request.maxBytes);
      const expectedSize = await this.remoteRegularFileSize(remotePath);
      if (expectedSize > maxBytes) {
        throw new RemoteSftpError(
          "limit-exceeded",
          `remote file exceeds the ${maxBytes} byte transfer bound`,
          false
        );
      }
      await this.pruneStaging(expectedSize);
      const localPath = resolve(
        this.targetRoot,
        `${createHash("sha256").update(transferId).digest("hex")}-${randomUUID()}${localStageExtension(remotePath)}`
      );
      try {
        await this.runBatch(
          `get ${quoteSftpPath(remotePath)} ${quoteSftpPath(localPath)}\n`,
          DEFAULT_TIMEOUT_MS,
          { monitoredPath: localPath, maxBytes }
        );
        const metadata = await lstat(localPath);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          throw new RemoteSftpError(
            "not-regular",
            "SFTP download did not produce a regular staged file",
            false
          );
        }
        if (metadata.size !== expectedSize || metadata.size > maxBytes) {
          throw new RemoteSftpError(
            "integrity-failed",
            "remote file size changed during the bounded SFTP download",
            true
          );
        }
        return {
          transferId,
          localPath,
          remotePath,
          byteLength: metadata.size,
          sha256: await hashBoundedFile(localPath, maxBytes)
        };
      } catch (error) {
        await rm(localPath, { force: true }).catch(() => undefined);
        throw normalizeSftpError(error);
      }
    });
  }

  upload(request: {
    transferId: string;
    localPath: string;
    remotePath: string;
    maxBytes: number;
    sha256: string;
  }): Promise<RemoteSftpUploadResult> {
    return this.enqueue(async () => {
      await this.prepare();
      const transferId = validateTransferId(request.transferId);
      const localPath = await this.requireStagedSource(request.localPath);
      const remotePath = validateRemotePath(request.remotePath);
      const maxBytes = validateTransferLimit(request.maxBytes);
      const expectedSha256 = validateSha256(request.sha256);
      const metadata = await lstat(localPath);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size > maxBytes
      ) {
        throw new RemoteSftpError(
          "limit-exceeded",
          "local upload source is not regular or exceeds its transfer bound",
          false
        );
      }
      const actualSha256 = await hashBoundedFile(localPath, maxBytes);
      if (actualSha256 !== expectedSha256) {
        throw new RemoteSftpError(
          "integrity-failed",
          "local upload source digest does not match its request",
          false
        );
      }
      const remoteTempPath = remoteUploadTempPath(remotePath);
      const readbackPath = resolve(
        this.targetRoot,
        `${createHash("sha256").update(transferId).digest("hex")}-${randomUUID()}.readback`
      );
      try {
        await this.runBatch(
          [
            `-mkdir ${quoteSftpPath(posix.dirname(remotePath))}`,
            `put ${quoteSftpPath(localPath)} ${quoteSftpPath(remoteTempPath)}`,
            `get ${quoteSftpPath(remoteTempPath)} ${quoteSftpPath(readbackPath)}`,
            ""
          ].join("\n"),
          DEFAULT_TIMEOUT_MS,
          { monitoredPath: readbackPath, maxBytes }
        );
        const readback = await lstat(readbackPath);
        if (
          !readback.isFile() ||
          readback.isSymbolicLink() ||
          readback.size !== metadata.size ||
          readback.size > maxBytes ||
          (await hashBoundedFile(readbackPath, maxBytes)) !== expectedSha256
        ) {
          throw new RemoteSftpError(
            "integrity-failed",
            "SFTP upload read-back did not preserve byte identity",
            true
          );
        }
        await this.runBatch(
          `rename ${quoteSftpPath(remoteTempPath)} ${quoteSftpPath(remotePath)}\n`,
          30_000
        );
        return {
          transferId,
          remotePath,
          byteLength: readback.size,
          sha256: expectedSha256
        };
      } catch (error) {
        await this.runBatch(
          `rm ${quoteSftpPath(remoteTempPath)}\n`,
          30_000
        ).catch(() => undefined);
        throw normalizeSftpError(error);
      } finally {
        await rm(readbackPath, { force: true }).catch(() => undefined);
      }
    });
  }

  async release(localPath: string): Promise<void> {
    await this.prepare();
    const source = await this.requireStagedSource(localPath);
    await rm(source, { force: true });
  }

  pruneManagedAttachments(request: {
    remoteDirectory: string;
    nowUnixMs: number;
    maxAgeMs: number;
    maxTotalBytes: number;
  }): Promise<RemoteSftpAttachmentPruneResult> {
    return this.enqueue(async () => {
      const remoteDirectory = validateRemotePath(request.remoteDirectory);
      const nowUnixMs = validateNonNegativeInteger(
        request.nowUnixMs,
        "attachment cleanup time"
      );
      const maxAgeMs = validatePositiveInteger(
        request.maxAgeMs,
        "attachment retention",
        365 * 24 * 60 * 60 * 1000
      );
      const maxTotalBytes = validatePositiveInteger(
        request.maxTotalBytes,
        "attachment quota",
        MAX_TRANSFER_BYTES
      );
      const before = await this.listManagedAttachments(remoteDirectory);
      const cutoff = nowUnixMs - maxAgeMs;
      const retained = before.filter(
        (entry) => entry.createdAtUnixMs >= cutoff
      );
      const removals = before.filter((entry) => entry.createdAtUnixMs < cutoff);
      let retainedBytes = retained.reduce((sum, entry) => sum + entry.size, 0);
      if (retainedBytes > maxTotalBytes) {
        for (const entry of [...retained].sort(compareManagedAttachments)) {
          if (retainedBytes <= maxTotalBytes) break;
          removals.push(entry);
          retainedBytes -= entry.size;
        }
      }
      if (removals.length > 0) {
        await this.removeManagedAttachments(
          remoteDirectory,
          removals.map((entry) => entry.name)
        );
      }
      const after = await this.listManagedAttachments(remoteDirectory);
      const remainingBytes = after.reduce((sum, entry) => sum + entry.size, 0);
      if (remainingBytes > maxTotalBytes) {
        throw new RemoteSftpError(
          "limit-exceeded",
          "remote attachment quota could not be reclaimed",
          true
        );
      }
      const remainingNames = new Set(after.map((entry) => entry.name));
      const deleted = before.filter((entry) => !remainingNames.has(entry.name));
      return {
        deletedCount: deleted.length,
        deletedBytes: deleted.reduce((sum, entry) => sum + entry.size, 0),
        remainingBytes
      };
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closeController.abort();
    for (const wake of this.waiters.splice(0)) wake(false);
    await Promise.all([...this.children].map((child) => terminateChild(child)));
    if (this.activeTransfers > 0) {
      await new Promise<void>((resolveIdle) =>
        this.idleWaiters.push(resolveIdle)
      );
    }
    await this.prepared?.catch(() => undefined);
    await rm(this.targetRoot, { recursive: true, force: true }).catch(
      () => undefined
    );
  }

  private async enqueue<T>(task: () => Promise<T>): Promise<T> {
    await this.acquireTransferSlot();
    try {
      return await task();
    } finally {
      this.releaseTransferSlot();
    }
  }

  private async acquireTransferSlot(): Promise<void> {
    if (this.closed) {
      throw new RemoteSftpError("unavailable", "SFTP provider is closed", true);
    }
    if (this.activeTransfers < MAX_CONCURRENT_TRANSFERS) {
      this.activeTransfers += 1;
      return;
    }
    if (this.waiters.length >= MAX_QUEUED_TRANSFERS) {
      throw new RemoteSftpError(
        "limit-exceeded",
        "SFTP transfer queue is full",
        true
      );
    }
    const granted = await new Promise<boolean>((resolveWaiter) =>
      this.waiters.push(resolveWaiter)
    );
    if (!granted || this.closed) {
      if (granted) this.releaseTransferSlot();
      throw new RemoteSftpError(
        "unavailable",
        "SFTP provider closed while the transfer was queued",
        true
      );
    }
    // The finishing transfer handed its occupied slot directly to this waiter.
  }

  private releaseTransferSlot(): void {
    const wake = this.waiters.shift();
    if (wake && !this.closed) {
      wake(true);
      return;
    }
    this.activeTransfers -= 1;
    if (this.activeTransfers === 0) {
      for (const resolveIdle of this.idleWaiters.splice(0)) resolveIdle();
    }
  }

  private prepare(): Promise<void> {
    this.prepared ??= (async () => {
      await mkdir(this.options.transferRoot, { recursive: true, mode: 0o700 });
      await mkdir(this.targetRoot, { recursive: true, mode: 0o700 });
      await assertPrivateDirectory(this.options.transferRoot);
      await assertPrivateDirectory(this.targetRoot);
      this.canonicalTransferRoot = await realpath(this.options.transferRoot);
    })();
    return this.prepared;
  }

  private async requireStagedSource(candidate: string): Promise<string> {
    if (typeof candidate !== "string" || candidate.includes("\0")) {
      throw new RemoteSftpError(
        "invalid-request",
        "local SFTP staging path is invalid",
        false
      );
    }
    const resolvedCandidate = resolve(candidate);
    const resolvedRoot = resolve(this.options.transferRoot);
    if (
      resolvedCandidate === resolvedRoot ||
      !resolvedCandidate.startsWith(`${resolvedRoot}/`)
    ) {
      throw new RemoteSftpError(
        "invalid-request",
        "local SFTP source is outside its private transfer root",
        false
      );
    }
    const metadata = await lstat(resolvedCandidate);
    if (metadata.isSymbolicLink()) {
      throw new RemoteSftpError(
        "invalid-request",
        "local SFTP source traverses a symbolic link",
        false
      );
    }
    const canonical = await realpath(resolvedCandidate);
    const canonicalRoot =
      this.canonicalTransferRoot ?? (await realpath(resolvedRoot));
    const relativeSuffix = resolvedCandidate.slice(resolvedRoot.length + 1);
    if (
      canonical !== resolve(canonicalRoot, relativeSuffix) ||
      canonical === canonicalRoot ||
      !canonical.startsWith(`${canonicalRoot}/`)
    ) {
      throw new RemoteSftpError(
        "invalid-request",
        "local SFTP source escapes or aliases its private transfer root",
        false
      );
    }
    return canonical;
  }

  private async remoteRegularFileSize(remotePath: string): Promise<number> {
    let result: BatchResult;
    try {
      result = await this.runBatch(
        `ls -ln ${quoteSftpPath(remotePath)}\n`,
        30_000
      );
    } catch (error) {
      if (isMissingRemotePath(error)) {
        throw new RemoteSftpError(
          "not-found",
          "remote SFTP file does not exist",
          false,
          { cause: error }
        );
      }
      throw error;
    }
    const listing = parseSftpLongListingMetadata(result.stdout);
    if (!listing || listing.kind !== "-") {
      throw new RemoteSftpError(
        "not-regular",
        "remote SFTP path is not a regular file with bounded metadata",
        false
      );
    }
    const size = listing.size;
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_TRANSFER_BYTES) {
      throw new RemoteSftpError(
        "limit-exceeded",
        "remote SFTP file size is outside the supported bound",
        false
      );
    }
    return size;
  }

  private async listManagedAttachments(
    remoteDirectory: string
  ): Promise<ManagedAttachmentEntry[]> {
    let result: BatchResult;
    try {
      result = await this.runBatch(
        `ls -ln ${quoteSftpPath(remoteDirectory)}\n`,
        30_000
      );
    } catch (error) {
      if (isMissingRemotePath(error)) return [];
      throw error;
    }
    const entries: ManagedAttachmentEntry[] = [];
    for (const rawLine of result.stdout.split(/\r?\n/u)) {
      const metadata = parseSftpLongListingMetadata(rawLine);
      if (!metadata || metadata.kind !== "-") continue;
      const name = parseManagedAttachmentName(rawLine);
      if (!name) continue;
      entries.push({
        name: name.value,
        size: metadata.size,
        createdAtUnixMs: name.createdAtUnixMs
      });
      if (entries.length > MAX_MANAGED_ATTACHMENT_ENTRIES) {
        throw new RemoteSftpError(
          "limit-exceeded",
          "remote attachment directory exceeds its entry bound",
          true
        );
      }
    }
    return entries;
  }

  private async removeManagedAttachments(
    remoteDirectory: string,
    names: string[]
  ): Promise<void> {
    const prefix = `cd ${quoteSftpPath(remoteDirectory)}\n`;
    let batch = prefix;
    for (const name of names) {
      const command = `-rm ${quoteSftpPath(name)}\n`;
      if (Buffer.byteLength(batch + command, "utf8") > MAX_SFTP_BATCH_BYTES) {
        await this.runBatch(batch, 30_000);
        batch = prefix;
      }
      batch += command;
    }
    if (batch !== prefix) {
      await this.runBatch(batch, 30_000);
    }
  }

  private async pruneStaging(reservedBytes: number): Promise<void> {
    await this.prepare();
    const entries: StagedEntry[] = [];
    let directoryEntries = 0;
    for await (const entry of await opendir(this.targetRoot)) {
      directoryEntries += 1;
      if (directoryEntries > MAX_STAGING_DIRECTORY_ENTRIES) {
        throw new RemoteSftpError(
          "limit-exceeded",
          "private SFTP staging directory exceeds its entry bound",
          true
        );
      }
      const path = resolve(this.targetRoot, entry.name);
      const metadata = await lstat(path).catch(() => null);
      if (!metadata?.isFile() || metadata.isSymbolicLink()) continue;
      entries.push({ path, size: metadata.size, mtimeMs: metadata.mtimeMs });
    }
    entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    let count = entries.length;
    for (const entry of entries) {
      const expired = this.now() - entry.mtimeMs > STAGED_RETENTION_MS;
      const overCount = count >= MAX_STAGED_FILES;
      const overBytes = total + reservedBytes > MAX_STAGED_BYTES;
      if (!expired && !overCount && !overBytes) break;
      await rm(entry.path, { force: true });
      total -= entry.size;
      count -= 1;
    }
    if (count >= MAX_STAGED_FILES || total + reservedBytes > MAX_STAGED_BYTES) {
      throw new RemoteSftpError(
        "limit-exceeded",
        "private SFTP staging quota is full",
        true
      );
    }
  }

  private async runBatch(
    batch: string,
    timeoutMs: number,
    monitor?: { monitoredPath: string; maxBytes: number }
  ): Promise<BatchResult> {
    if (
      Buffer.byteLength(batch, "utf8") > MAX_SFTP_BATCH_BYTES ||
      batch.includes("\0")
    ) {
      throw new RemoteSftpError(
        "invalid-request",
        "SFTP batch is invalid or oversized",
        false
      );
    }
    const assigned = this.options.assigned;
    const master = assigned.master;
    const child = await spawnMuxOnlyChannel(
      {
        kind: "sftp",
        sshPath: master.sshPath,
        ...(this.options.sftpPath === undefined
          ? {}
          : { sftpPath: this.options.sftpPath }),
        configPath: master.configPath,
        controlPath: master.controlPath,
        host: master.host,
        masterGeneration: assigned.generation,
        batchMode: true
      },
      {
        isCurrentGeneration: (generation) =>
          this.options.pool.isCurrentGeneration(assigned.targetId, generation)
      }
    );
    this.children.add(child);
    if (this.closed) {
      await terminateChild(child);
      this.children.delete(child);
      throw new RemoteSftpError(
        "unavailable",
        "SFTP provider closed while opening a transfer channel",
        true
      );
    }
    try {
      return await collectBatch(
        child,
        batch,
        timeoutMs,
        monitor,
        this.closeController.signal
      );
    } finally {
      this.children.delete(child);
    }
  }
}

async function collectBatch(
  child: ChildProcess,
  batch: string,
  timeoutMs: number,
  monitor: { monitoredPath: string; maxBytes: number } | undefined,
  closeSignal: AbortSignal
): Promise<BatchResult> {
  return await new Promise<BatchResult>((resolveBatch, rejectBatch) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let terminationError: Error | undefined;
    const stopWatchers = (): void => {
      clearTimeout(timeout);
      if (monitorTimer) clearInterval(monitorTimer);
      closeSignal.removeEventListener("abort", handleClose);
    };
    const finish = (error?: Error, result?: BatchResult): void => {
      if (settled) return;
      settled = true;
      stopWatchers();
      if (error) rejectBatch(error);
      else resolveBatch(result!);
    };
    const terminateAndFinish = (error: Error): void => {
      if (settled || terminationError) return;
      terminationError = error;
      stopWatchers();
      void terminateChild(child).finally(() => finish(error));
    };
    const collect = (target: Buffer[], chunk: Buffer): void => {
      if (settled || terminationError) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_SFTP_OUTPUT_BYTES) {
        terminateAndFinish(
          new RemoteSftpError(
            "limit-exceeded",
            "SFTP diagnostics exceeded their output bound",
            true
          )
        );
        return;
      }
      target.push(Buffer.from(chunk));
    };
    const timeout = setTimeout(() => {
      terminateAndFinish(
        new RemoteSftpError(
          "unavailable",
          `SFTP request exceeded ${timeoutMs} ms`,
          true,
          { stderr: Buffer.concat(stderr).toString("utf8") }
        )
      );
    }, timeoutMs);
    timeout.unref();
    const monitorTimer = monitor
      ? setInterval(() => {
          void lstat(monitor.monitoredPath)
            .then((metadata) => {
              if (settled || terminationError) {
                return;
              }
              if (
                metadata.isFile() &&
                !metadata.isSymbolicLink() &&
                metadata.size <= monitor.maxBytes
              ) {
                return;
              }
              terminateAndFinish(
                new RemoteSftpError(
                  "limit-exceeded",
                  "SFTP transfer exceeded its byte bound",
                  false,
                  { stderr: Buffer.concat(stderr).toString("utf8") }
                )
              );
            })
            .catch(() => undefined);
        }, 10)
      : undefined;
    monitorTimer?.unref();

    child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
    // SFTP may reject the batch and close before stdin is fully flushed. Its
    // close status is authoritative; do not let the expected EPIPE escape the
    // isolated provider process as an uncaught stream error.
    child.stdin?.on("error", () => undefined);
    child.once("error", (error) =>
      terminateAndFinish(
        terminationError ??
          new RemoteSftpError("unavailable", "SFTP subprocess failed", true, {
            cause: error
          })
      )
    );
    child.once("close", (exitCode, signal) => {
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (terminationError) {
        finish(terminationError);
        return;
      }
      if (exitCode !== 0) {
        finish(
          new RemoteSftpError(
            "unavailable",
            `SFTP subprocess exited with ${exitCode ?? signal ?? "unknown"}`,
            true,
            { stderr: stderrText }
          )
        );
        return;
      }
      finish(undefined, {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: stderrText
      });
    });
    function handleClose(): void {
      terminateAndFinish(
        new RemoteSftpError(
          "unavailable",
          "SFTP provider closed during a transfer",
          true,
          { stderr: Buffer.concat(stderr).toString("utf8") }
        )
      );
    }
    closeSignal.addEventListener("abort", handleClose, { once: true });
    if (closeSignal.aborted) {
      handleClose();
      return;
    }
    child.stdin?.end(batch);
  });
}

export function parseSftpLongListingMetadata(
  output: string
): { kind: string; size: number } | null {
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const match = line.match(
      /^([bcdlps-])[rwxStTs-]{9}[+@.]?\s+(?:\d+|\?)\s+\S+\s+\S+\s+(\d+)\s/u
    );
    if (!match) continue;
    const size = Number(match[2]);
    return Number.isSafeInteger(size) && size >= 0
      ? { kind: match[1], size }
      : null;
  }
  return null;
}

function parseManagedAttachmentName(
  listingLine: string
): { value: string; createdAtUnixMs: number } | null {
  const token = listingLine.trim().split(/\s+/u).at(-1);
  if (!token) return null;
  const value = posix.basename(token);
  const current = value.match(
    new RegExp(
      `^${REMOTE_ATTACHMENT_FILE_PREFIX}(\\d{1,16})-[a-f0-9]{32}(?:\\.[a-z0-9]{1,10})?$`,
      "u"
    )
  );
  if (current) {
    const createdAtUnixMs = Number(current[1]);
    return Number.isSafeInteger(createdAtUnixMs)
      ? { value, createdAtUnixMs }
      : null;
  }
  // Files from the pre-v1 development build had no timestamp. They live in
  // this app-owned directory and are reclaimed as legacy entries once seen.
  return /^(?=(?:[^-]*-){2})[A-Za-z0-9_-]{3,255}(?:\.[a-z0-9]{1,10})?$/u.test(
    value
  )
    ? { value, createdAtUnixMs: 0 }
    : null;
}

function compareManagedAttachments(
  left: ManagedAttachmentEntry,
  right: ManagedAttachmentEntry
): number {
  return (
    left.createdAtUnixMs - right.createdAtUnixMs ||
    left.name.localeCompare(right.name)
  );
}

function terminateChild(child: ChildProcess): Promise<void> {
  const existing = childTerminations.get(child);
  if (existing) return existing;
  const termination = new Promise<void>((resolveTermination) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveTermination();
      return;
    }
    let settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let finalTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (forceTimer) clearTimeout(forceTimer);
      if (finalTimer) clearTimeout(finalTimer);
      child.removeListener("close", finish);
      resolveTermination();
    };
    child.once("close", finish);
    child.kill("SIGTERM");
    forceTimer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      finalTimer = setTimeout(finish, TERMINATION_FINAL_WAIT_MS);
      finalTimer.unref();
    }, TERMINATION_GRACE_MS);
    forceTimer.unref();
  });
  childTerminations.set(child, termination);
  return termination;
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  const uid = process.getuid?.();
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    (uid !== undefined && metadata.uid !== uid)
  ) {
    throw new RemoteSftpError(
      "invalid-request",
      "SFTP transfer root must be a private owned real directory",
      false
    );
  }
}

async function hashBoundedFile(path: string, maximum: number): Promise<string> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maximum) {
      throw new RemoteSftpError(
        "limit-exceeded",
        "staged SFTP file grew beyond its byte bound",
        false
      );
    }
    hash.update(buffer);
  }
  return hash.digest("hex");
}

function validateRemotePath(value: string): string {
  if (
    typeof value !== "string" ||
    !posix.isAbsolute(value) ||
    /[\0\r\n]/u.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_REMOTE_PATH_BYTES
  ) {
    throw new RemoteSftpError(
      "invalid-request",
      "remote SFTP path must be absolute, bounded, and newline-free",
      false
    );
  }
  return posix.normalize(value);
}

function localStageExtension(remotePath: string): string {
  const extension = posix.extname(posix.basename(remotePath));
  return /^\.[A-Za-z0-9]{1,16}$/u.test(extension) ? extension : ".stage";
}

function validateTransferLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TRANSFER_BYTES) {
    throw new RemoteSftpError(
      "invalid-request",
      "SFTP transfer limit is outside 1..1GiB",
      false
    );
  }
  return value;
}

function validateNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RemoteSftpError(
      "invalid-request",
      `${field} must be a non-negative safe integer`,
      false
    );
  }
  return value;
}

function validatePositiveInteger(
  value: number,
  field: string,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RemoteSftpError(
      "invalid-request",
      `${field} is outside its supported bound`,
      false
    );
  }
  return value;
}

function validateTransferId(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new RemoteSftpError(
      "invalid-request",
      "SFTP transfer ID is invalid",
      false
    );
  }
  return value;
}

function validateSha256(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new RemoteSftpError(
      "invalid-request",
      "SFTP transfer digest must be SHA-256",
      false
    );
  }
  return value;
}

function quoteSftpPath(value: string): string {
  if (/[\0\r\n]/u.test(value)) {
    throw new RemoteSftpError(
      "invalid-request",
      "SFTP path contains a command separator",
      false
    );
  }
  // OpenSSH makeargv() protects glob metacharacters that appear inside a
  // quoted argument and removes that protection again for non-glob paths.
  // Pre-escaping those characters here would leave literal backslashes in
  // put/rename destinations; only quote the batch parser's own delimiters.
  return `"${value.replace(/[\\"]/gu, (character) => `\\${character}`)}"`;
}

function remoteUploadTempPath(remotePath: string): string {
  const directory = posix.dirname(remotePath);
  return posix.join(
    directory,
    `.kmux-upload-${createHash("sha256")
      .update(remotePath, "utf8")
      .digest("hex")
      .slice(0, 24)}-${randomUUID()}`
  );
}

function normalizeSftpError(error: unknown): RemoteSftpError {
  return error instanceof RemoteSftpError
    ? error
    : new RemoteSftpError(
        "unavailable",
        error instanceof Error ? error.message : String(error),
        true,
        { cause: error }
      );
}

function isMissingRemotePath(error: unknown): boolean {
  return (
    error instanceof RemoteSftpError &&
    /no such file|not found|couldn't stat remote file/iu.test(error.stderr)
  );
}
