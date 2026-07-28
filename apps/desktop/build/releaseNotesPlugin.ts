import type { Plugin } from "vite";

import {
  loadBundledReleaseNotes,
  type BundledReleaseNotesSource
} from "../../../scripts/release-notes.mjs";

export const RELEASE_NOTES_VIRTUAL_MODULE_ID = "virtual:kmux-release-notes";
const resolvedVirtualModuleId = `\0${RELEASE_NOTES_VIRTUAL_MODULE_ID}`;

export function createReleaseNotesPlugin(options: {
  repoRoot: string;
  releaseNotes?: BundledReleaseNotesSource | null;
}): Plugin {
  const releaseNotes =
    options.releaseNotes === undefined
      ? loadBundledReleaseNotes({ repoRoot: options.repoRoot })
      : options.releaseNotes;

  return {
    name: "kmux:release-notes",
    resolveId(id) {
      return id === RELEASE_NOTES_VIRTUAL_MODULE_ID
        ? resolvedVirtualModuleId
        : null;
    },
    load(id) {
      if (id !== resolvedVirtualModuleId) {
        return null;
      }
      if (!releaseNotes) {
        return "export default null;";
      }
      this.addWatchFile(releaseNotes.notePath);
      for (const image of releaseNotes.images) {
        this.addWatchFile(image.absolutePath);
      }
      return renderReleaseNotesVirtualModule(releaseNotes);
    }
  };
}

export function renderReleaseNotesVirtualModule(
  releaseNotes: BundledReleaseNotesSource | null
): string {
  if (!releaseNotes) {
    return "export default null;";
  }
  const imports = releaseNotes.images.map(
    (image, index) =>
      `import releaseNoteImage${index} from ${JSON.stringify(`${image.absolutePath}?url`)};`
  );
  const imageSources = releaseNotes.images.map(
    (image, index) =>
      `${JSON.stringify(image.source)}: releaseNoteImage${index}`
  );
  return [
    ...imports,
    "const releaseNotes = {",
    `  version: ${JSON.stringify(releaseNotes.version)},`,
    `  markdown: ${JSON.stringify(releaseNotes.markdown)},`,
    `  imageSources: {${imageSources.join(",")}}`,
    "};",
    "export default releaseNotes;"
  ].join("\n");
}
