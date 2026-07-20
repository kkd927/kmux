export type BootstrapAccountShellKind = "bourne" | "fish" | "csh" | "explicit";

export interface BootstrapShellPolicy {
  accountShellPath: string;
  accountShellKind: BootstrapAccountShellKind;
  bootstrapShellPath: string;
}

const BOURNE_SHELLS = new Set([
  "ash",
  "bash",
  "dash",
  "ksh",
  "mksh",
  "sh",
  "zsh"
]);
const FISH_SHELLS = new Set(["fish"]);
const CSH_SHELLS = new Set(["csh", "tcsh"]);

export function resolveBootstrapShellPolicy(options: {
  environmentOutput: string;
  bootstrapShellOverride?: string;
}): BootstrapShellPolicy {
  const accountShellPath = parseAccountShell(options.environmentOutput);
  const basename = accountShellPath.slice(
    accountShellPath.lastIndexOf("/") + 1
  );
  const accountShellKind = BOURNE_SHELLS.has(basename)
    ? "bourne"
    : FISH_SHELLS.has(basename)
      ? "fish"
      : CSH_SHELLS.has(basename)
        ? "csh"
        : undefined;
  if (!accountShellKind && options.bootstrapShellOverride === undefined) {
    throw new Error(
      `remote account shell ${JSON.stringify(accountShellPath)} is not a known bootstrap shell; set bootstrapShellOverride to an absolute POSIX-compatible shell path`
    );
  }
  const bootstrapShellPath =
    options.bootstrapShellOverride === undefined
      ? "/bin/sh"
      : requireAbsoluteShellPath(
          options.bootstrapShellOverride,
          "bootstrapShellOverride"
        );
  return {
    accountShellPath,
    accountShellKind: accountShellKind ?? "explicit",
    bootstrapShellPath
  };
}

export function buildBootstrapScriptCommand(
  policy: BootstrapShellPolicy,
  script: string
): string {
  requireBoundedCommand(script, "bootstrap script");
  const shell = quoteForAccountShell(
    policy.accountShellKind,
    requireAbsoluteShellPath(policy.bootstrapShellPath, "bootstrap shell")
  );
  const command = `${shell} -c ${quoteForAccountShell(policy.accountShellKind, script)}`;
  // OpenSSH necessarily asks the authenticated account shell to interpret its
  // command string. Known shells get explicit quoting adapters. An unknown
  // shell reaches this path only after the user explicitly supplied the
  // bootstrap interpreter, so no Bourne semantics are guessed silently.
  return policy.accountShellKind === "explicit" ? command : `exec ${command}`;
}

export function buildBootstrapHelperCommand(
  policy: BootstrapShellPolicy,
  runtimePath: string,
  args: readonly string[]
): string {
  const executable = requireAbsoluteShellPath(runtimePath, "remote runtime");
  if (
    args.length > 256 ||
    args.some(
      (argument) =>
        typeof argument !== "string" ||
        Buffer.byteLength(argument, "utf8") > 32 * 1024 ||
        /[\0\r\n]/u.test(argument)
    )
  ) {
    throw new TypeError("remote runtime arguments are invalid or oversized");
  }
  const inner = `exec ${[executable, ...args].map(quotePosixWord).join(" ")}`;
  return buildBootstrapScriptCommand(policy, inner);
}

function parseAccountShell(environmentOutput: string): string {
  if (
    typeof environmentOutput !== "string" ||
    Buffer.byteLength(environmentOutput, "utf8") > 64 * 1024 ||
    environmentOutput.includes("\0")
  ) {
    throw new TypeError("remote bootstrap environment output is invalid");
  }
  const values = environmentOutput
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("SHELL="))
    .map((line) => line.slice("SHELL=".length));
  const unique = [...new Set(values)];
  if (unique.length !== 1) {
    throw new Error(
      "remote account shell could not be determined unambiguously before bootstrap"
    );
  }
  return requireAbsoluteShellPath(unique[0], "remote account shell");
}

function requireAbsoluteShellPath(value: string, name: string): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    Buffer.byteLength(value, "utf8") > 32 * 1024 ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new TypeError(`${name} must be a bounded absolute path`);
  }
  return value;
}

function requireBoundedCommand(value: string, name: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 128 * 1024 ||
    value.includes("\0")
  ) {
    throw new TypeError(`${name} is empty or oversized`);
  }
}

function quoteForAccountShell(
  kind: BootstrapAccountShellKind,
  value: string
): string {
  switch (kind) {
    case "fish":
      return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
    case "bourne":
    case "csh":
    case "explicit":
      return quotePosixWord(value);
  }
}

function quotePosixWord(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
