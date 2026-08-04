// @vitest-environment jsdom

import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getXtermCompositionSettlement,
  invalidateXtermCompositionTransactions,
  installXtermCompositionTransactions
} from "./xtermCompositionTransactions";

interface FakeCompositionHelper {
  _textarea: HTMLTextAreaElement;
  _compositionView: HTMLElement;
  _compositionPosition: { start: number; end: number };
  _isComposing: boolean;
  _isSendingComposition: boolean;
  _dataAlreadySent: string;
  _coreService: { triggerDataEvent(data: string): void };
  compositionstart(): void;
  compositionupdate(event: Pick<CompositionEvent, "data">): void;
  compositionend(): void;
  keydown(event: KeyboardEvent): boolean;
  _finalizeComposition(waitForPropagation: boolean): void;
  _handleAnyTextareaChanges(): void;
  updateCompositionElements(): void;
}

interface FakeCore {
  _compositionHelper: FakeCompositionHelper;
  _inputEvent(event: InputEvent): boolean;
  _keyPress(event: KeyboardEvent): boolean;
  _keyPressHandled: boolean;
  _unprocessedDeadKey: boolean;
  cancel(event: Event): boolean;
}

interface Harness {
  terminal: Terminal;
  textarea: HTMLTextAreaElement;
  helper: FakeCompositionHelper;
  core: FakeCore;
  emitted: string[];
}

function createHarness(
  options: { clearTextareaOnBlur?: boolean } = {}
): Harness {
  const textarea = document.createElement("textarea");
  const compositionView = document.createElement("div");
  const emitted: string[] = [];
  const coreService = {
    triggerDataEvent(data: string) {
      emitted.push(data);
    }
  };
  const helper: FakeCompositionHelper = {
    _textarea: textarea,
    _compositionView: compositionView,
    _compositionPosition: { start: 0, end: 0 },
    _isComposing: false,
    _isSendingComposition: false,
    _dataAlreadySent: "",
    _coreService: coreService,
    compositionstart: vi.fn(),
    compositionupdate: vi.fn(),
    compositionend: vi.fn(),
    keydown: vi.fn(() => true),
    _finalizeComposition: vi.fn(),
    _handleAnyTextareaChanges: vi.fn(),
    updateCompositionElements: vi.fn()
  };
  const core: FakeCore = {
    _compositionHelper: helper,
    _keyPressHandled: false,
    _unprocessedDeadKey: false,
    _inputEvent(event) {
      if (event.inputType === "insertText" && event.data) {
        if (core._keyPressHandled) {
          return false;
        }
        coreService.triggerDataEvent(event.data);
        return true;
      }
      return false;
    },
    _keyPress(event) {
      if (!event.key) {
        return false;
      }
      coreService.triggerDataEvent(event.key);
      core._keyPressHandled = true;
      return true;
    },
    cancel: vi.fn(() => true)
  };
  const terminal = {
    _core: core,
    textarea,
    element: document.createElement("div"),
    dispose: vi.fn()
  } as unknown as Terminal;
  if (options.clearTextareaOnBlur) {
    textarea.addEventListener("blur", () => {
      textarea.value = "";
    });
  }
  const installation = installXtermCompositionTransactions(terminal);
  expect(installation.installed).toBe(true);
  return { terminal, textarea, helper, core, emitted };
}

function setCaret(textarea: HTMLTextAreaElement, position: number): void {
  textarea.selectionStart = position;
  textarea.selectionEnd = position;
}

function beginComposition(
  harness: Harness,
  committedPrefix: string,
  preedit: string
): void {
  harness.textarea.value = committedPrefix;
  setCaret(harness.textarea, committedPrefix.length);
  harness.helper.compositionstart();
  harness.helper.compositionupdate({ data: preedit });
  harness.textarea.value = `${committedPrefix}${preedit}`;
  setCaret(harness.textarea, harness.textarea.value.length);
}

