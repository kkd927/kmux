import type { IDisposable, Terminal } from "@xterm/xterm";

import {
  documentCompositionCoordinator,
  type CompositionAbortReason,
  type DocumentCompositionParticipant
} from "./xtermCompositionCoordinator";

interface CompositionPosition {
  start: number;
  end: number;
}

type CompositionStatus = "composing" | "pending" | "sent" | "cancelled";

interface CompositionTransaction {
  readonly id: number;
  readonly position: CompositionPosition;
  readonly suffixLength: number;
  readonly settlement: Promise<XtermCompositionSettlementResult>;
  onSettled(listener: (result: XtermCompositionSettlementResult) => void): void;
  settle(result: XtermCompositionSettlementResult): void;
  compositionRangeWasCleared: boolean;
  displacedCompositionPrefix: string;
  lastCompositionRangeText: string;
  status: CompositionStatus;
}

interface PendingBlurSnapshot {
  readonly transaction: CompositionTransaction;
  readonly value: string;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
}

interface ForeignInsertTextSnapshot {
  readonly owner: DocumentCompositionParticipant;
  readonly value: string;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
}

interface ForeignKeypressCommit {
  readonly owner: DocumentCompositionParticipant;
  readonly data: string;
}

interface XtermCoreService {
  triggerDataEvent(data: string, wasUserInput?: boolean): void;
}

interface XtermCompositionHelper {
  _textarea: HTMLTextAreaElement;
  _compositionView: HTMLElement;
  _compositionPosition: CompositionPosition;
  _isComposing: boolean;
  _isSendingComposition: boolean;
  _dataAlreadySent: string;
  _pendingComposition?: CompositionTransaction;
  _coreService: XtermCoreService;
  compositionstart(): void;
  compositionupdate(event: Pick<CompositionEvent, "data">): void;
  compositionend(): void;
  keydown(event: KeyboardEvent): boolean;
  _finalizeComposition(waitForPropagation: boolean): void;
  _handleAnyTextareaChanges(): void;
  updateCompositionElements(dontRecurse?: boolean): void;
}

interface XtermBrowserCore {
  _compositionHelper?: XtermCompositionHelper;
  _inputEvent(event: InputEvent): boolean;
  _keyPress(event: KeyboardEvent): boolean;
  _unprocessedDeadKey: boolean;
  cancel?(event: Event): boolean;
}

interface XtermTerminalInternals extends Terminal {
  _core?: XtermBrowserCore;
}

interface CompatibleXtermInternals {
  readonly core: XtermBrowserCore;
  readonly helper: XtermCompositionHelper;
  readonly coreService: XtermCoreService;
  readonly textarea: HTMLTextAreaElement;
}

interface OriginalMethods {
  compositionstart: XtermCompositionHelper["compositionstart"];
  compositionupdate: XtermCompositionHelper["compositionupdate"];
  compositionend: XtermCompositionHelper["compositionend"];
  keydown: XtermCompositionHelper["keydown"];
  finalizeComposition: XtermCompositionHelper["_finalizeComposition"];
  inputEvent: XtermBrowserCore["_inputEvent"];
  keyPress: XtermBrowserCore["_keyPress"];
  triggerDataEvent: XtermCoreService["triggerDataEvent"];
  terminalDispose: Terminal["dispose"];
}

export interface XtermCompositionTransactionInstallation extends IDisposable {
  readonly installed: boolean;
}

export interface XtermCompositionSettlement {
  readonly id: number;
  readonly promise: Promise<XtermCompositionSettlementResult>;
  onSettled(listener: (result: XtermCompositionSettlementResult) => void): void;
}

export type XtermCompositionSettlementResult =
  | { readonly status: "committed" }
  | {
      readonly status: "cancelled";
      readonly reason: CompositionAbortReason;
    };

interface InstalledCompositionTransactions extends XtermCompositionTransactionInstallation {
  currentTransaction(): CompositionTransaction | undefined;
  invalidate(): void;
}

const NOOP_INSTALLATION: XtermCompositionTransactionInstallation = {
  installed: false,
  dispose() {}
};

const terminalCompositionInstallations = new WeakMap<
  Terminal,
  InstalledCompositionTransactions
>();

const HANGUL_SYLLABLE_BASE = 0xac00;
const HANGUL_SYLLABLE_END = 0xd7a3;
const HANGUL_TRAILING_COUNT = 28;
const RECONCILER_PROVENANCE =
  "kmux-xterm-composition-reconciler:ordered-document-transactions:v1";
