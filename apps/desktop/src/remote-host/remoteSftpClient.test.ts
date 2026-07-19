import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMuxOnlyChannel } = vi.hoisted(() => ({
  spawnMuxOnlyChannel: vi.fn()
}));

vi.mock("./muxOnlyOpenSshChannel", () => ({ spawnMuxOnlyChannel }));

import {
  MuxOnlyRemoteSftpClient,
  RemoteSftpError,
  parseSftpLongListingMetadata
} from "./remoteSftpClient";

const roots: string[] = [];

beforeEach(() => {
  spawnMuxOnlyChannel.mockReset();
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("MuxOnlyRemoteSftpClient", () => {
  it("parses both numeric and name-bearing OpenSSH long listings", () => {
    expect(
      parseSftpLongListingMetadata(
        "-rw-------    ? kmux     kmux        65553 Jul 18  2026 /home/kmux/file"
      )
    ).toEqual({ kind: "-", size: 65_553 });
    expect(
      parseSftpLongListingMetadata(
        "-rw-r--r--    1 1000     1000          42 Jul 18 12:00 /tmp/file"
      )
    ).toEqual({ kind: "-", size: 42 });
    expect(
      parseSftpLongListingMetadata(
        "drwx------    ? kmux     kmux        4096 Jul 18  2026 /home/kmux"
      )
    ).toEqual({ kind: "d", size: 4_096 });
  });

  it("rejects unscoped remote paths before starting an SFTP channel", async () => {
    const client = await createClient();
    await expect(client.exists("relative/path")).rejects.toMatchObject({
      code: "invalid-request"
    });
    expect(spawnMuxOnlyChannel).not.toHaveBeenCalled();
    await client.close();
  });

  it("quotes SFTP paths so OpenSSH preserves glob, quote, and backslash bytes", async () => {
    const child = new FakeChildProcess();
    spawnMuxOnlyChannel.mockResolvedValue(child as unknown as ChildProcess);
    const client = await createClient();
    const exists = client.exists('/remote/[literal]*? "slash\\name".txt');
    await eventually(() => child.input.length > 0);

    expect(child.input).toBe(
      'ls -1 "/remote/[literal]*? \\"slash\\\\name\\".txt"\n'
    );
    child.succeed();
    await expect(exists).resolves.toBe(true);
    await client.close();
  });

  it("caps active and queued transfers and closes every waiter without leaking a slot", async () => {
    const children: FakeChildProcess[] = [];
    spawnMuxOnlyChannel.mockImplementation(async () => {
      const child = new FakeChildProcess();
      children.push(child);
      return child as unknown as ChildProcess;
    });
    const client = await createClient();
    const accepted = Array.from({ length: 68 }, (_, index) =>
      client.exists(`/remote/file-${index}`).catch((error) => error)
    );
    await eventually(() => children.length === 4);

    await expect(client.exists("/remote/overflow")).rejects.toMatchObject({
      code: "limit-exceeded"
    });
    expect(children).toHaveLength(4);

    await client.close();
    const outcomes = await Promise.all(accepted);
    expect(children.every((child) => child.killCount === 1)).toBe(true);
    expect(
      outcomes.every(
        (outcome) =>
          outcome instanceof RemoteSftpError && outcome.code === "unavailable"
      )
    ).toBe(true);
  });

  it("bounds staging-directory enumeration before starting a download", async () => {
    const transferRoot = await mkdtemp(join(tmpdir(), "kmux-sftp-client-"));
    roots.push(transferRoot);
    const targetRoot = join(
      transferRoot,
      createHash("sha256").update("target_1", "utf8").digest("hex")
    );
    await mkdir(targetRoot, { mode: 0o700 });
    for (let index = 0; index < 1_025; index += 1) {
      await mkdir(join(targetRoot, `foreign-${index}`), { mode: 0o700 });
    }
    const child = new FakeChildProcess();
    spawnMuxOnlyChannel.mockResolvedValue(child as unknown as ChildProcess);
    const client = createClientAt(transferRoot);

    const download = client.download({
      transferId: "bounded-directory",
      remotePath: "/remote/file",
      maxBytes: 1_024
    });
    await eventually(() => child.input.length > 0);
    child.stdout.write("-rw------- 1 1000 1000 10 Jul 19 12:00 /remote/file\n");
    child.succeed();

    await expect(download).rejects.toMatchObject({
      code: "limit-exceeded",
      retryable: true
    });
    expect(spawnMuxOnlyChannel).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it("escalates an ignored SIGTERM and waits for subprocess termination", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChildProcess(true);
      spawnMuxOnlyChannel.mockResolvedValue(child as unknown as ChildProcess);
      const client = await createClient();
      const outcome = client.exists("/remote/file").catch((error) => error);
      for (let turn = 0; turn < 20 && child.input.length === 0; turn += 1) {
        await Promise.resolve();
      }
      expect(child.input).not.toBe("");

      const closing = client.close();
      await Promise.resolve();
      expect(child.signals).toEqual(["SIGTERM"]);

      await vi.advanceTimersByTimeAsync(2_500);
      await closing;

      expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
      await expect(outcome).resolves.toMatchObject({
        code: "unavailable",
        retryable: true
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killCount = 0;
  readonly signals: NodeJS.Signals[] = [];
  input = "";

  constructor(private readonly ignoreSigterm = false) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.input += Buffer.from(chunk).toString("utf8");
        callback();
      }
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.signalCode !== null || this.exitCode !== null) return false;
    this.killCount += 1;
    this.signals.push(signal);
    if (this.ignoreSigterm && signal === "SIGTERM") return true;
    this.signalCode = signal;
    queueMicrotask(() => this.emit("close", null, signal));
    return true;
  }

  succeed(): void {
    if (this.signalCode !== null || this.exitCode !== null) return;
    this.exitCode = 0;
    this.emit("close", 0, null);
  }
}

async function createClient(): Promise<MuxOnlyRemoteSftpClient> {
  const transferRoot = await mkdtemp(join(tmpdir(), "kmux-sftp-client-"));
  roots.push(transferRoot);
  return createClientAt(transferRoot);
}

function createClientAt(transferRoot: string): MuxOnlyRemoteSftpClient {
  return new MuxOnlyRemoteSftpClient({
    pool: {
      isCurrentGeneration: () => true
    } as never,
    assigned: {
      targetId: "target_1",
      generation: "master_1",
      effectiveConnectionPolicyHash: "a".repeat(64),
      master: {
        sshPath: "/usr/bin/ssh",
        configPath: "/tmp/ssh-config",
        controlPath: "/tmp/control.sock",
        host: "target-alias",
        generation: "master_1"
      }
    } as never,
    transferRoot
  });
}

async function eventually(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 2_000) {
      throw new Error("condition did not become true");
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 1));
  }
}
