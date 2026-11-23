// @vitest-environment jsdom

import { act } from "react";
import ReactDOMClient from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentDescriptorDto } from "@kmux/proto";

import { OrchestrationSettings } from "./OrchestrationSettings";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("orchestration Agent skill settings", () => {
  let container: HTMLDivElement;
  let root: ReactDOMClient.Root;
  let previousKmux: typeof window.kmux;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = ReactDOMClient.createRoot(container);
    previousKmux = window.kmux;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.kmux = previousKmux;
  });

  it("discloses selected capability-owned destinations before explicit install", async () => {
    const installed = new Set<string>();
    const orchestrationSkill = vi.fn(
      async (request: Parameters<typeof window.kmux.orchestrationSkill>[0]) => {
        if (request.method === "orchestration.skill.install") {
          for (const agentId of request.params.agentIds) installed.add(agentId);
        }
        return [
          {
            agentId: "codex",
            support: "supported",
            state: installed.has("codex") ? "installed" : "not-installed",
            path: "/Users/test/.codex/skills/kmux-orchestration",
            ...(installed.has("codex") ? { version: 2 } : {})
          },
          {
            agentId: "copilot",
            support: "supported",
            state: installed.has("copilot") ? "installed" : "not-installed",
            path: "/Users/test/.copilot/skills/kmux-orchestration",
            ...(installed.has("copilot") ? { version: 2 } : {})
          },
          {
            agentId: "future-agent",
            support: "unsupported",
            state: "unsupported",
            reason: "this Agent has no reviewed kmux skill installation target"
          }
        ];
      }
    );
    window.kmux = {
      ...window.kmux,
      getAgentCatalog: vi.fn(
        async () =>
          [
            {
              id: "codex",
              displayName: "Codex",
              aliases: [],
              capabilities: ["skillPlacement"],
              skillPlacement: { scopes: ["global"] },
              presentation: { shortLabel: "CODEX" }
            },
            {
              id: "copilot",
              displayName: "GitHub Copilot",
              aliases: [],
              capabilities: ["skillPlacement"],
              skillPlacement: { scopes: ["global"] }
            },
            {
              id: "future-agent",
              displayName: "Future Agent",
              aliases: [],
              capabilities: []
            }
          ] satisfies AgentDescriptorDto[]
      ),
      orchestrationSkill
    };

    await renderSettings(root);

    const checkboxes = [
      ...container.querySelectorAll("input[type='checkbox']")
    ];
    expect(checkboxes).toHaveLength(3);
    expect((checkboxes[2] as HTMLInputElement).disabled).toBe(true);

    act(() => (checkboxes[0] as HTMLInputElement).click());
    act(() => (checkboxes[1] as HTMLInputElement).click());
    act(() => button("Install selected").click());

    expect(container.textContent).toContain("Confirm installation");
    expect(container.textContent).toContain(
      "/Users/test/.codex/skills/kmux-orchestration"
    );
    expect(container.textContent).toContain(
      "/Users/test/.copilot/skills/kmux-orchestration"
    );
    expect(
      orchestrationSkill.mock.calls.filter(
        ([request]) => request.method === "orchestration.skill.install"
      )
    ).toHaveLength(0);

    await act(async () => {
      button("Confirm install").click();
      await flushUi();
    });

    expect(orchestrationSkill).toHaveBeenCalledWith({
      method: "orchestration.skill.install",
      params: { agentIds: ["codex", "copilot"], confirm: true }
    });
    expect(container.textContent).toContain("Installed");
  });

  function button(label: string): HTMLButtonElement {
    const match = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes(label)
    );
    if (!(match instanceof HTMLButtonElement)) {
      throw new Error(`button ${label} was not rendered`);
    }
    return match;
  }
});

async function renderSettings(root: ReactDOMClient.Root): Promise<void> {
  await act(async () => {
    root.render(<OrchestrationSettings />);
    await flushUi();
  });
}

async function flushUi(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
