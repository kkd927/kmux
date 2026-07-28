declare module "virtual:kmux-release-notes" {
  const releaseNotes: {
    version: string;
    default: {
      markdown: string;
      imageSources: Readonly<Record<string, string>>;
    };
    localized: Readonly<
      Record<
        string,
        {
          markdown: string;
          imageSources: Readonly<Record<string, string>>;
        }
      >
    >;
  } | null;
  export default releaseNotes;
}
