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
      .fn<(surfaceId: string, cols: number, rows: number) => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(latest.promise);
    const sync = createTerminalResizeSync({ sendResize });

    const firstResult = sync.request({
      surfaceId: "surface_1",
      generation: 1,
      cols: 100,
      rows: 30
    });
    const supersededResult = sync.request({
      surfaceId: "surface_1",
      generation: 2,
      cols: 110,
      rows: 35
    });
    const latestResult = sync.request({
      surfaceId: "surface_1",
      generation: 3,
      cols: 120,
      rows: 40
    });

    expect(sendResize).toHaveBeenCalledTimes(1);
    expect(sendResize).toHaveBeenNthCalledWith(1, "surface_1", 100, 30);
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
    expect(sendResize).toHaveBeenNthCalledWith(2, "surface_1", 120, 40);

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
      .fn<(surfaceId: string, cols: number, rows: number) => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(latest.promise);
    const sync = createTerminalResizeSync({ sendResize });

    const failedResult = sync.request({
      surfaceId: "surface_1",
      generation: 1,
      cols: 100,
      rows: 30
    });
    const latestResult = sync.request({
      surfaceId: "surface_1",
      generation: 2,
      cols: 120,
      rows: 40
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
    expect(sendResize).toHaveBeenNthCalledWith(2, "surface_1", 120, 40);

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
      .fn<(surfaceId: string, cols: number, rows: number) => Promise<void>>()
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
      generation: 1,
      cols: 100,
      rows: 30
    });
    const secondResult = sync.request({
      surfaceId: "surface_2",
      generation: 1,
      cols: 80,
      rows: 24
    });
    const latestFirstResult = sync.request({
      surfaceId: "surface_1",
      generation: 2,
      cols: 120,
      rows: 40
    });

    expect(sendResize).toHaveBeenCalledTimes(2);
    expect(sendResize).toHaveBeenNthCalledWith(1, "surface_1", 100, 30);
    expect(sendResize).toHaveBeenNthCalledWith(2, "surface_2", 80, 24);

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
    expect(sendResize).toHaveBeenNthCalledWith(3, "surface_1", 120, 40);

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
});
