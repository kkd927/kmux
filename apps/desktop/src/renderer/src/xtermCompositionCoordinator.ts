export type CompositionAbortReason =
  | "disposed"
  | "document-deactivated"
  | "input-epoch-ended"
  | "local-replacement"
  | "new-physical-input"
  | "owner-invalidated"
  | "ordered-commit"
  | "unreadable-browser-input";

export interface DocumentCompositionParticipant {
  readonly installationToken: object;
  readonly transactionId: number;
  isPending(): boolean;
  tryCommitObserved(): boolean;
  tryCommitText(data: string): boolean;
  abortEmpty(reason: CompositionAbortReason): void;
}

/**
 * Orders the short interval where one xterm is settling a browser composition
 * while another xterm in the same document has already received focus.
 *
 * A settling transaction and a new composition are not mutually exclusive.
 * Participants therefore remain queued until they commit or explicitly abort;
 * registering or focusing another terminal never cancels an older transaction.
 */
export class DocumentCompositionCoordinator {
  private nextTransactionId = 0;
  private nextInputEpochId = 0;
  private readonly settling: DocumentCompositionParticipant[] = [];
  private readonly inputEpochByEvent = new WeakMap<Event, number>();
  private readonly participantInputEpoch = new WeakMap<
    DocumentCompositionParticipant,
    number
  >();
  private readonly activeInputEpochs: Array<{
    readonly event: Event;
    readonly id: number;
  }> = [];
  private observingInputEpoch = false;

  constructor(private readonly ownerDocument: Document) {
    // Capture input epochs for the coordinator's lifetime. A participant can
    // be registered by a target handler after capture but before the matching
    // document bubble listener runs, so installing this tracker only when a
    // transaction becomes pending would be too late for that event.
    this.ownerDocument.addEventListener(
      "keyup",
      this.handleInputEpochCapture,
      true
    );
    this.ownerDocument.addEventListener(
      "pointerup",
      this.handleInputEpochCapture,
      true
    );
    this.ownerDocument.addEventListener(
      "pointercancel",
      this.handleInputEpochCapture,
      true
    );
    this.ownerDocument.addEventListener(
      "click",
      this.handleInputEpochCapture,
      true
    );
  }

  private readonly handleInputEpochCapture = (event: Event): void => {
    this.nextInputEpochId += 1;
    const epoch = { event, id: this.nextInputEpochId };
    this.inputEpochByEvent.set(event, epoch.id);
    this.activeInputEpochs.push(epoch);

    // Event dispatch is synchronous. Keep nested dispatches as a stack and
    // release this marker only after every listener for the event has run.
    void Promise.resolve().then(() => {
      const index = this.activeInputEpochs.indexOf(epoch);
      if (index >= 0) {
        this.activeInputEpochs.splice(index, 1);
      }
    });
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    if (!event.isComposing) {
      this.resolveInputEpochBoundary("input-epoch-ended", event);
    }
  };

  private readonly handlePointerBoundary = (event: Event): void => {
    this.resolveInputEpochBoundary("input-epoch-ended", event);
  };

  private readonly handleDocumentDeactivated = (): void => {
    this.resolveInputEpochBoundary("document-deactivated");
  };

  private readonly handleVisibilityChange = (): void => {
    if (this.ownerDocument.visibilityState !== "visible") {
      this.handleDocumentDeactivated();
    }
  };

  allocateTransactionId(): number {
    this.nextTransactionId += 1;
    return this.nextTransactionId;
  }

  register(participant: DocumentCompositionParticipant): void {
    if (!this.settling.includes(participant)) {
      this.settling.push(participant);
      const inputEpoch = this.activeInputEpochs.at(-1);
      if (inputEpoch) {
        this.participantInputEpoch.set(participant, inputEpoch.id);
      }
      this.startObservingInputEpoch();
    }
  }

  unregister(participant: DocumentCompositionParticipant): void {
    const index = this.settling.indexOf(participant);
    if (index >= 0) {
      this.settling.splice(index, 1);
    }
    this.participantInputEpoch.delete(participant);
    if (this.settling.length === 0) {
      this.stopObservingInputEpoch();
    }
  }

  contains(participant: DocumentCompositionParticipant): boolean {
    return this.settling.includes(participant) && participant.isPending();
  }

  firstForeign(
    installationToken: object
  ): DocumentCompositionParticipant | undefined {
    return this.settling.find(
      (participant) =>
        participant.installationToken !== installationToken &&
        participant.isPending()
    );
  }

