// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import type {
  ILink,
  ILinkDecorations,
  ILinkProvider,
  Terminal
} from "@xterm/xterm";
import type {
  TerminalFileLinkResolveCandidate,
  TerminalFileLinkResolveResult
} from "@kmux/proto";

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

  it("matches relative terminal file paths", () => {
    expect(
      parseTerminalFilePathCandidates(
        "src/App.tsx ./foo.md ../notes/file.html"
      ).map((candidate) => candidate.rawPath)
    ).toEqual(["src/App.tsx", "./foo.md", "../notes/file.html"]);
  });

  it("rejects slashless words with line suffixes", () => {
    expect(parseTerminalFilePathCandidates("exit code 1")).toEqual([]);
    expect(parseTerminalFilePathCandidates("foo line 12")).toEqual([]);
    expect(parseTerminalFilePathCandidates("README.md:12")).toEqual([]);
  });

  it("detects VS Code-style line and column suffixes as link text", () => {
    const inputs = [
      "src/App.tsx:12",
      "src/App.tsx:12:3",
      "src/App.tsx(12)",
      "src/App.tsx line 12"
    ];

    for (const input of inputs) {
      expect(parseTerminalFilePathCandidates(input)).toEqual([
        {
          rawPath: "src/App.tsx",
          linkText: input,
          startIndex: 0,
          endIndex: input.length,
          hasSuffix: true
        }
      ]);
    }
  });

  it("uses VS Code local path boundaries around punctuation", () => {
    expect(
      parseTerminalFilePathCandidates(
        "See (src/foo.ts), [./foo.md], ../notes/file.html., and /tmp/report.md."
      ).map((candidate) => candidate.rawPath)
    ).toEqual([
      "src/foo.ts",
      "./foo.md],",
      "../notes/file.html.,",
      "/tmp/report.md."
    ]);
  });

  it("links only the inner absolute path in a call expression", () => {
    const text = "read(/users/kkd927/test.txt)";
    const [candidate] = parseTerminalFilePathCandidates(text);

    expect(candidate).toEqual({
      rawPath: "/users/kkd927/test.txt",
      linkText: "/users/kkd927/test.txt",
      startIndex: text.indexOf("/users/kkd927/test.txt"),
      endIndex:
        text.indexOf("/users/kkd927/test.txt") +
        "/users/kkd927/test.txt".length,
      hasSuffix: false
    });
  });

  it("does not trim language suffix characters from path candidates", () => {
    expect(
      parseTerminalFilePathCandidates(
        "docs/upstream-readiness-review.md로"
      ).map((candidate) => candidate.rawPath)
    ).toEqual(["docs/upstream-readiness-review.md로"]);
  });

  it("recovers a bracketed suffix path target without Markdown-specific parsing", () => {
    const text = "Open [App component](src/App.tsx:12) now";
    const [candidate] = parseTerminalFilePathCandidates(text);

    expect(candidate).toEqual({
      rawPath: "src/App.tsx",
      linkText: "src/App.tsx:12",
      startIndex: text.indexOf("src/App.tsx:12"),
      endIndex: text.indexOf("src/App.tsx:12") + "src/App.tsx:12".length,
      hasSuffix: true
    });
  });

  it("does not let Markdown web URL targets fall through to the file provider", () => {
    expect(
      parseTerminalFilePathCandidates(
        "Docs [site](https://example.com/src/App.tsx)"
      )
    ).toEqual([]);
  });

  it("does not reconstruct space-containing paths from quotes, angle links, or escapes", () => {
    expect(
      parseTerminalFilePathCandidates(
        'Open "/Users/user/My Project/src/App.tsx:12" now'
      ).map((candidate) => candidate.rawPath)
    ).toEqual(["/Users/user/My", "Project/src/App.tsx"]);
    expect(
      parseTerminalFilePathCandidates(
        "Open [App](<./My Project/src/App.tsx:12>) now"
      ).map((candidate) => candidate.rawPath)
    ).toEqual(["./My", "Project/src/App.tsx"]);
    expect(
      parseTerminalFilePathCandidates(
        "Open ./My\\ Project/src/App.tsx:12 now"
      ).map((candidate) => candidate.rawPath)
    ).toEqual(["./My", "Project/src/App.tsx"]);
  });

  it("continues to reject bare filenames even when quoted", () => {
    expect(parseTerminalFilePathCandidates('"README.md"')).toEqual([]);
  });
});

