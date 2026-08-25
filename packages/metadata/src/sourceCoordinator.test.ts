import { describe, expect, it, vi } from "vitest";

import { createMetadataSourceCoordinator } from "./sourceCoordinator";

describe("metadata source coordinator", () => {
  it("shares inventory, reads, and watcher lifecycle across projections", async () => {
    const inventory = vi.fn(async () => ["source"]);
    const read = vi.fn(async () => "bytes");
    const close = vi.fn();
    const stopWatch = vi.fn();
    let emit: ((sourceId?: string) => void) | undefined;
    const watch = vi.fn((listener: (sourceId?: string) => void) => {
      emit = listener;
      return stopWatch;
    });
    const create = vi.fn(() => ({
      inventory,
      read,
      watch,
      close
    }));
    const coordinator = createMetadataSourceCoordinator<string[], string>();
    const key = {
      targetAuthority: "ssh:host-key",
      principal: "uid:1000",
      agentId: "fixture",
      sourceDefinitionRevision: "1",
      rootSettingsRevision: "1"
    };
    const [history, usage] = await Promise.all([
      coordinator.acquire(key, create),
      coordinator.acquire(key, create)
    ]);
    expect(watch).not.toHaveBeenCalled();
    const historyChanged = vi.fn();
    const usageChanged = vi.fn();
    const unwatchHistory = history.watch(historyChanged);
    const unwatchUsage = usage.watch(usageChanged);
    expect(watch).toHaveBeenCalledTimes(1);
    await Promise.all([history.inventory(), usage.inventory()]);
    await Promise.all([history.read("source"), usage.read("source")]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(stopWatch).not.toHaveBeenCalled();
    expect(inventory).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    emit?.("source");
    expect(historyChanged).toHaveBeenCalledWith("source");
    expect(usageChanged).toHaveBeenCalledWith("source");
    await usage.read("source");
    expect(read).toHaveBeenCalledTimes(2);
    unwatchHistory();
    expect(stopWatch).not.toHaveBeenCalled();
    unwatchUsage();
    expect(stopWatch).toHaveBeenCalledTimes(1);
    await history.release();
    expect(close).not.toHaveBeenCalled();
    await usage.release();
    expect(stopWatch).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("never shares entries across principals or source revisions", async () => {
    const coordinator = createMetadataSourceCoordinator<[], string>();
    const close = vi.fn();
    const create = vi.fn(() => ({
      inventory: async () => [] as [],
      read: async () => "",
      close
    }));
    const base = {
      targetAuthority: "ssh:host",
      principal: "uid:1",
      agentId: "fixture",
      sourceDefinitionRevision: "1",
      rootSettingsRevision: "1"
    };
    const leases = await Promise.all([
      coordinator.acquire(base, create),
      coordinator.acquire({ ...base, principal: "uid:2" }, create),
      coordinator.acquire({ ...base, sourceDefinitionRevision: "2" }, create)
    ]);
    expect(create).toHaveBeenCalledTimes(3);
    await Promise.all(leases.map((lease) => lease.release()));
    expect(close).toHaveBeenCalledTimes(3);
  });

  it("invalidates shared inventory and reads before a stale-source retry", async () => {
    const inventory = vi.fn(async () => ["source"]);
    const read = vi.fn(async (sourceId: string) => `read:${sourceId}`);
    const coordinator = createMetadataSourceCoordinator<string[], string>();
    const lease = await coordinator.acquire(
      {
        targetAuthority: "ssh:host",
        principal: "uid:1",
        agentId: "fixture",
        sourceDefinitionRevision: "1",
        rootSettingsRevision: "1"
      },
      () => ({ inventory, read, close() {} })
    );

    await lease.inventory();
    await lease.read("source");
    lease.invalidate();
    await lease.inventory();
    await lease.read("source");

    expect(inventory).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(2);
    await lease.release();
  });
});
