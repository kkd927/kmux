#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(SCRIPT_PATH), "..");
const MODEL_PRICING_PATH = path.join(
  ROOT_DIR,
  "packages/metadata/src/modelPricing.json"
);

const SOURCES = {
  claude: "https://docs.anthropic.com/en/docs/about-claude/pricing",
  codex: {
    standard:
      "https://developers.openai.com/api/docs/pricing?latest-pricing=standard#text-tokens",
    fast: "https://developers.openai.com/api/docs/pricing?latest-pricing=fast#text-tokens"
  },
  gemini: "https://ai.google.dev/gemini-api/docs/pricing?hl=en"
};

const MANUAL_ALIASES = {
  codex: {
    "gpt-5.6-sol": ["gpt-5.6"]
  },
  gemini: {
    "gemini-3.5-flash": [
      "Gemini 3.5 Flash (Low)",
      "Gemini 3.5 Flash (Medium)",
      "Gemini 3.5 Flash (High)",
      "gemini-3.5-flash-low",
      "gemini-3.5-flash-medium",
      "gemini-3.5-flash-high"
    ]
  }
};

const MANUAL_ENTRIES = {};

const VENDOR_ORDER = ["claude", "codex", "gemini"];
const PRICING_MODE_ORDER = ["standard", "fast"];
const PRICING_ENTRY_KEYS = [
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
];

async function main() {
  const check = process.argv.includes("--check");
  const pricingDate = resolveModelPricingDate();
  const models = {
    claude: { standard: await fetchClaudePricing(pricingDate) },
    codex: await fetchCodexPricing(),
    gemini: { standard: await fetchGeminiPricing() }
  };

  for (const vendor of VENDOR_ORDER) {
    for (const mode of PRICING_MODE_ORDER) {
      const entries = models[vendor][mode];
      if (!entries) {
        continue;
      }
      models[vendor][mode] = mergeManualEntries(vendor, entries);
      applyManualAliases(vendor, models[vendor][mode]);
      assertEntries(`${vendor}/${mode}`, models[vendor][mode]);
    }
  }

  const current = JSON.parse(await readFile(MODEL_PRICING_PATH, "utf8"));
  const nextCatalog = buildModelPricingCatalog({
    currentCatalog: current,
    models,
    publishedAt: `${pricingDate}T00:00:00.000Z`
  });
  const next = `${JSON.stringify(nextCatalog, null, 2)}\n`;
  const currentSource = `${JSON.stringify(current, null, 2)}\n`;

  if (next === currentSource) {
    console.log("modelPricing.json is already up to date.");
    return;
  }

  if (check) {
    console.error(
      "modelPricing.json is not up to date. Run npm run update:model-pricing."
    );
    process.exit(1);
  }

  const temporaryPath = `${MODEL_PRICING_PATH}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, next);
    await rename(temporaryPath, MODEL_PRICING_PATH);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  console.log("Updated packages/metadata/src/modelPricing.json.");
}

export function buildModelPricingCatalog({
  currentCatalog,
  models,
  publishedAt
}) {
  if (
    currentCatalog.schemaVersion !== 1 ||
    !Number.isSafeInteger(currentCatalog.catalogVersion) ||
    currentCatalog.catalogVersion < 1
  ) {
    throw new Error("Current model pricing catalog metadata is invalid.");
  }
  if (JSON.stringify(currentCatalog.models) === JSON.stringify(models)) {
    return currentCatalog;
  }
  const publishedAtMs = Date.parse(publishedAt);
  if (
    !Number.isFinite(publishedAtMs) ||
    new Date(publishedAtMs).toISOString() !== publishedAt
  ) {
    throw new Error("Model pricing publishedAt is invalid.");
  }
  return {
    schemaVersion: 1,
    catalogVersion: currentCatalog.catalogVersion + 1,
    publishedAt,
    revision: createHash("sha256").update(JSON.stringify(models)).digest("hex"),
    models
  };
}

async function fetchClaudePricing(activeDate) {
  const html = await fetchText(SOURCES.claude);
  return parseClaudePricingHtml(html, activeDate);
}

export function parseClaudePricingHtml(
  html,
  activeDate = resolveModelPricingDate()
) {
  const table = html.match(
    /The following table shows pricing for all Claude models:[\s\S]*?<table[\s\S]*?<\/table>/u
  )?.[0];
  if (!table) {
    throw new Error("Could not find Claude model pricing table.");
  }

  return parseClaudePricingTable(table, activeDate);
}

export function parseClaudePricingTable(
  tableHtml,
  activeDate = resolveModelPricingDate()
) {
  assertPricingDayKey(activeDate, "Claude pricing active date");
  const rows = parseHtmlTable(tableHtml)
    .filter((row) => row[0]?.startsWith("Claude "))
    .map(parseClaudePricingRow);

  return selectActiveClaudePricingRows(rows, activeDate).map(
    (row) => row.entry
  );
}

async function fetchCodexPricing() {
  const pairs = await Promise.all(
    PRICING_MODE_ORDER.map(async (mode) => {
      const html = await fetchText(SOURCES.codex[mode]);
      return [mode, parseOpenAiPricingHtml(html, mode)];
    })
  );
  return Object.fromEntries(pairs);
}

export function parseOpenAiPricingHtml(html, mode) {
  assertOpenAiPricingMode(mode);
  try {
    const flagshipEntries = parseOpenAiTextTokenPricingHtml(html, mode);
    const specializedEntries = parseOpenAiSpecializedCodexPricingHtml(
      html,
      mode
    );
    return mergeOpenAiPricingEntries(mode, [
      ...flagshipEntries,
      ...specializedEntries
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message} ${openAiPricingDiagnostics(html, mode)}`,
      error instanceof Error ? { cause: error } : undefined
    );
  }
}

