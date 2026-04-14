import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import {
  buildBaseTerminalSymbolFallbackFamilies,
  buildResolvedTerminalFontFamily,
  createPendingResolvedTerminalTypographyVm,
  normalizeTerminalTypographySettings
} from "@kmux/core";
import type {
  ResolvedTerminalTypographyVm,
  TerminalTypographyIssue,
  TerminalTypographyProbeReport,
  TerminalTypographySettings
} from "@kmux/proto";

const execFileAsync = promisify(execFile);

const SYSTEM_PROFILER_MAX_BUFFER = 16 * 1024 * 1024;
const DIRECT_SYMBOL_FONTS = ["Symbols Nerd Font Mono", "Symbols Nerd Font"];
const GENERIC_FONT_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-monospace"
]);
const FONT_INVENTORY_ENV_KEY = "KMUX_TEST_FONT_FAMILIES";

type ResolutionState = {
  candidateGroups: string[][];
  candidateIndex: number;
  inventoryIssues: TerminalTypographyIssue[];
  vm: ResolvedTerminalTypographyVm;
};

export interface FontInventoryProvider {
  listFontFamilies(): Promise<string[]>;
}

export interface TerminalTypographyControllerOptions {
  initialSettings: TerminalTypographySettings;
  fontInventoryProvider?: FontInventoryProvider;
  onDidChange?: () => void;
  shouldLogInventoryErrors?: () => boolean;
}

type SystemProfilerFontPayload = {
  SPFontsDataType?: Array<{
    typefaces?: Array<{
      family?: string;
    }>;
  }>;
};

export class TerminalTypographyController {
  private readonly fontInventoryProvider: FontInventoryProvider;

  private readonly onDidChange?: () => void;

  private readonly shouldLogInventoryErrors: () => boolean;

  private fontInventoryPromise: Promise<string[]> | null = null;

  private fontFamilies: string[] = [];

  private settings: TerminalTypographySettings;

  private state: ResolutionState;

  constructor(options: TerminalTypographyControllerOptions) {
    this.fontInventoryProvider =
      options.fontInventoryProvider ?? createFontInventoryProvider();
    this.onDidChange = options.onDidChange;
    this.shouldLogInventoryErrors =
      options.shouldLogInventoryErrors ?? (() => true);
    this.settings = normalizeTerminalTypographySettings(
      options.initialSettings
    );
    this.state = {
      candidateGroups: buildCandidateGroups(this.settings, []),
      candidateIndex: 0,
      inventoryIssues: [],
      vm: createPendingResolvedTerminalTypographyVm(this.settings)
    };
    void this.ensureFontInventory();
  }

  getViewModel(): ResolvedTerminalTypographyVm {
    return this.state.vm;
  }

  setSettings(nextSettings: TerminalTypographySettings): void {
    this.settings = normalizeTerminalTypographySettings(nextSettings);
    this.state = this.resolveState(this.settings, this.fontFamilies);
    this.onDidChange?.();
  }

  async listFontFamilies(): Promise<string[]> {
    return [...(await this.ensureFontInventory())];
  }

  async preview(
    nextSettings: TerminalTypographySettings
  ): Promise<ResolvedTerminalTypographyVm> {
    const settings = normalizeTerminalTypographySettings(nextSettings);
    const fontFamilies = await this.ensureFontInventory();
    return this.resolveState(settings, fontFamilies).vm;
  }

  reportProbe(report: TerminalTypographyProbeReport): void {
    if (report.stackHash !== this.state.vm.stackHash) {
      return;
    }

    if (
      report.issues.some(isRetryableSymbolIssue) &&
      hasNextCandidate(this.state.candidateGroups, this.state.candidateIndex)
    ) {
      const nextCandidateIndex = advanceCandidateIndex(
        this.state.candidateGroups,
        this.state.candidateIndex
      );
      if (nextCandidateIndex !== this.state.candidateIndex) {
        this.state = this.resolveState(
          this.settings,
          this.fontFamilies,
          nextCandidateIndex
        );
        this.onDidChange?.();
        return;
      }
    }

    const issues = mergeIssues(this.state.inventoryIssues, report.issues);
    this.state = {
      ...this.state,
      vm: {
        ...this.state.vm,
        status: issues.length > 0 ? "degraded" : "ready",
        issues
      }
    };
    this.onDidChange?.();
  }

