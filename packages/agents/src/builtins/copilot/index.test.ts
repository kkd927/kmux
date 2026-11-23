import { createAgentProcessMatcher } from "../../processDetection";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { copilotAgent } from ".";

describe("Copilot agent", () => {
  it("passes automatic model selection through the CLI launch boundary", () => {
    expect(copilotAgent.launchPreferences.buildArgs({ model: "auto" })).toEqual(
      ["--model", "auto"]
    );
  });

  it("removes conflicting selectors and appends one exact resume argv", () => {
    expect(
      copilotAgent.resume.build(
        [
          "--model",
          "gpt-5.4",
          "--continue",
          "--resume",
          "old-session",
          "--session-id=other-session",
          "--connect",
          "remote-session",
          "--plain-diff"
        ],
        "11111111-1111-4111-8111-111111111111"
      )
    ).toEqual([
      "--model",
      "gpt-5.4",
      "--plain-diff",
      "--resume=11111111-1111-4111-8111-111111111111"
    ]);
  });

  it("normalizes lifecycle and notification hooks", () => {
    expect(
      copilotAgent.hooks.normalize("sessionStart", {
        sessionId: "session-1",
        cwd: "/workspace"
      })
    ).toMatchObject({ event: "session_start", vendorSessionId: "session-1" });
    expect(
      copilotAgent.hooks.normalize("permissionRequest", {
        sessionId: "session-1",
        permissionRequest: { intention: "Run the build" }
      })
    ).toBeNull();
    expect(
      copilotAgent.hooks.portable.managed.map(({ event }) => event)
    ).not.toContain("permissionRequest");
    expect(
      copilotAgent.hooks.normalize("notification", {
        notification_type: "permission_prompt",
        message: "Approve shell command"
      })
    ).toMatchObject({ event: "needs_input", message: "Approve shell command" });
    expect(
      copilotAgent.hooks.normalize("notification", {
        notificationType: "elicitation_dialog",
        message: "Choose a deployment target"
      })
    ).toMatchObject({
      event: "needs_input",
      message: "Choose a deployment target"
    });
    expect(
      copilotAgent.hooks.normalize("notification", {
        notification_type: "shell_completed"
      })
    ).toBeNull();
    expect(copilotAgent.hooks.normalize("agentStop", {})).toMatchObject({
      event: "turn_complete"
    });
    expect(copilotAgent.hooks.normalize("sessionEnd", {})).toMatchObject({
      event: "session_end"
    });
    expect(
      copilotAgent.hooks.normalizeNotification?.("notification", {
        title: "Permission needed",
        message: "Approve shell command"
      })
    ).toEqual({
      title: "Permission needed",
      message: "Approve shell command"
    });
  });

  it("detects the npm loader package and native child", () => {
    const matches = createAgentProcessMatcher(copilotAgent.processDetection);
    expect(
      matches("node /opt/node/lib/node_modules/@github/copilot/npm-loader.js")
    ).toBe(true);
    expect(
      matches("/opt/node/lib/node_modules/@github/copilot-darwin-arm64/copilot")
    ).toBe(true);
    expect(matches("/usr/bin/node unrelated.js")).toBe(false);
  });

  it("preserves Copilot config while trusting the canonical workspace once", () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-copilot-trust-"));
    const homeDir = join(root, "home");
    const copilotHome = join(root, "copilot-home");
    const workspace = join(root, "repository");
    const alias = join(root, "repository-alias");
    try {
      mkdirSync(homeDir);
      mkdirSync(copilotHome);
      mkdirSync(workspace);
      symlinkSync(workspace, alias, "dir");
      writeFileSync(
        join(copilotHome, "config.json"),
        `// User settings belong in settings.json.\n// This file is managed automatically.\n${JSON.stringify({ firstLaunchAt: "kept", serviceUrl: "https://example.invalid", trustedFolders: ["/old"] })}\n`
      );

      expect(
        copilotAgent.workspaceTrust.prepare({
          cwd: alias,
          homeDir,
          env: { COPILOT_HOME: copilotHome }
        })
      ).toBe("trusted");
      expect(
        copilotAgent.workspaceTrust.prepare({
          cwd: workspace,
          homeDir,
          env: { COPILOT_HOME: copilotHome }
        })
      ).toBe("already-trusted");
      const written = readFileSync(join(copilotHome, "config.json"), "utf8");
      expect(
        written.startsWith(
          "// User settings belong in settings.json.\n// This file is managed automatically.\n"
        )
      ).toBe(true);
      expect(JSON.parse(written.slice(written.indexOf("{")))).toEqual({
        firstLaunchAt: "kept",
        serviceUrl: "https://example.invalid",
        trustedFolders: ["/old", realpathSync.native(workspace)]
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not overwrite malformed Copilot trust config", () => {
    const root = mkdtempSync(join(tmpdir(), "kmux-copilot-trust-"));
    const copilotHome = join(root, "copilot-home");
    const workspace = join(root, "repository");
    try {
      mkdirSync(copilotHome);
      mkdirSync(workspace);
      const configPath = join(copilotHome, "config.json");
      writeFileSync(configPath, "not json\n");

      expect(
        copilotAgent.workspaceTrust.prepare({
          cwd: workspace,
          homeDir: root,
          env: { COPILOT_HOME: copilotHome }
        })
      ).toBe("unavailable");
      expect(readFileSync(configPath, "utf8")).toBe("not json\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
