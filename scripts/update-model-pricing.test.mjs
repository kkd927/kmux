import { describe, expect, it } from "vitest";

import {
  parseClaudePricingTable,
  parseOpenAiTextTokenPricingHtml
} from "./update-model-pricing.mjs";

const SONNET_WINDOW_ROWS = [
  [
    "Claude Sonnet 5 through August 31, 2026",
    "$2 / MTok",
    "$2.50 / MTok",
    "$4 / MTok",
    "$0.20 / MTok",
    "$10 / MTok"
  ],
  [
    "Claude Sonnet 5 starting September 1, 2026",
    "$3 / MTok",
    "$3.75 / MTok",
    "$6 / MTok",
    "$0.30 / MTok",
    "$15 / MTok"
  ]
];

describe("update-model-pricing Claude parser", () => {
  it("canonicalizes period-specific Claude Sonnet 5 rows to the same model", () => {
    expect(
      parseClaudePricingTable(table(SONNET_WINDOW_ROWS), "2026-07-03")
    ).toEqual([
      expect.objectContaining({
        modelId: "claude-sonnet-5",
        aliases: ["claude-sonnet-5"]
      })
    ]);
    expect(
      parseClaudePricingTable(table(SONNET_WINDOW_ROWS), "2026-09-01")
    ).toEqual([
      expect.objectContaining({
        modelId: "claude-sonnet-5",
        aliases: ["claude-sonnet-5"]
      })
    ]);
  });

  it("selects the introductory Claude Sonnet 5 price before September 2026", () => {
    const [entry] = parseClaudePricingTable(
      table(SONNET_WINDOW_ROWS),
      "2026-07-03"
    );

    expect(entry).toEqual(
      expect.objectContaining({
        modelId: "claude-sonnet-5",
        aliases: ["claude-sonnet-5"]
      })
    );
    expect(entry.inputCostPerToken).toBeCloseTo(0.000002, 12);
    expect(entry.outputCostPerToken).toBeCloseTo(0.00001, 12);
    expect(entry.cacheReadCostPerToken).toBeCloseTo(0.0000002, 12);
    expect(entry.cacheCreateCostPerToken).toBeCloseTo(0.0000025, 12);
  });

  it("selects the standard Claude Sonnet 5 price starting September 2026", () => {
    const [entry] = parseClaudePricingTable(
      table(SONNET_WINDOW_ROWS),
      "2026-09-01"
    );

    expect(entry).toEqual(
      expect.objectContaining({
        modelId: "claude-sonnet-5",
        aliases: ["claude-sonnet-5"]
      })
    );
    expect(entry.inputCostPerToken).toBeCloseTo(0.000003, 12);
    expect(entry.outputCostPerToken).toBeCloseTo(0.000015, 12);
    expect(entry.cacheReadCostPerToken).toBeCloseTo(0.0000003, 12);
    expect(entry.cacheCreateCostPerToken).toBeCloseTo(0.00000375, 12);
  });

  it("parses unknown Claude families without a hard-coded whitelist", () => {
    expect(
      parseClaudePricingTable(
        table([
          [
            "Claude Completely New 6.2 starting January 1, 2026",
            "$1 / MTok",
            "$1.25 / MTok",
            "$2 / MTok",
            "$0.10 / MTok",
            "$5 / MTok"
          ]
        ]),
        "2026-07-03"
      )
    ).toEqual([
      expect.objectContaining({
        modelId: "claude-completely-new-6-2",
        aliases: ["claude-completely-new-6.2"]
      })
    ]);
  });

  it("fails when no period row is active for the requested date", () => {
    expect(() =>
      parseClaudePricingTable(
        table([
          [
            "Claude Sonnet 5 starting September 1, 2026",
            "$3 / MTok",
            "$3.75 / MTok",
            "$6 / MTok",
            "$0.30 / MTok",
            "$15 / MTok"
          ]
        ]),
        "2026-07-03"
      )
    ).toThrow(/No active Claude pricing rows for claude-sonnet-5/u);
  });

  it("fails when multiple period rows are active for the requested date", () => {
    expect(() =>
      parseClaudePricingTable(
        table([
          [
            "Claude Sonnet 5 through December 31, 2026",
            "$2 / MTok",
            "$2.50 / MTok",
            "$4 / MTok",
            "$0.20 / MTok",
            "$10 / MTok"
          ],
          [
            "Claude Sonnet 5 starting January 1, 2026",
            "$3 / MTok",
            "$3.75 / MTok",
            "$6 / MTok",
            "$0.30 / MTok",
            "$15 / MTok"
          ]
        ]),
        "2026-07-03"
      )
    ).toThrow(/Multiple active Claude pricing rows for claude-sonnet-5/u);
  });

  it("fails instead of allowing unsupported suffix text into model IDs", () => {
    expect(() =>
      parseClaudePricingTable(
        table([
          [
            "Claude Sonnet 5 available through August 31, 2026",
            "$2 / MTok",
            "$2.50 / MTok",
            "$4 / MTok",
            "$0.20 / MTok",
            "$10 / MTok"
          ]
        ]),
        "2026-07-03"
      )
    ).toThrow(/Could not parse Claude model identity/u);
  });
});

