#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const MODEL_PRICING_PATH = path.join(
  ROOT_DIR,
  "packages/metadata/src/modelPricing.ts"
);

const SOURCES = {
  claude: "https://docs.anthropic.com/en/docs/about-claude/pricing",
  codex: "https://developers.openai.com/api/docs/pricing",
  gemini: "https://ai.google.dev/gemini-api/docs/pricing?hl=en"
};

const MANUAL_ALIASES = {
  claude: {
    "claude-sonnet-4-5": ["claude-sonnet-4-20250514"],
    "claude-opus-4-5": ["claude-opus-4-5-20251101"],
    "claude-opus-4-1": ["claude-opus-4-1-20250805", "claude-opus-4-20250514"]
  },
  codex: {
    "gpt-5-codex": ["gpt-5.1-codex", "gpt-5.1-codex-max"],
    "gpt-5.3-codex": ["gpt-5.2-codex"]
  },
  gemini: {
    "gemini-3.1-pro-preview": ["gemini-3-pro-preview"],
    "gemini-3.5-flash": [
      "Gemini 3.5 Flash (Low)",
      "Gemini 3.5 Flash (Medium)",
      "Gemini 3.5 Flash (High)",
      "gemini-3.5-flash-low",
      "gemini-3.5-flash-medium",
      "gemini-3.5-flash-high"
    ],
    "gemini-2.5-pro": [
      "gemini/gemini-2.5-pro",
      "gemini-2.5-pro-preview-06-05",
      "gemini-2.5-pro-preview-05-06",
      "gemini-2.5-pro-preview-03-25"
    ],
    "gemini-2.5-flash": [
      "gemini/gemini-2.5-flash",
      "gemini-2.5-flash-preview-05-20",
      "gemini-2.5-flash-preview-04-17",
      "gemini-2.5-flash-preview-09-2025"
    ],
    "gemini-2.5-flash-lite": [
      "gemini/gemini-2.5-flash-lite",
      "gemini-2.5-flash-lite-preview-06-17",
      "gemini-2.5-flash-lite-preview-09-2025"
    ]
  }
};

const MANUAL_ENTRIES = {
  claude: [
    {
      modelId: "claude-sonnet-4-5",
      inputCostPerTokenAboveThreshold: dollarsPerMillion(6),
      outputCostPerTokenAboveThreshold: dollarsPerMillion(22.5),
      cacheReadCostPerTokenAboveThreshold: dollarsPerMillion(0.6),
      cacheCreateCostPerTokenAboveThreshold: dollarsPerMillion(7.5)
    },
    {
      modelId: "claude-sonnet-4",
      inputCostPerTokenAboveThreshold: dollarsPerMillion(6),
      outputCostPerTokenAboveThreshold: dollarsPerMillion(22.5),
      cacheReadCostPerTokenAboveThreshold: dollarsPerMillion(0.6),
      cacheCreateCostPerTokenAboveThreshold: dollarsPerMillion(7.5)
    }
  ],
  codex: [
    {
      modelId: "gpt-5.4",
      inputCostPerToken: dollarsPerMillion(2.5),
      outputCostPerToken: dollarsPerMillion(15),
      cacheReadCostPerToken: dollarsPerMillion(0.25),
      inputCostPerTokenAboveThreshold: dollarsPerMillion(5),
      outputCostPerTokenAboveThreshold: dollarsPerMillion(22.5),
      cacheReadCostPerTokenAboveThreshold: dollarsPerMillion(0.5),
      tieredPricingThresholdTokens: 272_000,
      aliases: ["gpt-5.4-codex"]
    },
    {
      modelId: "gpt-5.4-mini",
      inputCostPerToken: dollarsPerMillion(0.75),
      outputCostPerToken: dollarsPerMillion(4.5),
      cacheReadCostPerToken: dollarsPerMillion(0.075)
    },
    {
      modelId: "gpt-5.4-pro",
      inputCostPerToken: dollarsPerMillion(30),
      outputCostPerToken: dollarsPerMillion(180),
      cacheReadCostPerToken: 0
    },
    {
      modelId: "gpt-5.3-codex-spark",
      inputCostPerToken: dollarsPerMillion(1.75),
      outputCostPerToken: dollarsPerMillion(14),
      cacheReadCostPerToken: dollarsPerMillion(0.175)
    }
  ],
  gemini: [
    {
      modelId: "gemini-3.1-flash-lite-preview",
      inputCostPerToken: dollarsPerMillion(0.25),
      outputCostPerToken: dollarsPerMillion(1.5),
      cacheReadCostPerToken: dollarsPerMillion(0.025)
    },
    {
      modelId: "gemini-3-flash-preview",
      inputCostPerToken: dollarsPerMillion(0.5),
      outputCostPerToken: dollarsPerMillion(3),
      cacheReadCostPerToken: dollarsPerMillion(0.05)
    }
  ]
};