export function parseOpenAiTextTokenPricingHtml(html, mode = "standard") {
  assertOpenAiPricingMode(mode);
  const tables = parseTextTokenPricingTables(html).filter(
    (table) => table.tier === mode && table.section === "Flagship models"
  );

  if (tables.length !== 1) {
    throw new Error(
      openAiTableSelectionError(
        `Expected one OpenAI ${mode} flagship text-token pricing table, found ${tables.length}.`,
        parseTextTokenPricingTables(html)
      )
    );
  }
  const textTokenTable = tables[0];

  const thresholdByModel = new Map(
    textTokenTable.propsRows
      .map((row) => openAiTextModelInfo(row[0]))
      .filter((model) => model.thresholdTokens)
      .map((model) => [model.modelId, model.thresholdTokens])
  );
  const sharedLongContextThreshold = sharedMapValue(thresholdByModel);
  const rows = textTokenTable.renderedRows;
  if (rows.length === 0) {
    throw new Error(
      `Could not find rendered OpenAI ${mode} text-token pricing rows.`
    );
  }
  const columns = openAiTextTokenPricingColumns(rows, mode, textTokenTable);

  const renderedEntries = rows
    .filter(
      (row) =>
        String(row[columns.model] ?? "").trim() !== "" &&
        normalizePricingHeader(row[columns.model]) !== "model"
    )
    .map((row) => {
      const modelId = openAiTextModelInfo(row[columns.model]).modelId;
      assertOpenAiModelId(modelId, mode);
      const entry = {
        modelId,
        inputCostPerToken: dollarsPerMillion(
          parseRequiredNumber(row[columns.input[0]])
        ),
        outputCostPerToken: dollarsPerMillion(
          parseRequiredNumber(row[columns.output[0]])
        ),
        cacheReadCostPerToken: dollarsPerMillion(
          parseOptionalNumber(row[columns.cachedInput[0]])
        )
      };
      if (
        columns.cacheWrites.length > 0 &&
        hasPrice(row[columns.cacheWrites[0]])
      ) {
        entry.cacheCreateCostPerToken = dollarsPerMillion(
          parseRequiredNumber(row[columns.cacheWrites[0]])
        );
      }
      if (
        columns.input.length > 1 &&
        columns.output.length > 1 &&
        hasPrice(row[columns.input[1]]) &&
        hasPrice(row[columns.output[1]])
      ) {
        const threshold =
          thresholdByModel.get(entry.modelId) ?? sharedLongContextThreshold;
        if (!threshold) {
          throw new Error(
            `Could not find OpenAI long-context threshold for ${entry.modelId}.`
          );
        }
        entry.inputCostPerTokenAboveThreshold = dollarsPerMillion(
          parseRequiredNumber(row[columns.input[1]])
        );
        entry.outputCostPerTokenAboveThreshold = dollarsPerMillion(
          parseRequiredNumber(row[columns.output[1]])
        );
        entry.cacheReadCostPerTokenAboveThreshold = dollarsPerMillion(
          parseOptionalNumber(row[columns.cachedInput[1]])
        );
        if (
          columns.cacheWrites.length > 1 &&
          hasPrice(row[columns.cacheWrites[1]])
        ) {
          entry.cacheCreateCostPerTokenAboveThreshold = dollarsPerMillion(
            parseRequiredNumber(row[columns.cacheWrites[1]])
          );
        }
        entry.tieredPricingThresholdTokens = threshold;
      }
      return entry;
    });
  const propsEntries = textTokenTable.propsRows.map((row) =>
    parseOpenAiTextTokenPropsRow(row, mode)
  );
  return mergeOpenAiPricingEntries(mode, [...propsEntries, ...renderedEntries]);
}

