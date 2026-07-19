import {
  decodeLocalPath,
  decodeRemotePath,
  localLocatedPath,
  remoteLocatedPath,
  type LocalPath,
  type RemotePath
} from "@kmux/core";

import type { TargetServiceSet } from "./contracts";
import {
  createLocalPathResolver,
  createTargetServiceRegistry,
  selectTargetPath,
  type RemotePathResolver
} from "./targetServiceRegistry";

describe("TargetServiceRegistry", () => {
  it("resolves local services without calling the SSH factory", () => {
    const local = services<LocalPath>("local");
    const remote = vi.fn(() => services<RemotePath>("remote"));
    const registry = createTargetServiceRegistry({ local, remote });

    expect(registry.resolve({ kind: "local" })).toEqual({
      target: { kind: "local" },
      services: local
    });
    expect(remote).not.toHaveBeenCalled();
  });

  it("re-resolves each verified SSH target without local fallback or stale binding cache", () => {
    const targetOne = services<RemotePath>("target-one");
    const targetOneReverified = services<RemotePath>("target-one-reverified");
    let currentTargetOne = targetOne;
    const remote = vi.fn((targetId: string) =>
      targetId === "target_1" ? currentTargetOne : undefined
    );
    const registry = createTargetServiceRegistry({
      local: services<LocalPath>("local"),
      remote
    });

    const first = registry.resolve({ kind: "ssh", targetId: "target_1" });
    currentTargetOne = targetOneReverified;
    const second = registry.resolve({ kind: "ssh", targetId: "target_1" });
    expect(first.services).toBe(targetOne);
    expect(second.services).toBe(targetOneReverified);
    expect(remote).toHaveBeenCalledTimes(2);
    expect(() =>
      registry.resolve({ kind: "ssh", targetId: "missing" })
    ).toThrow(/unavailable/);
  });

  it("rejects local/remote and cross-target path leakage before provider entry", () => {
    let resolveRemotePath: RemotePathResolver | undefined;
    const registry = createTargetServiceRegistry({
      local: services<LocalPath>("local"),
      remote: (_targetId, resolver) => {
        resolveRemotePath = resolver;
        return services<RemotePath>("remote");
      }
    });
    const local = registry.resolve({ kind: "local" });
    const targetOne = registry.resolve({ kind: "ssh", targetId: "target_1" });
    const localPath = localLocatedPath(decodeLocalPath("/tmp/local"));
    const targetOnePath = remoteLocatedPath(
      "target_1",
      decodeRemotePath("/srv/one")
    );
    const targetTwoPath = remoteLocatedPath(
      "target_2",
      decodeRemotePath("/srv/two")
    );

    expect(selectTargetPath(local, localPath)).toBe(localPath.path);
    expect(selectTargetPath(targetOne, targetOnePath)).toBe(targetOnePath.path);
    expect(() => selectTargetPath(local, targetOnePath)).toThrow(/SSH path/);
    expect(() => selectTargetPath(targetOne, localPath)).toThrow(/bound SSH/);
    expect(() => selectTargetPath(targetOne, targetTwoPath)).toThrow(
      /bound SSH/
    );
    expect(() => remoteLocatedPath("target_2", targetOnePath.path)).toThrow(
      /another target/
    );
    expect(() => createLocalPathResolver()(targetOnePath)).toThrow(/SSH path/);
    expect(() =>
      createLocalPathResolver()({
        kind: "local",
        path: targetOnePath.path
      } as never)
    ).toThrow(/LocalPath/);
    expect(resolveRemotePath?.(targetOnePath.path)).toBe("/srv/one");
    expect(() => resolveRemotePath?.(targetTwoPath.path)).toThrow(
      /bound SSH target/
    );
    expect(() => resolveRemotePath?.(decodeRemotePath("/srv/unbound"))).toThrow(
      /bound SSH target/
    );
    expect(() => resolveRemotePath?.(localPath.path as never)).toThrow(
      /RemotePath/
    );
  });
});

function services<TPath extends LocalPath | RemotePath>(
  label: string
): TargetServiceSet<TPath> {
  return {
    terminal: {
      create: vi.fn(),
      terminate: vi.fn(),
      sendText: vi.fn(),
      sendKey: vi.fn()
    },
    git: {
      inspect: vi.fn(async () => ({
        branch: label,
        dirtyEntries: [],
        dirtyEntriesTruncated: false
      })),
      managedWorktreeRoot: vi.fn(() => undefined as unknown as TPath),
      createWorktree: vi.fn(),
      removeWorktree: vi.fn()
    },
    files: {
      exists: vi.fn(),
      read: vi.fn(),
      join: vi.fn((base: TPath) => base),
      dirname: vi.fn((value: TPath) => value),
      basename: vi.fn(() => label),
      display: vi.fn(() => label),
      resolveTerminalPath: vi.fn(async () => null),
      stageForLocalOpen: vi.fn(async () => ({
        localPath: decodeLocalPath("/tmp/staged"),
        byteLength: 0,
        sha256: "0".repeat(64)
      }))
    },
    metadata: { refresh: vi.fn() },
    history: { refresh: vi.fn() },
    usage: {
      refresh: vi.fn(async () => ({ records: [], truncated: false }))
    },
    ports: {
      list: vi.fn(),
      remapBrowserUrl: vi.fn(async ({ url }: { url: URL }) => ({ url })),
      closeWorkspace: vi.fn()
    },
    attachments: {
      store: vi.fn(async () => ({
        path: undefined as unknown as TPath,
        terminalReference: label
      }))
    }
  };
}
