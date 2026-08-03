import { describe, expect, it } from "vitest";

import {
  parseClaudePricingTable,
  parseGeneratedPricingCatalog,
  parseOpenAiPricingHtml,
  parseOpenAiTextTokenPricingHtml,
  reconcileHistoricalPricing,
  sortModelPricingEntries
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

describe("update-model-pricing history", () => {
  it("reads generated catalogs and carries removed models into exact history", () => {
    const previousPricing = parseGeneratedPricingCatalog(
      generatedCatalogSource("MODEL_PRICING", {
        codex: {
          standard: [pricingEntry("gpt-7.0-codex", 1_000_000)],
          fast: [pricingEntry("gpt-7.0-fast-only", 272_000)]
        }
      }),
      "MODEL_PRICING"
    );
    const historicalPricing = parseGeneratedPricingCatalog(
      generatedCatalogSource("HISTORICAL_MODEL_PRICING", {
        codex: {
          standard: [
            {
              ...pricingEntry("gpt-6.0-codex", 500_000),
              retiredAt: "2026-01-01"
            }
          ]
        }
      }),
      "HISTORICAL_MODEL_PRICING"
    );

    const reconciled = reconcileHistoricalPricing({
      previousPricing,
      currentPricing: emptyPricingCatalogs(),
      historicalPricing,
      retiredAt: "2026-08-04"
    });

    expect(reconciled.codex.standard).toEqual([
      expect.objectContaining({
        modelId: "gpt-7.0-codex",
        retiredAt: "2026-08-04",
        tieredPricingThresholdTokens: 1_000_000
      }),
      expect.objectContaining({
        modelId: "gpt-6.0-codex",
        retiredAt: "2026-01-01",
        tieredPricingThresholdTokens: 500_000
      })
    ]);
    expect(reconciled.codex.fast).toEqual([
      expect.objectContaining({
        modelId: "gpt-7.0-fast-only",
        retiredAt: "2026-08-04"
      })
    ]);
  });

  it("does not archive models that remain in the current official catalog", () => {
    const entry = pricingEntry("gpt-7.0-codex", 272_000);
    const previousPricing = emptyPricingCatalogs();
    previousPricing.codex.standard = [entry];
    const currentPricing = emptyPricingCatalogs();
    currentPricing.codex.standard = [entry];

    const reconciled = reconcileHistoricalPricing({
      previousPricing,
      currentPricing,
      historicalPricing: emptyPricingCatalogs(),
      retiredAt: "2026-08-04"
    });

    expect(reconciled.codex.standard).toEqual([]);
  });
});

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
          "gpt-7.0",
          "$5.00",
          "$0.50",
          "-",
          "$30.00",
          "$10.00",
          "$1.00",
          "-",
          "$45.00"
        ],
        {
          propsRows: [["gpt-7.0 (< 272K context length)", 5, 0.5, "-", 30]]
        }
      )
    );

    expect(entry).toEqual({
      modelId: "gpt-7.0",
      inputCostPerToken: 0.000005,
      outputCostPerToken: 0.00003,
      cacheReadCostPerToken: 0.0000005,
      inputCostPerTokenAboveThreshold: 0.00001,
      outputCostPerTokenAboveThreshold: 0.000045,
      cacheReadCostPerTokenAboveThreshold: 0.000001,
      tieredPricingThresholdTokens: 272_000
    });
  });

  it.each(["gpt-7.1-orbit", "o-next-reasoning"])(
    "parses %s without a model-suffix allowlist",
    (modelId) => {
      const [entry] = parseOpenAiTextTokenPricingHtml(
        openAiTextTokenPricingPage(
          ["Model", "Input", "Cached input", "Cache writes", "Output"],
          [modelId, "$5.00", "$0.50", "$6.25", "$30.00"]
        )
      );

      expect(entry).toEqual({
        modelId,
        inputCostPerToken: 0.000005,
        outputCostPerToken: 0.00003,
        cacheReadCostPerToken: 0.0000005,
        cacheCreateCostPerToken: 0.00000625
      });
    }
  );

  it("applies the shared long-context threshold to new GPT variants", () => {
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
          "gpt-7.1-orbit",
          "$5.00",
          "$0.50",
          "$6.25",
          "$30.00",
          "$10.00",
          "$1.00",
          "$12.50",
          "$45.00"
        ],
        {
          propsRows: [
            ["gpt-7.1-orbit", 5, 0.5, 6.25, 30],
            ["gpt-7.0 (< 272K context length)", 5, 0.5, "-", 30]
          ]
        }
      )
    );

    expect(entry).toEqual({
      modelId: "gpt-7.1-orbit",
      inputCostPerToken: 0.000005,
      outputCostPerToken: 0.00003,
      cacheReadCostPerToken: 0.0000005,
      cacheCreateCostPerToken: 0.00000625,
      inputCostPerTokenAboveThreshold: 0.00001,
      outputCostPerTokenAboveThreshold: 0.000045,
      cacheReadCostPerTokenAboveThreshold: 0.000001,
      cacheCreateCostPerTokenAboveThreshold: 0.0000125,
      tieredPricingThresholdTokens: 272_000
    });
  });

  it("parses non-GPT flagship model IDs without an allowlist", () => {
    expect(
      parseOpenAiTextTokenPricingHtml(
        openAiTextTokenPricingPage(
          ["Model", "Input", "Cached input", "Output"],
          ["o-next", "$2.00", "$0.50", "$8.00"]
        )
      )
    ).toEqual([
      {
        modelId: "o-next",
        inputCostPerToken: 0.000002,
        outputCostPerToken: 0.000008,
        cacheReadCostPerToken: 0.0000005
      }
    ]);
  });

  it("fails when rendered pricing rows are unavailable", () => {
    expect(() =>
      parseOpenAiTextTokenPricingHtml(openAiPropsOnlyPricingPage())
    ).toThrow(
      /Could not find rendered OpenAI standard text-token pricing rows/u
    );
  });

  it("collects every flagship model and only the specialized Codex group for each mode", () => {
    const html = openAiPricingPage([
      {
        mode: "standard",
        flagshipRows: [
          ["gpt-new", 1, 0.1, 5],
          ["o-new", 2, 0.2, 8]
        ],
        groups: [
          { model: "Codex", rows: [["codex-new", 3, 0.3, 12]] },
          { model: "Search", rows: [["search-new", 4, 0.4, 16]] },
          { model: "Embedding", rows: [["embedding-new", 5, "-", "-"]] },
          { model: "Cyber", rows: [["cyber-new", 6, 0.6, 24]] },
          { model: "Moderation", rows: [["moderation-new", 7, 0.7, 28]] }
        ]
      },
      {
        mode: "fast",
        flagshipRows: [["gpt-new", 2, 0.2, 10]],
        groups: [
          { model: "Codex", rows: [["codex-new", 6, 0.6, 24]] },
          { model: "ChatGPT", rows: [["chat-new", 7, 0.7, 28]] }
        ]
      }
    ]);

    expect(
      parseOpenAiPricingHtml(html, "standard").map((entry) => entry.modelId)
    ).toEqual(["gpt-new", "o-new", "codex-new"]);
    expect(parseOpenAiPricingHtml(html, "fast")).toEqual([
      expect.objectContaining({
        modelId: "gpt-new",
        inputCostPerToken: 0.000002
      }),
      expect.objectContaining({
        modelId: "codex-new",
        inputCostPerToken: 0.000006
      })
    ]);
  });

  it("maps reordered flagship and specialized columns by header name", () => {
    const html = openAiPricingPage([
      {
        mode: "standard",
        flagshipHeadings: [
          "Output",
          "Model",
          "Cached input",
          "Input",
          "Cache writes"
        ],
        flagshipRows: [["$5.00", "gpt-reordered", "$0.10", "$1.00", "$1.25"]],
        flagshipPropsRows: [["gpt-reordered", 1, 0.1, 1.25, 5]],
        specializedHeadings: [
          "Category",
          "Output",
          "Model",
          "Cached input",
          "Input"
        ],
        groups: [
          {
            model: "Codex",
            rows: [["$10.00", "codex-reordered", "$0.20", "$2.00"]]
          }
        ]
      }
    ]);

    expect(parseOpenAiPricingHtml(html, "standard")).toEqual([
      {
        modelId: "gpt-reordered",
        inputCostPerToken: 0.000001,
        outputCostPerToken: 0.000005,
        cacheReadCostPerToken: expect.closeTo(0.0000001, 12),
        cacheCreateCostPerToken: 0.00000125
      },
      {
        modelId: "codex-reordered",
        inputCostPerToken: 0.000002,
        outputCostPerToken: 0.00001,
        cacheReadCostPerToken: expect.closeTo(0.0000002, 12)
      }
    ]);
  });

  it("fails when duplicate model rows conflict within a mode", () => {
    const html = openAiPricingPage([
      {
        mode: "standard",
        flagshipRows: [["duplicate-model", 1, 0.1, 5]],
        groups: [{ model: "Codex", rows: [["duplicate-model", 2, 0.2, 10]] }]
      }
    ]);

    expect(() => parseOpenAiPricingHtml(html, "standard")).toThrow(
      /Conflicting OpenAI standard pricing for duplicate-model/u
    );
  });

  it("merges identical duplicate model prices within a mode", () => {
    const html = openAiPricingPage([
      {
        mode: "standard",
        flagshipRows: [["shared-model", 1, 0.1, 5]],
        groups: [{ model: "Codex", rows: [["shared-model", 1, 0.1, 5]] }]
      }
    ]);

    expect(parseOpenAiPricingHtml(html, "standard")).toEqual([
      {
        modelId: "shared-model",
        inputCostPerToken: 0.000001,
        outputCostPerToken: 0.000005,
        cacheReadCostPerToken: expect.closeTo(0.0000001, 12)
      }
    ]);
  });

  it("reports available table candidates when the requested mode is absent", () => {
    const html = openAiPricingPage([
      {
        mode: "standard",
        flagshipRows: [["gpt-new", 1, 0.1, 5]],
        groups: [{ model: "Codex", rows: [["codex-new", 2, 0.2, 10]] }]
      }
    ]);

    expect(() => parseOpenAiPricingHtml(html, "fast")).toThrow(
      /Expected one OpenAI fast flagship.*Candidates/u
    );
  });

  it("reports the requested mode, headers, and row count when a required column is missing", () => {
    const html = openAiPricingPage([
      {
        mode: "standard",
        flagshipRows: [["gpt-new", 1, 5]],
        flagshipHeadings: ["Model", "Input", "Output"],
        groups: [{ model: "Codex", rows: [["codex-new", 2, 0.2, 10]] }]
      }
    ]);

    expect(() => parseOpenAiPricingHtml(html, "standard")).toThrow(
      /OpenAI standard text-token pricing cachedInput column.*"headings":\["Model","Input","Output"\].*"rowCount":2/u
    );
  });

  it("fails clearly when the requested tier has no valid pricing rows", () => {
    const html = openAiPricingPage([
      {
        mode: "fast",
        flagshipRows: [],
        groups: [{ model: "Codex", rows: [] }]
      }
    ]);

    expect(() => parseOpenAiPricingHtml(html, "fast")).toThrow(
      /No OpenAI fast pricing entries were generated/u
    );
  });
});

