import { expect, it } from "vitest";
import { resolveWorkflowAgentLaunchPreferences } from "./launchPreferences";

it("does not carry a binding's reasoning effort into a different model", () => {
  const defaults = { model: "reasoning-model", effort: "high" };
  expect(
    resolveWorkflowAgentLaunchPreferences(defaults, { model: "fast-model" })
  ).toEqual({ model: "fast-model" });
  expect(
    resolveWorkflowAgentLaunchPreferences(defaults, {
      model: "reasoning-model"
    })
  ).toEqual(defaults);
  expect(
    resolveWorkflowAgentLaunchPreferences(defaults, { effort: "low" })
  ).toEqual({ model: "reasoning-model", effort: "low" });
  expect(resolveWorkflowAgentLaunchPreferences(defaults, undefined)).toEqual(
    defaults
  );
});
