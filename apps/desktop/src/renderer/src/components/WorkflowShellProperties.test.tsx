// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import {
  initializeFlowEditorDocument,
  starterWorkflowDefinition,
  type ShellNodeDefinition
} from "@kmux/orchestration";
import { createStudioNode } from "../workflowProjection";
import {
  WorkflowJsonDraftContext,
  useWorkflowJsonDrafts
} from "./WorkflowJsonField";
import { WorkflowShellProperties } from "./WorkflowShellProperties";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("preserves typed argv when switching between executable and script forms", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const initial = createStudioNode(
    "shell",
    "shell:test"
  ) as ShellNodeDefinition;
  const args = [
    { kind: "literal", value: "literal with\nnewlines" },
    { kind: "input", input: "ticket" },
    { kind: "secret", secretRef: "secret:reference-only" }
  ] as const;
  let saved: ShellNodeDefinition = {
    ...initial,
    config: {
      ...initial.config,
      command: { kind: "structured", executable: "/usr/bin/printf", args }
    }
  };
  function Harness() {
    const drafts = useWorkflowJsonDrafts();
    const [node, setNode] = useState(saved);
    return (
      <WorkflowJsonDraftContext.Provider value={drafts}>
        <WorkflowShellProperties
          node={node}
          document={initializeFlowEditorDocument(
            starterWorkflowDefinition({
              definitionId: "shell-form",
              name: "Shell form"
            })
          )}
          onChange={(next) => {
            saved = next;
            setNode(next);
          }}
        />
      </WorkflowJsonDraftContext.Provider>
    );
  }
  const change = (label: string, value: string, scope: Element = container) =>
    act(() => {
      const element = [...scope.querySelectorAll("label")]
        .find(
          (candidate) => candidate.querySelector("span")?.textContent === label
        )!
        .querySelector("input, select")! as
        | HTMLInputElement
        | HTMLSelectElement;
      Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(element),
        "value"
      )!.set!.call(element, value);
      element.dispatchEvent(
        new Event(element instanceof HTMLSelectElement ? "change" : "input", {
          bubbles: true
        })
      );
    });
  try {
    act(() => root.render(<Harness />));
    change("Command type", "script");
    expect(saved.config.command).toEqual({ kind: "script", script: "", args });
    change("Command type", "structured");
    expect(saved.config.command).toEqual({
      kind: "structured",
      executable: "",
      args
    });
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