describe("update-model-pricing model ordering", () => {
  it("sorts Codex models by version and preserves source order within a version", () => {
    const entries = [
      { modelId: "gpt-7.0" },
      { modelId: "gpt-7.1-orbit" },
      { modelId: "gpt-7.1-terra" },
      { modelId: "gpt-7.2-nova" },
      { modelId: "unversioned-model" }
    ];

    expect(
      sortModelPricingEntries("codex", entries).map((entry) => entry.modelId)
    ).toEqual([
      "gpt-7.2-nova",
      "gpt-7.1-orbit",
      "gpt-7.1-terra",
      "gpt-7.0",
      "unversioned-model"
    ]);
  });
});

function emptyPricingCatalogs() {
  return {
    claude: { standard: [] },
    codex: { standard: [] },
    gemini: { standard: [] }
  };
}

function pricingEntry(modelId, tieredPricingThresholdTokens) {
  return {
    modelId,
    inputCostPerToken: 0.000001,
    outputCostPerToken: 0.000005,
    cacheReadCostPerToken: 0.0000001,
    tieredPricingThresholdTokens
  };
}

function generatedCatalogSource(variableName, partialPricing) {
  const pricing = emptyPricingCatalogs();
  for (const [vendor, catalog] of Object.entries(partialPricing)) {
    pricing[vendor] = catalog;
  }
  return `const ${variableName}: Record<string, unknown> = ${JSON.stringify(
    pricing,
    null,
    2
  )};`;
}

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

