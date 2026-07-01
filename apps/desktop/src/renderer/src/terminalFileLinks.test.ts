// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";

import {
  isTerminalFileLinkModifierActive,
  parseTerminalFilePathCandidates,
  registerTerminalFileLinkProvider
} from "./terminalFileLinks";

describe("terminal file link helpers", () => {
  it("requires Command on macOS and Ctrl on Linux", () => {
    expect(
      isTerminalFileLinkModifierActive(
        { altKey: false, ctrlKey: false, metaKey: true },
        "darwin"
      )
    ).toBe(true);
    expect(
      isTerminalFileLinkModifierActive(
        { altKey: true, ctrlKey: false, metaKey: false },
        "darwin"
      )
    ).toBe(false);
    expect(
      isTerminalFileLinkModifierActive(
        { altKey: false, ctrlKey: true, metaKey: false },
        "linux"
      )
    ).toBe(true);
    expect(
      isTerminalFileLinkModifierActive(
        { altKey: true, ctrlKey: false, metaKey: false },
        "linux"
      )
    ).toBe(false);
  });

  it("does not match web URLs", () => {
    expect(
      parseTerminalFilePathCandidates(
        "open https://example.com/src/foo.ts and http://localhost:3000/a/b"
      )
    ).toEqual([]);
  });

  it("matches absolute terminal file paths", () => {
    expect(
      parseTerminalFilePathCandidates(
        "/Users/user/.gemini/tmp/self_merge_proposal.html /Users/user/.gemini/tmp/self_merge_proposal.md"
      ).map((candidate) => candidate.rawPath)
    ).toEqual([
      "/Users/user/.gemini/tmp/self_merge_proposal.html",
      "/Users/user/.gemini/tmp/self_merge_proposal.md"
    ]);
  });

  it("matches relative terminal file paths with optional line and column suffixes", () => {
    expect(
      parseTerminalFilePathCandidates(
        "src/App.tsx:12:3 ./foo.md ../notes/file.html"
      ).map((candidate) => candidate.rawPath)
    ).toEqual(["src/App.tsx:12:3", "./foo.md", "../notes/file.html"]);
  });

  it("strips common surrounding and trailing punctuation", () => {
    expect(
      parseTerminalFilePathCandidates(
        "See (src/foo.ts), [./foo.md], ../notes/file.html., and /tmp/report.md."
      ).map((candidate) => candidate.rawPath)
    ).toEqual([
      "src/foo.ts",
      "./foo.md",
      "../notes/file.html",
      "/tmp/report.md"
    ]);
  });

  it("matches Markdown file link targets and uses the target span", () => {
    const text = "Open [App component](src/App.tsx:12) now";
    const [candidate] = parseTerminalFilePathCandidates(text);

    expect(candidate).toEqual({
      rawPath: "src/App.tsx:12",
      startIndex: text.indexOf("src/App.tsx:12"),
      endIndex: text.indexOf("src/App.tsx:12") + "src/App.tsx:12".length
    });
  });

  it("does not let Markdown web URL targets fall through to the file provider", () => {
    expect(
      parseTerminalFilePathCandidates(
        "Docs [site](https://example.com/src/App.tsx)"
      )
    ).toEqual([]);
  });

  it("matches quoted paths containing spaces", () => {
    const text = 'Open "/Users/user/My Project/src/App.tsx:12" now';
    const target = "/Users/user/My Project/src/App.tsx:12";
    const [candidate] = parseTerminalFilePathCandidates(text);

    expect(candidate).toEqual({
      rawPath: target,
      startIndex: text.indexOf(target),
      endIndex: text.indexOf(target) + target.length
    });
  });

  it("matches Markdown angle targets containing spaces", () => {
    const text = "Open [App](<./My Project/src/App.tsx:12>) now";
    const [candidate] = parseTerminalFilePathCandidates(text);

    expect(candidate?.rawPath).toBe("./My Project/src/App.tsx:12");
  });

  it("matches backslash-escaped spaces in paths", () => {
    const text = "Open ./My\\ Project/src/App.tsx:12 now";
    const [candidate] = parseTerminalFilePathCandidates(text);

    expect(candidate?.rawPath).toBe("./My Project/src/App.tsx:12");
  });

  it("continues to reject bare filenames even when quoted", () => {
    expect(parseTerminalFilePathCandidates('"README.md"')).toEqual([]);
  });
});