function parseOpenAiTextTokenPropsRow(row, mode) {
  if (row.length !== 4 && row.length !== 5) {
    throw new Error(
      `Unsupported OpenAI ${mode} text-token pricing row shape: ${JSON.stringify(
        row
      )}`
    );
  }
  const model = openAiTextModelInfo(row[0]);
  assertOpenAiModelId(model.modelId, mode);
  const hasCacheWriteColumn = row.length === 5;
  const entry = {
    modelId: model.modelId,
    inputCostPerToken: dollarsPerMillion(parseRequiredNumber(row[1])),
    outputCostPerToken: dollarsPerMillion(
      parseRequiredNumber(row[hasCacheWriteColumn ? 4 : 3])
    ),
    cacheReadCostPerToken: dollarsPerMillion(parseOptionalNumber(row[2]))
  };
  if (hasCacheWriteColumn && hasPrice(row[3])) {
    entry.cacheCreateCostPerToken = dollarsPerMillion(
      parseRequiredNumber(row[3])
    );
  }
  return entry;
}

function parseOpenAiSpecializedCodexPricingHtml(html, mode) {
  const allTables = parseAstroPricingTables(html);
  const tables = allTables.filter(
    (table) =>
      table.kind === "GroupedPricingTable" &&
      table.section === "Specialized models" &&
      table.tier === mode &&
      hasPricingHeaders(table.headings, [
        "Category",
        "Model",
        "Input",
        "Cached input",
        "Output"
      ])
  );
  if (tables.length !== 1) {
    throw new Error(
      openAiTableSelectionError(
        `Expected one OpenAI ${mode} specialized Codex pricing table, found ${tables.length}.`,
        allTables
      )
    );
  }

  const table = tables[0];
  const columns = pricingColumnsFromHeader(table.headings, mode, [
    "Category",
    "Model",
    "Input",
    "Cached input",
    "Output"
  ]);
  const rows = table.rows.filter(
    (row) =>
      String(row[columns.category] ?? "")
        .trim()
        .toLowerCase() === "codex"
  );
  if (rows.length === 0) {
    throw new Error(
      `OpenAI ${mode} specialized pricing table contains no Codex rows.`
    );
  }

  return rows.map((row) => {
    const modelId = String(row[columns.model] ?? "").trim();
    assertOpenAiModelId(modelId, mode);
    return {
      modelId,
      inputCostPerToken: dollarsPerMillion(
        parseRequiredNumber(row[columns.input])
      ),
      outputCostPerToken: dollarsPerMillion(
        parseRequiredNumber(row[columns.output])
      ),
      cacheReadCostPerToken: dollarsPerMillion(
        parseOptionalNumber(row[columns.cachedInput])
      )
    };
  });
}