const VENDOR_ORDER = ["claude", "codex", "gemini"];
const CODEX_MODEL_ORDER = [
  "gpt-5-codex",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-pro",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini"
];

async function main() {
  const check = process.argv.includes("--check");
  const pricing = {
    claude: await fetchClaudePricing(),
    codex: await fetchCodexPricing(),
    gemini: await fetchGeminiPricing()
  };

  for (const vendor of VENDOR_ORDER) {
    pricing[vendor] = mergeManualEntries(vendor, pricing[vendor]);
    applyManualAliases(vendor, pricing[vendor]);
    assertEntries(vendor, pricing[vendor]);
  }

  const current = await readFile(MODEL_PRICING_PATH, "utf8");
  const next = await formatSource(
    replacePricingBlock(current, pricing),
    MODEL_PRICING_PATH
  );

  if (next === current) {
    console.log("modelPricing.ts is already up to date.");
    return;
  }

  if (check) {
    console.error(
      "modelPricing.ts is not up to date. Run npm run update:model-pricing."
    );
    process.exit(1);
  }

  await writeFile(MODEL_PRICING_PATH, next);
  console.log("Updated packages/metadata/src/modelPricing.ts.");
}

async function fetchClaudePricing() {
  const html = await fetchText(SOURCES.claude);
  const table = html.match(
    /The following table shows pricing for all Claude models:[\s\S]*?<table[\s\S]*?<\/table>/u
  )?.[0];
  if (!table) {
    throw new Error("Could not find Claude model pricing table.");
  }

  return parseHtmlTable(table)
    .filter((row) => /^Claude (Opus|Sonnet|Haiku) /u.test(row[0] ?? ""))
    .map((row) => {
      const modelName = row[0].replace(/\s*\(.+?\)\s*$/u, "");
      const prices = row.slice(1).map(parseFirstDollar);
      if (prices.length < 5 || prices.some((price) => price === null)) {
        throw new Error(
          `Could not parse Claude pricing row: ${row.join(" | ")}`
        );
      }

      return {
        modelId: claudeModelId(modelName),
        inputCostPerToken: dollarsPerMillion(prices[0]),
        outputCostPerToken: dollarsPerMillion(prices[4]),
        cacheReadCostPerToken: dollarsPerMillion(prices[3]),
        cacheCreateCostPerToken: dollarsPerMillion(prices[1]),
        aliases: [claudeDottedAlias(modelName)]
      };
    });
}

async function fetchCodexPricing() {
  const html = await fetchText(SOURCES.codex);
  const tables = parseAstroPricingTables(html);
  const standardCodexTable = tables.find(
    (table) =>
      table.kind === "GroupedPricingTable" &&
      table.headings.join("|") === "Category|Model|Input|Cached input|Output" &&
      table.rows.some((row) => row[0] === "Codex" && row[1] === "gpt-5-codex")
  );

  if (!standardCodexTable) {
    throw new Error("Could not find OpenAI Codex pricing table.");
  }

  return standardCodexTable.rows
    .filter((row) => row[0] === "Codex")
    .filter((row) => /^gpt-5(?:\.\d+)?-codex(?:-[a-z]+)?$/u.test(row[1]))
    .map((row) => ({
      modelId: row[1],
      inputCostPerToken: dollarsPerMillion(parseRequiredNumber(row[2])),
      outputCostPerToken: dollarsPerMillion(parseRequiredNumber(row[4])),
      cacheReadCostPerToken: dollarsPerMillion(parseRequiredNumber(row[3]))
    }));
}