describe("terminal file link provider", () => {
  it("sets a single-line link range without including the following cell", async () => {
    const links = await provideFileLinksForText("src/App.tsx next");

    expect(links?.[0]?.text).toBe("src/App.tsx");
    expect(links?.[0]?.range).toEqual({
      start: { x: 1, y: 1 },
      end: { x: "src/App.tsx".length, y: 1 }
    });
  });

  it("sets an end-of-line link range using xterm right-side coordinates", async () => {
    const links = await provideFileLinksForText("src/App.tsx");

    expect(links?.[0]?.text).toBe("src/App.tsx");
    expect(links?.[0]?.range).toEqual({
      start: { x: 1, y: 1 },
      end: { x: 0, y: 2 }
    });
  });

  it("sets a wrapped link range without including the following wrapped-line cell", async () => {
    const links = await provideFileLinksForLines([
      { text: "src/", isWrapped: false },
      { text: "App.tsx next", isWrapped: true }
    ]);

    expect(links?.[0]?.text).toBe("src/App.tsx");
    expect(links?.[0]?.range).toEqual({
      start: { x: 1, y: 1 },
      end: { x: "App.tsx".length, y: 2 }
    });
  });

  it("links only the Markdown target span", async () => {
    const text = "Open [App component](src/App.tsx:12) now";
    const links = await provideFileLinksForText(text);
    const target = "src/App.tsx:12";
    const targetStart = text.indexOf(target);

    expect(links?.[0]?.text).toBe(target);
    expect(links?.[0]?.range).toEqual({
      start: { x: targetStart + 1, y: 1 },
      end: { x: targetStart + target.length, y: 1 }
    });
  });

  it("uses fallback validation for quoted, angle, and escaped space paths", async () => {
    const inputs = [
      {
        text: 'Open "/Users/user/My Project/src/App.tsx:12" now',
        target: "/Users/user/My Project/src/App.tsx:12"
      },
      {
        text: "Open [App](<./My Project/src/App.tsx:12>) now",
        target: "./My Project/src/App.tsx:12"
      },
      {
        text: "Open ./My\\ Project/src/App.tsx:12 now",
        target: "./My\\ Project/src/App.tsx:12"
      }
    ];

    for (const input of inputs) {
      const links = await provideFileLinksForText(
        input.text,
        resolveOnlyFallbackFileLinks
      );
      const targetStart = input.text.indexOf(input.target);

      expect(links).toHaveLength(1);
      expect(links?.[0]?.text).toBe(input.target);
      expect(links?.[0]?.range).toEqual({
        start: { x: targetStart + 1, y: 1 },
        end: { x: targetStart + input.target.length, y: 1 }
      });
    }
  });

  it("does not run fallback validation when primary links validate", async () => {
    const resolveFileLinks = vi.fn(resolveAllFileLinks);

    await provideFileLinksForText(
      'src/App.tsx "./My Project/src/App.tsx"',
      resolveFileLinks
    );

    expect(resolveFileLinks).toHaveBeenCalledTimes(1);
    expect(resolveFileLinks.mock.calls[0]?.[1][0]?.id).toMatch(/^primary-/);
  });

  it("uses the preload resolver by default", async () => {
    const providers: ILinkProvider[] = [];
    const terminal = createFakeTerminal("src/App.tsx");
    terminal.registerLinkProvider = vi.fn((nextProvider: ILinkProvider) => {
      providers.push(nextProvider);
      return { dispose: vi.fn() };
    });
    const previousKmux = window.kmux;
    const resolveTerminalFileLinks = vi.fn(resolveAllFileLinks);
    Object.assign(window, {
      kmux: {
        ...(previousKmux ?? {}),
        resolveTerminalFileLinks
      }
    });

    const registration = registerTerminalFileLinkProvider({
      terminal,
      getKeyboardPlatform: () => "linux",
      surfaceId: "surface_1",
      openFilePath: vi.fn(async () => {})
    });

    await provideLinksFromProvider(providers[0], 1);

    expect(resolveTerminalFileLinks).toHaveBeenCalledWith("surface_1", [
      expect.objectContaining({ rawPath: "src/App.tsx" })
    ]);
    registration.dispose();
    Object.assign(window, { kmux: previousKmux });
  });

  it("opens the resolved path returned by validation", async () => {
    const providers: ILinkProvider[] = [];
    const terminal = createFakeTerminal("src/App.tsx:12");
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
      resolveFileLinks: async (_surfaceId, candidates) => ({
        links: candidates.map((candidate) => ({
          id: candidate.id,
          openRawPath: "./resolved/App.tsx",
          resolvedPath: "/repo/resolved/App.tsx",
          linkText: candidate.linkText,
          startIndex: candidate.startIndex,
          endIndex: candidate.endIndex
        }))
      })
    });

    const links = await provideLinksFromProvider(providers[0], 1);
    links?.[0]?.activate(
      new MouseEvent("click", { ctrlKey: true }),
      "src/App.tsx:12"
    );
    await Promise.resolve();

    expect(openFilePath).toHaveBeenCalledWith(
      "surface_1",
      "/repo/resolved/App.tsx"
    );
    registration.dispose();
  });

  it("sends Markdown activation using the original path context", async () => {
    const providers: ILinkProvider[] = [];
    const terminal = createFakeTerminal("docs/README.md:12");
    terminal.registerLinkProvider = vi.fn((nextProvider: ILinkProvider) => {
      providers.push(nextProvider);
      return { dispose: vi.fn() };
    });
    const openFilePath = vi.fn(async () => {});
    const activateFileLink = vi.fn(async () => {});

    const registration = registerTerminalFileLinkProvider({
      terminal,
      getKeyboardPlatform: () => "linux",
      surfaceId: "surface_1",
      openFilePath,
      activateFileLink,
      getCwdForBufferLine: () => "/repo",
      resolveFileLinks: async (_surfaceId, candidates) => ({
        links: candidates.map((candidate) => ({
          id: candidate.id,
          openRawPath: "docs/README.md",
          resolvedPath: "/repo/docs/README.md",
          linkText: candidate.linkText,
          startIndex: candidate.startIndex,
          endIndex: candidate.endIndex,
          baseCwd: candidate.baseCwd,
          activation: "markdown-preview" as const
        }))
      })
    });

    const links = await provideLinksFromProvider(providers[0], 1);
    links?.[0]?.activate(new MouseEvent("click"), "docs/README.md:12");
    await Promise.resolve();

    expect(activateFileLink).toHaveBeenCalledWith({
      sourceSurfaceId: "surface_1",
      rawPath: "docs/README.md",
      baseCwd: "/repo"
    });
    expect(openFilePath).not.toHaveBeenCalled();
    registration.dispose();
  });

  it("uses the same xterm link decorations and click behavior as web URLs", async () => {
    const providers: ILinkProvider[] = [];
    const providerDisposable = { dispose: vi.fn() };
    const terminal = createFakeTerminal("docs/README.md:12");
    terminal.registerLinkProvider = vi.fn((nextProvider: ILinkProvider) => {
      providers.push(nextProvider);
      return providerDisposable;
    });
    const openFilePath = vi.fn(async () => {});
    const activateFileLink = vi.fn(async () => {});

    const registration = registerTerminalFileLinkProvider({
      terminal,
      getKeyboardPlatform: () => "linux",
      surfaceId: "surface_1",
      openFilePath,
      activateFileLink,
      resolveFileLinks: async (_surfaceId, candidates) => ({
        links: candidates.map((candidate) => ({
          id: candidate.id,
          openRawPath: "docs/README.md",
          resolvedPath: "/repo/docs/README.md",
          linkText: candidate.linkText,
          startIndex: candidate.startIndex,
          endIndex: candidate.endIndex,
          activation: "markdown-preview" as const
        }))
      })
    });

    expect(providers).toHaveLength(1);
    const links = await provideLinksFromProvider(providers[0], 1);

    const link = links?.[0];
    expect(link?.text).toBe("docs/README.md:12");
    expect(link?.decorations).toEqual({
      pointerCursor: true,
      underline: true
    });
    expect(link?.hover).toBeUndefined();
    expect(link?.leave).toBeUndefined();

    link?.activate(new MouseEvent("click"), link.text);
    await Promise.resolve();
    expect(activateFileLink).toHaveBeenCalledWith({
      sourceSurfaceId: "surface_1",
      rawPath: "docs/README.md"
    });
    expect(openFilePath).not.toHaveBeenCalled();

    registration.dispose();
    expect(providerDisposable.dispose).toHaveBeenCalledOnce();
  });

  it("updates hover decorations with the platform modifier and gates non-Markdown activation", async () => {
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
      openFilePath,
      resolveFileLinks: resolveAllFileLinks
    });

    expect(providers).toHaveLength(1);
    const links = await provideLinksFromProvider(providers[0], 1);

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
    expect(openFilePath).toHaveBeenCalledWith("surface_1", "src/App.tsx");

    window.dispatchEvent(new KeyboardEvent("keyup"));
    expect(link?.decorations).toEqual({
      pointerCursor: false,
      underline: false
    });

    registration.dispose();
    expect(providerDisposable.dispose).toHaveBeenCalledOnce();
  });

  it("uses Command, not Option, for non-Markdown links on macOS", async () => {
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
      openFilePath,
      resolveFileLinks: resolveAllFileLinks
    });

    const links = await provideLinksFromProvider(providers[0], 1);

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
    expect(openFilePath).toHaveBeenCalledWith("surface_1", "src/App.tsx");

    registration.dispose();
  });

  it("updates xterm-proxied decorations for macOS Command hover state", async () => {
    const providers: ILinkProvider[] = [];
    const terminal = createFakeTerminal("src/App.tsx");
    terminal.registerLinkProvider = vi.fn((nextProvider: ILinkProvider) => {
      providers.push(nextProvider);
      return { dispose: vi.fn() };
    });

    const registration = registerTerminalFileLinkProvider({
      terminal,
      getKeyboardPlatform: () => "darwin",
      surfaceId: "surface_1",
      openFilePath: vi.fn(async () => {}),
      resolveFileLinks: resolveAllFileLinks
    });

    const links = await provideLinksFromProvider(providers[0], 1);

    const link = links?.[0];
    expect(link?.text).toBe("src/App.tsx");

    const commandHoverDecorations = createTrackedDecorations();
    link?.hover?.(new MouseEvent("mousemove", { metaKey: true }), link.text);
    link!.decorations = commandHoverDecorations.decorations;
    await Promise.resolve();

    expect(commandHoverDecorations.state).toEqual({
      pointerCursor: true,
      underline: true
    });

    link?.leave?.(new MouseEvent("mouseout"), link.text);

    const commandKeyDecorations = createTrackedDecorations();
    link?.hover?.(new MouseEvent("mousemove"), link.text);
    link!.decorations = commandKeyDecorations.decorations;
    await Promise.resolve();

    expect(commandKeyDecorations.state).toEqual({
      pointerCursor: false,
      underline: false
    });

    window.dispatchEvent(new KeyboardEvent("keydown", { metaKey: true }));
    expect(commandKeyDecorations.state).toEqual({
      pointerCursor: true,
      underline: true
    });

    window.dispatchEvent(new KeyboardEvent("keyup"));
    expect(commandKeyDecorations.state).toEqual({
      pointerCursor: false,
      underline: false
    });

    registration.dispose();
  });

  it("opens the resolved path built from the captured line cwd", async () => {
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
      resolveFileLinks: resolveAllFileLinks,
      getCwdForBufferLine: () => "/repo/old"
    });

    const links = await provideLinksFromProvider(providers[0], 1);
    links?.[0]?.activate(
      new MouseEvent("click", { ctrlKey: true }),
      "src/App.tsx"
    );
    await Promise.resolve();

    expect(openFilePath).toHaveBeenCalledWith(
      "surface_1",
      "/repo/old/src/App.tsx"
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
      resolveFileLinks: resolveAllFileLinks,
      getCwdForBufferLine: (bufferLineNumber) =>
        bufferLineNumber === 0 ? "/repo/start" : "/repo/continuation"
    });

    const links = await provideLinksFromProvider(providers[0], 2);
    links?.[0]?.activate(
      new MouseEvent("click", { ctrlKey: true }),
      "src/App.tsx"
    );
    await Promise.resolve();

    expect(openFilePath).toHaveBeenCalledWith(
      "surface_1",
      "/repo/start/src/App.tsx"
    );
    registration.dispose();
  });
});

