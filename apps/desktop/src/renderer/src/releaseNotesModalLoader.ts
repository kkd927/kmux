import type { ReleaseNotesModal as ReleaseNotesModalValue } from "./components/ReleaseNotesModal";

export type ReleaseNotesModalComponent = typeof ReleaseNotesModalValue;

export interface ReleaseNotesModalModule {
  ReleaseNotesModal: ReleaseNotesModalComponent;
}

interface PendingModuleLoad {
  generation: number;
  promise: Promise<ReleaseNotesModalModule>;
}

export interface ReleaseNotesModalModuleLoader {
  getLoadedModule: () => ReleaseNotesModalModule | null;
  load: (signal: AbortSignal) => Promise<ReleaseNotesModalModule>;
}

export function createReleaseNotesModalModuleLoader(
  importModule: () => Promise<ReleaseNotesModalModule>
): ReleaseNotesModalModuleLoader {
  let loadedModule: ReleaseNotesModalModule | null = null;
  let pendingLoad: PendingModuleLoad | null = null;
  let nextGeneration = 0;

  const startLoad = (): PendingModuleLoad => {
    const load: PendingModuleLoad = {
      generation: nextGeneration + 1,
      promise: Promise.resolve().then(importModule)
    };
    nextGeneration = load.generation;
    pendingLoad = load;
    void load.promise.then(
      (module) => {
        if (pendingLoad?.generation === load.generation) {
          loadedModule = module;
          pendingLoad = null;
        }
      },
      () => {
        if (pendingLoad?.generation === load.generation) {
          pendingLoad = null;
        }
      }
    );
    return load;
  };

  return {
    getLoadedModule: () => loadedModule,
    load: (signal) => {
      if (signal.aborted) {
        return Promise.reject(abortReason(signal));
      }
      if (loadedModule) {
        return Promise.resolve(loadedModule);
      }

      const load = pendingLoad ?? startLoad();
      return new Promise<ReleaseNotesModalModule>((resolve, reject) => {
        let settled = false;
        const finish = (complete: () => void): void => {
          if (settled) {
            return;
          }
          settled = true;
          signal.removeEventListener("abort", onAbort);
          complete();
        };
        const onAbort = (): void => {
          finish(() => {
            if (pendingLoad?.generation === load.generation) {
              pendingLoad = null;
            }
            reject(abortReason(signal));
          });
        };

        signal.addEventListener("abort", onAbort, { once: true });
        void load.promise.then(
          (module) => {
            finish(() => {
              if (signal.aborted) {
                reject(abortReason(signal));
                return;
              }
              resolve(module);
            });
          },
          (error) => {
            finish(() => reject(error));
          }
        );
      });
    }
  };
}

const releaseNotesModalModuleLoader = createReleaseNotesModalModuleLoader(
  async () => import("./components/ReleaseNotesModal")
);

export function getLoadedReleaseNotesModal(): ReleaseNotesModalComponent | null {
  return (
    releaseNotesModalModuleLoader.getLoadedModule()?.ReleaseNotesModal ?? null
  );
}

export async function loadReleaseNotesModal(
  signal: AbortSignal
): Promise<ReleaseNotesModalComponent> {
  const module = await releaseNotesModalModuleLoader.load(signal);
  return module.ReleaseNotesModal;
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) {
    return signal.reason;
  }
  const error = new Error("Release notes modal preparation was aborted");
  error.name = "AbortError";
  return error;
}
