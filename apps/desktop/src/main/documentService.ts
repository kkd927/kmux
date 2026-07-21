import type { WebContents } from "electron";

import {
  sameLocatedPath,
  type AppState,
  type LocatedPath,
  type WorkspaceTarget
} from "@kmux/core";
import {
  MAX_MARKDOWN_BYTES,
  type Id,
  type MarkdownDocumentEvent,
  type MarkdownDocumentSubscriptionDto
} from "@kmux/proto";

import { RemoteHostManagerError } from "./remoteHost";
import type { FileMetadata, TargetServiceRegistry } from "./targets/contracts";

const LOCAL_RECONCILE_MS = 2_000;
const LOCAL_WATCH_DEBOUNCE_MS = 100;
const SSH_POLL_MS = 1_000;
const SSH_MAX_BACKOFF_MS = 30_000;
const SSH_FORCE_READ_POLLS = 10;

export interface DocumentEventSender {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, event: MarkdownDocumentEvent): void;
  once(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
}

export interface DocumentServiceOptions {
  getState(): AppState;
  targetServices: TargetServiceRegistry;
  ownsWindow(sender: DocumentEventSender, windowId: Id): boolean;
  watchLocal(path: LocatedPath, onChange: () => void): () => void;
  setTimer?(
    callback: () => void,
    delayMs: number
  ): ReturnType<typeof setTimeout>;
  clearTimer?(timer: ReturnType<typeof setTimeout>): void;
}

interface DocumentSubscription {
  surfaceId: Id;
  sender: DocumentEventSender;
  path: LocatedPath;
  target: WorkspaceTarget;
  generation: number;
  lastMetadataKey?: string;
  lastText?: string;
  pollCount: number;
  failedPolls: number;
  timer?: ReturnType<typeof setTimeout>;
  debounceTimer?: ReturnType<typeof setTimeout>;
  stopWatch?: () => void;
}

export class DocumentService {
  private readonly subscriptions = new Map<Id, DocumentSubscription>();
  private readonly revisions = new Map<Id, number>();
  private readonly senderSurfaces = new Map<number, Set<Id>>();
  private readonly senderDestroyedListeners = new Map<number, () => void>();
  private readonly setTimer: NonNullable<DocumentServiceOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<
    DocumentServiceOptions["clearTimer"]
  >;