  private async ensureFontInventory(): Promise<string[]> {
    if (!this.fontInventoryPromise) {
      this.fontInventoryPromise = this.fontInventoryProvider
        .listFontFamilies()
        .then((fontFamilies) => {
          this.fontFamilies = dedupeFontFamilies(fontFamilies).sort((a, b) =>
            a.localeCompare(b)
          );
          this.state = this.resolveState(this.settings, this.fontFamilies);
          this.onDidChange?.();
          return this.fontFamilies;
        })
        .catch((error) => {
          if (this.shouldLogInventoryErrors()) {
            warnTerminalFontInventoryFailure(error);
          }
          this.fontFamilies = [];
          this.state = this.resolveState(this.settings, this.fontFamilies);
          this.onDidChange?.();
          return this.fontFamilies;
        });
    }

    return this.fontInventoryPromise;
  }

  private resolveState(
    settings: TerminalTypographySettings,
    fontFamilies: string[],
    candidateIndex = defaultCandidateIndex(settings, fontFamilies)
  ): ResolutionState {
    const candidateGroups = buildCandidateGroups(settings, fontFamilies);
    const resolvedCandidateIndex = clampCandidateIndex(
      candidateGroups,
      candidateIndex
    );
    const inventoryIssues = collectInventoryIssues(settings, fontFamilies);
    const symbolFallbackFamilies = collectCandidateFamilies(
      settings.preferredTextFontFamily,
      candidateGroups,
      resolvedCandidateIndex
    );
    const resolvedFontFamily = buildResolvedTerminalFontFamily(
      settings.preferredTextFontFamily,
      symbolFallbackFamilies
    );
    const vm: ResolvedTerminalTypographyVm = {
      stackHash: hashFontStack(resolvedFontFamily),
      resolvedFontFamily,
      textFontFamily: settings.preferredTextFontFamily,
      symbolFallbackFamilies,
      autoFallbackApplied:
        symbolFallbackFamilies.length >
        settings.preferredSymbolFallbackFamilies.length,
      status: inventoryIssues.length > 0 ? "degraded" : "pending",
      issues: inventoryIssues
    };

    return {
      candidateGroups,
      candidateIndex: resolvedCandidateIndex,
      inventoryIssues,
      vm
    };
  }
}

export function createFontInventoryProvider(
  env: NodeJS.ProcessEnv = process.env
): FontInventoryProvider {
  const fakeFamilies = parseFakeFontFamilies(env[FONT_INVENTORY_ENV_KEY]);
  if (fakeFamilies.length > 0) {
    return createStaticFontInventoryProvider(fakeFamilies);
  }
  return createSystemProfilerFontInventoryProvider(env);
}

export function createStaticFontInventoryProvider(
  fontFamilies: string[]
): FontInventoryProvider {
  const deduped = dedupeFontFamilies(fontFamilies);
  return {
    async listFontFamilies() {
      return [...deduped];
    }
  };
}

function createSystemProfilerFontInventoryProvider(
  env: NodeJS.ProcessEnv
): FontInventoryProvider {
  return {
    async listFontFamilies() {
      const { stdout } = await execFileAsync(
        "system_profiler",
        ["SPFontsDataType", "-json"],
        {
          env,
          maxBuffer: SYSTEM_PROFILER_MAX_BUFFER
        }
      );
      return parseSystemProfilerFonts(stdout);
    }
  };
}

function warnTerminalFontInventoryFailure(error: unknown): void {
  if (!isWritableProcessStream(process.stderr)) {
    return;
  }

  try {
    console.warn("Failed to load terminal font inventory", error);
  } catch (warnError) {
    if (isIgnorableConsoleWriteError(warnError)) {
      return;
    }
    throw warnError;
  }
}