export const SUPPORTED_XTERM_COMPOSITION_VERSION = "6.0.0";

// Maps a trailing-jamo index to the trailing consonant retained by the first
// syllable and the leading-jamo index transferred to the next syllable.
const HANGUL_FINAL_TRANSFERS: ReadonlyArray<
  readonly [retainedTrailing: number, movedLeading: number] | undefined
> = [
  undefined,
  [0, 0],
  [0, 1],
  [1, 9],
  [0, 2],
  [4, 12],
  [4, 18],
  [0, 3],
  [0, 5],
  [8, 0],
  [8, 6],
  [8, 7],
  [8, 9],
  [8, 16],
  [8, 17],
  [8, 18],
  [0, 6],
  [0, 7],
  [17, 9],
  [0, 9],
  [0, 10],
  [0, 11],
  [0, 12],
  [0, 14],
  [0, 15],
  [0, 16],
  [0, 17],
  [0, 18]
];

export function getXtermCompositionSettlement(
  terminal: Terminal
): XtermCompositionSettlement | null {
  const transaction = terminalCompositionInstallations
    .get(terminal)
    ?.currentTransaction();
  return transaction
    ? {
        id: transaction.id,
        promise: transaction.settlement,
        onSettled: transaction.onSettled
      }
    : null;
}

export function invalidateXtermCompositionTransactions(
  terminal: Terminal
): void {
  terminalCompositionInstallations.get(terminal)?.invalidate();
}

function createCompositionTransaction(
  id: number,
  position: CompositionPosition,
  suffixLength: number
): CompositionTransaction {
  let settled = false;
  let settlementResult: XtermCompositionSettlementResult | undefined;
  const settlementListeners = new Set<
    (result: XtermCompositionSettlementResult) => void
  >();
  let resolveSettlement!: (result: XtermCompositionSettlementResult) => void;
  const settlement = new Promise<XtermCompositionSettlementResult>(
    (resolve) => {
      resolveSettlement = resolve;
    }
  );
  const invokeSettlementListener = (
    listener: (result: XtermCompositionSettlementResult) => void,
    result: XtermCompositionSettlementResult
  ): void => {
    try {
      listener(result);
    } catch (error) {
      // A lifecycle observer must not interrupt xterm's active DOM event.
      setTimeout(() => {
        throw error;
      }, 0);
    }
  };
  return {
    id,
    position,
    suffixLength,
    settlement,
    onSettled(listener) {
      if (settled && settlementResult) {
        invokeSettlementListener(listener, settlementResult);
        return;
      }
      settlementListeners.add(listener);
    },
    settle(result) {
      if (settled) {
        return;
      }
      settled = true;
      settlementResult = result;
      for (const listener of settlementListeners) {
        invokeSettlementListener(listener, result);
      }
      settlementListeners.clear();
      resolveSettlement(result);
    },
    compositionRangeWasCleared: false,
    displacedCompositionPrefix: "",
    lastCompositionRangeText: "",
    status: "composing"
  };
}

function hangulTransferPrefix(
  compositionText: string,
  committedText: string
): string {
  const compositionCodePoints = Array.from(compositionText);
  const committedCodePoints = Array.from(committedText);
  const lastComposition = compositionCodePoints.at(-1)?.codePointAt(0);
  const firstCommitted = committedCodePoints[0]?.codePointAt(0);
  if (
    lastComposition === undefined ||
    firstCommitted === undefined ||
    lastComposition < HANGUL_SYLLABLE_BASE ||
    lastComposition > HANGUL_SYLLABLE_END ||
    firstCommitted < HANGUL_SYLLABLE_BASE ||
    firstCommitted > HANGUL_SYLLABLE_END
  ) {
    return "";
  }

  const compositionOffset = lastComposition - HANGUL_SYLLABLE_BASE;
  const trailing = compositionOffset % HANGUL_TRAILING_COUNT;
  const transfer = HANGUL_FINAL_TRANSFERS[trailing];
  if (!transfer) {
    return "";
  }
  const [retainedTrailing, movedLeading] = transfer;
  const lastSyllableBase = lastComposition - trailing;
  const committedTrailing =
    (firstCommitted - HANGUL_SYLLABLE_BASE) % HANGUL_TRAILING_COUNT;
  const committedSyllableBase = firstCommitted - committedTrailing;
  const retainedSyllable = lastComposition - trailing + retainedTrailing;
  if (
    firstCommitted === lastComposition ||
    firstCommitted === retainedSyllable ||
    committedSyllableBase === lastSyllableBase
  ) {
    return "";
  }
  const committedLeading = Math.floor(
    (firstCommitted - HANGUL_SYLLABLE_BASE) / 588
  );
  if (committedLeading !== movedLeading) {
    return "";
  }

  return `${compositionCodePoints.slice(0, -1).join("")}${String.fromCodePoint(retainedSyllable)}`;
}

