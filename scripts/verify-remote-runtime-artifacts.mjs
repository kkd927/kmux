import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  REMOTE_RUNTIME_TARGET_NAMES,
  nativeRemoteRuntimeTarget,
  verifyRemoteRuntimeArtifact,
  writeRemoteRuntimeIndex
} from "./remote-runtime-artifact-contract.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distributionRoot = join(repositoryRoot, "remote", "kmuxd", "dist");
const nativeOnly = process.argv.includes("--native-only");
const allowCrossHostDarwinSignatureAttestation = process.argv.includes(
  "--cross-host-signature-attestation"
);
const unknownArguments = process.argv
  .slice(2)
  .filter(
    (value) =>
      value !== "--native-only" &&
      value !== "--cross-host-signature-attestation"
  );
if (
  unknownArguments.length > 0 ||
  (nativeOnly && allowCrossHostDarwinSignatureAttestation)
) {
  throw new Error("invalid remote runtime verification arguments");
}

if (nativeOnly) {
  const target = nativeRemoteRuntimeTarget();
  if (!target) {
    throw new Error("this host is not a supported remote runtime target");
  }
  const result = await verifyRemoteRuntimeArtifact(distributionRoot, target, {
    verifyNativeCapabilities: true
  });
  process.stdout.write(
    `${JSON.stringify({ target, sha256: result.manifest.sha256, native: true })}\n`
  );
} else {
  const index = await writeRemoteRuntimeIndex(distributionRoot, {
    allowCrossHostDarwinSignatureAttestation
  });
  process.stdout.write(
    `${JSON.stringify({ targets: REMOTE_RUNTIME_TARGET_NAMES, runtimeVersion: index.runtimeVersion })}\n`
  );
}
