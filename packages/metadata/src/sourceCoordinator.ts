import type { AgentId } from "@kmux/proto";

export interface MetadataTopologyKey {
  readonly targetAuthority: string;
  readonly principal: string;
  readonly agentId: AgentId;
  readonly sourceDefinitionRevision: string;
  readonly rootSettingsRevision: string;
}

export interface MetadataSourceResource<TInventory, TRead> {
  inventory(): Promise<TInventory>;
  read(sourceId: string): Promise<TRead>;
  watch?(onChange: (sourceId?: string) => void): () => void;
  close(): void | Promise<void>;
}

export interface MetadataProjectionLease<TInventory, TRead> {
  readonly key: MetadataTopologyKey;
  inventory(): Promise<TInventory>;
  read(sourceId: string): Promise<TRead>;
  watch(onChange: (sourceId?: string) => void): () => void;
  invalidate(sourceId?: string): void;
  release(): Promise<void>;
}

interface CoordinatorEntry<TInventory, TRead> {
  readonly key: MetadataTopologyKey;
  readonly resource: MetadataSourceResource<TInventory, TRead>;
  readonly listeners: Set<(sourceId?: string) => void>;
  readonly reads: Map<string, Promise<TRead>>;
  refs: number;
  inventory?: Promise<TInventory>;
  stopWatch?: () => void;
  closed: boolean;
}

export function createMetadataSourceCoordinator<TInventory, TRead>() {
  const entries = new Map<string, CoordinatorEntry<TInventory, TRead>>();
  const acquisitions = new Map<
    string,
    Promise<MetadataSourceResource<TInventory, TRead>>
  >();

  return Object.freeze({
    async acquire(
      key: MetadataTopologyKey,
      create: () =>
        | MetadataSourceResource<TInventory, TRead>
        | Promise<MetadataSourceResource<TInventory, TRead>>
    ): Promise<MetadataProjectionLease<TInventory, TRead>> {
      const serialized = JSON.stringify(key);
      let entry = entries.get(serialized);
      if (!entry) {
        let acquisition = acquisitions.get(serialized);
        if (!acquisition) {
          acquisition = Promise.resolve().then(create);
          acquisitions.set(serialized, acquisition);
        }
        const resource = await acquisition.finally(() =>
          acquisitions.delete(serialized)
        );
        entry = entries.get(serialized);
        if (!entry) {
          entry = {
            key: { ...key },
            resource,
            listeners: new Set(),
            reads: new Map(),
            refs: 0,
            closed: false
          };
          entries.set(serialized, entry);
        } else if (entry.resource !== resource) {
          await resource.close();
        }
      }
      entry.refs += 1;
      return createLease(serialized, entry);
    },
    size: () => entries.size,
    async close(): Promise<void> {
      await Promise.all(
        [...entries].map(async ([serialized, entry]) => {
          entries.delete(serialized);
          await closeEntry(entry);
        })
      );
    }
  });

  function createLease(
    serialized: string,
    entry: CoordinatorEntry<TInventory, TRead>
  ): MetadataProjectionLease<TInventory, TRead> {
    let released = false;
    const requireOpen = () => {
      if (released || entry.closed)
        throw new Error("metadata projection lease is closed");
    };
    return Object.freeze({
      key: { ...entry.key },
      inventory(): Promise<TInventory> {
        requireOpen();
        entry.inventory ??= entry.resource.inventory().catch((error) => {
          entry.inventory = undefined;
          throw error;
        });
        return entry.inventory;
      },
      read(sourceId: string): Promise<TRead> {
        requireOpen();
        let request = entry.reads.get(sourceId);
        if (!request) {
          request = entry.resource.read(sourceId).then(
            (result) => {
              if (entry.reads.get(sourceId) === request) {
                entry.reads.delete(sourceId);
              }
              return result;
            },
            (error: unknown) => {
              if (entry.reads.get(sourceId) === request) {
                entry.reads.delete(sourceId);
              }
              throw error;
            }
          );
          entry.reads.set(sourceId, request);
        }
        return request;
      },
      watch(listener: (sourceId?: string) => void): () => void {
        requireOpen();
        entry.listeners.add(listener);
        try {
          startWatch(entry);
        } catch (error) {
          entry.listeners.delete(listener);
          throw error;
        }
        let listening = true;
        return () => {
          if (!listening) return;
          listening = false;
          entry.listeners.delete(listener);
          if (entry.listeners.size === 0) {
            entry.stopWatch?.();
            entry.stopWatch = undefined;
          }
        };
      },
      invalidate(sourceId?: string): void {
        requireOpen();
        entry.inventory = undefined;
        if (sourceId === undefined) entry.reads.clear();
        else entry.reads.delete(sourceId);
      },
      async release(): Promise<void> {
        if (released) return;
        released = true;
        entry.refs -= 1;
        if (entry.refs === 0 && entries.get(serialized) === entry) {
          entries.delete(serialized);
          await closeEntry(entry);
        }
      }
    });
  }
}

function startWatch<TInventory, TRead>(
  entry: CoordinatorEntry<TInventory, TRead>
): void {
  if (entry.stopWatch || !entry.resource.watch) return;
  entry.stopWatch = entry.resource.watch((sourceId) => {
    entry.inventory = undefined;
    // A watcher source identity is for projection-level dirtying. Read cache
    // keys may encode ranges or queries, so a path cannot select every key.
    entry.reads.clear();
    for (const listener of entry.listeners) listener(sourceId);
  });
}

async function closeEntry<TInventory, TRead>(
  entry: CoordinatorEntry<TInventory, TRead>
): Promise<void> {
  if (entry.closed) return;
  entry.closed = true;
  entry.stopWatch?.();
  entry.listeners.clear();
  entry.reads.clear();
  await entry.resource.close();
}
