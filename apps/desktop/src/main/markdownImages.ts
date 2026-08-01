import { extname } from "node:path";

import { fromMarkdown } from "mdast-util-from-markdown";

import type { LocatedPath } from "@kmux/core";
import {
  MAX_MARKDOWN_IMAGE_SOURCE_LENGTH,
  MAX_MARKDOWN_IMAGE_SOURCES,
  type MarkdownImageSources
} from "@kmux/proto";

import type { LocatedTargetServiceSet } from "./targets/contracts";

const MAX_MARKDOWN_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_MARKDOWN_IMAGE_TOTAL_BYTES = 32 * 1024 * 1024;
const URL_PROTOCOL_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const HTML_IMAGE_RE = /<img\b[^>]*>/giu;
const HTML_SRC_RE = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/iu;

const imageMimeTypes = new Map<string, string>([
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"]
]);

interface MarkdownNode {
  type?: string;
  url?: string;
  identifier?: string;
  value?: string;
  children?: MarkdownNode[];
}

export async function resolveMarkdownImageSources(options: {
  documentPath: LocatedPath;
  files: LocatedTargetServiceSet["files"];
  markdown: string;
}): Promise<MarkdownImageSources> {
  const sources = extractMarkdownImageSources(options.markdown);
  const resolved: Record<string, string> = {};
  let totalBytes = 0;

  for (const source of sources) {
    const externalUrl = safeExternalImageUrl(source);
    if (externalUrl) {
      resolved[source] = externalUrl;
      continue;
    }
    const mimeType = imageMimeType(source);
    const relativeSegments = relativeImageSegments(source);
    if (!mimeType || !relativeSegments) continue;

    try {
      let imagePath = options.files.dirname(options.documentPath);
      for (const segment of relativeSegments) {
        imagePath =
          segment === ".."
            ? options.files.dirname(imagePath)
            : options.files.join(imagePath, segment);
      }
      const bytes = await options.files.read(imagePath, {
        maxBytes: MAX_MARKDOWN_IMAGE_BYTES
      });
      if (
        bytes.byteLength > MAX_MARKDOWN_IMAGE_BYTES ||
        totalBytes + bytes.byteLength > MAX_MARKDOWN_IMAGE_TOTAL_BYTES
      ) {
        continue;
      }
      totalBytes += bytes.byteLength;
      resolved[source] =
        `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
    } catch {
      // A missing or unreadable image should not prevent the Markdown body
      // from rendering. It remains outside the renderer allowlist instead.
    }
  }

  return resolved;
}

export function extractMarkdownImageSources(markdown: string): string[] {
  const root = fromMarkdown(markdown) as MarkdownNode;
  const definitions = new Map<string, string>();
  const candidates: string[] = [];

  visitMarkdown(root, (node) => {
    if (
      node.type === "definition" &&
      typeof node.identifier === "string" &&
      typeof node.url === "string"
    ) {
      definitions.set(node.identifier.toLocaleLowerCase("en-US"), node.url);
    }
  });
  visitMarkdown(root, (node) => {
    if (node.type === "image" && typeof node.url === "string") {
      candidates.push(node.url);
      return;
    }
    if (node.type === "imageReference" && typeof node.identifier === "string") {
      const source = definitions.get(
        node.identifier.toLocaleLowerCase("en-US")
      );
      if (source) candidates.push(source);
      return;
    }
    if (node.type === "html" && typeof node.value === "string") {
      for (const tag of node.value.matchAll(HTML_IMAGE_RE)) {
        const source = tag[0].match(HTML_SRC_RE);
        const value = source?.[1] ?? source?.[2] ?? source?.[3];
        if (value) candidates.push(decodeHtmlAttribute(value));
      }
    }
  });

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const source of candidates) {
    const bounded = source.trim();
    if (
      !bounded ||
      bounded.length > MAX_MARKDOWN_IMAGE_SOURCE_LENGTH ||
      /[\0\r\n]/u.test(bounded) ||
      seen.has(bounded)
    ) {
      continue;
    }
    seen.add(bounded);
    unique.push(bounded);
    if (unique.length >= MAX_MARKDOWN_IMAGE_SOURCES) break;
  }
  return unique;
}

function visitMarkdown(
  node: MarkdownNode,
  visitor: (node: MarkdownNode) => void
): void {
  visitor(node);
  for (const child of node.children ?? []) visitMarkdown(child, visitor);
}

function safeExternalImageUrl(source: string): string | undefined {
  try {
    const url = new URL(source);
    return ["http:", "https:"].includes(url.protocol)
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function relativeImageSegments(source: string): string[] | undefined {
  if (
    source.startsWith("/") ||
    source.startsWith("\\") ||
    source.startsWith("//") ||
    URL_PROTOCOL_RE.test(source)
  ) {
    return undefined;
  }
  const suffixIndex = source.search(/[?#]/u);
  const pathText = suffixIndex === -1 ? source : source.slice(0, suffixIndex);
  const segments: string[] = [];
  try {
    for (const rawSegment of pathText.split("/")) {
      const segment = decodeURIComponent(rawSegment);
      if (!segment || segment === ".") continue;
      if (
        segment.includes("/") ||
        segment.includes("\\") ||
        /[\0\r\n]/u.test(segment)
      ) {
        return undefined;
      }
      segments.push(segment);
    }
  } catch {
    return undefined;
  }
  return segments.length > 0 ? segments : undefined;
}

function imageMimeType(source: string): string | undefined {
  const suffixIndex = source.search(/[?#]/u);
  const pathText = suffixIndex === -1 ? source : source.slice(0, suffixIndex);
  return imageMimeTypes.get(extname(pathText).toLocaleLowerCase("en-US"));
}

function decodeHtmlAttribute(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|(amp|apos|gt|lt|quot));/giu,
    (entity, decimal: string, hex: string, named: string) => {
      if (decimal) return decodeHtmlCodePoint(decimal, 10, entity);
      if (hex) return decodeHtmlCodePoint(hex, 16, entity);
      return (
        (
          {
            amp: "&",
            apos: "'",
            gt: ">",
            lt: "<",
            quot: '"'
          } as Record<string, string>
        )[named.toLocaleLowerCase("en-US")] ?? entity
      );
    }
  );
}

function decodeHtmlCodePoint(
  value: string,
  radix: number,
  fallback: string
): string {
  const codePoint = Number.parseInt(value, radix);
  return Number.isSafeInteger(codePoint) &&
    codePoint > 0 &&
    codePoint <= 0x10ffff &&
    !(codePoint >= 0xd800 && codePoint <= 0xdfff)
    ? String.fromCodePoint(codePoint)
    : fallback;
}
