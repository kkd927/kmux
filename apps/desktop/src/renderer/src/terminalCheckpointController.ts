import {
  IncrementalSha256,
  TERMINAL_DATA_PLANE_MAX_CHECKPOINT_BYTES,
  type TerminalCheckpoint,
  type TerminalCheckpointMetadata
} from "@kmux/proto";

import { disposeTerminalBundle, type TerminalBundle } from "./terminalBundle";

export type TerminalCheckpointBindingToken = object;

export interface TerminalCheckpointBinding {
  createBundle(): TerminalBundle;
  getWrapper(): HTMLDivElement | null;
  /** Commits reversible ownership only; the controller disposes `expected`. */
  commitBundle(
    expected: TerminalBundle,
    replacement: TerminalBundle,
    checkpoint: TerminalCheckpointMetadata,
    swapGeneration: number
  ): boolean;
}

interface ActiveHydration {
  generation: number;
  bundle: TerminalBundle;
  cancellation: Promise<never>;
  rejectCancellation(error: Error): void;
  frameHandles: Set<number>;
  writeTask: TerminalCheckpointWriteTask | null;
  metadata: TerminalCheckpointMetadata;
  totalBytes: number;
  receivedBytes: number;
  decoder: TextDecoder;
  digest: IncrementalSha256;
  committing: boolean;
  disposed: boolean;
}

export interface TerminalCheckpointHydration {
  writeChunk(data: ArrayBuffer): Promise<void>;
  commit(digest: string): Promise<{ swapGeneration: number }>;
  cancel(reason?: Error): void;
}

interface TerminalCheckpointWriteTask {
  readonly completion: Promise<void>;
  cancel(reason?: Error): void;
}

interface SurfaceTerminalCheckpointControllerOptions {
  getCurrentBundle(): TerminalBundle;
  beginCooperativeWrite(
    laneId: string,
    data: string,
    write: (chunk: string, onParsed: () => void) => void
  ): TerminalCheckpointWriteTask;
  disposeBundle?(bundle: TerminalBundle): void;
  requestAnimationFrame?(callback: FrameRequestCallback): number;
  cancelAnimationFrame?(handle: number): void;
  queueMicrotask?(callback: () => void): void;
}

/**
 * Surface-scoped checkpoint transaction owner. It survives TerminalPane
 * remounts, so an in-flight offscreen parse can hand off to the pane that now
 * owns the surface instead of committing through a stale React closure.
 */
export class SurfaceTerminalCheckpointController {
  private readonly getCurrent: () => TerminalBundle;
  private readonly disposeTerminal: (bundle: TerminalBundle) => void;
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly enqueueMicrotask: (callback: () => void) => void;
  private readonly beginWrite: SurfaceTerminalCheckpointControllerOptions["beginCooperativeWrite"];
  private binding: {
    token: TerminalCheckpointBindingToken;
    value: TerminalCheckpointBinding;
  } | null = null;
  private active: ActiveHydration | null = null;
  private nextGeneration = 0;
  private bindingVersion = 0;
  private disposed = false;

  constructor({
    getCurrentBundle,
    beginCooperativeWrite,
    disposeBundle = disposeTerminalBundle,
    requestAnimationFrame = defaultRequestAnimationFrame,
    cancelAnimationFrame = defaultCancelAnimationFrame,
    queueMicrotask = globalThis.queueMicrotask.bind(globalThis)
  }: SurfaceTerminalCheckpointControllerOptions) {
    this.getCurrent = getCurrentBundle;
    this.beginWrite = beginCooperativeWrite;
    this.disposeTerminal = disposeBundle;
    this.requestFrame = requestAnimationFrame;
    this.cancelFrame = cancelAnimationFrame;
    this.enqueueMicrotask = queueMicrotask;
  }

  get currentBundle(): TerminalBundle {
    return this.getCurrent();
  }

  bind(binding: TerminalCheckpointBinding): TerminalCheckpointBindingToken {
    if (this.disposed) {
      throw new Error("terminal checkpoint controller is disposed");
    }
    const token: TerminalCheckpointBindingToken = {};
    this.binding = { token, value: binding };
    this.bindingVersion += 1;
    this.moveActiveStageToCurrentWrapper();
    return token;
  }

  unbind(token: TerminalCheckpointBindingToken): void {
    if (this.binding?.token !== token) {
      return;
    }
    this.binding = null;
    const version = ++this.bindingVersion;
    // Pane moves acquire and bind the same cached surface in the same turn.
    // Wait through that handoff before treating the stage as detached.
    this.enqueueMicrotask(() => {
      if (!this.disposed && !this.binding && this.bindingVersion === version) {
        this.cancelActive(
          new Error("terminal checkpoint hydration lost its visible owner")
        );
      }
    });
  }

