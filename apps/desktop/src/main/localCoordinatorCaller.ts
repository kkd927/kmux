import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename } from "node:path";

const execFileAsync = promisify(execFile);
type ProcessIdentity = { readonly pid: number; readonly startedAt: string };
type ProcessEntry = ProcessIdentity & {
  readonly parentPid: number;
  readonly executable: string;
};

async function processTable(): Promise<Map<number, ProcessEntry>> {
  if (process.platform === "win32")
    throw new Error(
      "Terminal Coordinator process verification is not available on this host"
    );
  const { stdout } = await execFileAsync(
    "ps",
    ["-axo", "pid=,ppid=,lstart=,comm="],
    {
      env: { ...process.env, LC_ALL: "C" },
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024
    }
  );
  const entries = new Map<number, ProcessEntry>();
  for (const line of stdout.split("\n")) {
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/u.exec(line);
    if (match)
      entries.set(Number(match[1]), {
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        startedAt: match[3]!.replace(/\s+/gu, " "),
        executable: match[4]!
      });
  }
  return entries;
}

function ancestry(
  entries: Map<number, ProcessEntry>,
  callerPid: number | undefined,
  terminalPid: number | undefined
): ProcessEntry[] {
  const chain: ProcessEntry[] = [];
  let pid = callerPid;
  while (pid && chain.length < 256) {
    const entry = entries.get(pid);
    if (!entry || chain.some((item) => item.pid === pid)) break;
    chain.push(entry);
    if (pid === terminalPid) return chain;
    pid = entry.parentPid;
  }
  throw new Error(
    "Coordinator command must originate from its authenticated live terminal process"
  );
}

async function captureTerminalOwner(
  terminalPid: number | undefined,
  callerPid: number | undefined
): Promise<ProcessEntry> {
  const chain = ancestry(await processTable(), callerPid, terminalPid);
  // Skip interactive/subshell wrappers without identifying a particular vendor.
  const root = chain.at(-1)!;
  const owner =
    chain
      .slice(1)
      .reverse()
      .find((entry) => !isShell(entry)) ?? root;
  return owner;
}

function isShell(entry: ProcessEntry): boolean {
  return /^-?(?:sh|bash|zsh|fish|dash|ksh|tcsh|csh|nu)$/u.test(
    basename(entry.executable)
  );
}

export async function captureTerminalCoordinator(
  terminalPid: number | undefined,
  callerPid: number | undefined
): Promise<ProcessIdentity> {
  const owner = await captureTerminalOwner(terminalPid, callerPid);
  return { pid: owner.pid, startedAt: owner.startedAt };
}

/** Generic process ownership works for every vendor and direct PTY launches. */
export async function captureTerminalWorkflowCaller(
  terminalPid: number | undefined,
  callerPid: number | undefined
): Promise<ProcessIdentity | undefined> {
  const owner = await captureTerminalOwner(terminalPid, callerPid);
  return isShell(owner)
    ? undefined
    : { pid: owner.pid, startedAt: owner.startedAt };
}

export async function verifyTerminalCoordinator(
  terminalPid: number | undefined,
  callerPid: number | undefined,
  expected: ProcessIdentity
): Promise<void> {
  const chain = ancestry(await processTable(), callerPid, terminalPid);
  if (
    !chain.some(
      (entry) =>
        entry.pid === expected.pid && entry.startedAt === expected.startedAt
    )
  ) {
    throw new Error(
      "The original Coordinator process has ended or this command belongs to another conversation"
    );
  }
}
