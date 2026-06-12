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

const SUPPORTED_IMAGE_MIME_TYPES = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp"
]);

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
