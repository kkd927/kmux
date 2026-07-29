import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  classifySessionInventoryCandidate,
  collectSessionInventory,
  type SessionInventoryCandidateRole,
  type SessionInventoryLimits,
  type SessionInventoryVendor
} from "./sessionInventory";

interface ContractFixture {
  version: number;
  scenarios: ContractScenario[];
}

interface ContractScenario {
  name: string;
  roots: string[];
  limits?: SessionInventoryLimits;
  entries: Array<
    | { kind: "directory"; path: string }
    | { kind: "file"; path: string; mtimeMs: number }
    | { kind: "symlink"; path: string; target: string }
  >;
  expectedCandidates: string[];
  truncated: boolean;
  classifications: Array<{
    vendor: SessionInventoryVendor;
    root: string;
    path: string;
    role: SessionInventoryCandidateRole;
  }>;
}

const fixture = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "fixtures/session-inventory-contract.json"),
    "utf8"
  )
) as ContractFixture;
const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

describe("session inventory cross-language contract", () => {
  for (const scenario of fixture.scenarios) {
    it(scenario.name, () => {
      const sandbox = createScenario(scenario);
      const result = collectSessionInventory(
        scenario.roots.map((root) => join(sandbox, root)),
        scenario.limits
      );

      expect(
        result.candidates.map((candidate) =>
          relative(sandbox, candidate.path).replace(/\\/gu, "/")
        )
      ).toEqual(scenario.expectedCandidates);
      expect(result.truncated).toBe(scenario.truncated);
      for (const classification of scenario.classifications) {
        expect(
          classifySessionInventoryCandidate(
            classification.vendor,
            join(sandbox, classification.root),
            join(sandbox, classification.path)
          )
        ).toBe(classification.role);
      }
    });
  }
});

function createScenario(scenario: ContractScenario): string {
  const sandbox = mkdtempSync(join(tmpdir(), "kmux-inventory-contract-"));
  const canonicalSandbox = realpathSync.native(sandbox);
  sandboxes.push(canonicalSandbox);
  for (const root of scenario.roots) {
    if (
      !scenario.entries.some(
        (entry) => entry.path === root && entry.kind === "symlink"
      )
    ) {
      mkdirSync(join(canonicalSandbox, root), { recursive: true });
    }
  }
  for (const entry of scenario.entries) {
    const path = join(canonicalSandbox, entry.path);
    if (entry.kind === "symlink") {
      continue;
    }
    if (entry.kind === "directory") {
      mkdirSync(path, { recursive: true });
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, entry.path, "utf8");
    const modifiedAt = new Date(entry.mtimeMs);
    utimesSync(path, modifiedAt, modifiedAt);
  }
  for (const entry of scenario.entries) {
    if (entry.kind !== "symlink") {
      continue;
    }
    mkdirSync(dirname(join(canonicalSandbox, entry.path)), { recursive: true });
    symlinkSync(
      join(canonicalSandbox, entry.target),
      join(canonicalSandbox, entry.path)
    );
  }
  return canonicalSandbox;
}