function isWritableProcessStream(
  stream: NodeJS.WriteStream | undefined
): stream is NodeJS.WriteStream {
  return Boolean(
    stream &&
    stream.writable &&
    !stream.destroyed &&
    !stream.writableEnded &&
    !stream.closed
  );
}

function isIgnorableConsoleWriteError(error: unknown): boolean {
  if (
    typeof error !== "object" ||
    error === null ||
    !("message" in error) ||
    typeof error.message !== "string"
  ) {
    return false;
  }

  const code =
    "code" in error && typeof error.code === "string" ? error.code : "";
  return (
    code === "EPIPE" ||
    code === "ERR_STREAM_DESTROYED" ||
    error.message.includes("write EPIPE") ||
    error.message.includes("stream is destroyed")
  );
}

function parseSystemProfilerFonts(stdout: string): string[] {
  const payload = JSON.parse(stdout) as SystemProfilerFontPayload;
  const fontFamilies = payload.SPFontsDataType?.flatMap((font) =>
    (font.typefaces ?? [])
      .map((typeface) => typeface.family?.trim())
      .filter((family): family is string => Boolean(family))
  );
  return dedupeFontFamilies(fontFamilies ?? []);
}

function buildCandidateGroups(
  settings: TerminalTypographySettings,
  fontFamilies: string[]
): string[][] {
  const preferredSymbolFallbackFamilies =
    buildBaseTerminalSymbolFallbackFamilies(
      settings.preferredSymbolFallbackFamilies
    );
  const installedFamilies = new Set(
    fontFamilies.map((fontFamily) => normalizeFontFamilyName(fontFamily))
  );
  const directSymbolFallbacks = DIRECT_SYMBOL_FONTS.filter((fontFamily) =>
    installedFamilies.has(normalizeFontFamilyName(fontFamily))
  );
  const matchedSymbolFallbacks = fontFamilies.filter(
    (fontFamily) =>
      isCompatibleInstalledSymbolFont(fontFamily) &&
      !directSymbolFallbacks.some(
        (directFontFamily) =>
          normalizeFontFamilyName(directFontFamily) ===
          normalizeFontFamilyName(fontFamily)
      )
  );

  return [
    preferredSymbolFallbackFamilies,
    dedupeFontFamilies([...directSymbolFallbacks, ...matchedSymbolFallbacks])
  ];
}

function collectInventoryIssues(
  settings: TerminalTypographySettings,
  fontFamilies: string[]
): TerminalTypographyIssue[] {
  const installedFamilies = new Set(
    fontFamilies.map((fontFamily) => normalizeFontFamilyName(fontFamily))
  );
  const preferredTextFamilies = parseFontFamilyList(
    settings.preferredTextFontFamily
  );
  if (
    preferredTextFamilies.length > 0 &&
    !preferredTextFamilies.some((fontFamily) =>
      hasFontFamily(installedFamilies, fontFamily)
    )
  ) {
    return [
      {
        code: "text_font_missing",
        severity: "warning"
      }
    ];
  }
  return [];
}

function collectCandidateFamilies(
  textFontFamily: string,
  candidateGroups: string[][],
  candidateIndex: number
): string[] {
  const textFamilies = new Set(
    parseFontFamilyList(textFontFamily).map((fontFamily) =>
      normalizeFontFamilyName(fontFamily)
    )
  );
  const symbolFallbackFamilies: string[] = [];
  const seen = new Set<string>();
  for (const family of candidateGroups
    .slice(0, candidateIndex + 1)
    .flatMap((group) => group)) {
    const normalizedFamily = normalizeFontFamilyName(family);
    if (
      !normalizedFamily ||
      seen.has(normalizedFamily) ||
      textFamilies.has(normalizedFamily)
    ) {
      continue;
    }
    seen.add(normalizedFamily);
    symbolFallbackFamilies.push(family);
  }
  return symbolFallbackFamilies;
}

function defaultCandidateIndex(
  settings: TerminalTypographySettings,
  fontFamilies: string[]
): number {
  const candidateGroups = buildCandidateGroups(settings, fontFamilies);
  return candidateGroups[1]?.length ? 1 : 0;
}

