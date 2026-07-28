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
      const documents = [
        releaseNotes.default,
        ...Object.values(releaseNotes.localized)
      ];
      for (const document of documents) {
        this.addWatchFile(document.notePath);
        for (const image of document.images) {
          this.addWatchFile(image.absolutePath);
        }
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

  const imports: string[] = [];
  let imageIndex = 0;
  const renderDocument = (
    document: BundledReleaseNotesSource["default"],
    indentation: string
  ): string[] => {
    const imageSources = document.images.map((image) => {
      const importName = `releaseNoteImage${imageIndex}`;
      imageIndex += 1;
      imports.push(
        `import ${importName} from ${JSON.stringify(`${image.absolutePath}?url`)};`
      );
      return `${JSON.stringify(image.source)}: ${importName}`;
    });
    return [
      `${indentation}{`,
      `${indentation}  markdown: ${JSON.stringify(document.markdown)},`,
      `${indentation}  imageSources: {${imageSources.join(",")}}`,
      `${indentation}}`
    ];
  };

  const defaultDocument = renderDocument(releaseNotes.default, "  ");
  const localizedDocuments = Object.entries(releaseNotes.localized).flatMap(
    ([locale, document], index, entries) => {
      const rendered = renderDocument(document, "    ");
      rendered[0] = `    ${JSON.stringify(locale)}: {`;
      rendered[rendered.length - 1] =
        `    }${index === entries.length - 1 ? "" : ","}`;
      return rendered;
    }
  );

  return [
    ...imports,
    "const releaseNotes = {",
    `  version: ${JSON.stringify(releaseNotes.version)},`,
    "  default:",
    ...defaultDocument.map((line, index) =>
      index === defaultDocument.length - 1 ? `${line},` : line
    ),
    "  localized: {",
    ...localizedDocuments,
    "  }",
    "};",
    "export default releaseNotes;"
  ].join("\n");
}
