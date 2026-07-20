import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  encodeLocatedPathDto,
  locatedPathForTarget,
  remoteLocatedPath,
  type LocalPath,
  type RemotePath
} from "@kmux/core";
import type { Id } from "@kmux/proto";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RemoteHostManager } from "../remoteHost";
import type { TargetServiceSet } from "./contracts";
import { createRemoteFileProviders } from "./remoteFileProvider";
import { createTargetServiceRegistry } from "./targetServiceRegistry";

const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(
    sandboxes
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("remote file providers", () => {
  it("downloads through target-scoped staging and verifies byte identity", async () => {
    const transferRoot = await sandbox();
    const stageRoot = join(transferRoot, "target");
    await mkdir(stageRoot, { mode: 0o700 });
    const bytes = Buffer.from("remote bytes");
    const stagedPath = join(stageRoot, "download.stage");
    const releaseFile = vi.fn(async (_targetId: string, path: string) => {
      await rm(path, { force: true });
    });
    const host = {
      fileExists: vi.fn(async () => true),
      downloadFile: vi.fn(async () => {
        await writeFile(stagedPath, bytes, { mode: 0o600 });
        return {
          transferId: "transfer_1",
          localPath: stagedPath,
          remotePath: "/home/kmux/file.txt",
          byteLength: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex")
        };
      }),
      uploadFile: vi.fn(),
      releaseFile,
      pruneRemoteAttachments: vi.fn()
    } as unknown as Pick<
      RemoteHostManager,
      | "fileExists"
      | "downloadFile"
      | "uploadFile"
      | "releaseFile"
      | "pruneRemoteAttachments"
    >;
    const provider = providers(host, transferRoot, () => "transfer_1");

    await expect(
      provider.files.read(remotePath("target_1", "/home/kmux/file.txt"), {
        maxBytes: 1024
      })
    ).resolves.toEqual(new Uint8Array(bytes));
    expect(releaseFile).toHaveBeenCalledWith("target_1", stagedPath);
    await expect(readFile(stagedPath)).rejects.toThrow();
  });

  it("rejects a staged local-open copy whose reported digest does not match its bytes", async () => {
    const transferRoot = await sandbox();
    const stageRoot = join(transferRoot, "target");
    await mkdir(stageRoot, { mode: 0o700 });
    const stagedPath = join(stageRoot, "download.md");
    const bytes = Buffer.from("changed remote bytes");
    const releaseFile = vi.fn(async (_targetId: string, path: string) => {
      await rm(path, { force: true });
    });
    const host = {
      fileExists: vi.fn(async () => true),
      downloadFile: vi.fn(async () => {
        await writeFile(stagedPath, bytes, { mode: 0o600 });
        return {
          transferId: "transfer_open",
          localPath: stagedPath,
          remotePath: "/home/kmux/file.md",
          byteLength: bytes.byteLength,
          sha256: "0".repeat(64)
        };
      }),
      uploadFile: vi.fn(),
      releaseFile,
      pruneRemoteAttachments: vi.fn()
    } as unknown as Pick<
      RemoteHostManager,
      | "fileExists"
      | "downloadFile"
      | "uploadFile"
      | "releaseFile"
      | "pruneRemoteAttachments"
    >;
    const provider = providers(host, transferRoot, () => "transfer_open");

    await expect(
      provider.files.stageForLocalOpen(
        remotePath("target_1", "/home/kmux/file.md"),
        { maxBytes: 1_024 }
      )
    ).rejects.toThrow(/byte-identity/u);
    expect(releaseFile).toHaveBeenCalledWith("target_1", stagedPath);
    await expect(readFile(stagedPath)).rejects.toThrow();
  });

  it("resolves POSIX terminal paths remotely and never accepts another target's path", async () => {
    const transferRoot = await sandbox();
    const fileExists = vi.fn(async (_targetId: string, path: string) =>
      path.endsWith("/src/main.ts")
    );
    const host = {
      fileExists,
      downloadFile: vi.fn(),
      uploadFile: vi.fn(),
      releaseFile: vi.fn(),
      pruneRemoteAttachments: vi.fn()
    } as unknown as Pick<
      RemoteHostManager,
      | "fileExists"
      | "downloadFile"
      | "uploadFile"
      | "releaseFile"
      | "pruneRemoteAttachments"
    >;
    const provider = providers(host, transferRoot, () => "transfer_2");

    await expect(
      provider.files.resolveTerminalPath({
        cwd: remotePath("target_1", "/work/repo"),
        rawPath: "src/main.ts:42:3"
      })
    ).resolves.toMatchObject({ displayPath: "/work/repo/src/main.ts" });
    expect(fileExists).toHaveBeenLastCalledWith(
      "target_1",
      "/work/repo/src/main.ts"
    );
    await expect(
      provider.files.exists(remotePath("target_2", "/work/repo/src/main.ts"))
    ).rejects.toThrow(/target/u);
  });

  it("stages bounded attachment bytes locally, uploads them by SFTP, and returns only the remote path", async () => {
    const transferRoot = await sandbox();
    let uploadedBytes = Buffer.alloc(0);
    const uploadFile = vi.fn(
      async (request: Parameters<RemoteHostManager["uploadFile"]>[0]) => {
        uploadedBytes = await readFile(request.localPath);
        return {
          transferId: request.transferId,
          remotePath: request.remotePath,
          byteLength: uploadedBytes.byteLength,
          sha256: request.sha256
        };
      }
    );
    const host = {
      fileExists: vi.fn(),
      downloadFile: vi.fn(),
      uploadFile,
      releaseFile: vi.fn(),
      pruneRemoteAttachments: vi.fn(async () => ({
        deletedCount: 0,
        deletedBytes: 0,
        remainingBytes: 0
      }))
    } as unknown as Pick<
      RemoteHostManager,
      | "fileExists"
      | "downloadFile"
      | "uploadFile"
      | "releaseFile"
      | "pruneRemoteAttachments"
    >;
    const provider = providers(
      host,
      transferRoot,
      () => "transfer_3",
      () => 1_721_430_000_000
    );
    const bytes = new TextEncoder().encode("image payload");

    const stored = await provider.attachments.store({
      workspaceId: "workspace_1",
      sessionId: "session_1",
      cwd: remotePath("target_1", "/work/repo"),
      bytes,
      name: "screen shot.PNG"
    });

    expect(uploadedBytes).toEqual(Buffer.from(bytes));
    expect(uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: "target_1",
        remotePath: expect.stringMatching(
          /^\/home\/kmux\/\.local\/state\/kmux\/attachments\/kmux-attachment-v1-1721430000000-[a-f0-9]{32}\.png$/u
        )
      })
    );
    expect(host.pruneRemoteAttachments).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: "target_1",
        remoteDirectory: "/home/kmux/.local/state/kmux/attachments",
        nowUnixMs: 1_721_430_000_000
      })
    );
    expect(rawRemote("target_1", stored.path)).toBe(stored.terminalReference);
    expect(stored.terminalReference).toBe(rawRemote("target_1", stored.path));
  });
});