function sendInsertText(harness: Harness, data: string): boolean {
  harness.textarea.dispatchEvent(
    new InputEvent("beforeinput", {
      bubbles: true,
      data,
      inputType: "insertText"
    })
  );
  return harness.core._inputEvent(
    new InputEvent("input", {
      bubbles: true,
      data,
      inputType: "insertText"
    })
  );
}

describe("xterm composition transactions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconciles compositionend and insertText as one commit", () => {
    const harness = createHarness();
    beginComposition(harness, "", "한");

    harness.helper.compositionend();
    expect(sendInsertText(harness, "한")).toBe(true);
    vi.runAllTimers();

    expect(harness.emitted).toEqual(["한"]);
  });

  it("delegates insertText when no composition transaction owns it", () => {
    const harness = createHarness();

    expect(sendInsertText(harness, "plain")).toBe(true);

    expect(harness.emitted).toEqual(["plain"]);
  });

  it("commits from the propagated textarea when insertText is absent", () => {
    const harness = createHarness();
    beginComposition(harness, "", "日");

    harness.helper.compositionend();
    vi.runAllTimers();

    expect(harness.emitted).toEqual(["日"]);
  });

  it("preserves a pending commit across xterm's surface-handoff blur clear", () => {
    const harness = createHarness({ clearTextareaOnBlur: true });
    beginComposition(harness, "", "대");
    harness.textarea.value = "데";
    setCaret(harness.textarea, 1);

    harness.helper.compositionend();
    harness.textarea.dispatchEvent(new FocusEvent("blur"));
    vi.runAllTimers();

    expect(harness.emitted).toEqual(["데"]);
    expect(harness.textarea.value).toBe("");
  });

  it("keeps an empty handoff transaction open for a later insertText", () => {
    const harness = createHarness();
    beginComposition(harness, "", "른");
    harness.textarea.value = "";
    setCaret(harness.textarea, 0);

    harness.helper.compositionend();
    vi.runAllTimers();
    expect(harness.emitted).toEqual([]);

    harness.textarea.value = "른";
    setCaret(harness.textarea, 1);
    expect(sendInsertText(harness, "른")).toBe(true);

    expect(harness.emitted).toEqual(["른"]);
  });

  it("keeps a focused empty transaction open for a later insertText task", async () => {
    const harness = createHarness();
    document.body.appendChild(harness.textarea);
    harness.textarea.focus();
    beginComposition(harness, "", "번");
    harness.helper.compositionupdate({ data: "" });
    harness.textarea.value = "";
    setCaret(harness.textarea, 0);
    harness.core._inputEvent(
      new InputEvent("input", {
        data: null,
        inputType: "deleteContentBackward"
      })
    );
    harness.helper.compositionend();
    const settlement = getXtermCompositionSettlement(harness.terminal);
    expect(settlement).not.toBeNull();
    let settlementResult: unknown;
    settlement!.onSettled((result) => {
      settlementResult = result;
    });

    vi.runAllTimers();
    expect(settlementResult).toBeUndefined();

    harness.textarea.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        data: "번",
        inputType: "insertText"
      })
    );
    harness.textarea.value = "번";
    setCaret(harness.textarea, 1);
    expect(
      harness.core._inputEvent(
        new InputEvent("input", {
          bubbles: true,
          data: "번",
          inputType: "insertText"
        })
      )
    ).toBe(true);

    beginComposition(harness, "번", "째");
    harness.helper.compositionend();
    expect(sendInsertText(harness, "째")).toBe(true);
    vi.runAllTimers();

    await expect(settlement!.promise).resolves.toEqual({
      status: "committed"
    });
    expect(harness.emitted).toEqual(["번", "째"]);
    harness.textarea.remove();
    harness.terminal.dispose();
  });

  it("aborts an empty cancelled composition at the input epoch boundary", async () => {
    const harness = createHarness();
    beginComposition(harness, "", "취소");
    harness.textarea.value = "";
    setCaret(harness.textarea, 0);

    harness.helper.compositionend();
    const settlement = getXtermCompositionSettlement(harness.terminal);
    let settled = false;
    settlement?.onSettled(() => {
      settled = true;
    });
    vi.runAllTimers();

    expect(settled).toBe(false);
    document.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        bubbles: true
      })
    );
    await settlement?.promise;

    expect(settled).toBe(true);
    expect(harness.emitted).toEqual([]);
    expect(harness.helper._isSendingComposition).toBe(false);
    harness.terminal.dispose();
  });

  it("keeps a transaction created by a click open for later insertText", async () => {
    const harness = createHarness();
    beginComposition(harness, "", "번");
    harness.textarea.value = "";
    setCaret(harness.textarea, 0);
    const target = document.createElement("button");
    document.body.appendChild(target);
    target.addEventListener(
      "click",
      () => {
        harness.helper.compositionend();
      },
      { once: true }
    );

    target.click();
    const settlement = getXtermCompositionSettlement(harness.terminal);
    expect(settlement).not.toBeNull();
    let settled = false;
    settlement!.onSettled(() => {
      settled = true;
    });

    await vi.runAllTimersAsync();
    expect(settled).toBe(false);

    harness.textarea.value = "번";
    setCaret(harness.textarea, 1);
    expect(sendInsertText(harness, "번")).toBe(true);

    await expect(settlement!.promise).resolves.toEqual({
      status: "committed"
    });
    expect(harness.emitted).toEqual(["번"]);
    target.remove();
    harness.terminal.dispose();
  });

  it("settles an empty transaction at a later click boundary", async () => {
    const harness = createHarness();
    beginComposition(harness, "", "취소");
    harness.textarea.value = "";
    setCaret(harness.textarea, 0);
    const target = document.createElement("button");
    document.body.appendChild(target);
    target.addEventListener(
      "click",
      () => {
        harness.helper.compositionend();
      },
      { once: true }
    );

    target.click();
    const settlement = getXtermCompositionSettlement(harness.terminal);
    expect(settlement).not.toBeNull();
    let settled = false;
    settlement!.onSettled(() => {
      settled = true;
    });
    expect(settled).toBe(false);

    target.click();

    await expect(settlement!.promise).resolves.toEqual({
      status: "cancelled",
      reason: "input-epoch-ended"
    });
    expect(harness.emitted).toEqual([]);
    target.remove();
    harness.terminal.dispose();
  });

  it("reports explicit owner invalidation when a session is discarded", async () => {
    const harness = createHarness();
    beginComposition(harness, "", "이전");
    harness.textarea.value = "";
    setCaret(harness.textarea, 0);
    harness.helper.compositionend();
    const settlement = getXtermCompositionSettlement(harness.terminal);
    expect(settlement).not.toBeNull();

    invalidateXtermCompositionTransactions(harness.terminal);

    await expect(settlement!.promise).resolves.toEqual({
      status: "cancelled",
      reason: "owner-invalidated"
    });
    expect(harness.emitted).toEqual([]);
    harness.terminal.dispose();
  });

  it("routes a post-handoff insertText to its originating transaction", async () => {
    const origin = createHarness();
    beginComposition(origin, "", "녕");
    origin.textarea.value = "";
    setCaret(origin.textarea, 0);
    origin.helper.compositionend();
    const settlement = getXtermCompositionSettlement(origin.terminal);
    expect(settlement).not.toBeNull();

    vi.runAllTimers();
    expect(origin.emitted).toEqual([]);

    const destination = createHarness();
    expect(
      destination.core._keyPress(
        new KeyboardEvent("keypress", { key: "녕", bubbles: true })
      )
    ).toBe(true);
    expect(destination.emitted).toEqual([]);
    destination.textarea.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        data: "녕",
        inputType: "insertText"
      })
    );
    destination.textarea.value = "녕";
    setCaret(destination.textarea, 1);
    expect(
      destination.core._inputEvent(
        new InputEvent("input", {
          bubbles: true,
          data: "녕",
          inputType: "insertText"
        })
      )
    ).toBe(true);
    await settlement!.promise;

    expect(origin.emitted).toEqual(["녕"]);
    expect(destination.emitted).toEqual([]);
    expect(destination.textarea.value).toBe("");
    expect(destination.core.cancel).toHaveBeenCalledOnce();
    origin.terminal.dispose();
    destination.terminal.dispose();
  });

  it("flushes the origin before a destination physical keydown", async () => {
    const origin = createHarness();
    beginComposition(origin, "", "녕");
    origin.helper.compositionend();
    const settlement = getXtermCompositionSettlement(origin.terminal);

    const destination = createHarness();
    expect(
      destination.helper.keydown(
        new KeyboardEvent("keydown", {
          key: "a",
          code: "KeyA",
          keyCode: 65,
          bubbles: true
        })
      )
    ).toBe(true);
    expect(origin.emitted).toEqual(["녕"]);
    expect(
      destination.core._keyPress(
        new KeyboardEvent("keypress", { key: "a", bubbles: true })
      )
    ).toBe(true);
    vi.runAllTimers();
    await settlement?.promise;

    expect(origin.emitted).toEqual(["녕"]);
    expect(destination.emitted).toEqual(["a"]);
    origin.terminal.dispose();
    destination.terminal.dispose();
  });

  it("flushes an observed origin before a destination composition starts", () => {
    const origin = createHarness();
    beginComposition(origin, "", "옛");
    origin.helper.compositionend();

    const destination = createHarness();
    destination.helper.compositionstart();

    expect(origin.emitted).toEqual(["옛"]);
    expect(destination.emitted).toEqual([]);
    origin.terminal.dispose();
    destination.terminal.dispose();
  });

  it("allows an empty origin settlement and a new composition to coexist", () => {
    const origin = createHarness();
    beginComposition(origin, "", "녕");
    origin.textarea.value = "";
    setCaret(origin.textarea, 0);
    origin.helper.compositionend();

    const destination = createHarness();
    beginComposition(destination, "", "새");
    expect(origin.emitted).toEqual([]);

    origin.textarea.value = "녕";
    setCaret(origin.textarea, 1);
    vi.runAllTimers();
    expect(origin.emitted).toEqual(["녕"]);

    destination.helper.compositionend();
    expect(sendInsertText(destination, "새")).toBe(true);
    vi.runAllTimers();

    expect(origin.emitted).toEqual(["녕"]);
    expect(destination.emitted).toEqual(["새"]);
    origin.terminal.dispose();
    destination.terminal.dispose();
  });

  it("notifies lifecycle ownership synchronously after emitting the commit", () => {
    const harness = createHarness();
    beginComposition(harness, "", "한");
    harness.helper.compositionend();
    const settlement = getXtermCompositionSettlement(harness.terminal);
    let observedAtSettlement: string[] | undefined;
    settlement?.onSettled(() => {
      observedAtSettlement = [...harness.emitted];
    });

    expect(
      harness.helper.keydown(
        new KeyboardEvent("keydown", { key: " ", keyCode: 32 })
      )
    ).toBe(true);

    expect(observedAtSettlement).toEqual(["한"]);
  });

  it("reconciles keypress and insertText observations of one commit", () => {
    const harness = createHarness();
    beginComposition(harness, "", "日本");
    harness.helper.compositionend();

    expect(
      harness.core._keyPress(
        new KeyboardEvent("keypress", { key: "日本", bubbles: true })
      )
    ).toBe(true);
    expect(sendInsertText(harness, "日本")).toBe(true);
    vi.runAllTimers();

    expect(harness.emitted).toEqual(["日本"]);
  });

  it("preserves a following repeated keypress after the pending key is released", () => {
    const harness = createHarness();
    beginComposition(harness, "", "ㅋ");
    harness.helper.compositionend();
    harness.textarea.dispatchEvent(
      new KeyboardEvent("keyup", { key: "z", code: "KeyZ", bubbles: true })
    );

    expect(
      harness.core._keyPress(
        new KeyboardEvent("keypress", { key: "ㅋ", bubbles: true })
      )
    ).toBe(true);
    harness.textarea.value = "ㅋㅋ";
    setCaret(harness.textarea, 2);
    expect(sendInsertText(harness, "ㅋ")).toBe(true);
    vi.runAllTimers();

    expect(harness.emitted.join("")).toBe("ㅋㅋ");
  });

  it("preserves rollover input observed before compositionend and after keypress", () => {
    const harness = createHarness();
    beginComposition(harness, "ㅋㅋ", "ㅋ");
    harness.core._inputEvent(
      new InputEvent("input", {
        data: "ㅋ",
        inputType: "insertCompositionText"
      })
    );
    harness.textarea.dispatchEvent(
      new KeyboardEvent("keyup", { key: "z", code: "KeyZ", bubbles: true })
    );
    harness.core._inputEvent(
      new InputEvent("input", {
        data: "ㅋ",
        inputType: "insertCompositionText"
      })
    );
    harness.helper.compositionend();

    expect(
      harness.core._keyPress(
        new KeyboardEvent("keypress", { key: "ㅋ", bubbles: true })
      )
    ).toBe(true);
    harness.textarea.value = "ㅋㅋㅋㅋ";
    setCaret(harness.textarea, 4);
    expect(sendInsertText(harness, "ㅋ")).toBe(true);
    vi.runAllTimers();

    expect(harness.emitted.join("")).toBe("ㅋㅋ");
  });

  it("preserves repeated identical commits from distinct transactions", () => {
    const harness = createHarness();
    let prefix = "";
    for (let index = 0; index < 3; index += 1) {
      beginComposition(harness, prefix, "한");
      prefix += "한";
      harness.helper.compositionend();
      expect(sendInsertText(harness, "한")).toBe(true);
    }
    vi.runAllTimers();

    expect(harness.emitted).toEqual(["한", "한", "한"]);
  });

  it("makes an old delayed callback inert after a synchronous commit", () => {
    const harness = createHarness();
    beginComposition(harness, "", "빠");
    harness.helper.compositionend();

    expect(
      harness.helper.keydown(
        new KeyboardEvent("keydown", { key: " ", keyCode: 32 })
      )
    ).toBe(true);
    harness.helper._coreService.triggerDataEvent(" ");
    beginComposition(harness, "빠 ", "연");
    harness.helper.compositionend();
    vi.runAllTimers();

    expect(harness.emitted).toEqual(["빠", " ", "연"]);
  });

  it("uses the next composition boundary for Hangul final-consonant transfer", () => {
    const harness = createHarness();
    beginComposition(harness, "", "텟");
    harness.helper.compositionend();

    harness.textarea.value = "테";
    setCaret(harness.textarea, 1);
    harness.helper.compositionstart();
    harness.helper.compositionupdate({ data: "스" });
    harness.textarea.value = "테스";
    setCaret(harness.textarea, 2);
    harness.helper.compositionend();
    expect(sendInsertText(harness, "스")).toBe(true);
    vi.runAllTimers();

    expect(harness.emitted.join("")).toBe("테스");
  });

  it("keeps a continuous Hangul transfer independent of stale helper diff state", () => {
    const harness = createHarness();
    beginComposition(harness, "", "으");
    harness.core._inputEvent(
      new InputEvent("input", {
        data: "으",
        inputType: "insertCompositionText"
      })
    );

    harness.helper.compositionupdate({ data: "을" });
    harness.textarea.value = "을";
    setCaret(harness.textarea, 1);
    harness.core._inputEvent(
      new InputEvent("input", {
        data: "을",
        inputType: "insertCompositionText"
      })
    );

    // A delayed xterm textarea-diff observation belongs to the earlier browser
    // event that created it, not to this composition transaction.
    harness.helper._dataAlreadySent = "으";
    harness.helper.compositionupdate({ data: "로" });
    harness.textarea.value = "으로";
    setCaret(harness.textarea, 2);
    harness.core._inputEvent(
      new InputEvent("input", {
        data: "로",
        inputType: "insertCompositionText"
      })
    );
    harness.helper.compositionend();
    vi.runAllTimers();

    expect(harness.emitted).toEqual(["으로"]);
  });

  it("retains a Hangul syllable displaced inside one composition", () => {
    const harness = createHarness();
    beginComposition(harness, "", "누");
    harness.core._inputEvent(
      new InputEvent("input", {
        data: "누",
        inputType: "insertCompositionText"
      })
    );

    harness.helper.compositionupdate({ data: "눅" });
    harness.textarea.value = "눅";
    setCaret(harness.textarea, 1);
    harness.core._inputEvent(
      new InputEvent("input", {
        data: "눅",
        inputType: "insertCompositionText"
      })
    );

    harness.helper.compositionupdate({ data: "고" });
    harness.textarea.value = "고";
    setCaret(harness.textarea, 1);
    harness.core._inputEvent(
      new InputEvent("input", {
        data: "고",
        inputType: "insertCompositionText"
      })
    );
    harness.helper.compositionend();
    vi.runAllTimers();

    expect(harness.emitted).toEqual(["누고"]);
  });

  it("does not reinterpret a compound-final edit as a syllable transfer", () => {
    const harness = createHarness();
    beginComposition(harness, "", "느");
    harness.core._inputEvent(
      new InputEvent("input", {
        data: "느",
        inputType: "insertCompositionText"
      })
    );

    for (const preedit of ["는", "늕", "는"]) {
      harness.helper.compositionupdate({ data: preedit });
      harness.textarea.value = preedit;
      setCaret(harness.textarea, 1);
      harness.core._inputEvent(
        new InputEvent("input", {
          data: preedit,
          inputType: "insertCompositionText"
        })
      );
    }
    harness.helper.compositionend();
    vi.runAllTimers();

    expect(harness.emitted).toEqual(["는"]);
  });

  it("recovers a Hangul syllable committed inside an empty composition boundary", () => {
    const harness = createHarness();
    beginComposition(harness, "", "유");
    harness.core._inputEvent(
      new InputEvent("input", {
        data: "유",
        inputType: "insertCompositionText"
      })
    );

    harness.helper.compositionupdate({ data: "율" });
    harness.textarea.value = "율";
    setCaret(harness.textarea, 1);
    harness.core._inputEvent(
      new InputEvent("input", {
        data: "율",
        inputType: "insertCompositionText"
      })
    );

    harness.helper.compositionupdate({ data: "" });
    harness.textarea.value = "";
    setCaret(harness.textarea, 0);
    harness.core._inputEvent(
      new InputEvent("input", {
        data: null,
        inputType: "deleteContentBackward"
      })
    );
    harness.helper.compositionend();

    harness.textarea.value = "로";
    setCaret(harness.textarea, 1);
    expect(sendInsertText(harness, "로")).toBe(true);
    vi.runAllTimers();

    expect(harness.emitted).toEqual(["유로"]);
  });

  it("retains the first consonant of a split compound Hangul final", () => {
    const harness = createHarness();
    beginComposition(harness, "", "읽");
    harness.core._inputEvent(
      new InputEvent("input", {
        data: "읽",
        inputType: "insertCompositionText"
      })
    );

    harness.helper.compositionupdate({ data: "" });
    harness.textarea.value = "";
    setCaret(harness.textarea, 0);
    harness.core._inputEvent(
      new InputEvent("input", {
        data: null,
        inputType: "deleteContentBackward"
      })
    );
    harness.helper.compositionend();

    harness.textarea.value = "거";
    setCaret(harness.textarea, 1);
    expect(sendInsertText(harness, "거")).toBe(true);
    vi.runAllTimers();

    expect(harness.emitted).toEqual(["일거"]);
  });

  it("does not reinterpret an ordinary empty-boundary Hangul commit", () => {
    const harness = createHarness();
    beginComposition(harness, "", "는");
    harness.core._inputEvent(
      new InputEvent("input", {
        data: "는",
        inputType: "insertCompositionText"
      })
    );

    harness.helper.compositionupdate({ data: "" });
    harness.textarea.value = "";
    setCaret(harness.textarea, 0);
    harness.core._inputEvent(
      new InputEvent("input", {
        data: null,
        inputType: "deleteContentBackward"
      })
    );
    harness.helper.compositionend();

    harness.textarea.value = "는";
    setCaret(harness.textarea, 1);
    expect(sendInsertText(harness, "는")).toBe(true);
    vi.runAllTimers();

    expect(harness.emitted).toEqual(["는"]);
  });

  it("does not duplicate a retained base syllable at a rollover boundary", () => {
    const harness = createHarness();
    beginComposition(harness, "", "앙");
    harness.core._inputEvent(
      new InputEvent("input", {
        data: "앙",
        inputType: "insertCompositionText"
      })
    );

    harness.helper.compositionupdate({ data: "" });
    harness.textarea.value = "";
    setCaret(harness.textarea, 0);
    harness.core._inputEvent(
      new InputEvent("input", {
        data: null,
        inputType: "deleteContentBackward"
      })
    );
    harness.helper.compositionend();

    harness.textarea.value = "아";
    setCaret(harness.textarea, 1);
    expect(sendInsertText(harness, "아")).toBe(true);
    vi.runAllTimers();

    expect(harness.emitted).toEqual(["아"]);
  });

  it("isolates a new composition from retained textarea prefix and suffix", () => {
    const harness = createHarness();
    harness.textarea.value = "데";
    setCaret(harness.textarea, 0);

    harness.helper.compositionstart();
    harness.helper.compositionupdate({ data: "근" });
    harness.textarea.setRangeText("근");
    harness.helper.compositionend();
    vi.runAllTimers();

    expect(harness.textarea.value).toBe("근데");
    expect(harness.emitted).toEqual(["근"]);
  });

  it("preserves Hangul, ASCII, Hangul, Space, and Enter order", () => {
    const harness = createHarness();
    beginComposition(harness, "", "한");
    harness.helper.compositionend();
    sendInsertText(harness, "한");

    harness.core._keyPress(
      new KeyboardEvent("keypress", { key: "a", bubbles: true })
    );
    beginComposition(harness, "한a", "글");
    harness.helper.compositionend();
    sendInsertText(harness, "글");

    beginComposition(harness, "한a글", "공");
    harness.helper.compositionend();
    harness.helper.keydown(
      new KeyboardEvent("keydown", { key: " ", keyCode: 32 })
    );
    harness.helper._coreService.triggerDataEvent(" ");
    beginComposition(harness, "한a글공 ", "백");
    harness.helper.compositionend();
    harness.helper.keydown(
      new KeyboardEvent("keydown", { key: "Enter", keyCode: 13 })
    );
    harness.helper._coreService.triggerDataEvent("\r");
    vi.runAllTimers();

    expect(harness.emitted.join("")).toBe("한a글공 백\r");
  });

  it("cancels a disposed terminal's pending transaction", () => {
    const oldHarness = createHarness();
    beginComposition(oldHarness, "", "이전");
    oldHarness.helper.compositionend();
    oldHarness.terminal.dispose();

    const replacementHarness = createHarness();
    beginComposition(replacementHarness, "", "새");
    replacementHarness.helper.compositionend();
    vi.runAllTimers();

    expect(oldHarness.emitted).toEqual([]);
    expect(replacementHarness.emitted).toEqual(["새"]);
  });
});