function compositionStartPosition(textarea: HTMLTextAreaElement): {
  start: number;
  end: number;
} {
  const selectionStart = textarea.selectionStart ?? textarea.value.length;
  const selectionEnd = textarea.selectionEnd ?? selectionStart;
  return {
    start: Math.min(selectionStart, selectionEnd),
    end: Math.max(selectionStart, selectionEnd)
  };
}

function compatibleXtermInternals(
  terminal: Terminal
): CompatibleXtermInternals | null {
  const internalTerminal = terminal as XtermTerminalInternals;
  const core = internalTerminal._core;
  const helper = core?._compositionHelper;

  // Some lightweight view tests deliberately provide an unopened xterm
  // facade. Production installs only after Terminal.open(), where element is
  // non-null; an opened terminal must satisfy the complete private contract.
  if (!terminal.element && (!core || !helper)) {
    return null;
  }

  const textarea = terminal.textarea;
  const missing: string[] = [];
  if (!core) {
    missing.push("Terminal._core");
  }
  if (!helper) {
    missing.push("_core._compositionHelper");
  }
  if (!textarea) {
    missing.push("Terminal.textarea");
  }
  if (typeof terminal.dispose !== "function") {
    missing.push("Terminal.dispose()");
  }
  if (core) {
    if (typeof core._inputEvent !== "function") {
      missing.push("_core._inputEvent()");
    }
    if (typeof core._keyPress !== "function") {
      missing.push("_core._keyPress()");
    }
    if (typeof core._unprocessedDeadKey !== "boolean") {
      missing.push("_core._unprocessedDeadKey");
    }
  }
  if (helper) {
    if (textarea && helper._textarea !== textarea) {
      missing.push("_compositionHelper._textarea identity");
    }
    if (typeof helper._compositionView?.classList?.add !== "function") {
      missing.push("_compositionHelper._compositionView");
    }
    if (
      typeof helper._compositionPosition?.start !== "number" ||
      typeof helper._compositionPosition?.end !== "number"
    ) {
      missing.push("_compositionHelper._compositionPosition");
    }
    if (typeof helper._isComposing !== "boolean") {
      missing.push("_compositionHelper._isComposing");
    }
    if (typeof helper._isSendingComposition !== "boolean") {
      missing.push("_compositionHelper._isSendingComposition");
    }
    if (typeof helper._dataAlreadySent !== "string") {
      missing.push("_compositionHelper._dataAlreadySent");
    }
    if (typeof helper.compositionstart !== "function") {
      missing.push("_compositionHelper.compositionstart()");
    }
    if (typeof helper.compositionupdate !== "function") {
      missing.push("_compositionHelper.compositionupdate()");
    }
    if (typeof helper.compositionend !== "function") {
      missing.push("_compositionHelper.compositionend()");
    }
    if (typeof helper.keydown !== "function") {
      missing.push("_compositionHelper.keydown()");
    }
    if (typeof helper._finalizeComposition !== "function") {
      missing.push("_compositionHelper._finalizeComposition()");
    }
    if (typeof helper._handleAnyTextareaChanges !== "function") {
      missing.push("_compositionHelper._handleAnyTextareaChanges()");
    }
    if (typeof helper.updateCompositionElements !== "function") {
      missing.push("_compositionHelper.updateCompositionElements()");
    }
    if (typeof helper._coreService?.triggerDataEvent !== "function") {
      missing.push("_compositionHelper._coreService.triggerDataEvent()");
    }
  }

  if (missing.length > 0 || !core || !helper || !textarea) {
    throw new Error(
      `Unsupported @xterm/xterm private API for ${SUPPORTED_XTERM_COMPOSITION_VERSION}: ${missing.join(", ")} (${RECONCILER_PROVENANCE})`
    );
  }

  return {
    core,
    helper,
    coreService: helper._coreService,
    textarea
  };
}