async function fetchGeminiPricing() {
  const html = await fetchText(SOURCES.gemini);
  const sections = html.split(/<div class="models-section">/u).slice(1);
  const entries = [];

  for (const section of sections) {
    const modelId = section.match(/<code[^>]*>(gemini-[^<]+)<\/code>/u)?.[1];
    if (!modelId || !isGeminiTextModel(modelId)) {
      continue;
    }

    const standardTable = section.match(
      /<section><h3[^>]*data-text="Standard"[\s\S]*?<table class="pricing-table">[\s\S]*?<\/table>/u
    )?.[0];
    if (!standardTable) {
      continue;
    }

    const rows = parseHtmlTable(standardTable);
    const inputPrices = parseDollarTiers(findPriceRow(rows, "Input price"));
    const outputPrices = parseDollarTiers(findPriceRow(rows, "Output price"));
    const cachePrices = parseDollarTiers(
      findPriceRow(rows, "Context caching price")
    );

    if (!inputPrices.base || !outputPrices.base) {
      continue;
    }

    const entry = {
      modelId: canonicalGeminiModelId(modelId),
      inputCostPerToken: dollarsPerMillion(inputPrices.base),
      outputCostPerToken: dollarsPerMillion(outputPrices.base),
      cacheReadCostPerToken: dollarsPerMillion(cachePrices.base ?? 0)
    };

    if (inputPrices.above || outputPrices.above || cachePrices.above) {
      entry.inputCostPerTokenAboveThreshold = dollarsPerMillion(
        inputPrices.above ?? inputPrices.base
      );
      entry.outputCostPerTokenAboveThreshold = dollarsPerMillion(
        outputPrices.above ?? outputPrices.base
      );
      if (cachePrices.base !== null) {
        entry.cacheReadCostPerTokenAboveThreshold = dollarsPerMillion(
          cachePrices.above ?? cachePrices.base
        );
        entry.cacheCreateCostPerTokenAboveThreshold =
          entry.cacheReadCostPerTokenAboveThreshold;
      }
    }

    entries.push(entry);
  }

  if (!entries.some((entry) => entry.modelId === "gemini-2.5-pro")) {
    throw new Error("Could not find Gemini 2.5 Pro pricing.");
  }

  return entries;
}

function parseAstroPricingTables(html) {
  const tables = [];
  for (const match of html.matchAll(
    /component-export="(GroupedPricingTable|PricingTable)"[^>]*props="([^"]+)"/gu
  )) {
    const kind = match[1];
    const props = reviveAstroJson(JSON.parse(decodeHtml(match[2])));
    if (kind === "GroupedPricingTable") {
      tables.push({
        kind,
        headings: props.headings,
        rows: (props.groups ?? []).flatMap((group) =>
          (group.rows ?? []).map((row) => [
            cellText(group.model),
            ...row.map(cellText)
          ])
        )
      });
    } else {
      tables.push({
        kind,
        headings: props.headings,
        rows: (props.rows ?? []).map((row) => row.map(cellText))
      });
    }
  }
  return tables;
}

function parseHtmlTable(tableHtml) {
  const rows = [];
  for (const rowMatch of tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gu)) {
    const cells = [
      ...rowMatch[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gu)
    ].map((cellMatch) => stripHtml(cellMatch[1]));
    if (cells.length > 0) {
      rows.push(cells);
    }
  }
  return rows;
}

