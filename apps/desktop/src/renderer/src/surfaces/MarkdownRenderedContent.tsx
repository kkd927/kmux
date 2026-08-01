import {
  useEffect,
  useMemo,
  type ComponentPropsWithoutRef,
  type MouseEvent,
  type RefObject
} from "react";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { harden } from "rehype-harden";
import {
  defaultRehypePlugins,
  Streamdown,
  type Components,
  type StreamdownProps
} from "streamdown";

import type { ColorTheme } from "@kmux/ui";

const plugins = { code, mermaid, math, cjk };
const streamdownPrefix = "kmuxsd";
const streamdownLinkClassName =
  "kmuxsd:wrap-anywhere kmuxsd:font-medium kmuxsd:text-primary kmuxsd:underline";
const markdownRelativeUrlOrigin = "https://kmux-relative.invalid/";

export type MarkdownUrl =
  | { kind: "external"; url: string }
  | { kind: "fragment"; fragment: string }
  | { kind: "blocked" };

export interface MarkdownRenderedContentProps {
  colorTheme: ColorTheme;
  markdown: string;
  imageSources?: Readonly<Record<string, string>>;
  onReady: () => void;
  surfaceId: string;
  viewportRef: RefObject<HTMLDivElement>;
}

export function MarkdownRenderedContent({
  colorTheme,
  markdown,
  imageSources,
  onReady,
  surfaceId,
  viewportRef
}: MarkdownRenderedContentProps): JSX.Element {
  useEffect(onReady, [onReady]);
  const hasAllowedImages =
    imageSources !== undefined && Object.keys(imageSources).length > 0;
  const allowedImageUrls = useMemo(
    () => new Set(Object.values(imageSources ?? {})),
    [imageSources]
  );
  const rehypePlugins = useMemo<NonNullable<StreamdownProps["rehypePlugins"]>>(
    () => [
      defaultRehypePlugins.raw,
      defaultRehypePlugins.sanitize,
      normalizeLegacyTableAlignment,
      addMarkdownHeadingIds,
      ...(hasAllowedImages
        ? [
            [rewriteAllowedImageSources, imageSources] as [
              typeof rewriteAllowedImageSources,
              Readonly<Record<string, string>>
            ]
          ]
        : []),
      [
        harden,
        {
          allowedProtocols: ["http", "https", "mailto"],
          allowedLinkPrefixes: ["*"],
          allowedImagePrefixes: hasAllowedImages ? ["*"] : [],
          allowDataImages: hasAllowedImages,
          defaultOrigin: markdownRelativeUrlOrigin
        }
      ],
      restoreRelativeMarkdownUrls
    ],
    [hasAllowedImages, imageSources]
  );

  const components = useMemo<Components>(
    () => ({
      a: ({ node: _node, ...props }) => (
        <MarkdownLink
          {...props}
          surfaceId={surfaceId}
          viewportRef={viewportRef}
        />
      ),
      ...(hasAllowedImages
        ? {
            img: ({ node: _node, src, ...props }) =>
              typeof src === "string" && allowedImageUrls.has(src) ? (
                <img {...props} src={src} />
              ) : null
          }
        : {})
    }),
    [allowedImageUrls, hasAllowedImages, surfaceId, viewportRef]
  );

  return (
    <div className="kmuxMarkdownSurface__document">
      <Streamdown
        components={components}
        controls={{
          code: { copy: false, download: false },
          mermaid: {
            copy: false,
            download: false,
            fullscreen: false,
            panZoom: false
          },
          table: { copy: false, download: false, fullscreen: false }
        }}
        dir="auto"
        disallowedElements={hasAllowedImages ? undefined : ["img"]}
        isAnimating={false}
        lineNumbers
        mermaid={{
          config: {
            securityLevel: "strict",
            startOnLoad: false,
            theme: colorTheme === "dark" ? "dark" : "default"
          }
        }}
        mode="static"
        parseIncompleteMarkdown={false}
        plugins={plugins}
        prefix={streamdownPrefix}
        rehypePlugins={rehypePlugins}
        shikiTheme={["github-light", "github-dark"]}
        urlTransform={(url, key) => {
          if (key === "src") {
            return allowedImageUrls.has(url) ? url : null;
          }
          return classifyMarkdownUrl(url).kind === "blocked" ? null : url;
        }}
      >
        {markdown}
      </Streamdown>
    </div>
  );
}

interface MarkdownHastNode {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownHastNode[];
}