  constructor(private readonly options: DocumentServiceOptions) {
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  subscribe(
    sender: DocumentEventSender,
    request: MarkdownDocumentSubscriptionDto
  ): void {
    const resolved = this.resolveAuthorizedSurface(sender, request.surfaceId);
    const existing = this.subscriptions.get(request.surfaceId);
    if (existing?.sender.id === sender.id) {
      this.scheduleRead(existing, true, 0);
      return;
    }
    if (existing) this.cancel(existing);

    const subscription: DocumentSubscription = {
      surfaceId: request.surfaceId,
      sender,
      path: resolved.path,
      target: resolved.target,
      generation: 0,
      pollCount: 0,
      failedPolls: 0
    };
    this.subscriptions.set(subscription.surfaceId, subscription);
    this.trackSender(subscription);
    if (subscription.target.kind === "local") {
      subscription.stopWatch = this.options.watchLocal(subscription.path, () =>
        this.scheduleLocalWatchRead(subscription)
      );
    }
    this.scheduleRead(subscription, true, 0);
  }

  unsubscribe(
    sender: DocumentEventSender,
    request: MarkdownDocumentSubscriptionDto
  ): void {
    const subscription = this.subscriptions.get(request.surfaceId);
    if (subscription?.sender.id === sender.id) this.cancel(subscription);
  }

  closeSurface(surfaceId: Id): void {
    const subscription = this.subscriptions.get(surfaceId);
    if (subscription) this.cancel(subscription);
    this.revisions.delete(surfaceId);
  }

  retryTarget(targetId: Id): void {
    for (const subscription of this.subscriptions.values()) {
      if (
        subscription.target.kind === "ssh" &&
        subscription.target.targetId === targetId
      ) {
        subscription.failedPolls = 0;
        this.scheduleRead(subscription, true, 0);
      }
    }
  }

  close(): void {
    for (const subscription of [...this.subscriptions.values()]) {
      this.cancel(subscription);
    }
    this.revisions.clear();
  }

  private resolveAuthorizedSurface(sender: DocumentEventSender, surfaceId: Id) {
    const state = this.options.getState();
    const surface = state.surfaces[surfaceId];
    const pane = surface ? state.panes[surface.paneId] : undefined;
    const workspace = pane ? state.workspaces[pane.workspaceId] : undefined;
    if (
      !surface ||
      surface.content.kind !== "markdown" ||
      !pane ||
      !workspace ||
      state.windows[workspace.windowId]?.activeWorkspaceId !== workspace.id ||
      pane.activeSurfaceId !== surface.id ||
      !this.options.ownsWindow(sender, workspace.windowId)
    ) {
      throw new Error("document subscription is not authorized");
    }
    return {
      path: surface.content.source.path,
      target: workspace.location.target
    };
  }

  private trackSender(subscription: DocumentSubscription): void {
    let surfaces = this.senderSurfaces.get(subscription.sender.id);
    if (!surfaces) {
      surfaces = new Set();
      this.senderSurfaces.set(subscription.sender.id, surfaces);
      const listener = () => this.closeSender(subscription.sender.id);
      this.senderDestroyedListeners.set(subscription.sender.id, listener);
      subscription.sender.once("destroyed", listener);
    }
    surfaces.add(subscription.surfaceId);
  }

  private closeSender(senderId: number): void {
    for (const surfaceId of this.senderSurfaces.get(senderId) ?? []) {
      const subscription = this.subscriptions.get(surfaceId);
      if (subscription?.sender.id === senderId) this.cancel(subscription);
    }
  }

  private cancel(subscription: DocumentSubscription): void {
    if (this.subscriptions.get(subscription.surfaceId) !== subscription) return;
    subscription.generation += 1;
    if (subscription.timer) this.clearTimer(subscription.timer);
    if (subscription.debounceTimer) this.clearTimer(subscription.debounceTimer);
    subscription.stopWatch?.();
    this.subscriptions.delete(subscription.surfaceId);
    const surfaces = this.senderSurfaces.get(subscription.sender.id);
    surfaces?.delete(subscription.surfaceId);
    if (surfaces?.size === 0) {
      const listener = this.senderDestroyedListeners.get(
        subscription.sender.id
      );
      if (listener) subscription.sender.removeListener("destroyed", listener);
      this.senderDestroyedListeners.delete(subscription.sender.id);
      this.senderSurfaces.delete(subscription.sender.id);
    }
  }

  private scheduleLocalWatchRead(subscription: DocumentSubscription): void {
    if (!this.isCurrent(subscription)) return;
    if (subscription.debounceTimer) this.clearTimer(subscription.debounceTimer);
    subscription.debounceTimer = this.setTimer(() => {
      subscription.debounceTimer = undefined;
      this.scheduleRead(subscription, true, 0);
    }, LOCAL_WATCH_DEBOUNCE_MS);
  }

  private scheduleRead(
    subscription: DocumentSubscription,
    forceRead: boolean,
    delayMs: number
  ): void {
    if (!this.isCurrent(subscription)) return;
    if (subscription.timer) this.clearTimer(subscription.timer);
    subscription.timer = this.setTimer(() => {
      subscription.timer = undefined;
      void this.refresh(subscription, forceRead);
    }, delayMs);
  }

  private async refresh(
    subscription: DocumentSubscription,
    forceRead: boolean
  ): Promise<void> {
    if (!this.isCurrent(subscription)) return;
    if (!this.isStillVisible(subscription)) {
      this.cancel(subscription);
      return;
    }
    const generation = ++subscription.generation;
    this.emit(subscription, { type: "loading" });
    try {
      const files = this.options.targetServices.resolveLocated(
        subscription.target
      ).files;
      const metadata = await files.stat(subscription.path);
      if (!this.isCompletionCurrent(subscription, generation)) return;
      if (!metadata) {
        this.emit(subscription, { type: "error", errorCode: "missing" });
        this.scheduleNext(subscription, false);
        return;
      }
      if (metadata.kind !== "file") {
        this.emit(subscription, { type: "error", errorCode: "read-failed" });
        this.scheduleNext(subscription, false);
        return;
      }
      if (metadata.size > MAX_MARKDOWN_BYTES) {
        this.emit(subscription, { type: "error", errorCode: "too-large" });
        this.scheduleNext(subscription, false);
        return;
      }
      const metadataKey = fileMetadataKey(metadata);
      const reconcile =
        subscription.target.kind === "ssh" &&
        subscription.pollCount % SSH_FORCE_READ_POLLS === 0;
      if (
        !forceRead &&
        !reconcile &&
        subscription.lastMetadataKey === metadataKey
      ) {
        subscription.failedPolls = 0;
        this.scheduleNext(subscription, true);
        return;
      }
      const bytes = await files.read(subscription.path, {
        maxBytes: MAX_MARKDOWN_BYTES
      });
      if (!this.isCompletionCurrent(subscription, generation)) return;
      if (bytes.byteLength > MAX_MARKDOWN_BYTES) {
        this.emit(subscription, { type: "error", errorCode: "too-large" });
        this.scheduleNext(subscription, false);
        return;
      }
      const text = decodeMarkdownUtf8(bytes);
      subscription.lastMetadataKey = metadataKey;
      subscription.failedPolls = 0;
      if (text !== subscription.lastText) {
        subscription.lastText = text;
        this.emit(subscription, {
          type: "snapshot",
          text,
          byteLength: bytes.byteLength
        });
      }
      this.scheduleNext(subscription, true);
    } catch (error) {
      if (!this.isCompletionCurrent(subscription, generation)) return;
      if (error instanceof TypeError && error.message === "invalid UTF-8") {
        this.emit(subscription, {
          type: "error",
          errorCode: "invalid-encoding"
        });
        this.scheduleNext(subscription, false);
        return;
      }
      subscription.failedPolls += 1;
      if (isOfflineFailure(subscription.target, error)) {
        this.emit(subscription, { type: "offline" });
      } else {
        this.emit(subscription, { type: "error", errorCode: "read-failed" });
      }
      this.scheduleNext(subscription, false);
    }
  }

  private scheduleNext(
    subscription: DocumentSubscription,
    successful: boolean
  ): void {
    if (!this.isCurrent(subscription)) return;
    subscription.pollCount += 1;
    if (subscription.target.kind === "local") {
      this.scheduleRead(subscription, false, LOCAL_RECONCILE_MS);
      return;
    }
    const delay = successful
      ? SSH_POLL_MS
      : Math.min(
          SSH_MAX_BACKOFF_MS,
          SSH_POLL_MS * 2 ** Math.min(subscription.failedPolls, 5)
        );
    this.scheduleRead(subscription, false, delay);
  }

  private emit(
    subscription: DocumentSubscription,
    event:
      | { type: "loading" | "offline" }
      | { type: "snapshot"; text: string; byteLength: number }
      | {
          type: "error";
          errorCode:
            | "missing"
            | "too-large"
            | "invalid-encoding"
            | "read-failed";
        }
  ): void {
    if (!this.isCurrent(subscription) || subscription.sender.isDestroyed()) {
      return;
    }
    const revision = (this.revisions.get(subscription.surfaceId) ?? 0) + 1;
    this.revisions.set(subscription.surfaceId, revision);
    subscription.sender.send("kmux:document:event", {
      ...event,
      surfaceId: subscription.surfaceId,
      revision
    } as MarkdownDocumentEvent);
  }

  private isCurrent(subscription: DocumentSubscription): boolean {
    return this.subscriptions.get(subscription.surfaceId) === subscription;
  }

  private isStillVisible(subscription: DocumentSubscription): boolean {
    const state = this.options.getState();
    const surface = state.surfaces[subscription.surfaceId];
    const pane = surface ? state.panes[surface.paneId] : undefined;
    const workspace = pane ? state.workspaces[pane.workspaceId] : undefined;
    return Boolean(
      surface?.content.kind === "markdown" &&
      pane?.activeSurfaceId === surface.id &&
      workspace &&
      state.windows[workspace.windowId]?.activeWorkspaceId === workspace.id &&
      this.options.ownsWindow(subscription.sender, workspace.windowId) &&
      sameLocatedPath(surface.content.source.path, subscription.path)
    );
  }

  private isCompletionCurrent(
    subscription: DocumentSubscription,
    generation: number
  ): boolean {
    return (
      this.isCurrent(subscription) && subscription.generation === generation
    );
  }
}

export type ElectronDocumentEventSender = Pick<
  WebContents,
  "id" | "isDestroyed" | "send" | "once" | "removeListener"
>;

function fileMetadataKey(metadata: FileMetadata): string {
  return `${metadata.kind}:${metadata.size}:${metadata.modifiedAtMs ?? "unknown"}`;
}

function decodeMarkdownUtf8(bytes: Uint8Array): string {
  const withoutBom =
    bytes.byteLength >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
      ? bytes.subarray(3)
      : bytes;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(withoutBom);
  } catch {
    throw new TypeError("invalid UTF-8");
  }
}

function isOfflineFailure(target: WorkspaceTarget, error: unknown): boolean {
  return (
    target.kind === "ssh" &&
    (!(error instanceof RemoteHostManagerError) || error.retryable)
  );
}
