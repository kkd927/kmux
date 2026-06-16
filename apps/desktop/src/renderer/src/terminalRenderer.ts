import {
  createXtermTheme,
  THEMES,
  type ColorTheme
} from "@kmux/ui";
import type { ImageAttachmentMimeType } from "@kmux/proto";
import type {
  CreateImageAttachmentPayload,
  CreateImageAttachmentsResult
} from "@kmux/proto";

export {
  resolveTerminalEnterRewrite,
  shouldDeferTerminalShortcutToIme,
  shouldSuppressXtermDuringIme,
  type TerminalEnterRewrite,
  type TerminalKeyboardEventLike
} from "../../terminalKeyboard";

export interface TerminalPasteHost {
  paste(data: string): void;
}

export interface PendingTerminalEnterRewrite {
  surfaceId: string;
  sequence: string;
}

export interface TerminalEnterRewriteResult {
  data: string;
  clearPending: boolean;
}

export interface TerminalImeDuplicateCommitGuard {
  compositionStart(textareaValue: string): void;
  compositionUpdate(text: string): void;
  compositionEnd(textareaValue: string, fallbackText?: string): string;
  reset(): void;
  filterData(data: string): string | null;
}

const SUPPORTED_IMAGE_MIME_TYPES = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp"
]);
const IME_DUPLICATE_COMMIT_WINDOW_MS = 1500;

export function createTerminalPaneXtermTheme(
  palette: Parameters<typeof createXtermTheme>[0],
  colorTheme: ColorTheme
): ReturnType<typeof createXtermTheme> {
  return {
    ...createXtermTheme(palette, colorTheme),
    background: THEMES[colorTheme].windowBg
  };
}

interface PasteClipboardIntoTerminalOptions {
  terminal: TerminalPasteHost;
  readClipboardText: () => string;
  surfaceId?: string;
  readClipboardImages?: () =>
    | CreateImageAttachmentPayload[]
    | Promise<CreateImageAttachmentPayload[]>;
  createImageAttachments?: (
    surfaceId: string,
    payloads: CreateImageAttachmentPayload[]
  ) => Promise<CreateImageAttachmentsResult>;
  onImageAttachmentStatus?: (message: string) => void;
  onImageAttachmentError?: (error: unknown) => void;
}

export async function pasteClipboardIntoTerminal(
  options: PasteClipboardIntoTerminalOptions
): Promise<boolean> {
  const imagePayloads = (await options.readClipboardImages?.()) ?? [];
  if (
    imagePayloads.length > 0 &&
    options.surfaceId &&
    options.createImageAttachments
  ) {
    try {
      const result = await options.createImageAttachments(
        options.surfaceId,
        imagePayloads
      );
      if (result.promptText) {
        options.terminal.paste(result.promptText);
        return true;
      }
      if (result.message) {
        options.onImageAttachmentStatus?.(result.message);
      }
    } catch (error) {
      options.onImageAttachmentError?.(error);
      options.onImageAttachmentStatus?.("Could not attach image");
    }
  }

  return pasteClipboardText(options);
}

function pasteClipboardText(options: PasteClipboardIntoTerminalOptions): boolean {
  const text = options.readClipboardText();
  if (!text) {
    return false;
  }

  options.terminal.paste(text);
  return true;
}

export function isSupportedImageMimeType(
  mimeType: string | null | undefined
): mimeType is ImageAttachmentMimeType {
  return Boolean(mimeType && SUPPORTED_IMAGE_MIME_TYPES.has(mimeType));
}

export function shouldUseImagePaste(input: {
  imageCount: number;
  text: string;
}): boolean {
  return input.imageCount > 0;
}

export function countSupportedImageFiles(
  files: ArrayLike<{ type: string | null | undefined }>
): number {
  return Array.from(files).filter((file) =>
    isSupportedImageMimeType(file.type)
  ).length;
}

export function applyPendingTerminalEnterRewrite(
  surfaceId: string,
  data: string,
  pending: PendingTerminalEnterRewrite | null
): TerminalEnterRewriteResult {
  if (!pending) {
    return { data, clearPending: false };
  }
  if (pending.surfaceId !== surfaceId) {
    return { data, clearPending: true };
  }
  const carriageReturnIndex = data.indexOf("\r");
  if (carriageReturnIndex < 0) {
    return { data, clearPending: false };
  }
  const escapeIndex = data.indexOf("\u001b");
  if (escapeIndex >= 0 && escapeIndex < carriageReturnIndex) {
    return { data, clearPending: true };
  }
  return {
    data:
      data.slice(0, carriageReturnIndex) +
      pending.sequence +
      data.slice(carriageReturnIndex + 1),
    clearPending: true
  };
}

