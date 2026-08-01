import type {
  Id,
  SessionRuntimeState,
  SurfaceStorageStatusVm,
  WorkspaceGitRepositoryMetadata
} from "../index";

export type SurfaceKind = "terminal" | "markdown";

export interface SurfaceVmCommon {
  id: Id;
  paneId: Id;
  title: string;
  titleLocked: boolean;
  unreadCount: number;
  attention: boolean;
}

export interface TerminalRuntimeMetadataDto {
  cwd?: string;
  branch?: string;
  gitRepository?: WorkspaceGitRepositoryMetadata;
  ports: number[];
}

export interface TerminalSurfaceVmContent {
  kind: "terminal";
  sessionId: Id;
  runtimeStatus: SessionRuntimeState;
  shellInputReady: boolean;
  exitCode?: number;
  storageStatus?: SurfaceStorageStatusVm;
  runtimeMetadata: TerminalRuntimeMetadataDto;
}

export interface MarkdownSurfaceVmContent {
  kind: "markdown";
}

export type SurfaceVmContentMap = {
  terminal: TerminalSurfaceVmContent;
  markdown: MarkdownSurfaceVmContent;
};

export type SurfaceVm<K extends SurfaceKind = SurfaceKind> = SurfaceVmCommon & {
  content: SurfaceVmContentMap[K];
};

export function requireTerminalSurfaceVmContent(
  surface: SurfaceVm
): TerminalSurfaceVmContent {
  if (surface.content.kind !== "terminal") {
    throw new TypeError(`Surface ${surface.id} is not a Terminal Surface`);
  }
  return surface.content;
}

export function terminalSurfaceVmContent(
  surface: SurfaceVm | null | undefined
): TerminalSurfaceVmContent | undefined {
  return surface?.content.kind === "terminal" ? surface.content : undefined;
}

export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
export const MAX_MARKDOWN_IMAGE_SOURCES = 64;
export const MAX_MARKDOWN_IMAGE_SOURCE_LENGTH = 4 * 1024;
export const MAX_MARKDOWN_IMAGE_DATA_URL_LENGTH = 12 * 1024 * 1024;
export const MAX_MARKDOWN_IMAGE_SOURCES_TOTAL_LENGTH = 48 * 1024 * 1024;

export type MarkdownImageSources = Readonly<Record<string, string>>;

export interface MarkdownDocumentSubscriptionDto {
  surfaceId: Id;
}

export interface TerminalFileLinkActivationDto {
  sourceSurfaceId: Id;
  rawPath: string;
  baseCwd?: string;
}

export type MarkdownDocumentErrorCode =
  | "missing"
  | "too-large"
  | "invalid-encoding"
  | "read-failed";

export type MarkdownDocumentEvent =
  | { type: "loading"; surfaceId: Id; revision: number }
  | {
      type: "snapshot";
      surfaceId: Id;
      revision: number;
      text: string;
      byteLength: number;
      imageSources?: MarkdownImageSources;
    }
  | { type: "offline"; surfaceId: Id; revision: number }
  | {
      type: "error";
      surfaceId: Id;
      revision: number;
      errorCode: MarkdownDocumentErrorCode;
    };

export function decodeMarkdownDocumentSubscriptionDto(
  value: unknown
): MarkdownDocumentSubscriptionDto {
  const record = requireExactRecord(
    value,
    ["surfaceId"],
    "document subscription"
  );
  return { surfaceId: requireBoundedId(record.surfaceId, "surfaceId") };
}

export function decodeTerminalFileLinkActivationDto(
  value: unknown
): TerminalFileLinkActivationDto {
  const record = requireRecord(value, "terminal file-link activation");
  const keys =
    record.baseCwd === undefined
      ? ["sourceSurfaceId", "rawPath"]
      : ["sourceSurfaceId", "rawPath", "baseCwd"];
  const exact = requireExactRecord(
    value,
    keys,
    "terminal file-link activation"
  );
  return {
    sourceSurfaceId: requireBoundedId(exact.sourceSurfaceId, "sourceSurfaceId"),
    rawPath: requireBoundedPathText(exact.rawPath, "rawPath"),
    ...(exact.baseCwd === undefined
      ? {}
      : { baseCwd: requireBoundedPathText(exact.baseCwd, "baseCwd") })
  };
}