async function provideFileLinksForText(
  text: string,
  resolveFileLinks = resolveAllFileLinks
): Promise<ILink[] | undefined> {
  return provideFileLinksForLines(
    [{ text, isWrapped: false }],
    resolveFileLinks
  );
}

async function provideFileLinksForLines(
  lines: Array<{ text: string; isWrapped: boolean }>,
  resolveFileLinks = resolveAllFileLinks
): Promise<ILink[] | undefined> {
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
    openFilePath: vi.fn(async () => {}),
    resolveFileLinks
  });

  const links = await provideLinksFromProvider(providers[0], 1);
  registration.dispose();
  return links;
}

function provideLinksFromProvider(
  provider: ILinkProvider | undefined,
  bufferLineNumber: number
): Promise<ILink[] | undefined> {
  return new Promise((resolve) => {
    if (!provider) {
      resolve(undefined);
      return;
    }
    provider.provideLinks(bufferLineNumber, (providedLinks) => {
      resolve(providedLinks);
    });
  });
}

async function resolveAllFileLinks(
  _surfaceId: string,
  candidates: TerminalFileLinkResolveCandidate[]
): Promise<TerminalFileLinkResolveResult> {
  return {
    links: candidates.map((candidate) => ({
      id: candidate.id,
      openRawPath: candidate.rawPath,
      resolvedPath: candidate.baseCwd
        ? `${candidate.baseCwd}/${candidate.rawPath}`
        : candidate.rawPath,
      linkText: candidate.linkText,
      startIndex: candidate.startIndex,
      endIndex: candidate.endIndex
    }))
  };
}