function openAiTextTokenPricingColumns(rows, mode, table) {
  const header = rows.find(
    (row) =>
      row.some((cell) => normalizePricingHeader(cell) === "model") &&
      row.some((cell) => normalizePricingHeader(cell) === "input") &&
      row.some((cell) => normalizePricingHeader(cell) === "output")
  );
  if (!header) {
    throw new Error(
      openAiTableSelectionError(
        `Could not find OpenAI ${mode} text-token pricing column headers.`,
        [table]
      )
    );
  }

  const columns = {
    model: findColumnIndexes(header, "model")[0],
    input: findColumnIndexes(header, "input"),
    cachedInput: findColumnIndexes(header, "cached input"),
    cacheWrites: findColumnIndexes(header, "cache writes"),
    output: findColumnIndexes(header, "output")
  };
  for (const key of ["model", "input", "cachedInput", "output"]) {
    if (
      columns[key] === undefined ||
      (Array.isArray(columns[key]) && columns[key].length === 0)
    ) {
      throw new Error(
        openAiTableSelectionError(
          `Could not find OpenAI ${mode} text-token pricing ${key} column.`,
          [table]
        )
      );
    }
  }
  return columns;
}

function findColumnIndexes(header, label) {
  return header.flatMap((value, index) =>
    normalizePricingHeader(value) === label ? [index] : []
  );
}

function sharedMapValue(valuesByKey) {
  const values = [...new Set(valuesByKey.values())];
  return values.length === 1 ? values[0] : undefined;
}

function assertOpenAiPricingMode(mode) {
  if (!PRICING_MODE_ORDER.includes(mode)) {
    throw new Error(`Unsupported OpenAI pricing mode: ${mode}`);
  }
}

function assertOpenAiModelId(modelId, mode) {
  if (typeof modelId !== "string" || modelId.trim() === "") {
    throw new Error(`OpenAI ${mode} pricing row has an empty model ID.`);
  }
}

function mergeOpenAiPricingEntries(mode, entries) {
  const merged = new Map();
  for (const entry of entries) {
    const existing = merged.get(entry.modelId);
    if (!existing) {
      merged.set(entry.modelId, entry);
      continue;
    }
    const combined = mergeCompatibleOpenAiPricingEntries(existing, entry);
    if (!combined) {
      throw new Error(
        `Conflicting OpenAI ${mode} pricing for ${entry.modelId}: ${JSON.stringify(
          existing
        )} vs ${JSON.stringify(entry)}`
      );
    }
    merged.set(entry.modelId, combined);
  }
  if (merged.size === 0) {
    throw new Error(`No OpenAI ${mode} pricing entries were generated.`);
  }
  return [...merged.values()];
}

function mergeCompatibleOpenAiPricingEntries(left, right) {
  for (const key of PRICING_ENTRY_KEYS) {
    if (
      left[key] !== undefined &&
      right[key] !== undefined &&
      JSON.stringify(left[key]) !== JSON.stringify(right[key])
    ) {
      return null;
    }
  }
  return { ...left, ...right };
}

async function fetchGeminiPricing() {
  const html = await fetchText(SOURCES.gemini);
  const sections = html.split(/<div class="models-section">/u).slice(1);
  const entries = [];

  for (const section of sections) {
    const modelIds = geminiTextModelIds(section);
    const modelId = modelIds[0];
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
    const aliases = modelIds.slice(1);
    if (aliases.length > 0) {
      entry.aliases = aliases;
    }

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
        section: nearestPricingHeading(html, match.index),
        tier: pricingPaneValueAt(html, match.index),
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
        section: nearestPricingHeading(html, match.index),
        tier: pricingPaneValueAt(html, match.index),
        headings: props.headings,
        rows: (props.rows ?? []).map((row) => row.map(cellText))
      });
    }
  }
  return tables;
}

