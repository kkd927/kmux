import { describe, expect, it } from "vitest";

import { renderReleaseNotesVirtualModule } from "./releaseNotesPlugin";

describe("release note virtual module", () => {
  it("imports only the images selected for the current release", () => {
    const source = renderReleaseNotesVirtualModule({
      version: "1.2.0",
      markdown: "# Current",
      notePath: "/repo/docs/release-notes/v1.2.0.md",
      images: [
        {
          source: "./assets/v1.2.0/current.webp",
          absolutePath: "/repo/docs/release-notes/assets/v1.2.0/current.webp"
        }
      ]
    });

    expect(source).toContain(
      'import releaseNoteImage0 from "/repo/docs/release-notes/assets/v1.2.0/current.webp?url";'
    );
    expect(source).toContain('"./assets/v1.2.0/current.webp"');
    expect(source).not.toContain("v1.1.0");
  });

  it("exports null when the current release has no notes", () => {
    expect(renderReleaseNotesVirtualModule(null)).toBe("export default null;");
  });
});
