import { describe, expect, it, vi } from "vitest";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";

import { installMultilineOscLinkProvider } from "./terminalOscLinks";
import { computeTerminalWebLinks } from "./terminalWebLinks";

async function createTerminal(cols: number, data: string): Promise<Terminal> {
  const terminal = new HeadlessTerminal({
    cols,
    rows: 12,
    allowProposedApi: true
  });
  await new Promise<void>((resolve) => terminal.write(data, resolve));
  return terminal as unknown as Terminal;
}

describe("terminal web links across wrapped lines", () => {
  it("computes full multi-line ranges for soft-wrapped URLs after wide characters", async () => {
    const url =
      "https://example.com/shared/infra/http/npush/NpushClient.java?line=25";
    const terminal = await createTerminal(
      60,
      `크가 HTTP 요청 여러 건으로 나뉩니다. ${url}\r\n`
    );
    const activate = vi.fn();

    const fromRow1 = computeTerminalWebLinks(1, terminal, activate);
    const fromRow2 = computeTerminalWebLinks(2, terminal, activate);
    const expectedRange = {
      start: { x: 38, y: 1 },
      end: { x: 45, y: 2 }
    };

    expect(fromRow1).toHaveLength(1);
    expect(fromRow1[0]?.text).toBe(url);
    expect(fromRow1[0]?.range).toEqual(expectedRange);

    expect(fromRow2).toHaveLength(1);
    expect(fromRow2[0]?.text).toBe(url);
    expect(fromRow2[0]?.range).toEqual(expectedRange);

    terminal.dispose();
  });

  it("connects TUI hard-wrapped URLs split at delimiters or right edge from both lines", async () => {
    const delimiterTerminal = await createTerminal(
      70,
      "문서를 확인하세요: https://example.com/org/repo/blob/main/shared/\r\nNpushClient.java\r\n"
    );
    const activate = vi.fn();
    const expectedUrl =
      "https://example.com/org/repo/blob/main/shared/NpushClient.java";
    const expectedRange = {
      start: { x: 20, y: 1 },
      end: { x: 16, y: 2 }
    };

    expect(computeTerminalWebLinks(1, delimiterTerminal, activate)).toEqual([
      expect.objectContaining({ text: expectedUrl, range: expectedRange })
    ]);
    expect(computeTerminalWebLinks(2, delimiterTerminal, activate)).toEqual([
      expect.objectContaining({ text: expectedUrl, range: expectedRange })
    ]);
    delimiterTerminal.dispose();

    const flushTerminal = await createTerminal(
      40,
      "See https://example.com/very/long/path/a\r\nb/c/index.html\r\n"
    );
    expect(computeTerminalWebLinks(1, flushTerminal, activate)).toEqual([
      expect.objectContaining({
        text: "https://example.com/very/long/path/ab/c/index.html",
        range: { start: { x: 5, y: 1 }, end: { x: 14, y: 2 } }
      })
    ]);
    flushTerminal.dispose();
  });

  it("does not merge hard-wrapped URLs into prose, separate URLs, or differently styled lines", async () => {
    const activate = vi.fn();

    const proseTerminal = await createTerminal(
      60,
      "설명을 참고하세요: https://example.com/docs/getting-started\r\n다음 단계에서는 설정을 확인합니다.\r\n"
    );
    expect(computeTerminalWebLinks(1, proseTerminal, activate)).toEqual([
      expect.objectContaining({
        text: "https://example.com/docs/getting-started",
        range: { start: { x: 20, y: 1 }, end: { x: 59, y: 1 } }
      })
    ]);
    proseTerminal.dispose();

    const consecutiveUrls = await createTerminal(
      60,
      "https://example.com/org/project/issues/12345678901234567890\r\nhttps://example.com/org/project/issues/999\r\n"
    );
    expect(computeTerminalWebLinks(1, consecutiveUrls, activate)).toEqual([
      expect.objectContaining({
        text: "https://example.com/org/project/issues/12345678901234567890",
        range: { start: { x: 1, y: 1 }, end: { x: 59, y: 1 } }
      })
    ]);
    consecutiveUrls.dispose();

    const styleMismatch = await createTerminal(
      50,
      "See \x1b[36mhttps://example.com/very/long/path/prefix/\x1b[0m\r\nnext/segment\r\n"
    );
    expect(computeTerminalWebLinks(1, styleMismatch, activate)).toEqual([
      expect.objectContaining({
        text: "https://example.com/very/long/path/prefix/",
        range: { start: { x: 5, y: 1 }, end: { x: 46, y: 1 } }
      })
    ]);
    styleMismatch.dispose();
  });
});

