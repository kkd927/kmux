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
            source: "./assets/v1.2.0/current.webp",
            absolutePath: "/repo/docs/release-notes/assets/v1.2.0/current.webp"
          }
        ]
      },
      localized: {
        ko: {
          markdown: "# 현재",
          notePath: "/repo/docs/release-notes/v1.2.0.ko.md",
          images: [
            {
              source: "./assets/v1.2.0/ko.png",
              absolutePath: "/repo/docs/release-notes/assets/v1.2.0/ko.png"
            }
          ]
        }
      }
    });

    expect(source).toContain(
      'import releaseNoteImage0 from "/repo/docs/release-notes/assets/v1.2.0/current.webp?url";'
    );
    expect(source).toContain(
      'import releaseNoteImage1 from "/repo/docs/release-notes/assets/v1.2.0/ko.png?url";'
    );
    expect(source).toContain('"./assets/v1.2.0/current.webp"');
    expect(source).toContain('"./assets/v1.2.0/ko.png"');
    expect(source).toContain('"ko": {');
    expect(source).toContain('markdown: "# 현재"');
    expect(source).not.toContain("v1.1.0");
  });

  it("exports null when the current release has no notes", () => {
    expect(renderReleaseNotesVirtualModule(null)).toBe("export default null;");
  });
});