export function decodeMarkdownDocumentEvent(
  value: unknown
): MarkdownDocumentEvent {
  const base = requireRecord(value, "document event");
  const type = base.type;
  const keys =
    type === "snapshot"
      ? base.imageSources === undefined
        ? ["type", "surfaceId", "revision", "text", "byteLength"]
        : [
            "type",
            "surfaceId",
            "revision",
            "text",
            "byteLength",
            "imageSources"
          ]
      : type === "error"
        ? ["type", "surfaceId", "revision", "errorCode"]
        : ["type", "surfaceId", "revision"];
  const record = requireExactRecord(value, keys, "document event");
  const surfaceId = requireBoundedId(record.surfaceId, "surfaceId");
  const revision = requireRevision(record.revision);
  if (type === "loading" || type === "offline") {
    return { type, surfaceId, revision };
  }
  if (type === "snapshot") {
    if (
      typeof record.text !== "string" ||
      record.text.length > MAX_MARKDOWN_BYTES ||
      !Number.isSafeInteger(record.byteLength) ||
      (record.byteLength as number) < 0 ||
      (record.byteLength as number) > MAX_MARKDOWN_BYTES
    ) {
      throw new TypeError("document snapshot is outside its byte bound");
    }
    const imageSources = decodeMarkdownImageSources(record.imageSources);
    return {
      type,
      surfaceId,
      revision,
      text: record.text,
      byteLength: record.byteLength as number,
      ...(imageSources === undefined ? {} : { imageSources })
    };
  }
  if (type === "error" && isMarkdownDocumentErrorCode(record.errorCode)) {
    return { type, surfaceId, revision, errorCode: record.errorCode };
  }
  throw new TypeError("document event type or error code is invalid");
}

function decodeMarkdownImageSources(
  value: unknown
): MarkdownImageSources | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, "Markdown image sources");
  const entries = Object.entries(record);
  if (entries.length > MAX_MARKDOWN_IMAGE_SOURCES) {
    throw new TypeError("Markdown image sources exceed the count bound");
  }
  const imageSources: Record<string, string> = {};
  let totalLength = 0;
  for (const [source, resolved] of entries) {
    if (
      !source ||
      source.length > MAX_MARKDOWN_IMAGE_SOURCE_LENGTH ||
      typeof resolved !== "string" ||
      !isSafeMarkdownImageUrl(resolved)
    ) {
      throw new TypeError("Markdown image source is invalid");
    }
    totalLength += source.length + resolved.length;
    if (totalLength > MAX_MARKDOWN_IMAGE_SOURCES_TOTAL_LENGTH) {
      throw new TypeError("Markdown image sources exceed the transfer bound");
    }
    imageSources[source] = resolved;
  }
  return imageSources;
}

function isSafeMarkdownImageUrl(value: string): boolean {
  if (!value || value.length > MAX_MARKDOWN_IMAGE_DATA_URL_LENGTH) return false;
  if (
    /^data:image\/(?:avif|bmp|gif|jpeg|png|svg\+xml|webp|x-icon);base64,/iu.test(
      value
    )
  ) {
    return true;
  }
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactRecord(
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> {
  const record = requireRecord(value, label);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${label} keys are invalid`);
  }
  return record;
}

function requireBoundedId(value: unknown, label: string): Id {
  if (typeof value !== "string" || !value || value.length > 512) {
    throw new TypeError(`${label} must be a bounded ID`);
  }
  return value;
}

function requireRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError("document revision must be a positive safe integer");
  }
  return value as number;
}

function requireBoundedPathText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    new TextEncoder().encode(value).byteLength > 32 * 1024 ||
    value.includes("\0")
  ) {
    throw new TypeError(`${label} must be a bounded path string`);
  }
  return value;
}

function isMarkdownDocumentErrorCode(
  value: unknown
): value is MarkdownDocumentErrorCode {
  return (
    value === "missing" ||
    value === "too-large" ||
    value === "invalid-encoding" ||
    value === "read-failed"
  );
}
