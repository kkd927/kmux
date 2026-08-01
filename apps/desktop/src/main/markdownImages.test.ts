import path from "node:path";

import { locatedPathForTarget, type LocatedPath } from "@kmux/core";
import { createPathAccess } from "@kmux/core/main/path-access";
import { describe, expect, it, vi } from "vitest";

import {
  extractMarkdownImageSources,
  resolveMarkdownImageSources
} from "./markdownImages";
import type { LocatedTargetServiceSet } from "./targets/contracts";

describe("Markdown image resolution", () => {
  it("extracts inline, reference, and raw HTML images once", () => {
    expect(
      extractMarkdownImageSources(`
![inline](./assets/hero.png)
![reference][hero]
![duplicate](./assets/hero.png)

[hero]: ./assets/reference.webp

<p><img alt="button" src="./assets/button.svg?dark=1"></p>
<img src="https://example.com/badge.svg">
`)
    ).toEqual([
      "./assets/hero.png",
      "./assets/reference.webp",
      "./assets/button.svg?dark=1",
      "https://example.com/badge.svg"
    ]);
  });

  it("loads relative local or SSH assets as bounded data URLs and allowlists HTTPS images", async () => {
    const target = { kind: "local" } as const;
    const documentPath = locatedPathForTarget(target, "/repo/docs/README.md");
    const { unwrapLocal } = createPathAccess();
    const reads = new Map<string, Uint8Array>([
      ["/repo/assets/hero.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
      ["/repo/docs/button.svg", new TextEncoder().encode("<svg></svg>")]
    ]);
    const read = vi.fn(async (value: LocatedPath) => {
      const raw = displayLocatedPath(value, unwrapLocal);
      const bytes = reads.get(raw);
      if (!bytes) throw new Error("missing");
      return bytes;
    });
    const files = {
      dirname: (value: LocatedPath) =>
        locatedPathForTarget(
          target,
          path.dirname(displayLocatedPath(value, unwrapLocal))
        ),
      join: (base: LocatedPath, ...segments: string[]) =>
        locatedPathForTarget(
          target,
          path.join(displayLocatedPath(base, unwrapLocal), ...segments)
        ),
      read
    } as unknown as LocatedTargetServiceSet["files"];

    const imageSources = await resolveMarkdownImageSources({
      documentPath,
      files,
      markdown: [
        "![hero](../assets/hero.png)",
        '<img src="./button.svg?theme=dark">',
        "![remote](https://example.com/badge.svg)",
        "![blocked](file:///tmp/private.png)",
        "![not image](./secret.txt)"
      ].join("\n\n")
    });

    expect(read).toHaveBeenCalledTimes(2);
    expect(imageSources).toEqual({
      "../assets/hero.png": "data:image/png;base64,iVBORw==",
      "./button.svg?theme=dark": "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "https://example.com/badge.svg": "https://example.com/badge.svg"
    });
  });
});

function displayLocatedPath(
  value: LocatedPath,
  unwrapLocal: ReturnType<typeof createPathAccess>["unwrapLocal"]
): string {
  if (value.kind !== "local") throw new Error("expected local path");
  return unwrapLocal(value.path);
}
