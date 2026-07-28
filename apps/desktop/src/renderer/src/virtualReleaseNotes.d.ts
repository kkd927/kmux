declare module "virtual:kmux-release-notes" {
  const releaseNotes: {
    version: string;
    markdown: string;
    imageSources: Readonly<Record<string, string>>;
  } | null;
  export default releaseNotes;
}