function clampCandidateIndex(
  candidateGroups: string[][],
  candidateIndex: number
): number {
  const maxCandidateIndex = candidateGroups.reduce((maxIndex, group, index) => {
    if (index === 0 || group.length > 0) {
      return index;
    }
    return maxIndex;
  }, 0);
  return Math.max(0, Math.min(candidateIndex, maxCandidateIndex));
}

function hasNextCandidate(
  candidateGroups: string[][],
  candidateIndex: number
): boolean {
  return (
    advanceCandidateIndex(candidateGroups, candidateIndex) > candidateIndex
  );
}

function advanceCandidateIndex(
  candidateGroups: string[][],
  candidateIndex: number
): number {
  for (
    let nextCandidateIndex = candidateIndex + 1;
    nextCandidateIndex < candidateGroups.length;
    nextCandidateIndex += 1
  ) {
    const currentFamilies = collectCandidateFamilies(
      "",
      candidateGroups,
      candidateIndex
    );
    const nextFamilies = collectCandidateFamilies(
      "",
      candidateGroups,
      nextCandidateIndex
    );
    if (nextFamilies.join("\u0000") !== currentFamilies.join("\u0000")) {
      return nextCandidateIndex;
    }
  }
  return candidateIndex;
}

function isCompatibleInstalledSymbolFont(fontFamily: string): boolean {
  return /Nerd Font|Powerline/i.test(fontFamily);
}

function hasFontFamily(
  installedFamilies: Set<string>,
  fontFamily: string
): boolean {
  const normalizedFamily = normalizeFontFamilyName(fontFamily);
  return (
    GENERIC_FONT_FAMILIES.has(normalizedFamily) ||
    installedFamilies.has(normalizedFamily)
  );
}

function parseFontFamilyList(fontFamily: string): string[] {
  return fontFamily
    .split(",")
    .map((family) => stripFontFamilyQuotes(family.trim()))
    .filter(Boolean);
}

function stripFontFamilyQuotes(fontFamily: string): string {
  if (
    (fontFamily.startsWith('"') && fontFamily.endsWith('"')) ||
    (fontFamily.startsWith("'") && fontFamily.endsWith("'"))
  ) {
    return fontFamily.slice(1, -1).trim();
  }
  return fontFamily.trim();
}

function normalizeFontFamilyName(fontFamily: string): string {
  return stripFontFamilyQuotes(fontFamily).toLowerCase();
}

function dedupeFontFamilies(fontFamilies: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const fontFamily of fontFamilies) {
    const normalizedFontFamily = normalizeFontFamilyName(fontFamily);
    if (!normalizedFontFamily || seen.has(normalizedFontFamily)) {
      continue;
    }
    seen.add(normalizedFontFamily);
    deduped.push(fontFamily.trim());
  }
  return deduped;
}

function mergeIssues(
  left: TerminalTypographyIssue[],
  right: TerminalTypographyIssue[]
): TerminalTypographyIssue[] {
  const merged = new Map<string, TerminalTypographyIssue>();
  for (const issue of [...left, ...right]) {
    merged.set(issue.code, issue);
  }
  return [...merged.values()];
}

function isRetryableSymbolIssue(issue: TerminalTypographyIssue): boolean {
  return (
    issue.code === "nerd_glyph_missing" ||
    issue.code === "powerline_glyph_missing" ||
    issue.code === "powerline_width_mismatch" ||
    issue.code === "symbol_font_missing"
  );
}

function hashFontStack(fontFamily: string): string {
  return createHash("sha1").update(fontFamily).digest("hex").slice(0, 12);
}

function parseFakeFontFamilies(rawValue: string | undefined): string[] {
  if (!rawValue?.trim()) {
    return [];
  }
  if (rawValue.trim().startsWith("[")) {
    try {
      return JSON.parse(rawValue) as string[];
    } catch {
      return [];
    }
  }
  return rawValue
    .split(",")
    .map((fontFamily) => fontFamily.trim())
    .filter(Boolean);
}
