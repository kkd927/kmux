// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { AgentLaunchPreferences } from "@kmux/orchestration";
import type { AgentModelOptionDto } from "@kmux/proto";
import { WorkflowAgentLaunchFields } from "./WorkflowAgentLaunchFields";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("resets incompatible effort on model changes and supplies the required model-specific default", async () => {
  const models: AgentModelOptionDto[] = [
    { id: "wide", displayName: "Wide", efforts: ["low", "high"] },
    { id: "fast", displayName: "Fast", efforts: [] },
    {
      id: "required",
      displayName: "Required",
      efforts: ["medium"],
      defaultEffort: "medium",
      effortRequired: true
    }
  ];
  const original = window.kmux;
  window.kmux = {
    getAgentModelOptions: vi.fn().mockResolvedValue(models)
  } as never;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let saved: AgentLaunchPreferences | undefined = {
    model: "wide",
    effort: "high"
  };
  function Harness() {
    const [value, setValue] = useState(saved);
    return (
      <WorkflowAgentLaunchFields
        agentId="fixture"
        capable
        value={value ?? {}}
        readonly={false}
        modelLabel="Model"
        effortLabel="Effort"
        onChange={(next) => {
          saved = next;
          setValue(next);
        }}
      />
    );
  }
  const select = async (label: string, value: string) => {
    const field = container.querySelector<HTMLSelectElement>(
      `select[aria-label="${label}"]`
    )!;
    await act(async () => {
      field.value = value;
      field.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };
  try {
    await act(async () => root.render(<Harness />));
    await select("Model", "fast");
    expect(saved).toEqual({ model: "fast" });
    expect(
      container.querySelector<HTMLSelectElement>('select[aria-label="Effort"]')!
        .disabled
    ).toBe(true);
    await select("Model", "required");
    expect(saved).toEqual({ model: "required", effort: "medium" });
    await select("Model", "");
    expect(saved).toBeUndefined();
  } finally {
    act(() => root.unmount());
    container.remove();
    window.kmux = original;
  }
});

it("ignores a late model response after the selected Agent changes", async () => {
  const original = window.kmux;
  let resolveFirst!: (models: AgentModelOptionDto[]) => void;
  const first = new Promise<AgentModelOptionDto[]>((resolve) => {
    resolveFirst = resolve;
  });
  window.kmux = {
    getAgentModelOptions: vi.fn((id: string) =>
      id === "first"
        ? first
        : Promise.resolve([
            { id: "second-model", displayName: "Second", efforts: [] }
          ])
    )
  } as never;
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (id: string) =>
    root.render(
      <WorkflowAgentLaunchFields
        agentId={id}
        capable
        value={{}}
        readonly={false}
        modelLabel="Model"
        effortLabel="Effort"
        onChange={() => {}}
      />
    );
  try {
    await act(async () => render("first"));
    await act(async () => render("second"));
    await act(async () =>
      resolveFirst([{ id: "first-model", displayName: "First", efforts: [] }])
    );
    const options = [
      ...container.querySelector<HTMLSelectElement>(
        'select[aria-label="Model"]'
      )!.options
    ].map((option) => option.value);
    expect(options).toEqual(["", "second-model"]);
  } finally {
    act(() => root.unmount());
    window.kmux = original;
  }
});

it("shows inherited tier choices and saves an edited tier as model plus effort", async () => {
  const original = window.kmux;
  window.kmux = {
    getAgentModelOptions: vi.fn().mockResolvedValue([
      {
        id: "grouped-model",
        displayName: "Grouped model",
        efforts: ["low", "high"],
        effortRequired: true,
        defaultEffort: "high",
        variants: [
          { model: "grouped-model-high", effort: "high" },
          { model: "grouped-model-low", effort: "low" }
        ]
      }
    ])
  } as never;
  const container = document.createElement("div");
  const root = createRoot(container);
  const onChange = vi.fn();
  try {
    await act(async () =>
      root.render(
        <WorkflowAgentLaunchFields
          agentId="fixture"
          capable
          value={{}}
          inherited={{ model: "grouped-model-high" }}
          readonly={false}
          modelLabel="Model"
          effortLabel="Effort"
          onChange={onChange}
        />
      )
    );
    const field = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Effort"]'
    )!;
    expect(field.value).toBe("high");
    await act(async () => {
      field.value = "low";
      field.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith({
      model: "grouped-model",
      effort: "low"
    });
  } finally {
    act(() => root.unmount());
    window.kmux = original;
  }
});