async function resolveOnlyFallbackFileLinks(
  _surfaceId: string,
  candidates: TerminalFileLinkResolveCandidate[]
): Promise<TerminalFileLinkResolveResult> {
  return {
    links: candidates
      .filter((candidate) => candidate.id.startsWith("fallback-"))
      .map((candidate) => ({
        id: candidate.id,
        openRawPath: candidate.rawPath,
        resolvedPath: candidate.baseCwd
          ? `${candidate.baseCwd}/${candidate.rawPath}`
          : candidate.rawPath,
        linkText: candidate.linkText,
        startIndex: candidate.startIndex,
        endIndex: candidate.endIndex
      }))
  };
}

function createFakeTerminal(text: string): Terminal {
  return createFakeTerminalFromLines([{ text, isWrapped: false }]);
}

function createTrackedDecorations(): {
  decorations: ILinkDecorations;
  state: ILinkDecorations;
} {
  const state: ILinkDecorations = {
    pointerCursor: false,
    underline: false
  };
  const decorations = {} as ILinkDecorations;
  Object.defineProperties(decorations, {
    pointerCursor: {
      get: () => state.pointerCursor,
      set: (value: boolean) => {
        state.pointerCursor = value;
      }
    },
    underline: {
      get: () => state.underline,
      set: (value: boolean) => {
        state.underline = value;
      }
    }
  });
  return { decorations, state };
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