function providers(
  host: Pick<
    RemoteHostManager,
    | "fileExists"
    | "downloadFile"
    | "uploadFile"
    | "releaseFile"
    | "pruneRemoteAttachments"
  >,
  transferRoot: string,
  createTransferId: () => Id,
  now?: () => number
): TargetServiceSet<RemotePath> {
  const registry = createTargetServiceRegistry({
    local: {} as TargetServiceSet<LocalPath>,
    remote: (targetId, resolveRemotePath, decodeRemotePath) =>
      createRemoteFileProviders({
        host,
        targetId,
        transferRoot,
        remoteStateRoot: "/home/kmux/.local/state/kmux",
        remoteHomeDir: "/home/kmux",
        resolveRemotePath,
        decodeRemotePath,
        createTransferId,
        ...(now === undefined ? {} : { now })
      }) as TargetServiceSet<RemotePath>
  });
  const resolved = registry.resolve({ kind: "ssh", targetId: "target_1" });
  if (resolved.target.kind !== "ssh") throw new Error("expected SSH services");
  return resolved.services as TargetServiceSet<RemotePath>;
}

function remotePath(targetId: string, value: string): RemotePath {
  const located = locatedPathForTarget({ kind: "ssh", targetId }, value);
  if (located.kind !== "ssh") throw new Error("expected an SSH path");
  return located.path;
}

function rawRemote(targetId: string, path: RemotePath): string {
  return encodeLocatedPathDto(remoteLocatedPath(targetId, path)).path;
}

async function sandbox(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "kmux-remote-files-"));
  sandboxes.push(path);
  return path;
}
