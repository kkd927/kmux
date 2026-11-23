// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import {
  initializeFlowEditorDocument,
  starterWorkflowDefinition
} from "@kmux/orchestration";
import { WorkflowInputProperties } from "./WorkflowDataProperties";
import {
  WorkflowJsonDraftContext,
  useWorkflowJsonDrafts
} from "./WorkflowJsonField";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("retains invalid JSON across inspector unmount and row removal without replacing null, false or unfinished input", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let saved = initializeFlowEditorDocument({
    ...starterWorkflowDefinition({ definitionId: "forms", name: "Forms" }),
    inputs: [
      { id: "first", required: false, default: null },
      { id: "second", required: false, default: false }
    ]
  });
  function Harness() {
    const drafts = useWorkflowJsonDrafts();
    const [value, setValue] = useState(saved);
    const [visible, setVisible] = useState(true);
    return (
      <WorkflowJsonDraftContext.Provider value={drafts}>
        <button type="button" onClick={() => setVisible(!visible)}>
          Toggle inspector
        </button>
        <output>{drafts.errors.length}</output>
        {visible ? (
          <WorkflowInputProperties
            document={value}
            nodeId="start"
            onChange={(next) => {
              saved = next;
              setValue(next);
            }}
          />
        ) : null}
      </WorkflowJsonDraftContext.Provider>
    );
  }
  const click = (label: string) =>
    act(() =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === label)!
        .click()
    );
  const fields = () =>
    container.querySelectorAll<HTMLTextAreaElement>(
      'textarea[aria-label="Default JSON (optional)"]'
    );
  const fill = (field: HTMLTextAreaElement, value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  try {
    act(() => root.render(<Harness />));
    expect([...fields()].map((field) => field.value)).toEqual([
      "null",
      "false"
    ]);
    fill(fields()[1]!, '{"unfinished":');
    click("Toggle inspector");
    expect(container.querySelector("output")!.textContent).toBe("1");
    click("Toggle inspector");
    expect(fields()[1]!.value).toBe('{"unfinished":');
    click("Remove input");
    expect(fields()[0]!.value).toBe('{"unfinished":');
    expect(saved.workflow.inputs).toEqual([
      { id: "second", required: false, default: false }
    ]);
    fill(fields()[0]!, "1e999");
    expect(container.querySelector("output")!.textContent).toBe("1");
    expect(saved.workflow.inputs[0]!.default).toBe(false);
    fill(fields()[0]!, '{"key.with.dot": [null, false, "한글"]}');
    expect(container.querySelector("output")!.textContent).toBe("0");
    expect(
      JSON.parse(JSON.stringify(saved.workflow.inputs[0]!.default))
    ).toEqual({ "key.with.dot": [null, false, "한글"] });
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