describe("terminal file link provider", () => {
  it("sets a single-line link range without including the following cell", () => {
    const links = provideFileLinksForText("src/App.tsx next");

    expect(links?.[0]?.text).toBe("src/App.tsx");
    expect(links?.[0]?.range).toEqual({
      start: { x: 1, y: 1 },
      end: { x: "src/App.tsx".length, y: 1 }
    });
  });

  it("sets an end-of-line link range using xterm right-side coordinates", () => {
    const links = provideFileLinksForText("src/App.tsx");

    expect(links?.[0]?.text).toBe("src/App.tsx");
    expect(links?.[0]?.range).toEqual({
      start: { x: 1, y: 1 },
      end: { x: 0, y: 2 }
    });
  });

  it("sets a wrapped link range without including the following wrapped-line cell", () => {
    const links = provideFileLinksForLines([
      { text: "src/", isWrapped: false },
      { text: "App.tsx next", isWrapped: true }
    ]);

    expect(links?.[0]?.text).toBe("src/App.tsx");
    expect(links?.[0]?.range).toEqual({
      start: { x: 1, y: 1 },
      end: { x: "App.tsx".length, y: 2 }
    });
  });

  it("links only the Markdown target span", () => {
    const text = "Open [App component](src/App.tsx:12) now";
    const links = provideFileLinksForText(text);
    const target = "src/App.tsx:12";
    const targetStart = text.indexOf(target);

    expect(links?.[0]?.text).toBe(target);
    expect(links?.[0]?.range).toEqual({
      start: { x: targetStart + 1, y: 1 },
      end: { x: targetStart + target.length, y: 1 }
    });
  });

  it("sets an escaped-space link range over the source token", () => {
    const text = "Open ./My\\ Project/src/App.tsx next";
    const links = provideFileLinksForText(text);
    const sourceTarget = "./My\\ Project/src/App.tsx";
    const targetStart = text.indexOf(sourceTarget);

    expect(links?.[0]?.text).toBe("./My Project/src/App.tsx");
    expect(links?.[0]?.range).toEqual({
      start: { x: targetStart + 1, y: 1 },
      end: { x: targetStart + sourceTarget.length, y: 1 }
    });
  });

  it("updates hover decorations with the platform modifier and gates activation", async () => {
    const providers: ILinkProvider[] = [];
    const providerDisposable = { dispose: vi.fn() };
    const terminal = createFakeTerminal("src/App.tsx:12:3");
    terminal.registerLinkProvider = vi.fn((nextProvider: ILinkProvider) => {
      providers.push(nextProvider);
      return providerDisposable;
    });
    const openFilePath = vi.fn(async () => {});

    const registration = registerTerminalFileLinkProvider({
      terminal,
      getKeyboardPlatform: () => "linux",
      surfaceId: "surface_1",
      openFilePath
    });

    let links: ILink[] | undefined;
    expect(providers).toHaveLength(1);
    providers[0].provideLinks(1, (providedLinks) => {
      links = providedLinks;
    });

    const link = links?.[0];
    expect(link?.text).toBe("src/App.tsx:12:3");
    expect(link?.decorations).toEqual({
      pointerCursor: false,
      underline: false
    });

    link?.hover?.(new MouseEvent("mousemove"), link.text);
    expect(link?.decorations).toEqual({
      pointerCursor: false,
      underline: false
    });

    window.dispatchEvent(new KeyboardEvent("keydown", { ctrlKey: true }));
    expect(link?.decorations).toEqual({
      pointerCursor: true,
      underline: true
    });

    link?.activate(new MouseEvent("click"), link.text);
    expect(openFilePath).not.toHaveBeenCalled();

    link?.activate(new MouseEvent("click", { ctrlKey: true }), link.text);
    await Promise.resolve();
    expect(openFilePath).toHaveBeenCalledWith(
      "surface_1",
      "src/App.tsx:12:3",
      undefined
    );

    window.dispatchEvent(new KeyboardEvent("keyup"));
    expect(link?.decorations).toEqual({
      pointerCursor: false,
      underline: false
    });

    registration.dispose();
    expect(providerDisposable.dispose).toHaveBeenCalledOnce();
  });

  it("uses Command, not Option, for macOS hover decorations and activation", async () => {
    const providers: ILinkProvider[] = [];
    const terminal = createFakeTerminal("src/App.tsx");
    terminal.registerLinkProvider = vi.fn((nextProvider: ILinkProvider) => {
      providers.push(nextProvider);
      return { dispose: vi.fn() };
    });
    const openFilePath = vi.fn(async () => {});

    const registration = registerTerminalFileLinkProvider({
      terminal,
      getKeyboardPlatform: () => "darwin",
      surfaceId: "surface_1",
      openFilePath
    });

    let links: ILink[] | undefined;
    providers[0].provideLinks(1, (providedLinks) => {
      links = providedLinks;
    });

    const link = links?.[0];
    expect(link?.text).toBe("src/App.tsx");

    link?.hover?.(new MouseEvent("mousemove", { altKey: true }), link.text);
    expect(link?.decorations).toEqual({
      pointerCursor: false,
      underline: false
    });

    link?.activate(new MouseEvent("click", { altKey: true }), link.text);
    expect(openFilePath).not.toHaveBeenCalled();

    link?.hover?.(new MouseEvent("mousemove", { metaKey: true }), link.text);
    expect(link?.decorations).toEqual({
      pointerCursor: true,
      underline: true
    });

    link?.activate(new MouseEvent("click", { metaKey: true }), link.text);
    await Promise.resolve();
    expect(openFilePath).toHaveBeenCalledWith(
      "surface_1",
      "src/App.tsx",
      undefined
    );

    registration.dispose();
  });

  it("passes captured line cwd when activating a relative file link", async () => {
    const providers: ILinkProvider[] = [];
    const terminal = createFakeTerminal("src/App.tsx");
    terminal.registerLinkProvider = vi.fn((nextProvider: ILinkProvider) => {
      providers.push(nextProvider);
      return { dispose: vi.fn() };
    });
    const openFilePath = vi.fn(async () => {});

    const registration = registerTerminalFileLinkProvider({
      terminal,
      getKeyboardPlatform: () => "linux",
      surfaceId: "surface_1",
      openFilePath,
      getCwdForBufferLine: () => "/repo/old"
    });

    let links: ILink[] | undefined;
    providers[0].provideLinks(1, (providedLinks) => {
      links = providedLinks;
    });
    links?.[0]?.activate(
      new MouseEvent("click", { ctrlKey: true }),
      "src/App.tsx"
    );
    await Promise.resolve();

    expect(openFilePath).toHaveBeenCalledWith(
      "surface_1",
      "src/App.tsx",
      "/repo/old"
    );
    registration.dispose();
  });

  it("uses the actual link start line cwd when scanning from a wrapped continuation", async () => {
    const providers: ILinkProvider[] = [];
    const terminal = createFakeTerminalFromLines([
      { text: "src/", isWrapped: false },
      { text: "App.tsx", isWrapped: true }
    ]);
    terminal.registerLinkProvider = vi.fn((nextProvider: ILinkProvider) => {
      providers.push(nextProvider);
      return { dispose: vi.fn() };
    });
    const openFilePath = vi.fn(async () => {});

    const registration = registerTerminalFileLinkProvider({
      terminal,
      getKeyboardPlatform: () => "linux",
      surfaceId: "surface_1",
      openFilePath,
      getCwdForBufferLine: (bufferLineNumber) =>
        bufferLineNumber === 0 ? "/repo/start" : "/repo/continuation"
    });

    let links: ILink[] | undefined;
    providers[0].provideLinks(2, (providedLinks) => {
      links = providedLinks;
    });
    links?.[0]?.activate(
      new MouseEvent("click", { ctrlKey: true }),
      "src/App.tsx"
    );
    await Promise.resolve();

    expect(openFilePath).toHaveBeenCalledWith(
      "surface_1",
      "src/App.tsx",
      "/repo/start"
    );
    registration.dispose();
  });
});