function openAiTextTokenPricingPage(header, row, options = {}) {
  const props = JSON.stringify({
    tier: "standard",
    rows: options.propsRows ?? [row]
  }).replace(/"/gu, "&quot;");
  return `<h3>Flagship models</h3>
  <div component-export="TextTokenPricingTables" props="${props}">
    <table>
      <tr>${header.map((cell) => `<th>${cell}</th>`).join("")}</tr>
      <tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>
    </table>
  </div>`;
}

function openAiPropsOnlyPricingPage() {
  const props = JSON.stringify({
    tier: "standard",
    rows: [["gpt-7.0 (< 272K context length)", 5, 0.5, "-", 30]]
  }).replace(/"/gu, "&quot;");
  return `<h3>Flagship models</h3>
  <div component-export="TextTokenPricingTables" props="${props}">
    <table></table>
  </div>`;
}

function openAiPricingPage(tiers) {
  return tiers
    .map(
      ({
        mode,
        flagshipRows,
        flagshipPropsRows,
        flagshipHeadings,
        specializedHeadings,
        groups
      }) => {
        const textProps = htmlProps({
          tier: mode,
          rows: flagshipPropsRows ?? flagshipRows
        });
        const headings = flagshipHeadings ?? [
          "Model",
          "Input",
          "Cached input",
          "Output"
        ];
        const groupedProps = htmlProps({
          headings: specializedHeadings ?? [
            "Category",
            "Model",
            "Input",
            "Cached input",
            "Output"
          ],
          groups
        });
        return `<h3>Flagship models</h3>
        <div data-content-switcher-pane="true" data-value="${mode}">
          <div component-export="TextTokenPricingTables" props="${textProps}">
            <table>
              <tr>${headings.map((cell) => `<th>${cell}</th>`).join("")}</tr>
              ${flagshipRows
                .map(
                  (row) =>
                    `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`
                )
                .join("")}
            </table>
          </div>
        </div>
        <h3>Specialized models</h3>
        <div data-content-switcher-pane="true" data-value="${mode}">
          <div component-export="GroupedPricingTable" props="${groupedProps}"></div>
        </div>`;
      }
    )
    .join("\n");
}

function htmlProps(value) {
  return JSON.stringify(value).replace(/"/gu, "&quot;");
}
