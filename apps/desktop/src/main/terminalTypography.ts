import { createHash } from "node:crypto";

import {
  buildBaseTerminalSymbolFallbackFamilies,
  buildResolvedTerminalFontFamily,
  normalizeTerminalTypographySettings
} from "@kmux/core";
import type {
  ResolvedTerminalTypographyVm,
  TerminalTypographyIssue,
  TerminalTypographyProbeReport,
  TerminalTypographySettings
} from "@kmux/proto";

export interface TerminalTypographyControllerOptions {
  initialSettings: TerminalTypographySettings;
  onDidChange?: () => void;
}

export class TerminalTypographyController {
  private readonly onDidChange?: () => void;

  private settings: TerminalTypographySettings;

  private vm: ResolvedTerminalTypographyVm;

  constructor(options: TerminalTypographyControllerOptions) {
    this.onDidChange = options.onDidChange;
    this.settings = normalizeTerminalTypographySettings(
      options.initialSettings
    );
    this.vm = resolveTerminalTypography(this.settings);
  }

  getViewModel(): ResolvedTerminalTypographyVm {
    return this.vm;
  }

  setSettings(nextSettings: TerminalTypographySettings): void {
    this.settings = normalizeTerminalTypographySettings(nextSettings);
    this.vm = resolveTerminalTypography(this.settings);
    this.onDidChange?.();
  }

  async preview(
    nextSettings: TerminalTypographySettings
  ): Promise<ResolvedTerminalTypographyVm> {
    return resolveTerminalTypography(
      normalizeTerminalTypographySettings(nextSettings)
    );
  }

  reportProbe(report: TerminalTypographyProbeReport): void {
    if (report.stackHash !== this.vm.stackHash) {
      return;
    }

    const issues = mergeIssues(this.vm.issues, report.issues);
    this.vm = {
      ...this.vm,
      status: issues.length > 0 ? "degraded" : "ready",
      issues
    };
    this.onDidChange?.();
  }
}

function resolveTerminalTypography(
  settings: TerminalTypographySettings
): ResolvedTerminalTypographyVm {
  const symbolFallbackFamilies = excludeTextFontFamilies(
    settings.preferredTextFontFamily,
    buildBaseTerminalSymbolFallbackFamilies(
      settings.preferredSymbolFallbackFamilies
    )
  );
  const resolvedFontFamily = buildResolvedTerminalFontFamily(
    settings.preferredTextFontFamily,
    symbolFallbackFamilies
  );

  return {
    stackHash: createHash("sha256").update(resolvedFontFamily).digest("hex"),
    resolvedFontFamily,
    textFontFamily: settings.preferredTextFontFamily,
    symbolFallbackFamilies,
    autoFallbackApplied: symbolFallbackFamilies.length > 0,
    status: "pending",
    issues: []
  };
}

function excludeTextFontFamilies(
  textFontFamily: string,
  symbolFallbackFamilies: string[]
): string[] {
  const textFamilies = new Set(
    parseFontFamilyList(textFontFamily).map(normalizeFontFamilyName)
  );
  const seen = new Set<string>();
  const result: string[] = [];
  for (const fontFamily of symbolFallbackFamilies) {
    const normalized = normalizeFontFamilyName(fontFamily);
    if (!normalized || textFamilies.has(normalized) || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(fontFamily);
  }
  return result;
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

function mergeIssues(
  left: TerminalTypographyIssue[],
  right: TerminalTypographyIssue[]
): TerminalTypographyIssue[] {
  const merged = new Map<string, TerminalTypographyIssue>();
  for (const issue of left) {
    merged.set(issue.code, issue);
  }
  for (const issue of right) {
    merged.set(issue.code, issue);
  }
  return [...merged.values()];
}