function provideFileLinksForText(text: string): ILink[] | undefined {
  return provideFileLinksForLines([{ text, isWrapped: false }]);
}

function provideFileLinksForLines(
  lines: Array<{ text: string; isWrapped: boolean }>
): ILink[] | undefined {
  const providers: ILinkProvider[] = [];
  const terminal = createFakeTerminalFromLines(lines);
  terminal.registerLinkProvider = vi.fn((nextProvider: ILinkProvider) => {
    providers.push(nextProvider);
    return { dispose: vi.fn() };
  });

  const registration = registerTerminalFileLinkProvider({
    terminal,
    getKeyboardPlatform: () => "linux",
    surfaceId: "surface_1",
    openFilePath: vi.fn(async () => {})
  });

  let links: ILink[] | undefined;
  providers[0].provideLinks(1, (providedLinks) => {
    links = providedLinks;
  });
  registration.dispose();
  return links;
}

function createFakeTerminal(text: string): Terminal {
  return createFakeTerminalFromLines([{ text, isWrapped: false }]);
}

function createFakeTerminalFromLines(
  lineInputs: Array<{ text: string; isWrapped: boolean }>
): Terminal {
  const cell = {
    chars: "",
    width: 0,
    getChars() {
      return this.chars;
    },
    getWidth() {
      return this.width;
    }
  };
  const lines = lineInputs.map((input) => ({
    isWrapped: input.isWrapped,
    length: input.text.length,
    translateToString(trimRight?: boolean) {
      return trimRight ? input.text.trimEnd() : input.text;
    },
    getCell(index: number, targetCell = cell) {
      targetCell.chars = input.text[index] ?? "";
      targetCell.width = index < input.text.length ? 1 : 0;
      return targetCell;
    }
  }));

  return {
    buffer: {
      active: {
        getLine(index: number) {
          return lines[index];
        },
        getNullCell() {
          return cell;
        }
      }
    },
    registerLinkProvider: vi.fn()
  } as unknown as Terminal;
}
