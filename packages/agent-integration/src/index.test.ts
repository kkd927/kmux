import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fixtures from "../fixtures/merge-v3.json";

import {
  ensureAgentIntegrations,
  ensureAgentIntegrationVendor,
  mergeAgentIntegrationConfig,
  planAgentIntegrationSnapshot,
  type AgentIntegrationVendor
} from "./index";

interface MergeFixture {
  name: string;
  vendor: AgentIntegrationVendor;
  input: unknown;
  output?: unknown;
  errorContains?: string;
}

describe("agent integration contract", () => {
  it("installs all vendor contracts into a clean home", () => {
    const home = mkdtempSync(join(tmpdir(), "kmux-agent-integration-"));
    try {
      expect(
        ensureAgentIntegrations({ homeDir: home }).map(
          ({ vendor, status }) => ({ vendor, status })
        )
      ).toEqual([
        { vendor: "claude", status: "changed" },
        { vendor: "codex", status: "changed" },
        { vendor: "copilot", status: "changed" },
        { vendor: "antigravity", status: "changed" }
      ]);
      expect(
        Object.keys(
          JSON.parse(
            readFileSync(join(home, ".claude", "settings.json"), "utf8")
          ).hooks
        )
      ).toEqual(["PermissionRequest", "PreToolUse", "SessionStart", "Stop"]);
      expect(
        Object.keys(
          JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"))
            .hooks
        )
      ).toEqual(["SessionStart", "PermissionRequest", "Stop"]);
      expect(
        Object.keys(
          JSON.parse(
            readFileSync(join(home, ".gemini", "config", "hooks.json"), "utf8")
          )["kmux-antigravity"]
        )
      ).toEqual(["PreInvocation", "PreToolUse", "Stop"]);
      const copilot = JSON.parse(
        readFileSync(join(home, ".copilot", "hooks", "kmux.json"), "utf8")
      );
      expect(copilot.version).toBe(1);
      expect(Object.keys(copilot.hooks)).toEqual([
        "sessionStart",
        "notification",
        "agentStop",
        "sessionEnd"
      ]);
      expect(copilot.hooks.sessionStart[0]).toMatchObject({
        type: "command",
        bash: expect.stringContaining("KMUX_MANAGED_COPILOT_HOOK=1")
      });
      expect(copilot.hooks.sessionStart[0]).not.toHaveProperty("hooks");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("matches the shared merge fixtures", () => {
    for (const fixture of fixtures as MergeFixture[]) {
      const merge = () =>
        mergeAgentIntegrationConfig(fixture.vendor, fixture.input);
      if (fixture.errorContains) {
        expect(merge, fixture.name).toThrow(fixture.errorContains);
        continue;
      }
      expect(merge(), fixture.name).toEqual(fixture.output);
    }
  });

  it("plans the same merge for local and remote snapshots and is idempotent", () => {
    for (const fixture of fixtures as MergeFixture[]) {
      if (fixture.output === undefined) continue;
      const planned = planAgentIntegrationSnapshot({
        vendor: fixture.vendor,
        path: `/home/test/${fixture.vendor}.json`,
        state: "present",
        sha256: "a".repeat(64),
        content: JSON.stringify(fixture.input)
      });
      expect(JSON.parse(planned.desiredContent), fixture.name).toEqual(
        fixture.output
      );
      expect(planned.expected).toEqual({
        state: "present",
        sha256: "a".repeat(64)
      });
      expect(
        planAgentIntegrationSnapshot({
          vendor: fixture.vendor,
          path: planned.path,
          state: "present",
          sha256: "b".repeat(64),
          content: planned.desiredContent
        }).changed,
        fixture.name
      ).toBe(false);
    }
  });

  it("uses COPILOT_HOME for the Copilot hook document", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-agent-integration-"));
    const home = join(sandbox, "home");
    const copilotHome = join(sandbox, "custom-copilot-home");
    try {
      const copilot = ensureAgentIntegrations({
        homeDir: home,
        env: { COPILOT_HOME: copilotHome }
      }).find(({ vendor }) => vendor === "copilot");

      expect(copilot).toMatchObject({
        path: join(copilotHome, "hooks", "kmux.json"),
        status: "changed"
      });
      expect(
        JSON.parse(
          readFileSync(join(copilotHome, "hooks", "kmux.json"), "utf8")
        )
      ).toMatchObject({ version: 1 });
      expect(existsSync(join(home, ".copilot", "hooks", "kmux.json"))).toBe(
        false
      );
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("does not partially install over a structurally unsupported user config", () => {
    const home = mkdtempSync(join(tmpdir(), "kmux-agent-integration-"));
    const path = join(home, ".codex", "hooks.json");
    const content = '{"description":"keep","hooks":{"Stop":"user-command"}}\n';
    try {
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(path, content, "utf8");
      const preservedTimestamp = new Date("2020-01-02T03:04:05.000Z");
      utimesSync(path, preservedTimestamp, preservedTimestamp);
      const mtime = statSync(path).mtimeMs;

      const results = ensureAgentIntegrations({ homeDir: home });
      expect(results.map(({ vendor, status }) => ({ vendor, status }))).toEqual(
        [
          { vendor: "claude", status: "changed" },
          { vendor: "codex", status: "degraded" },
          { vendor: "copilot", status: "changed" },
          { vendor: "antigravity", status: "changed" }
        ]
      );
      expect(results[1]?.warning).toContain(
        "codex hooks.Stop must be an array"
      );
      expect(readFileSync(path, "utf8")).toBe(content);
      expect(statSync(path).mtimeMs).toBe(mtime);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not overwrite invalid JSON and preserves mtime on a no-op", () => {
    const home = mkdtempSync(join(tmpdir(), "kmux-agent-integration-"));
    const path = join(home, ".codex", "hooks.json");
    try {
      const first = ensureAgentIntegrationVendor("codex", path);
      expect(first.status).toBe("changed");
      const mtime = statSync(path).mtimeMs;
      expect(ensureAgentIntegrationVendor("codex", path).status).toBe(
        "current"
      );
      expect(statSync(path).mtimeMs).toBe(mtime);

      writeFileSync(path, "{", "utf8");
      expect(ensureAgentIntegrationVendor("codex", path).status).toBe(
        "degraded"
      );
      expect(readFileSync(path, "utf8")).toBe("{");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "does not follow a settings symlink",
    () => {
      const home = mkdtempSync(join(tmpdir(), "kmux-agent-integration-"));
      const path = join(home, ".codex", "hooks.json");
      const target = join(home, "user-owned.json");
      try {
        mkdirSync(join(home, ".codex"), { recursive: true });
        writeFileSync(target, '{"keep":true}', "utf8");
        symlinkSync(target, path);

        expect(ensureAgentIntegrationVendor("codex", path).status).toBe(
          "degraded"
        );
        expect(readFileSync(target, "utf8")).toBe('{"keep":true}');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(process.platform === "win32")(
    "does not replace a stale read-only settings file",
    () => {
      const home = mkdtempSync(join(tmpdir(), "kmux-agent-integration-"));
      const path = join(home, ".codex", "hooks.json");
      const content = '{"userField":"keep"}';
      try {
        mkdirSync(join(home, ".codex"), { recursive: true });
        writeFileSync(path, content, "utf8");
        chmodSync(path, 0o400);

        expect(ensureAgentIntegrationVendor("codex", path).status).toBe(
          "degraded"
        );
        expect(readFileSync(path, "utf8")).toBe(content);
      } finally {
        chmodSync(path, 0o600);
        rmSync(home, { recursive: true, force: true });
      }
    }
  );
});
