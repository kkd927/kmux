import { describe, expect, it } from "vitest";

import { renderReleaseNotesVirtualModule } from "./releaseNotesPlugin";

describe("release note virtual module", () => {
  it("exports the default and localized documents with their own images", () => {
    const source = renderReleaseNotesVirtualModule({
      version: "1.2.0",
      default: {
        markdown: "# Current",
        notePath: "/repo/docs/release-notes/v1.2.0.md",
        images: [
          {
            source: "./assets/current.webp",
            absolutePath: "/repo/docs/release-notes/assets/current.webp"
          }
        ]
      },
      localized: {
        ko: {
          markdown: "# 현재",
          notePath: "/repo/docs/release-notes/v1.2.0.ko.md",
          images: [
            {
              source: "./assets/ko.png",
              absolutePath: "/repo/docs/release-notes/assets/ko.png"
            }
          ]
        }
      }
    });

    expect(source).toContain(
      'import releaseNoteImage0 from "/repo/docs/release-notes/assets/current.webp?url";'
    );
    expect(source).toContain(
      'import releaseNoteImage1 from "/repo/docs/release-notes/assets/ko.png?url";'
    );
    expect(source).toContain('"./assets/current.webp"');
    expect(source).toContain('"./assets/ko.png"');
    expect(source).toContain('"ko": {');
    expect(source).toContain('markdown: "# 현재"');
    expect(source).not.toContain("v1.1.0");
  });

  it("exports null when the current release has no notes", () => {
    expect(renderReleaseNotesVirtualModule(null)).toBe("export default null;");
  });
});
