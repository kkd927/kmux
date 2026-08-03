// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import {
  createReleaseNotesModalModuleLoader,
  type ReleaseNotesModalComponent,
  type ReleaseNotesModalModule
} from "./releaseNotesModalLoader";

describe("release notes modal module loader", () => {
  it("abandons an unresolved generation and caches the successful retry", async () => {
    const SecondModal: ReleaseNotesModalComponent = () => <div>second</div>;
    const firstModule = deferred<ReleaseNotesModalModule>();
    const secondModule = deferred<ReleaseNotesModalModule>();
    const importModule = vi
      .fn<() => Promise<ReleaseNotesModalModule>>()
      .mockImplementationOnce(() => firstModule.promise)
      .mockImplementationOnce(() => secondModule.promise);
    const loader = createReleaseNotesModalModuleLoader(importModule);
    const firstAttempt = new AbortController();

    const firstLoad = loader.load(firstAttempt.signal);
    await Promise.resolve();
    expect(importModule).toHaveBeenCalledTimes(1);

    const timeout = new Error("module load timed out");
    timeout.name = "TimeoutError";
    firstAttempt.abort(timeout);
    await expect(firstLoad).rejects.toBe(timeout);

    const secondAttempt = new AbortController();
    const secondLoad = loader.load(secondAttempt.signal);
    await Promise.resolve();
    expect(importModule).toHaveBeenCalledTimes(2);

    firstModule.reject(new Error("late failure from abandoned load"));
    await Promise.resolve();

    const sharedAttempt = new AbortController();
    const sharedLoad = loader.load(sharedAttempt.signal);
    expect(importModule).toHaveBeenCalledTimes(2);

    secondModule.resolve({ ReleaseNotesModal: SecondModal });
    await expect(secondLoad).resolves.toEqual({
      ReleaseNotesModal: SecondModal
    });
    await expect(sharedLoad).resolves.toEqual({
      ReleaseNotesModal: SecondModal
    });
    expect(loader.getLoadedModule()).toEqual({
      ReleaseNotesModal: SecondModal
    });
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
