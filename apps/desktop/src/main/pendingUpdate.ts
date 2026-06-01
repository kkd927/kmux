import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";

export interface PendingUpdateRecord {
  version: string;
}

export interface PendingUpdateStore {
  read(): PendingUpdateRecord | null;
  record(version: string): void;
  clear(): void;
}

export type PendingInstallStatus = "none" | "applied" | "incomplete";

export interface PendingInstallEvaluation {
  status: PendingInstallStatus;
  version?: string;
}

/**
 * Records the version targeted by the most recent `quitAndInstall` so the next
 * launch can tell whether Squirrel.Mac actually swapped the bundle. macOS only
 * installs one Squirrel update per login session; a second attempt stages the
 * update but never runs ShipIt, leaving the app on the old version with no
 * error surfaced. Comparing the recorded version against the running version on
 * startup lets us turn that silent failure into an actionable "restart your
 * Mac" hint.
 */
export function createPendingUpdateStore(filePath: string): PendingUpdateStore {
  return {
    read() {
      let content: string;
      try {
        content = readFileSync(filePath, "utf8");
      } catch {
        return null;
      }
      try {
        const parsed = JSON.parse(content) as Partial<PendingUpdateRecord>;
        if (typeof parsed?.version === "string" && parsed.version.trim()) {
          return { version: parsed.version.trim() };
        }
      } catch {
        // Corrupt marker: treat as absent.
      }
      return null;
    },
    record(version) {
      const trimmed = version?.trim();
      if (!trimmed) {
        return;
      }
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        const tmpPath = `${filePath}.tmp-${process.pid}`;
        writeFileSync(tmpPath, JSON.stringify({ version: trimmed }, null, 2));
        try {
          renameSync(tmpPath, filePath);
        } finally {
          if (existsSync(tmpPath)) {
            rmSync(tmpPath, { force: true });
          }
        }
      } catch {
        // Best effort: failing to record only disables the recovery hint.
      }
    },
    clear() {
      try {
        rmSync(filePath, { force: true });
      } catch {
        // Ignore: nothing to clear.
      }
    }
  };
}

/**
 * Compares dotted numeric versions (e.g. "0.3.10" vs "0.3.11"), ignoring any
 * prerelease suffix. Returns -1, 0, or 1.
 */
export function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index] ?? 0;
    const b = rightParts[index] ?? 0;
    if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
}

function parseVersion(version: string): number[] {
  return String(version)
    .split("-")[0]
    .split(".")
    .map((segment) => {
      const value = Number.parseInt(segment, 10);
      return Number.isFinite(value) ? value : 0;
    });
}

/**
 * Decides what to do with a recorded pending install given the currently
 * running version. "applied" means the swap succeeded (or was superseded);
 * "incomplete" means the update never landed and the user should be nudged.
 */
export function evaluatePendingInstall(
  currentVersion: string,
  record: PendingUpdateRecord | null
): PendingInstallEvaluation {
  if (!record?.version) {
    return { status: "none" };
  }
  if (compareVersions(currentVersion, record.version) >= 0) {
    return { status: "applied", version: record.version };
  }
  return { status: "incomplete", version: record.version };
}