describe("update-model-pricing OpenAI parser", () => {
  it("maps text-token prices by header after cache-write columns are added", () => {
    const [entry] = parseOpenAiTextTokenPricingHtml(
      openAiTextTokenPricingPage(
        [
          "Model",
          "Input",
          "Cached input",
          "Cache writes",
          "Output",
          "Input",
          "Cached input",
          "Cache writes",
          "Output"
        ],
        [
          "gpt-5.5",
          "$5.00",
          "$0.50",
          "-",
          "$30.00",
          "$10.00",
          "$1.00",
          "-",
          "$45.00"
        ]
      )
    );

    expect(entry).toEqual({
      modelId: "gpt-5.5",
      inputCostPerToken: 0.000005,
      outputCostPerToken: 0.00003,
      cacheReadCostPerToken: 0.0000005,
      inputCostPerTokenAboveThreshold: 0.00001,
      outputCostPerTokenAboveThreshold: 0.000045,
      cacheReadCostPerTokenAboveThreshold: 0.000001,
      tieredPricingThresholdTokens: 272_000
    });
  });

  it("fails when rendered pricing rows are unavailable", () => {
    expect(() =>
      parseOpenAiTextTokenPricingHtml(openAiPropsOnlyPricingPage())
    ).toThrow(/Could not find rendered OpenAI text-token pricing rows/u);
  });
});

function table(rows) {
  return `<table>
    <tr>
      <th>Model</th>
      <th>Base Input Tokens</th>
      <th>5m Cache Writes</th>
      <th>1h Cache Writes</th>
      <th>Cache Hits & Refreshes</th>
      <th>Output Tokens</th>
    </tr>
    ${rows
      .map(
        (row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`
      )
      .join("\n")}
  </table>`;
}

function openAiTextTokenPricingPage(header, row) {
  const props = JSON.stringify({
    tier: "standard",
    rows: [["gpt-5.5 (< 272K context length)"]]
  }).replace(/"/gu, "&quot;");
  return `<div component-export="TextTokenPricingTables" props="${props}">
    <table>
      <tr>${header.map((cell) => `<th>${cell}</th>`).join("")}</tr>
      <tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>
    </table>
  </div>`;
}

function openAiPropsOnlyPricingPage() {
  const props = JSON.stringify({
    tier: "standard",
    rows: [["gpt-5.5 (< 272K context length)", 5, 0.5, "-", 30]]
  }).replace(/"/gu, "&quot;");
  return `<div component-export="TextTokenPricingTables" props="${props}">
    <table></table>
  </div>`;
}