  /** Flushes only commits already observable at their originating textarea. */
  flushObservedForeign(installationToken: object): void {
    for (const participant of [...this.settling]) {
      if (
        participant.installationToken !== installationToken &&
        participant.isPending()
      ) {
        participant.tryCommitObserved();
      }
    }
  }

  /**
   * A real non-IME key starts a new browser input epoch. Resolve every older
   * foreign transaction before that key is allowed to emit. An empty
   * transaction may abort only after its originating textarea was checked.
   */
  resolveForeignBeforePhysicalInput(installationToken: object): void {
    for (const participant of [...this.settling]) {
      if (
        participant.installationToken === installationToken ||
        !participant.isPending()
      ) {
        continue;
      }
      if (!participant.tryCommitObserved() && participant.isPending()) {
        participant.abortEmpty("new-physical-input");
      }
    }
  }

  /**
   * A cancelled composition has no commit event to consume. The key/pointer
   * release (or document deactivation) is the observable end of that browser
   * input epoch: by then a matching insertText has either arrived or cannot
   * still belong to the ended composition. This gives empty transactions a
   * deterministic lifetime without guessing an elapsed timeout.
   */
  private resolveInputEpochBoundary(
    reason: CompositionAbortReason,
    event?: Event
  ): void {
    const boundaryEpoch = event
      ? this.inputEpochByEvent.get(event)
      : undefined;
    for (const participant of [...this.settling]) {
      if (!participant.isPending()) {
        continue;
      }
      // An empty composition can produce its matching insertText in a later
      // task. The physical event that created the participant therefore cannot
      // also prove that transaction was cancelled; only a later input epoch or
      // an explicit lifecycle boundary may abort it.
      if (
        boundaryEpoch !== undefined &&
        this.participantInputEpoch.get(participant) === boundaryEpoch
      ) {
        continue;
      }
      if (!participant.tryCommitObserved() && participant.isPending()) {
        participant.abortEmpty(reason);
      }
    }
  }

  private startObservingInputEpoch(): void {
    if (this.observingInputEpoch) {
      return;
    }
    this.observingInputEpoch = true;
    // Resolve at the bubbling boundary after target handlers have had a chance
    // to finish composition. The capture tracker distinguishes transactions
    // created by this event from transactions left pending by an older epoch.
    this.ownerDocument.addEventListener("keyup", this.handleKeyUp);
    this.ownerDocument.addEventListener(
      "pointerup",
      this.handlePointerBoundary
    );
    this.ownerDocument.addEventListener(
      "pointercancel",
      this.handlePointerBoundary
    );
    this.ownerDocument.addEventListener("click", this.handlePointerBoundary);
    this.ownerDocument.addEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
      true
    );
    this.ownerDocument.defaultView?.addEventListener(
      "blur",
      this.handleDocumentDeactivated,
      true
    );
  }

  private stopObservingInputEpoch(): void {
    if (!this.observingInputEpoch) {
      return;
    }
    this.observingInputEpoch = false;
    this.ownerDocument.removeEventListener("keyup", this.handleKeyUp);
    this.ownerDocument.removeEventListener(
      "pointerup",
      this.handlePointerBoundary
    );
    this.ownerDocument.removeEventListener(
      "pointercancel",
      this.handlePointerBoundary
    );
    this.ownerDocument.removeEventListener("click", this.handlePointerBoundary);
    this.ownerDocument.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
      true
    );
    this.ownerDocument.defaultView?.removeEventListener(
      "blur",
      this.handleDocumentDeactivated,
      true
    );
  }

  /** Preserve document observation order before a later transaction commits. */
  resolveBeforeCommit(participant: DocumentCompositionParticipant): void {
    const participantIndex = this.settling.indexOf(participant);
    if (participantIndex <= 0) {
      return;
    }
    for (const earlier of [...this.settling.slice(0, participantIndex)]) {
      if (!earlier.isPending()) {
        continue;
      }
      if (!earlier.tryCommitObserved() && earlier.isPending()) {
        earlier.abortEmpty("ordered-commit");
      }
    }
  }
}

const documentCoordinators = new WeakMap<
  Document,
  DocumentCompositionCoordinator
>();

export function documentCompositionCoordinator(
  ownerDocument: Document
): DocumentCompositionCoordinator {
  const existing = documentCoordinators.get(ownerDocument);
  if (existing) {
    return existing;
  }
  const coordinator = new DocumentCompositionCoordinator(ownerDocument);
  documentCoordinators.set(ownerDocument, coordinator);
  return coordinator;
}