function mergeManualEntries(vendor, entries) {
  const merged = new Map(entries.map((entry) => [entry.modelId, entry]));
  for (const entry of MANUAL_ENTRIES[vendor] ?? []) {
    const existing = merged.get(entry.modelId);
    if (existing) {
      merged.set(entry.modelId, mergePricingEntry(existing, entry));
    } else {
      merged.set(entry.modelId, entry);
    }
  }
  return [...merged.values()].sort((left, right) =>
    compareModelIds(vendor, left.modelId, right.modelId)
  );
}

function mergePricingEntry(existing, overlay) {
  return {
    ...existing,
    ...overlay,
    aliases:
      existing.aliases || overlay.aliases
        ? [
            ...new Set([
              ...(existing.aliases ?? []),
              ...(overlay.aliases ?? [])
            ])
          ]
        : undefined
  };
}

function applyManualAliases(vendor, entries) {
  for (const entry of entries) {
    const aliases = [
      ...(entry.aliases ?? []),
      ...(MANUAL_ALIASES[vendor]?.[entry.modelId] ?? [])
    ];
    if (aliases.length > 0) {
      entry.aliases = [...new Set(aliases)];
    }
  }
}

function replacePricingBlock(source, pricing) {
  const generated = `const MODEL_PRICING: Record<SupportedVendor, PricingEntry[]> = ${formatPricingObject(
    pricing
  )};`;
  return source.replace(
    /const MODEL_PRICING: Record<SupportedVendor, PricingEntry\[\]> = \{[\s\S]*?\n\};/u,
    generated
  );
}

async function formatSource(source, filepath) {
  const prettier = await import("prettier");
  const options = await prettier.resolveConfig(filepath);
  return prettier.format(source, { ...options, filepath });
}

function formatPricingObject(pricing) {
  const lines = ["{"];
  for (const [vendorIndex, vendor] of VENDOR_ORDER.entries()) {
    lines.push(`  ${vendor}: [`);
    pricing[vendor].forEach((entry, entryIndex) => {
      lines.push("    {");
      const keys = [
        "modelId",
        "inputCostPerToken",
        "outputCostPerToken",
        "cacheReadCostPerToken",
        "cacheCreateCostPerToken",
        "inputCostPerTokenAboveThreshold",
        "outputCostPerTokenAboveThreshold",
        "cacheReadCostPerTokenAboveThreshold",
        "cacheCreateCostPerTokenAboveThreshold",
        "tieredPricingThresholdTokens",
        "aliases"
      ].filter((key) => entry[key] !== undefined);
      keys.forEach((key, keyIndex) => {
        const suffix = keyIndex === keys.length - 1 ? "" : ",";
        lines.push(`      ${key}: ${formatValue(entry[key])}${suffix}`);
      });
      lines.push(
        `    }${entryIndex === pricing[vendor].length - 1 ? "" : ","}`
      );
    });
    lines.push(`  ]${vendorIndex === VENDOR_ORDER.length - 1 ? "" : ","}`);
  }
  lines.push("}");
  return lines.join("\n");
}

function formatValue(value) {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= 10_000) {
      return value.toLocaleString("en-US").replace(/,/gu, "_");
    }
    if (value > 0 && value < 1) {
      return value.toFixed(12).replace(/0+$/u, "").replace(/\.$/u, "");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
  }
  throw new Error(`Unsupported generated value: ${value}`);
}

function assertEntries(vendor, entries) {
  if (entries.length === 0) {
    throw new Error(`No pricing entries generated for ${vendor}.`);
  }
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.modelId)) {
      throw new Error(
        `Duplicate ${vendor} model pricing entry: ${entry.modelId}`
      );
    }
    seen.add(entry.modelId);
    for (const key of [
      "inputCostPerToken",
      "outputCostPerToken",
      "cacheReadCostPerToken"
    ]) {
      if (typeof entry[key] !== "number" || Number.isNaN(entry[key])) {
        throw new Error(`Invalid ${key} for ${vendor}/${entry.modelId}`);
      }
    }
  }
}

