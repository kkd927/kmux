// @vitest-environment jsdom

import { act } from "react";
import ReactDOMClient from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyMarkdownUrl,
  MarkdownRenderedContent
} from "./MarkdownRenderedContent";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("MarkdownRenderedContent security boundary", () => {
  let container: HTMLDivElement;
  let viewport: HTMLDivElement;
  let root: ReactDOMClient.Root;
  const openExternalUrl = vi.fn(async () => undefined);

  beforeEach(() => {
    viewport = document.createElement("div");
    container = document.createElement("div");
    viewport.append(container);
    document.body.append(viewport);
    root = ReactDOMClient.createRoot(container);
    openExternalUrl.mockClear();
    Object.defineProperty(window, "kmux", {
      configurable: true,
      value: { openExternalUrl }
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    viewport.remove();
  });

  it("blocks raw HTML, unsafe protocols, and remote or data images", async () => {
    await renderMarkdown(`
<script>window.__markdownExecuted = true</script>
<img src="https://example.com/raw.png" onerror="window.__markdownExecuted = true">

![remote](https://example.com/image.png)
![data](data:image/png;base64,AAAA)

[script](javascript:alert(1)) [file](file:///tmp/secret) [data](data:text/html,bad)
`);

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.querySelector('a[href^="file:"]')).toBeNull();
    expect(container.querySelector('a[href^="data:"]')).toBeNull();
    expect(
      (window as typeof window & { __markdownExecuted?: boolean })
        .__markdownExecuted
    ).not.toBe(true);
  });

  it("cancels renderer navigation and delegates external links", async () => {
    await renderMarkdown(
      "[website](https://example.com/docs) [email](mailto:docs@example.com)"
    );
    const links = [...container.querySelectorAll<HTMLAnchorElement>("a")];

    for (const link of links) {
      const navigated = link.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
      expect(navigated).toBe(false);
    }
    expect(openExternalUrl).toHaveBeenNthCalledWith(
      1,
      "surface_markdown",
      "https://example.com/docs"
    );
    expect(openExternalUrl).toHaveBeenNthCalledWith(
      2,
      "surface_markdown",
      "mailto:docs@example.com"
    );
  });

  it("resolves fragments only inside the current document viewport", async () => {
    const target = document.createElement("div");
    target.id = "details";
    target.scrollIntoView = vi.fn();
    viewport.prepend(target);
    await renderMarkdown("[Details](#details)");

    const link = container.querySelector<HTMLAnchorElement>("a")!;
    expect(
      link.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      )
    ).toBe(false);
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  async function renderMarkdown(markdown: string): Promise<void> {
    await act(async () => {
      root.render(
        <MarkdownRenderedContent
          colorTheme="dark"
          markdown={markdown}
          onReady={() => {}}
          surfaceId="surface_markdown"
          viewportRef={{ current: viewport }}
        />
      );
      await Promise.resolve();
    });
  }
});

describe("classifyMarkdownUrl", () => {
  it("allows only supported external and current-document fragment URLs", () => {
    expect(classifyMarkdownUrl("https://example.com/path")).toMatchObject({
      kind: "external"
    });
    expect(classifyMarkdownUrl("mailto:docs@example.com")).toEqual({
      kind: "external",
      url: "mailto:docs@example.com"
    });
    expect(classifyMarkdownUrl("#section%201")).toEqual({
      kind: "fragment",
      fragment: "section 1"
    });
    for (const blocked of [
      "javascript:alert(1)",
      "file:///tmp/secret",
      "data:text/html,bad",
      "other.md",
      "/absolute.md"
    ]) {
      expect(classifyMarkdownUrl(blocked)).toEqual({ kind: "blocked" });
    }
  });
});