function parseTextTokenPricingTables(html) {
  const tables = [];
  for (const match of html.matchAll(
    /component-export="TextTokenPricingTables"[^>]*props="([^"]+)"[\s\S]*?<table[^>]*>([\s\S]*?)<\/table>/gu
  )) {
    const props = reviveAstroJson(JSON.parse(decodeHtml(match[1])));
    tables.push({
      kind: "TextTokenPricingTables",
      section: nearestPricingHeading(html, match.index),
      tier: props.tier,
      headings: [],
      propsRows: (props.rows ?? []).map((row) => row.map(cellText)),
      renderedRows: parseHtmlTable(`<table>${match[2]}</table>`)
    });
  }
  return tables;
}

function nearestPricingHeading(html, index) {
  const headings = [
    ...html.slice(0, index).matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gu)
  ];
  return headings.length > 0 ? stripHtml(headings.at(-1)[1]) : undefined;
}

function pricingPaneValueAt(html, index) {
  const paneIndex = html.lastIndexOf(
    'data-content-switcher-pane="true"',
    index
  );
  if (paneIndex < 0) {
    return undefined;
  }
  const paneTagEnd = html.indexOf(">", paneIndex);
  if (paneTagEnd < 0 || paneTagEnd > index) {
    return undefined;
  }
  return /data-value="([^"]+)"/u.exec(html.slice(paneIndex, paneTagEnd))?.[1];
}