  async applyCheckpoint(
    checkpoint: TerminalCheckpoint
  ): Promise<{ swapGeneration: number }> {
    const { data, ...metadata } = checkpoint;
    const bytes = new TextEncoder().encode(data);
    const hydration = this.beginCheckpoint(metadata, bytes.byteLength);
    try {
      if (bytes.byteLength > 0) {
        await hydration.writeChunk(bytes.buffer);
      }
      return await hydration.commit(
        new IncrementalSha256().update(bytes).digestHex()
      );
    } catch (error) {
      hydration.cancel(
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  beginCheckpoint(
    metadata: TerminalCheckpointMetadata,
    totalBytes: number
  ): TerminalCheckpointHydration {
    if (this.disposed) {
      throw new Error("terminal checkpoint controller is disposed");
    }
    const initialBinding = this.binding?.value;
    if (!initialBinding) {
      throw new Error("terminal checkpoint has no visible surface owner");
    }

    this.cancelActive(
      new Error("terminal checkpoint hydration was superseded")
    );
    const bundle = initialBinding.createBundle();
    const transaction = this.createTransaction(bundle, metadata, totalBytes);
    this.active = transaction;

    try {
      this.stageBundle(bundle, initialBinding.getWrapper());
      if (
        metadata.cols > 0 &&
        metadata.rows > 0 &&
        (bundle.terminal.cols !== metadata.cols ||
          bundle.terminal.rows !== metadata.rows)
      ) {
        bundle.terminal.resize(metadata.cols, metadata.rows);
      }
      bundle.lineCwds.clear();
      bundle.lineCwds.importSnapshotRanges(metadata.cwdRanges);
    } catch (error) {
      this.disposeTransaction(transaction);
      if (this.active === transaction) {
        this.active = null;
      }
      throw error;
    }

    return {
      writeChunk: async (data) => {
        this.assertCurrent(transaction);
        if (transaction.committing) {
          throw new Error("terminal checkpoint is already committing");
        }
        const bytes = new Uint8Array(data);
        if (
          bytes.byteLength === 0 ||
          transaction.receivedBytes + bytes.byteLength > transaction.totalBytes
        ) {
          throw new Error("terminal checkpoint chunk exceeds declared bytes");
        }
        transaction.receivedBytes += bytes.byteLength;
        transaction.digest.update(bytes);
        const text = transaction.decoder.decode(bytes, { stream: true });
        await this.writeHydrationText(transaction, text);
      },
      commit: async (digest) => {
        this.assertCurrent(transaction);
        if (transaction.receivedBytes !== transaction.totalBytes) {
          throw new Error("terminal checkpoint ended before all bytes arrived");
        }
        transaction.committing = true;
        const finalText = transaction.decoder.decode();
        if (finalText.length > 0) {
          await this.writeHydrationText(transaction, finalText);
        }
        if (transaction.digest.digestHex() !== digest) {
          throw new Error("terminal checkpoint digest mismatch");
        }
        return this.commitHydration(transaction);
      },
      cancel: (
        reason = new Error("terminal checkpoint hydration cancelled")
      ) => {
        if (this.active === transaction) {
          this.cancelActive(reason);
        }
      }
    };
  }

  cancelPending(
    reason = "terminal checkpoint hydration was invalidated"
  ): void {
    this.cancelActive(new Error(reason));
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.binding = null;
    this.bindingVersion += 1;
    this.cancelActive(new Error("terminal checkpoint controller was disposed"));
  }

  private createTransaction(
    bundle: TerminalBundle,
    metadata: TerminalCheckpointMetadata,
    totalBytes: number
  ): ActiveHydration {
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes < 0 ||
      totalBytes > TERMINAL_DATA_PLANE_MAX_CHECKPOINT_BYTES
    ) {
      throw new Error("terminal checkpoint declared an invalid byte length");
    }
    let rejectCancellation!: (error: Error) => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    // Cancellation can happen between streamed chunks, when no write is
    // currently racing this promise. Keep that intentional rejection from
    // becoming an unhandled promise while preserving it for the next race.
    void cancellation.catch(() => undefined);
    return {
      generation: ++this.nextGeneration,
      bundle,
      cancellation,
      rejectCancellation,
      frameHandles: new Set(),
      writeTask: null,
      metadata,
      totalBytes,
      receivedBytes: 0,
      decoder: new TextDecoder("utf-8", { fatal: true }),
      digest: new IncrementalSha256(),
      committing: false,
      disposed: false
    };
  }

  private async writeHydrationText(
    transaction: ActiveHydration,
    data: string
  ): Promise<void> {
    if (data.length === 0) {
      return;
    }
    this.assertCurrent(transaction);
    const writeTask = this.beginWrite(
      transaction.metadata.session.surfaceId,
      data,
      (chunk, onParsed) => transaction.bundle.terminal.write(chunk, onParsed)
    );
    transaction.writeTask = writeTask;
    try {
      await this.raceCancellation(transaction, writeTask.completion);
      this.assertCurrent(transaction);
    } finally {
      if (transaction.writeTask === writeTask) {
        transaction.writeTask = null;
      }
    }
  }

  private async commitHydration(
    transaction: ActiveHydration
  ): Promise<{ swapGeneration: number }> {
    await this.raceCancellation(
      transaction,
      this.waitForStagedPaint(transaction)
    );
    this.assertCurrent(transaction);

    const binding = this.binding?.value;
    if (!binding) {
      throw new Error("terminal checkpoint lost its surface before commit");
    }
    this.stageBundle(transaction.bundle, binding.getWrapper());
    const expected = this.getCurrent();
    prepareBundleForCommit(transaction.bundle);
    if (
      !binding.commitBundle(
        expected,
        transaction.bundle,
        transaction.metadata,
        transaction.generation
      )
    ) {
      throw new Error("terminal checkpoint commit became stale");
    }
    if (this.active === transaction) {
      this.active = null;
    }
    transaction.frameHandles.clear();
    transaction.writeTask = null;

    // Reversible store/DOM ownership is committed above. The prior parser is
    // disposed only after that point, so a cleanup failure cannot roll back to
    // a partially disposed widget.
    try {
      this.disposeTerminal(expected);
    } catch (error) {
      warnCheckpointCleanup(
        "Failed to dispose replaced terminal bundle",
        error
      );
    }
    return { swapGeneration: transaction.generation };
  }

  private stageBundle(
    bundle: TerminalBundle,
    wrapper: HTMLDivElement | null
  ): void {
    if (!wrapper) {
      throw new Error("terminal checkpoint has no measurable wrapper");
    }
    const { host } = bundle;
    host.dataset.terminalHydrationStage = "true";
    host.setAttribute("aria-hidden", "true");
    host.style.position = "absolute";
    host.style.inset = "0";
    host.style.visibility = "hidden";
    host.style.pointerEvents = "none";
    if (host.parentNode !== wrapper) {
      wrapper.appendChild(host);
    }
  }

  private moveActiveStageToCurrentWrapper(): void {
    const active = this.active;
    const wrapper = this.binding?.value.getWrapper() ?? null;
    if (!active || active.disposed || !wrapper) {
      return;
    }
    this.stageBundle(active.bundle, wrapper);
  }

  private waitForStagedPaint(transaction: ActiveHydration): Promise<void> {
    return new Promise<void>((resolve) => {
      const first = this.requestFrame(() => {
        transaction.frameHandles.delete(first);
        const second = this.requestFrame(() => {
          transaction.frameHandles.delete(second);
          resolve();
        });
        transaction.frameHandles.add(second);
      });
      transaction.frameHandles.add(first);
    });
  }

  private async raceCancellation<T>(
    transaction: ActiveHydration,
    operation: Promise<T>
  ): Promise<T> {
    return Promise.race([operation, transaction.cancellation]);
  }

  private assertCurrent(transaction: ActiveHydration): void {
    if (
      this.disposed ||
      transaction.disposed ||
      this.active !== transaction ||
      transaction.generation !== this.nextGeneration
    ) {
      throw new Error("terminal checkpoint hydration became stale");
    }
  }

  private cancelActive(error: Error): void {
    const active = this.active;
    if (!active) {
      return;
    }
    this.active = null;
    active.rejectCancellation(error);
    this.disposeTransaction(active);
  }

  private disposeTransaction(transaction: ActiveHydration): void {
    if (transaction.disposed) {
      return;
    }
    transaction.disposed = true;
    for (const handle of transaction.frameHandles) {
      try {
        this.cancelFrame(handle);
      } catch (error) {
        warnCheckpointCleanup(
          "Failed to cancel terminal checkpoint frame",
          error
        );
      }
    }
    transaction.frameHandles.clear();
    try {
      transaction.writeTask?.cancel(
        new Error("terminal checkpoint hydration was cancelled")
      );
    } catch (error) {
      warnCheckpointCleanup(
        "Failed to cancel terminal checkpoint write",
        error
      );
    }
    transaction.writeTask = null;
    try {
      this.disposeTerminal(transaction.bundle);
    } catch (error) {
      warnCheckpointCleanup("Failed to dispose staged terminal bundle", error);
    }
  }
}

function warnCheckpointCleanup(message: string, error: unknown): void {
  try {
    console.warn(message, error);
  } catch {
    // Cleanup remains no-throw even if diagnostics are unavailable.
  }
}

function prepareBundleForCommit(bundle: TerminalBundle): void {
  const { host } = bundle;
  delete host.dataset.terminalHydrationStage;
  host.removeAttribute("aria-hidden");
  host.style.removeProperty("position");
  host.style.removeProperty("inset");
  host.style.removeProperty("visibility");
  host.style.removeProperty("pointer-events");
}

function defaultRequestAnimationFrame(callback: FrameRequestCallback): number {
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(callback);
  }
  return setTimeout(() => callback(performance.now()), 0) as unknown as number;
}

function defaultCancelAnimationFrame(handle: number): void {
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(handle);
    return;
  }
  clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
}
