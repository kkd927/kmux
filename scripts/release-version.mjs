const NUMERIC_IDENTIFIER = "(?:0|[1-9][0-9]*)";
const PRERELEASE_IDENTIFIER = `(?:${NUMERIC_IDENTIFIER}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`;
const VERSION_PATTERN = new RegExp(
  `^(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})\\.${NUMERIC_IDENTIFIER}(?:-${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*)?$`
);

/**
 * Maps an application version to the minor release-note document version.
 * Patch and prerelease identifiers deliberately share the same release notes.
 */
export function releaseNotesVersionFor(version) {
  if (typeof version !== "string") {
    throw invalidVersionError(version);
  }
  const match = VERSION_PATTERN.exec(version);
  if (!match) {
    throw invalidVersionError(version);
  }
  return `${match[1]}.${match[2]}`;
}

function invalidVersionError(version) {
  return new Error(
    `Invalid application version ${JSON.stringify(version)}. Expected X.Y.Z or X.Y.Z-prerelease.`
  );
}