function normalizePricingHeader(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function hasPricingHeaders(actual, expected) {
  const normalized = new Set(actual.map(normalizePricingHeader));
  return expected.every((header) =>
    normalized.has(normalizePricingHeader(header))
  );
}

function pricingColumnsFromHeader(header, mode, required) {
  const columns = Object.fromEntries(
    header.map((value, index) => [
      normalizePricingHeader(value).replace(/\s+(.)/gu, (_, char) =>
        char.toUpperCase()
      ),
      index
    ])
  );
  for (const label of required) {
    const key = normalizePricingHeader(label).replace(/\s+(.)/gu, (_, char) =>
      char.toUpperCase()
    );
    if (columns[key] === undefined) {
      throw new Error(
        `Could not find OpenAI ${mode} specialized pricing ${label} column.`
      );
    }
  }
  return columns;
}

function openAiTableSelectionError(message, tables) {
  const candidates = tables.map((table) => ({
    kind: table.kind,
    section: table.section,
    tier: table.tier,
    headings:
      table.headings?.length > 0
        ? table.headings
        : table.renderedRows?.find((row) =>
            row.some((cell) => normalizePricingHeader(cell) === "model")
          ),
    rowCount: table.rows?.length ?? table.renderedRows?.length ?? 0
  }));
  return `${message} Candidates: ${JSON.stringify(candidates)}`;
}

function openAiPricingDiagnostics(html, mode) {
  try {
    return `Diagnostics: ${JSON.stringify({
      requestedTier: mode,
      tables: [
        ...parseTextTokenPricingTables(html),
        ...parseAstroPricingTables(html)
      ].map((table) => ({
        kind: table.kind,
        section: table.section,
        tier: table.tier,
        headings:
          table.headings?.length > 0
            ? table.headings
            : table.renderedRows?.find((row) =>
                row.some((cell) => normalizePricingHeader(cell) === "model")
              ),
        rowCount: table.rows?.length ?? table.renderedRows?.length ?? 0
      }))
    })}`;
  } catch (error) {
    return `Diagnostics unavailable for requested tier ${mode}: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
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
  return sortModelPricingEntries(vendor, [...merged.values()]);
}

export function sortModelPricingEntries(vendor, entries) {
  return [...entries].sort((left, right) =>
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
      if (
        typeof entry[key] !== "number" ||
        !Number.isFinite(entry[key]) ||
        entry[key] < 0
      ) {
        throw new Error(`Invalid ${key} for ${vendor}/${entry.modelId}`);
      }
    }
  }
}

function compareModelIds(vendor, left, right) {
  if (vendor === "codex") {
    return compareCodexModelIds(left, right);
  }
  return compareVersionLike(right, left);
}

function compareCodexModelIds(left, right) {
  const leftVersion = codexModelVersion(left);
  const rightVersion = codexModelVersion(right);
  if (leftVersion && rightVersion) {
    return (
      rightVersion.major - leftVersion.major ||
      rightVersion.minor - leftVersion.minor
    );
  }
  if (leftVersion) {
    return -1;
  }
  if (rightVersion) {
    return 1;
  }
  return compareVersionLike(right, left);
}

function codexModelVersion(modelId) {
  const match = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/u.exec(modelId);
  return match
    ? { major: Number(match[1]), minor: Number(match[2] ?? 0) }
    : null;
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

function parseClaudePricingRow(row) {
  const sourceLabel = row[0] ?? "";
  const identity = parseClaudeModelIdentity(sourceLabel);
  const prices = row.slice(1).map(parseFirstDollar);
  if (prices.length < 5 || prices.some((price) => !Number.isFinite(price))) {
    throw new Error(`Could not parse Claude pricing row: ${row.join(" | ")}`);
  }

  const modelId = claudeModelId(identity.modelName);
  assertClaudeModelId(modelId, sourceLabel);

  return {
    modelId,
    sourceLabel,
    activeFrom: identity.activeFrom,
    activeThrough: identity.activeThrough,
    entry: {
      modelId,
      inputCostPerToken: dollarsPerMillion(prices[0]),
      outputCostPerToken: dollarsPerMillion(prices[4]),
      cacheReadCostPerToken: dollarsPerMillion(prices[3]),
      cacheCreateCostPerToken: dollarsPerMillion(prices[1]),
      aliases: [claudeDottedAlias(identity.modelName)]
    }
  };
}

function parseClaudeModelIdentity(value) {
  const normalized = value.replace(/\s*\(.+?\)\s*$/u, "").trim();
  const tokens = normalized.split(/\s+/u);
  if (tokens[0] !== "Claude") {
    throw new Error(`Could not parse Claude model identity: ${value}`);
  }
  const versionIndex = tokens.findIndex(
    (token, index) => index > 0 && /^\d+(?:\.\d+)?$/u.test(token)
  );
  if (versionIndex < 2) {
    throw new Error(`Could not parse Claude model identity: ${value}`);
  }

  const identity = {
    modelName: tokens.slice(0, versionIndex + 1).join(" ")
  };
  const windowTokens = tokens.slice(versionIndex + 1);
  if (windowTokens.length > 0) {
    const windowKind = windowTokens[0].toLowerCase();
    if (windowKind !== "through" && windowKind !== "starting") {
      throw new Error(`Could not parse Claude model identity: ${value}`);
    }
    const dayKey = parseClaudePricingWindowDate(
      windowTokens.slice(1).join(" ")
    );
    if (windowKind === "through") {
      identity.activeThrough = dayKey;
    } else {
      identity.activeFrom = dayKey;
    }
  }
  return identity;
}

function parseClaudePricingWindowDate(value) {
  const match =
    /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(\d{4})$/iu.exec(
      value.trim()
    );
  if (!match) {
    throw new Error(`Could not parse Claude pricing window date: ${value}`);
  }

  const monthIndex = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december"
  ].indexOf(match[1].toLowerCase());
  const year = Number(match[3]);
  const month = monthIndex + 1;
  const day = Number(match[2]);
  const parsed = new Date(Date.UTC(year, monthIndex, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== monthIndex ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`Invalid Claude pricing window date: ${value}`);
  }

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(
    2,
    "0"
  )}`;
}

function selectActiveClaudePricingRows(rows, activeDate) {
  const rowsByModelId = new Map();
  for (const row of rows) {
    const group = rowsByModelId.get(row.modelId) ?? [];
    group.push(row);
    rowsByModelId.set(row.modelId, group);
  }

  const selected = [];
  for (const [modelId, modelRows] of rowsByModelId) {
    const activeRows = modelRows.filter((row) =>
      isClaudePricingRowActive(row, activeDate)
    );
    if (activeRows.length !== 1) {
      const prefix = activeRows.length === 0 ? "No active" : "Multiple active";
      throw new Error(
        `${prefix} Claude pricing rows for ${modelId} on ${activeDate}: ${modelRows
          .map((row) => row.sourceLabel)
          .join(" | ")}`
      );
    }
    selected.push(activeRows[0]);
  }
  return selected;
}

function isClaudePricingRowActive(row, activeDate) {
  if (row.activeFrom && activeDate < row.activeFrom) {
    return false;
  }
  if (row.activeThrough && activeDate > row.activeThrough) {
    return false;
  }
  return true;
}

export function resolveModelPricingDate() {
  const configured = process.env.KMUX_MODEL_PRICING_DATE;
  if (configured) {
    assertPricingDayKey(configured, "KMUX_MODEL_PRICING_DATE");
    return configured;
  }
  return new Date().toISOString().slice(0, 10);
}

function assertPricingDayKey(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error(`${label} must use YYYY-MM-DD format.`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`${label} is not a valid calendar date.`);
  }
}

function assertClaudeModelId(modelId, sourceLabel) {
  if (!/-\d+(?:-\d+)*$/u.test(modelId)) {
    throw new Error(
      `Generated Claude modelId must end with a numeric version: ${modelId}`
    );
  }
  if (
    /\b(?:through|starting)\b|,|(?:^|-)20\d{2}(?:-|$)|(?:^|-)(?:january|february|march|april|may|june|july|august|september|october|november|december)(?:-|$)/iu.test(
      modelId
    )
  ) {
    throw new Error(
      `Generated Claude modelId includes pricing window text from "${sourceLabel}": ${modelId}`
    );
  }
}

function claudeModelId(modelName) {
  return modelName
    .toLowerCase()
    .replace(/\./gu, "-")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function claudeDottedAlias(modelName) {
  return modelName.toLowerCase().replace(/\s+/gu, "-");
}

function geminiTextModelIds(section) {
  return [
    ...new Set(
      [...section.matchAll(/<code[^>]*>(gemini-[^<]+)<\/code>/gu)]
        .map((match) => match[1])
        .filter((modelId) => isGeminiTextModelAlias(modelId))
    )
  ];
}

function isGeminiTextModelAlias(modelId) {
  return isGeminiTextModel(
    canonicalGeminiModelId(modelId).replace(/-customtools$/u, "")
  );
}

function isGeminiTextModel(modelId) {
  return /^gemini-\d+(?:\.\d+)?-(?:pro|flash-lite|flash)(?:-preview(?:-\d{2}-\d{4})?)?$/u.test(
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
  const parsed =
    typeof value === "number"
      ? value
      : Number(String(value).replace(/[$,]/gu, "").trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected numeric price, got ${value}`);
  }
  return parsed;
}

function parseOptionalNumber(value) {
  const normalized = String(value ?? "").trim();
  if (normalized === "" || normalized === "-" || normalized === "null") {
    return 0;
  }
  return parseRequiredNumber(value);
}

function hasPrice(value) {
  const normalized = String(value ?? "").trim();
  return normalized !== "" && normalized !== "-" && normalized !== "null";
}

function openAiTextModelInfo(value) {
  const text = cellText(value);
  const thresholdMatch = /\(<\s*([0-9.]+)K context length\)/iu.exec(text);
  return {
    modelId: text
      .replace(/\s*\(<\s*[0-9.]+K context length\)\s*$/iu, "")
      .trim(),
    thresholdTokens: thresholdMatch
      ? Math.round(Number(thresholdMatch[1]) * 1_000)
      : undefined
  };
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

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
