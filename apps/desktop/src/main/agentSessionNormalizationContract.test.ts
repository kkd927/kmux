import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync as NodeSqliteDatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createUsageAdapters } from "@kmux/metadata";

import { createExternalSessionIndexer } from "./externalSessions";

interface AgentSessionContractFixture {
  version: number;
  scenarios: AgentSessionContractScenario[];
}

interface AgentSessionContractScenario {
  name: string;
  vendor: "codex" | "claude" | "antigravity";
  sessionId: string;
  sourcePath: string;
  lines: Array<Record<string, unknown>>;
  usageSourcePath?: string;
  usageLines?: Array<Record<string, unknown>>;
  conversationPrompts?: string[];
  expected: {
    title: string;
    cwd: string;
    usage: {
      inputTokens: number;
      outputTokens: number;
      thinkingTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      cacheWriteTokensKnown: boolean;
      totalTokens: number;
    };
  };
}

const fixture = JSON.parse(
  readFileSync(
    resolve(
      process.cwd(),
      "fixtures/agent-session-normalization-contract.json"
    ),
    "utf8"
  )
) as AgentSessionContractFixture;
const sandboxes: string[] = [];
const nodeRequire = createRequire(import.meta.url);

type DatabaseSyncConstructor = typeof NodeSqliteDatabaseSync;

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

function writeAntigravityConversationDatabase(
  sandbox: string,
  sessionId: string,
  prompts: readonly string[]
): void {
  const DatabaseSync = (
    nodeRequire("node:sqlite") as {
      DatabaseSync?: DatabaseSyncConstructor;
    }
  ).DatabaseSync;
  if (!DatabaseSync) {
    throw new Error("node:sqlite is required by the normalization contract");
  }
  const path = join(
    sandbox,
    ".gemini",
    "antigravity-cli",
    "conversations",
    `${sessionId}.db`
  );
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  try {
    database.exec(
      "CREATE TABLE steps (idx INTEGER NOT NULL, step_type INTEGER NOT NULL, step_payload BLOB)"
    );
    const insert = database.prepare(
      "INSERT INTO steps (idx, step_type, step_payload) VALUES (?, 14, ?)"
    );
    prompts.forEach((prompt, index) => {
      insert.run(index, encodeAntigravityPrompt(prompt));
    });
  } finally {
    database.close();
  }
}

function encodeAntigravityPrompt(prompt: string): Buffer {
  const content = Buffer.from(prompt, "utf8");
  const length: number[] = [];
  let remaining = content.length;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) {
      byte |= 0x80;
    }
    length.push(byte);
  } while (remaining > 0);
  return Buffer.concat([Buffer.from([0x12, ...length]), content]);
}

describe("agent session cross-language normalization contract", () => {
  it("uses the same titles, cwd values, and token rules as the remote parser", async () => {
    expect(fixture.version).toBe(1);
    for (const scenario of fixture.scenarios) {
      const sandbox = mkdtempSync(join(tmpdir(), "kmux-agent-contract-"));
      sandboxes.push(sandbox);
      const source = join(sandbox, scenario.sourcePath);
      const usageSource = join(
        sandbox,
        scenario.usageSourcePath ?? scenario.sourcePath
      );
      mkdirSync(dirname(source), { recursive: true });
      mkdirSync(dirname(usageSource), { recursive: true });
      const historyLines = scenario.lines.map((line) => JSON.stringify(line));
      const usageLines = (scenario.usageLines ?? []).map((line) =>
        JSON.stringify(line)
      );
      writeFileSync(
        source,
        `${[
          ...historyLines,
          ...(usageSource === source ? usageLines : [])
        ].join("\n")}\n`,
        "utf8"
      );
      if (usageSource !== source) {
        writeFileSync(usageSource, `${usageLines.join("\n")}\n`, "utf8");
      }
      if (scenario.conversationPrompts?.length) {
        writeAntigravityConversationDatabase(
          sandbox,
          scenario.sessionId,
          scenario.conversationPrompts
        );
      }

      const snapshot = createExternalSessionIndexer({
        homeDir: sandbox,
        commandAvailability: () => true
      }).listExternalAgentSessions();
      const session = snapshot.sessions.find(
        (candidate) =>
          candidate.vendor === scenario.vendor &&
          candidate.key === `${scenario.vendor}:${scenario.sessionId}`
      );

      expect(session, scenario.name).toMatchObject({
        title: scenario.expected.title,
        cwd: scenario.expected.cwd
      });

      const adapters = createUsageAdapters({ homeDir: sandbox });
      try {
        const adapter = adapters.find(
          (candidate) => candidate.vendor === scenario.vendor
        );
        const usage = await adapter?.initialScan(0);
        const sample = usage?.samples.find(
          (candidate) => candidate.sessionId === scenario.sessionId
        );
        expect(sample, scenario.name).toMatchObject(scenario.expected.usage);
      } finally {
        adapters.forEach((adapter) => adapter.close());
      }
    }
  });
});
