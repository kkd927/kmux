import {
  useEffect,
  useMemo,
  type ComponentPropsWithoutRef,
  type MouseEvent,
  type RefObject
} from "react";
import { cjk } from "@streamdown/cjk";
import { createCodePlugin } from "@streamdown/code";
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

const code = createCodePlugin({
  themes: ["github-light", "github-dark-high-contrast"]
});
const plugins = { code, mermaid, math, cjk };
const rehypePlugins: NonNullable<StreamdownProps["rehypePlugins"]> = [
  defaultRehypePlugins.sanitize,
  [
    harden,
    {
      allowedProtocols: ["http", "https", "mailto"],
      allowedLinkPrefixes: ["*"],
      allowedImagePrefixes: [],
      allowDataImages: false
    }
  ]
];

export type MarkdownUrl =
  | { kind: "external"; url: string }
  | { kind: "fragment"; fragment: string }
  | { kind: "blocked" };

export interface MarkdownRenderedContentProps {
  colorTheme: ColorTheme;
  markdown: string;
  onReady: () => void;
  surfaceId: string;
  viewportRef: RefObject<HTMLDivElement>;
}

export function MarkdownRenderedContent({
  colorTheme,
  markdown,
  onReady,
  surfaceId,
  viewportRef
}: MarkdownRenderedContentProps): JSX.Element {
  useEffect(onReady, [onReady]);

  const components = useMemo<Components>(
    () => ({
      a: ({ node: _node, ...props }) => (
        <MarkdownLink
          {...props}
          surfaceId={surfaceId}
          viewportRef={viewportRef}
        />
      )
    }),
    [surfaceId, viewportRef]
  );

  return (
    <Streamdown
      className="kmuxMarkdownSurface__document"
      components={components}
      controls={{
        code: { copy: true, download: false },
        mermaid: {
          copy: true,
          download: false,
          fullscreen: true,
          panZoom: true
        },
        table: { copy: true, download: false, fullscreen: true }
      }}
      dir="auto"
      disallowedElements={["img"]}
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
      rehypePlugins={rehypePlugins}
      shikiTheme={["github-light", "github-dark-high-contrast"]}
      skipHtml
      urlTransform={(url, key) =>
        key === "src" || classifyMarkdownUrl(url).kind === "blocked"
          ? null
          : url
      }
    >
      {markdown}
    </Streamdown>
  );
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

  return <a {...props} href={href} onClick={activate} />;
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
