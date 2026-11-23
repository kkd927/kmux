// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import {
  starterWorkflowDefinition,
  type WorkflowDefinitionV1
} from "@kmux/orchestration";
import { WorkflowRunInputs } from "./WorkflowRunInputs";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("preserves typed form values and requires an explicit catalog Agent while retaining invalid JSON for correction", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let saved = "{}";
  const definition: WorkflowDefinitionV1 = {
    ...starterWorkflowDefinition({
      definitionId: "input-form",
      name: "Typed input form"
    }),
    inputs: [
      { id: "worker", required: true, schema: { schema: { type: "string" } } },
      { id: "count", required: true, schema: { schema: { type: "integer" } } },
      {
        id: "enabled",
        required: true,
        schema: { schema: { type: "boolean" } }
      },
      { id: "payload", required: true, schema: { schema: { type: "object" } } },
      {
        id: "choice",
        required: false,
        default: "auto",
        schema: { schema: { enum: ["auto", null] } }
      }
    ],
    agentBindings: {
      role: {
        agent: { kind: "run-input", inputId: "worker" },
        scope: { kind: "run" },
        authorityMode: "ambient",
        targetPolicy: "local",
        surfacePolicy: "create",
        sessionPolicy: "fresh",
        worktreePolicy: "current",
        inputMode: "orchestrated"
      }
    }
  };
  function Harness() {
    const [value, setValue] = useState("{}");
    return (
      <form>
        <WorkflowRunInputs
          definition={definition}
          value={value}
          agents={[
            {
              id: "custom-agent",
              displayName: "Custom Agent",
              aliases: [],
              capabilities: []
            }
          ]}
          onChange={(next) => {
            saved = next;
            setValue(next);
          }}
        />
      </form>
    );
  }
  const field = (id: string) =>
    container.querySelector(`[aria-label="${id}"]`) as
      | HTMLInputElement
      | HTMLSelectElement
      | HTMLTextAreaElement;
  const change = (id: string, value: string) =>
    act(() => {
      const element = field(id);
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
    expect(field("worker").value).toBe("");
    expect(container.querySelector("form")!.checkValidity()).toBe(false);
    change("worker", "custom-agent");
    change("count", "3");
    change("enabled", "false");
    change("choice", "null");
    expect(field("choice").value).toBe("null");
    change("payload", '{"nested":');
    expect(field("payload").checkValidity()).toBe(false);
    change("count", "4");
    expect(field("payload").value).toBe('{"nested":');
    change("payload", '{"nested":[1,true]}');
    expect(container.querySelector("form")!.checkValidity()).toBe(true);
    expect(JSON.parse(saved)).toEqual({
      worker: "custom-agent",
      count: 4,
      enabled: false,
      choice: null,
      payload: { nested: [1, true] }
    });
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
