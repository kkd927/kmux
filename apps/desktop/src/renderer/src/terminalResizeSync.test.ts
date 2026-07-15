import { describe, expect, it, vi } from "vitest";

import { createTerminalResizeSync } from "./terminalResizeSync";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

describe("terminal resize sync", () => {
  it("sends the first resize immediately and only the latest pending resize after ack", async () => {
    const first = deferred();
    const latest = deferred();
    const sendResize = vi
      .fn<
        (
          surfaceId: string,
          attachId: string | null,
          cols: number,
          rows: number,
          gestureActive: boolean,
          generation: number,
          trigger?: string
        ) => Promise<void>
      >()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(latest.promise);
    const sync = createTerminalResizeSync({ sendResize });

    const firstResult = sync.request({
      surfaceId: "surface_1",
      attachId: "attach_1",
      generation: 1,
      cols: 100,
      rows: 30,
      gestureActive: false
    });
    const supersededResult = sync.request({
      surfaceId: "surface_1",
      attachId: "attach_1",
      generation: 2,
      cols: 110,
      rows: 35,
      gestureActive: false
    });
    const latestResult = sync.request({
      surfaceId: "surface_1",
      attachId: "attach_1",
      generation: 3,
      cols: 120,
      rows: 40,
      gestureActive: false
    });

    expect(sendResize).toHaveBeenCalledTimes(1);
    expect(sendResize).toHaveBeenNthCalledWith(
      1,
      "surface_1",
      "attach_1",
      100,
      30,
      false,
      1,
      undefined
    );
    await expect(supersededResult).resolves.toEqual(
      expect.objectContaining({
        status: "superseded",
        surfaceId: "surface_1",
        generation: 2,
        cols: 110,
        rows: 35
      })
    );

    first.resolve();
    await expect(firstResult).resolves.toEqual(
      expect.objectContaining({
        status: "synced",
        generation: 1,
        cols: 100,
        rows: 30
      })
    );
    expect(sendResize).toHaveBeenCalledTimes(2);
    expect(sendResize).toHaveBeenNthCalledWith(
      2,
      "surface_1",
      "attach_1",
      120,
      40,
      false,
      3,
      undefined
    );

    latest.resolve();
    await expect(latestResult).resolves.toEqual(
      expect.objectContaining({
        status: "synced",
        generation: 3,
        cols: 120,
        rows: 40
      })
    );
  });

  it("reports failed remote resizes without losing a newer pending resize", async () => {
    const first = deferred();
    const latest = deferred();
    const sendResize = vi
      .fn<
        (
          surfaceId: string,
          attachId: string | null,
          cols: number,
          rows: number,
          gestureActive: boolean,
          generation: number,
          trigger?: string
        ) => Promise<void>
      >()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(latest.promise);
    const sync = createTerminalResizeSync({ sendResize });

    const failedResult = sync.request({
      surfaceId: "surface_1",
      attachId: "attach_1",
      generation: 1,
      cols: 100,
      rows: 30,
      gestureActive: false
    });
    const latestResult = sync.request({
      surfaceId: "surface_1",
      attachId: "attach_1",
      generation: 2,
      cols: 120,
      rows: 40,
      gestureActive: false
    });

    first.reject(new Error("remote resize failed"));
    await expect(failedResult).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        generation: 1,
        cols: 100,
        rows: 30
      })
    );
    expect(sendResize).toHaveBeenCalledTimes(2);
    expect(sendResize).toHaveBeenNthCalledWith(
      2,
      "surface_1",
      "attach_1",
      120,
      40,
      false,
      2,
      undefined
    );

    latest.resolve();
    await expect(latestResult).resolves.toEqual(
      expect.objectContaining({
        status: "synced",
        generation: 2,
        cols: 120,
        rows: 40
      })
    );
  });

  it("keeps resize queues isolated per surface", async () => {
    const firstSurface = deferred();
    const secondSurface = deferred();
    const latestFirstSurface = deferred();
    const sendResize = vi
      .fn<
        (
          surfaceId: string,
          attachId: string | null,
          cols: number,
          rows: number,
          gestureActive: boolean,
          generation: number,
          trigger?: string
        ) => Promise<void>
      >()
      .mockImplementation((surfaceId) => {
        if (surfaceId === "surface_1" && sendResize.mock.calls.length === 1) {
          return firstSurface.promise;
        }
        if (surfaceId === "surface_2") {
          return secondSurface.promise;
        }
        return latestFirstSurface.promise;
      });
    const sync = createTerminalResizeSync({ sendResize });

    const firstResult = sync.request({
      surfaceId: "surface_1",
      attachId: "attach_1",
      generation: 1,
      cols: 100,
      rows: 30,
      gestureActive: false
    });
    const secondResult = sync.request({
      surfaceId: "surface_2",
      attachId: "attach_2",
      generation: 1,
      cols: 80,
      rows: 24,
      gestureActive: false
    });
    const latestFirstResult = sync.request({
      surfaceId: "surface_1",
      attachId: "attach_1",
      generation: 2,
      cols: 120,
      rows: 40,
      gestureActive: false
    });

    expect(sendResize).toHaveBeenCalledTimes(2);
    expect(sendResize).toHaveBeenNthCalledWith(
      1,
      "surface_1",
      "attach_1",
      100,
      30,
      false,
      1,
      undefined
    );
    expect(sendResize).toHaveBeenNthCalledWith(
      2,
      "surface_2",
      "attach_2",
      80,
      24,
      false,
      1,
      undefined
    );

    secondSurface.resolve();
    await expect(secondResult).resolves.toEqual(
      expect.objectContaining({
        status: "synced",
        surfaceId: "surface_2",
        cols: 80,
        rows: 24
      })
    );
    expect(sendResize).toHaveBeenCalledTimes(2);

    firstSurface.resolve();
    await expect(firstResult).resolves.toEqual(
      expect.objectContaining({
        status: "synced",
        surfaceId: "surface_1",
        cols: 100,
        rows: 30
      })
    );
    expect(sendResize).toHaveBeenCalledTimes(3);
    expect(sendResize).toHaveBeenNthCalledWith(
      3,
      "surface_1",
      "attach_1",
      120,
      40,
      false,
      2,
      undefined
    );

    latestFirstSurface.resolve();
    await expect(latestFirstResult).resolves.toEqual(
      expect.objectContaining({
        status: "synced",
        surfaceId: "surface_1",
        cols: 120,
        rows: 40
      })
    );
  });

  it("does not collapse same-size resizes across different attachments", async () => {
    const first = deferred();
    const second = deferred();
    const sendResize = vi
      .fn<
        (
          surfaceId: string,
          attachId: string | null,
          cols: number,
          rows: number,
          gestureActive: boolean,
          generation: number,
          trigger?: string
        ) => Promise<void>
      >()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const sync = createTerminalResizeSync({ sendResize });

    const firstResult = sync.request({
      surfaceId: "surface_1",
      attachId: "attach_1",
      generation: 1,
      cols: 120,
      rows: 40,
      gestureActive: false
    });
    const secondResult = sync.request({
      surfaceId: "surface_1",
      attachId: "attach_2",
      generation: 2,
      cols: 120,
      rows: 40,
      gestureActive: false
    });

    first.resolve();
    await expect(firstResult).resolves.toEqual(
      expect.objectContaining({
        status: "synced",
        attachId: "attach_1"
      })
    );
    expect(sendResize).toHaveBeenCalledTimes(2);
    expect(sendResize).toHaveBeenNthCalledWith(
      2,
      "surface_1",
      "attach_2",
      120,
      40,
      false,
      2,
      undefined
    );

    second.resolve();
    await expect(secondResult).resolves.toEqual(
      expect.objectContaining({
        status: "synced",
        attachId: "attach_2"
      })
    );
  });

  it("does not collapse a gesture-end release onto an identical held resize", async () => {
    const first = deferred();
    const second = deferred();
    const sendResize = vi
      .fn<
        (
          surfaceId: string,
          attachId: string | null,
          cols: number,
          rows: number,
          gestureActive: boolean,
          generation: number,
          trigger?: string
        ) => Promise<void>
      >()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const sync = createTerminalResizeSync({ sendResize });

    const heldResult = sync.request({
      surfaceId: "surface_1",
      attachId: "attach_1",
      generation: 1,
      cols: 120,
      rows: 40,
      gestureActive: true
    });
    const releaseResult = sync.request({
      surfaceId: "surface_1",
      attachId: "attach_1",
      generation: 2,
      cols: 120,
      rows: 40,
      gestureActive: false
    });

    first.resolve();
    await expect(heldResult).resolves.toEqual(
      expect.objectContaining({ status: "synced", gestureActive: true })
    );
    // The release must actually be sent: it is what commits the held PTY size.
    expect(sendResize).toHaveBeenCalledTimes(2);
    expect(sendResize).toHaveBeenNthCalledWith(
      2,
      "surface_1",
      "attach_1",
      120,
      40,
      false,
      2,
      undefined
    );

    second.resolve();
    await expect(releaseResult).resolves.toEqual(
      expect.objectContaining({ status: "synced", gestureActive: false })
    );
  });
});