function compareModelIds(vendor, left, right) {
  if (vendor === "codex") {
    const leftIndex = CODEX_MODEL_ORDER.indexOf(left);
    const rightIndex = CODEX_MODEL_ORDER.indexOf(right);
    if (leftIndex !== -1 || rightIndex !== -1) {
      return (
        (leftIndex === -1 ? 999 : leftIndex) -
        (rightIndex === -1 ? 999 : rightIndex)
      );
    }
  }
  return compareVersionLike(right, left);
}

function compareVersionLike(left, right) {
  const leftParts = left.match(/\d+(?:\.\d+)?/gu)?.map(Number) ?? [];
  const rightParts = right.match(/\d+(?:\.\d+)?/gu)?.map(Number) ?? [];
  for (
    let index = 0;
    index < Math.max(leftParts.length, rightParts.length);
    index += 1
  ) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return left.localeCompare(right);
}

function claudeModelId(modelName) {
  return modelName.toLowerCase().replace(/\./gu, "-").replace(/\s+/gu, "-");
}

function claudeDottedAlias(modelName) {
  return modelName.toLowerCase().replace(/\s+/gu, "-");
}

function isGeminiTextModel(modelId) {
  return /^gemini-(?:3(?:\.\d+)?|2\.[05])-(?:pro|flash-lite|flash)(?:-preview(?:-\d{2}-\d{4})?)?$/u.test(
    modelId
  );
}

function canonicalGeminiModelId(modelId) {
  return modelId.replace(/-preview-\d{2}-\d{4}$/u, "-preview");
}

function parseDollarTiers(value) {
  if (!value || /not available/iu.test(value)) {
    return { base: null, above: null };
  }
  const prices = [...value.matchAll(/\$([0-9.]+)/gu)].map((match) =>
    Number(match[1])
  );
  const tokenPrices = prices.filter((price, index) => {
    if (index < 2) {
      return true;
    }
    return !/per hour/iu.test(value);
  });
  return {
    base: tokenPrices[0] ?? null,
    above: /prompts\s*>/iu.test(value) ? (tokenPrices[1] ?? null) : null
  };
}

function findPriceRow(rows, labelPrefix) {
  return rows.find((row) => row[0]?.startsWith(labelPrefix))?.[2];
}

function parseFirstDollar(value) {
  return Number(value.match(/\$([0-9.]+)/u)?.[1] ?? NaN);
}

function parseRequiredNumber(value) {
  if (typeof value === "number") {
    return value;
  }
  const normalized = String(value).replace(/[$,]/gu, "").trim();
  const parsed = Number(normalized);
  if (Number.isNaN(parsed)) {
    throw new Error(`Expected numeric price, got ${value}`);
  }
  return parsed;
}

function dollarsPerMillion(dollars) {
  return dollars / 1_000_000;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "kmux-model-pricing-updater/1.0"
    }
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${url}: ${response.status} ${response.statusText}`
    );
  }
  return response.text();
}

function cellText(cell) {
  if (cell && typeof cell === "object" && "__pricingHtml" in cell) {
    return stripHtml(String(cell.__pricingHtml));
  }
  return String(cell);
}

function reviveAstroJson(value) {
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number"
  ) {
    if (value[0] === 0) {
      return reviveAstroJson(value[1]);
    }
    if (value[0] === 1) {
      return value[1].map(reviveAstroJson);
    }
    return reviveAstroJson(value[1]);
  }
  if (Array.isArray(value)) {
    return value.map(reviveAstroJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        reviveAstroJson(nestedValue)
      ])
    );
  }
  return value;
}

function stripHtml(value) {
  return decodeHtml(
    value.replace(/<br\s*\/?>/giu, " ").replace(/<\/?[A-Za-z][^>]*>/gu, " ")
  )
    .replace(/\s+/gu, " ")
    .trim();
}

function decodeHtml(value) {
  return value
    .replace(/&quot;/gu, '"')
    .replace(/&#34;/gu, '"')
    .replace(/&#x27;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