export function createTerminalImeDuplicateCommitGuard(options: {
  now?: () => number;
  duplicateWindowMs?: number;
} = {}): TerminalImeDuplicateCommitGuard {
  const now = options.now ?? (() => performance.now());
  const duplicateWindowMs =
    options.duplicateWindowMs ?? IME_DUPLICATE_COMMIT_WINDOW_MS;
  let active = false;
  let startValue = "";
  let lastCompositionText = "";
  let endedCompositionText = "";
  let endedCommitText = "";
  let endedAt = 0;

  const hasImeText = (data: string): boolean => {
    for (const character of data) {
      const codePoint = character.codePointAt(0) ?? 0;
      if (codePoint > 0x7f && codePoint !== 0x7f) {
        return true;
      }
    }
    return false;
  };

  return {
    compositionStart(textareaValue: string): void {
      active = true;
      startValue = textareaValue;
      lastCompositionText = "";
      endedCompositionText = "";
      endedCommitText = "";
      endedAt = 0;
    },
    compositionUpdate(text: string): void {
      if (active) {
        lastCompositionText = text;
      }
    },
    compositionEnd(textareaValue: string, fallbackText = ""): string {
      active = false;
      endedAt = now();
      endedCompositionText = lastCompositionText;
      endedCommitText =
        insertedTextBetween(startValue, textareaValue) ||
        fallbackText ||
        endedCompositionText;
      startValue = textareaValue;
      lastCompositionText = "";
      return endedCommitText;
    },
    reset(): void {
      active = false;
      startValue = "";
      lastCompositionText = "";
      endedCompositionText = "";
      endedCommitText = "";
      endedAt = 0;
    },
    filterData(data: string): string | null {
      if (!data) {
        return null;
      }
      if (active) {
        return hasImeText(data) ? null : data;
      }
      if (!endedAt || now() - endedAt > duplicateWindowMs) {
        endedCompositionText = "";
        endedCommitText = "";
        endedAt = 0;
        return data;
      }

      if (!endedCommitText && !endedCompositionText && hasImeText(data)) {
        endedCommitText = data;
        return data;
      }

      let filtered = data;
      let consumedRecentCommit = false;
      for (const committedText of [endedCommitText, endedCompositionText]) {
        let consumedLength = consumedNormalizedPrefixLength(
          filtered,
          committedText
        );
        while (consumedLength > 0) {
          filtered = filtered.slice(consumedLength);
          consumedRecentCommit = true;
          consumedLength = consumedNormalizedPrefixLength(
            filtered,
            committedText
          );
        }
      }

      if (consumedRecentCommit) {
        return filtered || null;
      }

      if (
        isNormalizedPrefix(data, endedCommitText) ||
        isNormalizedPrefix(data, endedCompositionText)
      ) {
        return null;
      }

      if (!hasImeText(data)) {
        return data;
      }

      // If the incoming data is Korean but does not match the recently ended
      // composition, the user must have started a different Korean character.
      // Reset immediately so this new input is not blocked.
      endedCompositionText = "";
      endedCommitText = "";
      endedAt = 0;
      return data;
    }
  };
}

function normalizeTerminalImeText(value: string): string {
  return value.normalize("NFC");
}

function consumedNormalizedPrefixLength(
  input: string,
  committedText: string
): number {
  if (!input || !committedText) {
    return 0;
  }
  const normalizedCommittedText = normalizeTerminalImeText(committedText);
  let prefix = "";
  for (const character of input) {
    prefix += character;
    if (normalizeTerminalImeText(prefix) === normalizedCommittedText) {
      return prefix.length;
    }
  }
  return 0;
}

function isNormalizedPrefix(input: string, committedText: string): boolean {
  if (!input || !committedText) {
    return false;
  }
  return normalizeTerminalImeText(committedText).startsWith(
    normalizeTerminalImeText(input)
  );
}

function insertedTextBetween(previousValue: string, nextValue: string): string {
  if (!previousValue) {
    return nextValue;
  }
  let prefixLength = 0;
  while (
    prefixLength < previousValue.length &&
    prefixLength < nextValue.length &&
    previousValue[prefixLength] === nextValue[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < previousValue.length - prefixLength &&
    suffixLength < nextValue.length - prefixLength &&
    previousValue[previousValue.length - 1 - suffixLength] ===
      nextValue[nextValue.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  return nextValue.slice(
    prefixLength,
    suffixLength > 0 ? nextValue.length - suffixLength : nextValue.length
  );
}