describe("multiline OSC 8 hyperlink expansion", () => {
  it("expands soft-wrapped and hard-wrapped OSC 8 links without merging unrelated rows", async () => {
    const terminal = (await createTerminal(
      40,
      "See \x1b]8;;https://example.com/soft\x07https://example.com/very/long/wrapped/path\x1b]8;;\x07 end\r\n" +
        "Hard \x1b]8;;https://example.com/hard\x07https://example.com/a/\r\nb/c\x1b]8;;\x07\r\n" +
        "\x1b]8;;https://example.com/same\x07one\x1b]8;;\x07\r\n" +
        "\x1b]8;;https://example.com/same\x07two\x1b]8;;\x07\r\n"
    )) as Terminal & {
      _core: {
        _bufferService: {
          buffer: {
            lines: {
              get(index: number): {
                getTrimmedLength(): number;
                loadCell(
                  index: number,
                  cell: {
                    hasExtendedAttrs(): boolean | number;
                    extended: { urlId: number };
                  }
                ): void;
              };
            };
            getNullCell(): {
              hasExtendedAttrs(): boolean | number;
              extended: { urlId: number };
            };
          };
          cols: number;
        };
        _oscLinkService: {
          getLinkData(linkId: number): { id?: string; uri: string } | undefined;
        };
        _linkProviderService?: { linkProviders: ILinkProvider[] };
      };
    };

    const singleLineOscProvider: ILinkProvider = {
      provideLinks(y, callback) {
        const line = terminal._core._bufferService.buffer.lines.get(y - 1);
        const cell = terminal._core._bufferService.buffer.getNullCell();
        const trimmed = line.getTrimmedLength();
        const links: ILink[] = [];
        let start = -1;
        let currentId = 0;
        for (let x = 0; x < trimmed; x += 1) {
          line.loadCell(x, cell);
          const uid = cell.hasExtendedAttrs() ? cell.extended.urlId : 0;
          if (uid !== currentId) {
            if (currentId !== 0 && start !== -1) {
              const uri = terminal._core._oscLinkService.getLinkData(currentId)
                ?.uri;
              if (uri) {
                links.push({
                  text: uri,
                  range: { start: { x: start + 1, y }, end: { x, y } },
                  activate: vi.fn()
                });
              }
            }
            currentId = uid;
            start = uid !== 0 ? x : -1;
          }
        }
        if (currentId !== 0 && start !== -1) {
          const uri = terminal._core._oscLinkService.getLinkData(currentId)
            ?.uri;
          if (uri) {
            links.push({
              text: uri,
              range: { start: { x: start + 1, y }, end: { x: trimmed, y } },
              activate: vi.fn()
            });
          }
        }
        callback(links);
      }
    };

    terminal._core._linkProviderService = {
      linkProviders: [singleLineOscProvider]
    };
    const restore = installMultilineOscLinkProvider(terminal);
    const provider = terminal._core._linkProviderService.linkProviders[0];

    const getLinks = (row: number) =>
      new Promise<ILink[] | undefined>((resolve) =>
        provider.provideLinks(row, resolve)
      );

    // Soft-wrapped OSC 8 spans row 1 (col 5..40) -> row 2 (col 1..6)
    expect(await getLinks(1)).toEqual([
      expect.objectContaining({
        text: "https://example.com/soft",
        range: { start: { x: 5, y: 1 }, end: { x: 6, y: 2 } }
      })
    ]);
    expect(await getLinks(2)).toEqual([
      expect.objectContaining({
        text: "https://example.com/soft",
        range: { start: { x: 5, y: 1 }, end: { x: 6, y: 2 } }
      })
    ]);

    // Hard-wrapped open OSC 8 spans row 3 (col 6..27) -> row 4 (col 1..3)
    expect(await getLinks(3)).toEqual([
      expect.objectContaining({
        text: "https://example.com/hard",
        range: { start: { x: 6, y: 3 }, end: { x: 3, y: 4 } }
      })
    ]);
    expect(await getLinks(4)).toEqual([
      expect.objectContaining({
        text: "https://example.com/hard",
        range: { start: { x: 6, y: 3 }, end: { x: 3, y: 4 } }
      })
    ]);

    // Unrelated short OSC 8 links with identical URI on rows 5 and 6 stay separate
    expect(await getLinks(5)).toEqual([
      expect.objectContaining({
        text: "https://example.com/same",
        range: { start: { x: 1, y: 5 }, end: { x: 3, y: 5 } }
      })
    ]);
    expect(await getLinks(6)).toEqual([
      expect.objectContaining({
        text: "https://example.com/same",
        range: { start: { x: 1, y: 6 }, end: { x: 3, y: 6 } }
      })
    ]);

    restore();
    expect(terminal._core._linkProviderService.linkProviders[0]).toBe(
      singleLineOscProvider
    );
    terminal.dispose();
  });
});
