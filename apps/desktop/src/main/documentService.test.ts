import { EventEmitter } from "node:events";

import {
  applyAction,
  createInitialState,
  locatedPathForTarget,
  type AppState,
  type LocatedPath
} from "@kmux/core";
import { MAX_MARKDOWN_BYTES, type MarkdownDocumentEvent } from "@kmux/proto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DocumentService, type DocumentEventSender } from "./documentService";
import type {
  FileMetadata,
  LocatedTargetServiceSet,
  TargetServiceRegistry
} from "./targets/contracts";

class FakeSender extends EventEmitter implements DocumentEventSender {
  readonly id = 7;
  readonly events: MarkdownDocumentEvent[] = [];
  destroyed = false;

  isDestroyed(): boolean {
    return this.destroyed;
  }

  send(channel: string, event: MarkdownDocumentEvent): void {
    expect(channel).toBe("kmux:document:event");
    this.events.push(event);
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

describe("DocumentService", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reads a bounded local Markdown snapshot, strips BOM, and refreshes from its watch", async () => {
    const fixture = createMarkdownFixture("local");
    let bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x23, 0x20, 0x48, 0x69]);
    let modifiedAtMs = 1;
    const stat = vi.fn(
      async (): Promise<FileMetadata> => ({
        kind: "file",
        size: bytes.byteLength,
        modifiedAtMs
      })
    );
    const read = vi.fn(async () => bytes);
    let notifyWatch: (() => void) | undefined;
    const stopWatch = vi.fn();
    const service = createService(
      fixture.state,
      { stat, read },
      {
        watchLocal: (_path, onChange) => {
          notifyWatch = onChange;
          return stopWatch;
        }
      }
    );
    const sender = new FakeSender();

    service.subscribe(sender, { surfaceId: fixture.surfaceId });
    await vi.advanceTimersByTimeAsync(0);

    expect(read).toHaveBeenCalledWith(expect.anything(), {
      maxBytes: MAX_MARKDOWN_BYTES
    });
    expect(sender.events).toEqual([
      { type: "loading", surfaceId: fixture.surfaceId, revision: 1 },
      {
        type: "snapshot",
        surfaceId: fixture.surfaceId,
        revision: 2,
        text: "# Hi",
        byteLength: 7
      }
    ]);

