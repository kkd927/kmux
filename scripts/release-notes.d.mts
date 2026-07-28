export interface ReleaseNoteImage {
  source: string;
  absolutePath: string;
}

export interface BundledReleaseNoteDocumentSource {
  markdown: string;
  notePath: string;
  images: ReleaseNoteImage[];
}

export interface BundledReleaseNotesSource {
  version: string;
  default: BundledReleaseNoteDocumentSource;
  localized: Record<string, BundledReleaseNoteDocumentSource>;
}

export function loadBundledReleaseNotes(options: {
  repoRoot: string;
  version?: string;
}): BundledReleaseNotesSource | null;

export function resolveReleaseNoteImages(options: {
  markdown: string;
  notePath: string;
  version: string;
}): ReleaseNoteImage[];

export function rewriteReleaseNoteImagesForGitHub(
  markdown: string,
  options: {
    notePath: string;
    repository: string;
    tag: string;
    version: string;
  }
): string;

export function prepareGitHubReleaseNotes(options: {
  repoRoot: string;
  repository: string;
  tag: string;
  outputPath: string;
}): boolean;