/**
 * Reconciles Chromium's composition, keypress, and insertText observations at
 * xterm's commit boundary. Every delayed callback owns one transaction token;
 * completing a later transaction can never reactivate an older callback.
 */
export function installXtermCompositionTransactions(
  terminal: Terminal
): XtermCompositionTransactionInstallation {
  const internals = compatibleXtermInternals(terminal);
  if (!internals) {
    return NOOP_INSTALLATION;
  }

  const { core, helper, coreService, textarea } = internals;
  const ownerDocument = textarea.ownerDocument;
  const coordinator = documentCompositionCoordinator(ownerDocument);
  const installationToken = {};
  const original: OriginalMethods = {
    compositionstart: helper.compositionstart,
    compositionupdate: helper.compositionupdate,
    compositionend: helper.compositionend,
    keydown: helper.keydown,
    finalizeComposition: helper._finalizeComposition,
    inputEvent: core._inputEvent,
    keyPress: core._keyPress,
    triggerDataEvent: coreService.triggerDataEvent,
    terminalDispose: terminal.dispose
  };

  let disposed = false;
  let current: CompositionTransaction | undefined;
  let pending: CompositionTransaction | undefined;
  let lastEnded: CompositionTransaction | undefined;
  let synchronousCommitAwaitingInput: CompositionTransaction | undefined;
  let keypressCommitAwaitingInput: CompositionTransaction | undefined;
  let ownedInsertText: CompositionTransaction | undefined;
  let pendingBlurSnapshot: PendingBlurSnapshot | undefined;
  let blurPreservedTransaction: CompositionTransaction | undefined;
  let foreignInsertTextSnapshot: ForeignInsertTextSnapshot | undefined;
  let foreignKeypressCommit: ForeignKeypressCommit | undefined;
  let interceptingKeypress = false;
  let bypassKeypressInterception = false;

  const participants = new Map<
    CompositionTransaction,
    DocumentCompositionParticipant
  >();

  const foreignDocumentOwner = (): DocumentCompositionParticipant | undefined =>
    coordinator.firstForeign(installationToken);

  const clearDocumentOwnership = (
    transaction: CompositionTransaction
  ): void => {
    const participant = participants.get(transaction);
    if (participant) {
      coordinator.unregister(participant);
      participants.delete(transaction);
    }
  };

  const syncHelperState = (): void => {
    helper._pendingComposition = pending;
    helper._isSendingComposition = pending !== undefined;
  };

  const clearTransactionObservers = (
    transaction: CompositionTransaction
  ): void => {
    if (synchronousCommitAwaitingInput === transaction) {
      synchronousCommitAwaitingInput = undefined;
    }
    if (keypressCommitAwaitingInput === transaction) {
      keypressCommitAwaitingInput = undefined;
    }
    if (ownedInsertText === transaction) {
      ownedInsertText = undefined;
    }
  };

  const finishBlurPreservation = (
    transaction: CompositionTransaction
  ): void => {
    if (pendingBlurSnapshot?.transaction === transaction) {
      pendingBlurSnapshot = undefined;
    }
    if (blurPreservedTransaction !== transaction) {
      return;
    }
    blurPreservedTransaction = undefined;
    if (textarea.ownerDocument.activeElement !== textarea) {
      textarea.value = "";
    }
  };

  const readTransactionText = (
    transaction: CompositionTransaction,
    nextCompositionStart?: number
  ): string => {
    const start = Math.min(textarea.value.length, transaction.position.start);
    const valueEnd = Math.max(
      start,
      textarea.value.length - transaction.suffixLength
    );
    const end = Math.min(
      valueEnd,
      Math.max(start, nextCompositionStart ?? valueEnd)
    );
    return textarea.value.substring(start, end);
  };

  const transactionCommitText = (
    transaction: CompositionTransaction,
    observedText: string
  ): string => {
    const clearedRangePrefix = transaction.compositionRangeWasCleared
      ? hangulTransferPrefix(transaction.lastCompositionRangeText, observedText)
      : "";
    return `${transaction.displacedCompositionPrefix}${clearedRangePrefix}${observedText}`;
  };

  const emitTransactionData = (
    transaction: CompositionTransaction,
    data: string
  ): boolean => {
    if (transaction.status === "sent") {
      return true;
    }
    if (transaction.status === "cancelled") {
      return false;
    }
    if (data.length === 0) {
      return false;
    }
    const participant = participants.get(transaction);
    if (participant) {
      coordinator.resolveBeforeCommit(participant);
    }
    transaction.status = "sent";
    if (pending === transaction) {
      pending = undefined;
    }
    clearTransactionObservers(transaction);
    clearDocumentOwnership(transaction);
    syncHelperState();
    bypassKeypressInterception = true;
    try {
      coreService.triggerDataEvent(data, true);
    } finally {
      bypassKeypressInterception = false;
      finishBlurPreservation(transaction);
      transaction.settle({ status: "committed" });
    }
    return true;
  };

  const emitTransaction = (
    transaction: CompositionTransaction,
    nextCompositionStart?: number
  ): boolean => {
    return emitTransactionData(
      transaction,
      transactionCommitText(
        transaction,
        readTransactionText(transaction, nextCompositionStart)
      )
    );
  };

  const cancelTransaction = (
    transaction: CompositionTransaction,
    reason: CompositionAbortReason = "local-replacement"
  ): void => {
    if (transaction.status === "sent") {
      transaction.settle({ status: "committed" });
      return;
    }
    if (transaction.status === "cancelled") {
      transaction.settle({ status: "cancelled", reason });
      return;
    }
    transaction.status = "cancelled";
    if (pending === transaction) {
      pending = undefined;
    }
    clearTransactionObservers(transaction);
    clearDocumentOwnership(transaction);
    finishBlurPreservation(transaction);
    syncHelperState();
    transaction.settle({ status: "cancelled", reason });
  };

  const invalidateTransactions = (reason: CompositionAbortReason): void => {
    const activeTransactions = new Set<CompositionTransaction>();
    if (current) {
      activeTransactions.add(current);
    }
    if (pending) {
      activeTransactions.add(pending);
    }
    if (lastEnded) {
      activeTransactions.add(lastEnded);
    }
    for (const transaction of activeTransactions) {
      cancelTransaction(transaction, reason);
    }
    current = undefined;
    pending = undefined;
    lastEnded = undefined;
    synchronousCommitAwaitingInput = undefined;
    keypressCommitAwaitingInput = undefined;
    ownedInsertText = undefined;
    pendingBlurSnapshot = undefined;
    blurPreservedTransaction = undefined;
    foreignInsertTextSnapshot = undefined;
    foreignKeypressCommit = undefined;
    syncHelperState();
  };

  const claimDocumentOwnership = (
    transaction: CompositionTransaction
  ): void => {
    const existing = participants.get(transaction);
    if (existing) {
      return;
    }
    const participant: DocumentCompositionParticipant = {
      installationToken,
      transactionId: transaction.id,
      isPending() {
        return transaction.status === "pending";
      },
      tryCommitObserved() {
        if (transaction.status !== "pending") {
          return false;
        }
        return emitTransaction(transaction);
      },
      tryCommitText(data) {
        if (transaction.status !== "pending") {
          return false;
        }
        return (
          emitTransaction(transaction) ||
          emitTransactionData(
            transaction,
            transactionCommitText(transaction, data)
          )
        );
      },
      abortEmpty(reason) {
        cancelTransaction(transaction, reason);
      }
    };
    participants.set(transaction, participant);
    coordinator.register(participant);
  };

  const closeComposition = (waitForPropagation: boolean): void => {
    helper._compositionView.classList.remove("active");
    helper._isComposing = false;

    if (!waitForPropagation) {
      if (pending) {
        const transaction = pending;
        if (!emitTransaction(transaction)) {
          cancelTransaction(transaction);
        }
      }
      if (!current || current.status !== "composing") {
        return;
      }
      if (!emitTransaction(current)) {
        cancelTransaction(current);
      }
      return;
    }

    if (!current || current.status !== "composing") {
      if (current?.status === "sent") {
        synchronousCommitAwaitingInput = current;
        current = undefined;
      }
      return;
    }
    if (pending) {
      const transaction = pending;
      if (!emitTransaction(transaction)) {
        cancelTransaction(transaction);
      }
    }
    const transaction = current;
    transaction.status = "pending";
    current = undefined;
    pending = transaction;
    syncHelperState();
    claimDocumentOwnership(transaction);
    setTimeout(() => {
      if (
        !disposed &&
        pending === transaction &&
        keypressCommitAwaitingInput !== transaction &&
        ownedInsertText !== transaction
      ) {
        // This task boundary can observe a textarea commit, but an empty
        // focused textarea is not proof of cancellation. Chromium may deliver
        // the matching insertText in a later task while the textarea remains
        // focused. Explicit input-epoch and lifecycle boundaries abort empty
        // transactions once a later commit can no longer belong to them.
        emitTransaction(transaction);
      }
    }, 0);
  };

  const patchedCompositionStart = (): void => {
    coordinator.flushObservedForeign(installationToken);
    lastEnded = undefined;
    const position = compositionStartPosition(textarea);
    if (pending) {
      const transaction = pending;
      if (!emitTransaction(transaction, position.start)) {
        cancelTransaction(transaction);
      }
    }
    if (current?.status === "composing") {
      cancelTransaction(current);
    }
    synchronousCommitAwaitingInput = undefined;
    keypressCommitAwaitingInput = undefined;
    ownedInsertText = undefined;

    const transaction = createCompositionTransaction(
      coordinator.allocateTransactionId(),
      position,
      textarea.value.length - position.end
    );
    current = transaction;
    helper._isComposing = true;
    helper._compositionPosition = transaction.position;
    helper._compositionView.textContent = "";
    helper._dataAlreadySent = "";
    helper._compositionView.classList.add("active");
    syncHelperState();
  };

  const patchedCompositionUpdate = (
    event: Pick<CompositionEvent, "data">
  ): void => {
    const transaction = current;
    if (!transaction || transaction.status !== "composing") {
      return;
    }
    helper._compositionView.textContent = event.data;
    helper.updateCompositionElements();
    const position = transaction.position;
    setTimeout(() => {
      if (transaction.status === "cancelled") {
        return;
      }
      const selectionEnd = textarea.selectionEnd ?? textarea.value.length;
      position.end = Math.max(position.start, selectionEnd);
    }, 0);
  };

  const patchedCompositionEnd = (): void => {
    lastEnded = current ?? pending ?? lastEnded;
    closeComposition(true);
  };

  const patchedKeydown = (event: KeyboardEvent): boolean => {
    if (
      event.keyCode !== 16 &&
      event.keyCode !== 17 &&
      event.keyCode !== 18 &&
      event.keyCode !== 20 &&
      event.keyCode !== 21 &&
      event.keyCode !== 229
    ) {
      coordinator.resolveForeignBeforePhysicalInput(installationToken);
    }
    foreignInsertTextSnapshot = undefined;
    foreignKeypressCommit = undefined;
    synchronousCommitAwaitingInput = undefined;
    keypressCommitAwaitingInput = undefined;
    ownedInsertText = undefined;
    if (helper._isComposing || pending) {
      if (event.keyCode === 20 || event.keyCode === 229) {
        return false;
      }
      if (
        event.keyCode === 16 ||
        event.keyCode === 17 ||
        event.keyCode === 18
      ) {
        return false;
      }
      closeComposition(false);
    }

    if (event.keyCode === 229) {
      helper._handleAnyTextareaChanges();
      return false;
    }
    return true;
  };

  const consumeInputEvent = (event: InputEvent): boolean => {
    if (event.inputType !== "insertText") {
      return false;
    }
    if (pending) {
      const transaction = pending;
      if (!emitTransaction(transaction)) {
        if (!emitTransactionData(transaction, event.data ?? "")) {
          cancelTransaction(transaction, "unreadable-browser-input");
        }
      }
    } else if (ownedInsertText) {
      // The matching keypress or synchronous commit already emitted this
      // transaction. Consume only the duplicate browser observation.
    } else {
      const foreignSnapshot = foreignInsertTextSnapshot;
      foreignInsertTextSnapshot = undefined;
      const foreignOwner =
        !current && !helper._isComposing
          ? (foreignSnapshot?.owner ?? foreignDocumentOwner())
          : undefined;
      if (!foreignOwner || !coordinator.contains(foreignOwner)) {
        return false;
      }
      foreignKeypressCommit = undefined;
      const data = event.data ?? "";
      const emitted = foreignOwner.tryCommitText(data);
      if (!emitted && foreignOwner.isPending()) {
        foreignOwner.abortEmpty("unreadable-browser-input");
      }
      if (foreignSnapshot) {
        textarea.value = foreignSnapshot.value;
        if (
          foreignSnapshot.selectionStart !== null &&
          foreignSnapshot.selectionEnd !== null
        ) {
          textarea.setSelectionRange(
            foreignSnapshot.selectionStart,
            foreignSnapshot.selectionEnd
          );
        }
      } else if (data.length > 0) {
        const end = textarea.selectionStart ?? textarea.value.length;
        const start = Math.max(0, end - data.length);
        textarea.setRangeText("", start, end, "end");
      }
      core._unprocessedDeadKey = false;
      if (core.cancel) {
        core.cancel(event);
      } else {
        event.preventDefault();
        event.stopPropagation();
      }
      return true;
    }
    foreignInsertTextSnapshot = undefined;
    ownedInsertText = undefined;
    synchronousCommitAwaitingInput = undefined;
    keypressCommitAwaitingInput = undefined;
    core._unprocessedDeadKey = false;
    if (core.cancel) {
      core.cancel(event);
    } else {
      event.preventDefault();
      event.stopPropagation();
    }
    return true;
  };

  const handleBeforeInput = (event: InputEvent): void => {
    if (event.inputType !== "insertText") {
      foreignInsertTextSnapshot = undefined;
      foreignKeypressCommit = undefined;
      synchronousCommitAwaitingInput = undefined;
      keypressCommitAwaitingInput = undefined;
      ownedInsertText = undefined;
      return;
    }
    const foreignOwner = foreignDocumentOwner();
    if (foreignOwner && !current && !pending && !helper._isComposing) {
      foreignInsertTextSnapshot = {
        owner: foreignOwner,
        value: textarea.value,
        selectionStart: textarea.selectionStart,
        selectionEnd: textarea.selectionEnd
      };
      synchronousCommitAwaitingInput = undefined;
      keypressCommitAwaitingInput = undefined;
      ownedInsertText = undefined;
      return;
    }
    foreignInsertTextSnapshot = undefined;
    ownedInsertText =
      keypressCommitAwaitingInput ?? synchronousCommitAwaitingInput;
    keypressCommitAwaitingInput = undefined;
    synchronousCommitAwaitingInput = undefined;
  };

  const handleBlurCapture = (): void => {
    const transaction = pending;
    pendingBlurSnapshot =
      transaction?.status === "pending"
        ? {
            transaction,
            value: textarea.value,
            selectionStart: textarea.selectionStart,
            selectionEnd: textarea.selectionEnd
          }
        : undefined;
  };

  const handleBlurAfterXterm = (): void => {
    const snapshot = pendingBlurSnapshot;
    pendingBlurSnapshot = undefined;
    if (
      !snapshot ||
      pending !== snapshot.transaction ||
      snapshot.transaction.status !== "pending"
    ) {
      return;
    }
    // CoreBrowserTerminal clears the helper textarea in its blur listener.
    // Preserve the browser-observed transaction value until the matching
    // delayed finalize has read it, then clear it after the commit is sent.
    if (textarea.value.length === 0 && snapshot.value.length > 0) {
      textarea.value = snapshot.value;
      if (snapshot.selectionStart !== null && snapshot.selectionEnd !== null) {
        textarea.setSelectionRange(
          snapshot.selectionStart,
          snapshot.selectionEnd
        );
      }
      blurPreservedTransaction = snapshot.transaction;
    }
  };

  const patchedInputEvent = function (
    this: XtermBrowserCore,
    event: InputEvent
  ): boolean {
    const transaction = current;
    if (transaction?.status === "composing") {
      const rangeText = readTransactionText(transaction);
      if (event.inputType === "insertCompositionText") {
        if (rangeText.length > 0) {
          transaction.displacedCompositionPrefix += hangulTransferPrefix(
            transaction.lastCompositionRangeText,
            rangeText
          );
          transaction.lastCompositionRangeText = rangeText;
        }
        transaction.compositionRangeWasCleared = false;
      } else if (
        event.inputType === "deleteContentBackward" &&
        transaction.lastCompositionRangeText.length > 0 &&
        rangeText.length === 0
      ) {
        transaction.compositionRangeWasCleared = true;
      }
    }
    if (consumeInputEvent(event)) {
      return true;
    }
    return original.inputEvent.call(this, event);
  };

  const patchedKeyPress = function (
    this: XtermBrowserCore,
    event: KeyboardEvent
  ): boolean {
    interceptingKeypress = true;
    try {
      return original.keyPress.call(this, event);
    } finally {
      interceptingKeypress = false;
    }
  };

  const patchedTriggerDataEvent = function (
    this: XtermCoreService,
    data: string,
    wasUserInput?: boolean
  ): void {
    if (interceptingKeypress && !bypassKeypressInterception) {
      const foreignOwner = foreignDocumentOwner();
      if (
        foreignOwner &&
        coordinator.contains(foreignOwner) &&
        !current &&
        !pending &&
        !helper._isComposing
      ) {
        const observation: ForeignKeypressCommit = {
          owner: foreignOwner,
          data
        };
        foreignKeypressCommit = observation;
        setTimeout(() => {
          if (
            disposed ||
            foreignKeypressCommit !== observation ||
            !coordinator.contains(foreignOwner)
          ) {
            return;
          }
          foreignKeypressCommit = undefined;
          if (!foreignOwner.tryCommitText(data) && foreignOwner.isPending()) {
            foreignOwner.abortEmpty("unreadable-browser-input");
          }
        }, 0);
        return;
      }
    }
    if (interceptingKeypress && !bypassKeypressInterception && pending) {
      const transaction = pending;
      // keypress and insertText are two browser observations, not enough
      // information to decide how much text the pending commit owns. Defer
      // until input has updated the transaction's textarea range. This also
      // preserves intentional rollover repeats that extend that range.
      keypressCommitAwaitingInput = transaction;
      setTimeout(() => {
        if (
          disposed ||
          pending !== transaction ||
          keypressCommitAwaitingInput !== transaction
        ) {
          return;
        }
        keypressCommitAwaitingInput = undefined;
        if (!emitTransaction(transaction)) {
          emitTransactionData(transaction, data);
        }
      }, 0);
      return;
    }
    original.triggerDataEvent.call(this, data, wasUserInput);
  };

  helper.compositionstart = patchedCompositionStart;
  helper.compositionupdate = patchedCompositionUpdate;
  helper.compositionend = patchedCompositionEnd;
  helper.keydown = patchedKeydown;
  helper._finalizeComposition = closeComposition;
  core._inputEvent = patchedInputEvent;
  core._keyPress = patchedKeyPress;
  coreService.triggerDataEvent = patchedTriggerDataEvent;
  textarea.addEventListener("beforeinput", handleBeforeInput, true);
  textarea.addEventListener("blur", handleBlurCapture, true);
  textarea.addEventListener("blur", handleBlurAfterXterm);

  const installation: InstalledCompositionTransactions = {
    installed: true,
    currentTransaction() {
      return lastEnded ?? pending ?? current;
    },
    invalidate() {
      invalidateTransactions("owner-invalidated");
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      invalidateTransactions("disposed");
      textarea.removeEventListener("beforeinput", handleBeforeInput, true);
      textarea.removeEventListener("blur", handleBlurCapture, true);
      textarea.removeEventListener("blur", handleBlurAfterXterm);
      if (helper.compositionstart === patchedCompositionStart) {
        helper.compositionstart = original.compositionstart;
      }
      if (helper.compositionupdate === patchedCompositionUpdate) {
        helper.compositionupdate = original.compositionupdate;
      }
      if (helper.compositionend === patchedCompositionEnd) {
        helper.compositionend = original.compositionend;
      }
      if (helper.keydown === patchedKeydown) {
        helper.keydown = original.keydown;
      }
      if (helper._finalizeComposition === closeComposition) {
        helper._finalizeComposition = original.finalizeComposition;
      }
      if (core._inputEvent === patchedInputEvent) {
        core._inputEvent = original.inputEvent;
      }
      if (core._keyPress === patchedKeyPress) {
        core._keyPress = original.keyPress;
      }
      if (coreService.triggerDataEvent === patchedTriggerDataEvent) {
        coreService.triggerDataEvent = original.triggerDataEvent;
      }
      if (terminal.dispose === patchedTerminalDispose) {
        terminal.dispose = original.terminalDispose;
      }
      if (terminalCompositionInstallations.get(terminal) === installation) {
        terminalCompositionInstallations.delete(terminal);
      }
    }
  };

  const patchedTerminalDispose = function (this: Terminal): void {
    installation.dispose();
    original.terminalDispose.call(this);
  };
  terminal.dispose = patchedTerminalDispose;
  terminalCompositionInstallations.set(terminal, installation);

  return installation;
}

/** Small injectable boundary used by the terminal lifecycle and its tests. */
export const xtermCompositionTransactions = {
  install: installXtermCompositionTransactions,
  getSettlement: getXtermCompositionSettlement,
  invalidate: invalidateXtermCompositionTransactions
};