    bytes = new TextEncoder().encode("updated");
    modifiedAtMs = 2;
    notifyWatch?.();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1);
    expect(sender.events.at(-1)).toEqual({
      type: "snapshot",
      surfaceId: fixture.surfaceId,
      revision: 4,
      text: "updated",
      byteLength: 7
    });

    service.closeSurface(fixture.surfaceId);
    expect(stopWatch).toHaveBeenCalledOnce();
  });

  it("reports missing, oversized, and invalid UTF-8 files without sending bodies", async () => {
    const fixture = createMarkdownFixture("local");
    const sender = new FakeSender();
    const stat = vi
      .fn<() => Promise<FileMetadata | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ kind: "file", size: MAX_MARKDOWN_BYTES + 1 })
      .mockResolvedValue({ kind: "file", size: 2 });
    const read = vi.fn(async () => new Uint8Array([0xc3, 0x28]));
    const service = createService(fixture.state, { stat, read });

    service.subscribe(sender, { surfaceId: fixture.surfaceId });
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.events.at(-1)).toMatchObject({
      type: "error",
      errorCode: "missing"
    });

    service.subscribe(sender, { surfaceId: fixture.surfaceId });
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.events.at(-1)).toMatchObject({
      type: "error",
      errorCode: "too-large"
    });

    service.subscribe(sender, { surfaceId: fixture.surfaceId });
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.events.at(-1)).toMatchObject({
      type: "error",
      errorCode: "invalid-encoding"
    });
    expect(read).toHaveBeenCalledOnce();
    service.close();
  });

  it("drops stale async completions and cleans subscriptions when the sender is destroyed", async () => {
    const fixture = createMarkdownFixture("local");
    let resolveRead!: (bytes: Uint8Array) => void;
    const read = vi.fn(
      () =>
        new Promise<Uint8Array>((resolve) => {
          resolveRead = resolve;
        })
    );
    const stopWatch = vi.fn();
    const service = createService(
      fixture.state,
      {
        stat: vi.fn(
          async (): Promise<FileMetadata> => ({ kind: "file", size: 3 })
        ),
        read
      },
      { watchLocal: () => stopWatch }
    );
    const sender = new FakeSender();

    service.subscribe(sender, { surfaceId: fixture.surfaceId });
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledOnce();
    sender.destroy();
    resolveRead(new TextEncoder().encode("old"));
    await Promise.resolve();

    expect(sender.events).toHaveLength(1);
    expect(sender.events[0]?.type).toBe("loading");
    expect(stopWatch).toHaveBeenCalledOnce();
  });

  it("polls visible SSH documents, marks transient failures offline, and retries immediately after reconnect", async () => {
    const fixture = createMarkdownFixture("ssh");
    const sender = new FakeSender();
    const stat = vi
      .fn<() => Promise<FileMetadata>>()
      .mockRejectedValueOnce(new Error("target unavailable"))
      .mockResolvedValue({ kind: "file", size: 6 });
    const read = vi.fn(async () => new TextEncoder().encode("remote"));
    const service = createService(fixture.state, { stat, read });

    service.subscribe(sender, { surfaceId: fixture.surfaceId });
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.events.at(-1)).toMatchObject({ type: "offline" });

    service.retryTarget("target_1");
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.events.at(-1)).toMatchObject({
      type: "snapshot",
      text: "remote"
    });
    expect(stat).toHaveBeenCalledTimes(2);
    service.close();
  });

  it("rejects subscriptions from a renderer that does not own the Surface window", () => {
    const fixture = createMarkdownFixture("local");
    const service = createService(
      fixture.state,
      {
        stat: vi.fn(),
        read: vi.fn()
      },
      { ownsWindow: () => false }
    );

    expect(() =>
      service.subscribe(new FakeSender(), { surfaceId: fixture.surfaceId })
    ).toThrow(/not authorized/);
  });
});

function createMarkdownFixture(targetKind: "local" | "ssh"): {
  state: AppState;
  surfaceId: string;
} {
  const state = createInitialState();
  let workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
  if (targetKind === "ssh") {
    applyAction(state, {
      type: "workspace.create",
      target: { kind: "ssh", targetId: "target_1" },
      cwd: "/srv/app"
    });
    workspaceId = state.windows[state.activeWindowId].activeWorkspaceId;
  }
  const workspace = state.workspaces[workspaceId];
  const paneId = workspace.activePaneId;
  applyAction(state, {
    type: "surface.open",
    workspaceId,
    init: {
      kind: "markdown",
      path: locatedPathForTarget(
        workspace.location.target,
        targetKind === "local" ? "/tmp/README.md" : "/srv/app/README.md"
      ),
      title: "README.md"
    },
    placement: { kind: "tab", paneId }
  });
  return { state, surfaceId: state.panes[paneId].activeSurfaceId };
}

function createService(
  state: AppState,
  files: Pick<LocatedTargetServiceSet["files"], "stat" | "read">,
  overrides: {
    watchLocal?: (path: LocatedPath, onChange: () => void) => () => void;
    ownsWindow?: () => boolean;
  } = {}
): DocumentService {
  const targetServices = {
    resolveLocated: () => ({ files }) as LocatedTargetServiceSet
  } as unknown as TargetServiceRegistry;
  return new DocumentService({
    getState: () => state,
    targetServices,
    ownsWindow: overrides.ownsWindow ?? (() => true),
    watchLocal: overrides.watchLocal ?? (() => () => {})
  });
}
