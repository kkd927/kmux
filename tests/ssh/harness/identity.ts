import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";

import { runOpenSshCommand } from "../../../apps/desktop/src/remote-host/openSshProcess";

export interface SshTestIdentity {
  privateKeyPath: string;
  publicKeyPath: string;
  publicKey: string;
}

export async function createSshTestIdentity(options: {
  sandboxPath: string;
  name: string;
  sshKeygenPath: string;
  passphrase?: string;
}): Promise<SshTestIdentity> {
  const privateKeyPath = join(options.sandboxPath, options.name);
  await runOpenSshCommand(
    options.sshKeygenPath,
    [
      "-q",
      "-t",
      "ed25519",
      "-N",
      options.passphrase ?? "",
      "-C",
      `${options.name}@kmux.invalid`,
      "-f",
      privateKeyPath
    ],
    { timeoutMs: 15_000 }
  );
  await chmod(privateKeyPath, 0o600);
  await chmod(`${privateKeyPath}.pub`, 0o644);
  return {
    privateKeyPath,
    publicKeyPath: `${privateKeyPath}.pub`,
    publicKey: (await readFile(`${privateKeyPath}.pub`, "utf8")).trim()
  };
}