function addMarkdownHeadingIds(): (tree: MarkdownHastNode) => void {
  return (tree) => {
    const assignedIds = new Set<string>();
    const nextSuffixes = new Map<string, number>();
    visitMarkdownHast(tree, (node) => {
      if (node.type !== "element" || !/^h[1-6]$/u.test(node.tagName ?? "")) {
        return;
      }
      const baseId = markdownHeadingId(markdownNodeText(node));
      if (!baseId) return;

      let suffix = nextSuffixes.get(baseId) ?? 0;
      let id = suffix === 0 ? baseId : `${baseId}-${suffix}`;
      while (assignedIds.has(id)) {
        suffix += 1;
        id = `${baseId}-${suffix}`;
      }
      assignedIds.add(id);
      nextSuffixes.set(baseId, suffix + 1);
      node.properties ??= {};
      node.properties.id = id;
    });
  };
}

function normalizeLegacyTableAlignment(): (tree: MarkdownHastNode) => void {
  return (tree) => {
    visitMarkdownHast(tree, (node) => {
      if (
        node.type !== "element" ||
        !["td", "th"].includes(node.tagName ?? "") ||
        typeof node.properties?.vAlign !== "string"
      ) {
        return;
      }
      const verticalAlign = node.properties.vAlign.toLocaleLowerCase("en-US");
      if (!["baseline", "bottom", "middle", "top"].includes(verticalAlign)) {
        delete node.properties.vAlign;
        return;
      }
      node.properties.style = `vertical-align:${verticalAlign}`;
      delete node.properties.vAlign;
    });
  };
}

function markdownNodeText(node: MarkdownHastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(markdownNodeText).join("");
}

function markdownHeadingId(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/gu, "-");
}

function rewriteAllowedImageSources(
  imageSources: Readonly<Record<string, string>>
): (tree: MarkdownHastNode) => void {
  return (tree) => {
    visitMarkdownHast(tree, (node) => {
      if (
        node.type !== "element" ||
        node.tagName !== "img" ||
        typeof node.properties?.src !== "string"
      ) {
        return;
      }
      const bundledSource = imageSources[node.properties.src];
      if (bundledSource) {
        node.properties.src = bundledSource;
      }
    });
  };
}

function restoreRelativeMarkdownUrls(): (tree: MarkdownHastNode) => void {
  return (tree) => {
    visitMarkdownHast(tree, (node) => {
      if (node.type !== "element" || node.tagName !== "a") return;
      const href = node.properties?.href;
      if (
        typeof href !== "string" ||
        !href.startsWith(markdownRelativeUrlOrigin)
      ) {
        return;
      }
      const restored = href.slice(markdownRelativeUrlOrigin.length);
      node.properties ??= {};
      node.properties.href = restored;
      delete node.properties.target;
      delete node.properties.rel;
    });
  };
}

function visitMarkdownHast(
  node: MarkdownHastNode,
  visitor: (node: MarkdownHastNode) => void
): void {
  visitor(node);
  for (const child of node.children ?? []) {
    visitMarkdownHast(child, visitor);
  }
}

export function classifyMarkdownUrl(rawUrl: string): MarkdownUrl {
  if (rawUrl.startsWith("#")) {
    try {
      return {
        kind: "fragment",
        fragment: decodeURIComponent(rawUrl.slice(1))
      };
    } catch {
      return { kind: "blocked" };
    }
  }
  try {
    const url = new URL(rawUrl);
    if (["http:", "https:", "mailto:"].includes(url.protocol)) {
      return { kind: "external", url: url.toString() };
    }
  } catch {
    // Relative and malformed links are not supported in v1.
  }
  return { kind: "blocked" };
}

interface MarkdownLinkProps extends ComponentPropsWithoutRef<"a"> {
  surfaceId: string;
  viewportRef: RefObject<HTMLDivElement>;
}

function MarkdownLink({
  className,
  href,
  onClick,
  surfaceId,
  viewportRef,
  ...props
}: MarkdownLinkProps): JSX.Element {
  function activate(event: MouseEvent<HTMLAnchorElement>): void {
    onClick?.(event);
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (!href) return;
    const classified = classifyMarkdownUrl(href);
    if (classified.kind === "external") {
      void window.kmux
        .openExternalUrl(surfaceId, classified.url)
        .catch((error) => console.warn("Failed to open Markdown link", error));
      return;
    }
    if (classified.kind === "fragment") {
      findFragment(viewportRef.current, classified.fragment)?.scrollIntoView({
        block: "start"
      });
    }
  }

  return (
    <a
      {...props}
      className={[streamdownLinkClassName, className].filter(Boolean).join(" ")}
      data-streamdown="link"
      href={href}
      onClick={activate}
    />
  );
}

function findFragment(
  viewport: HTMLDivElement | null,
  fragment: string
): HTMLElement | undefined {
  if (!viewport || !fragment) return undefined;
  return [...viewport.querySelectorAll<HTMLElement>("[id], a[name]")].find(
    (element) =>
      element.id === fragment || element.getAttribute("name") === fragment
  );
}
