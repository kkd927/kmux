import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from "react";

import type { SubscriptionUsageRowVm, UsageViewSnapshot } from "@kmux/proto";

import { RightSidebarHost } from "./RightSidebarHost";
import { useUsageSnapshot } from "../hooks/useUsageView";
import styles from "../styles/App.module.css";

const HEATMAP_ROWS = 7;
const HEATMAP_CELL_SIZE_PX = 10;
const HEATMAP_CELL_GAP_PX = 3;
const HEATMAP_BOARD_HORIZONTAL_PADDING_PX = 48;
const HEATMAP_MIN_COLUMNS = 20;
const HEATMAP_DEFAULT_COLUMNS = 25;
const HEATMAP_MAX_COLUMNS = 30;
const HEATMAP_MIN_MONTH_LABEL_GAP_COLUMNS = 2;
type HeatmapCell = {
  dayKey: string | null;
  totalCostUsd: number;
  totalTokens: number;
  activeSessionCount: number;
  costSource: string;
  intensity: number;
  tooltipLabel: string;
  tooltipDetails: string;
  isPlaceholder: boolean;
};

type HeatmapTooltipState = {
  label: string;
  details: string;
  left: number;
  top: number;
};

type SummaryCardDefinition = {
  key: string;
  value: string;
  label: string;
};

type LinearBreakdownRow = {
  key: string;
  label: string;
  title?: string;
  tokens: number;
  costUsd: number;
  hasUnknownCost?: boolean;
  barValue: number;
  rowTestId?: string;
  tokenTestId?: string;
  costTestId?: string;
};

interface UsageDashboardProps {
  onJumpToSurface: (workspaceId: string, surfaceId: string) => void;
}

export function UsageDashboard(_props: UsageDashboardProps): JSX.Element {
  const snapshot = useUsageSnapshot();
  const models = snapshot.models ?? [];
  const dailyActivity = snapshot.dailyActivity ?? [];
  const pricingCoverage = snapshot.pricingCoverage;
  const tokenBreakdown = snapshot.todayTokenBreakdown ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    thinkingTokens: 0,
    totalTokens: 0
  };
  const tokenCostBreakdown = snapshot.todayTokenCostBreakdown ?? {
    inputCostUsd: 0,
    outputCostUsd: 0,
    cacheReadCostUsd: 0,
    cacheWriteCostUsd: 0,
    thinkingCostUsd: 0,
    hasUnknownInputCost: false,
    hasUnknownOutputCost: false,
    hasUnknownCacheReadCost: false,
    hasUnknownCacheWriteCost: false,
    hasUnknownThinkingCost: false
  };
  const summaryCards = useMemo(
    () => buildSummaryCards(snapshot),
    [snapshot]
  );

  return (
    <RightSidebarHost
      title="Usage"
      subtitle={buildSubtitle(snapshot.updatedAt, pricingCoverage)}
      badge={snapshot.dayKey}
      testId="usage-right-panel"
    >
      <div className={styles.usageDashboard} data-testid="usage-dashboard">
        <section className={styles.usageMetricGrid}>
          {summaryCards.map(({ key, ...card }) => (
            <UsageMetricCard key={key} cardKey={key} {...card} />
          ))}
        </section>

        {snapshot.subscriptionUsage.length > 0 ? (
          <section
            className={styles.usageCard}
            data-testid="subscription-windows-card"
          >
            <SubscriptionWindowsCard
              subscriptionUsage={snapshot.subscriptionUsage}
            />
          </section>
        ) : null}

        <UsageHeatmap
          todayDayKey={snapshot.dayKey}
          dailyActivity={dailyActivity}
        />

        <div className={styles.usageCardGrid}>
          <section className={styles.usageCard}>
            <CardHeader
              title="Top Models"
              description="Spend-ranked model mix for the current day"
            />
            {models.length === 0 ? (
              <EmptyState text="No model usage captured yet." />
            ) : (
              <TopModelsCard models={models.slice(0, 4)} />
            )}
          </section>
        </div>

        <section className={styles.usageCard}>
          <CardHeader
            title="Token Mix"
            description="Today's token distribution across categories"
          />
          <SalesCategoryCard
            tokenBreakdown={tokenBreakdown}
            tokenCostBreakdown={tokenCostBreakdown}
          />
        </section>

        <section className={styles.usageCard}>
          <CardHeader
            title="Project Hotspots"
            description="Current-day AI usage by tracked projects"
          />
          {(snapshot.directoryHotspots?.length ?? 0) === 0 ? (
            <EmptyState text="No project usage is attributed yet." />
          ) : (
            <DirectoryHotspotsCard
              directories={snapshot.directoryHotspots ?? []}
            />
          )}
        </section>

      </div>
    </RightSidebarHost>
  );
}

function UsageMetricCard(
  props: Omit<SummaryCardDefinition, "key"> & { cardKey: string }
): JSX.Element {
  return (
    <div
      className={styles.usageMetricCard}
      data-testid={`usage-summary-card-${props.cardKey}`}
    >
      <div className={styles.usageMetricBody}>
        <div className={styles.usageMetricValue}>{props.value}</div>
        <div className={styles.usageMetricLabel}>{props.label}</div>
      </div>
    </div>
  );
}

function CardHeader(props: {
  title: string;
  description: string;
  actions?: JSX.Element;
}): JSX.Element {
  return (
    <div className={styles.usageCardHeader}>
      <div className={styles.usageCardHeaderCopy}>
        <h3 className={styles.usageCardTitle}>{props.title}</h3>
        <p className={styles.usageCardDescription}>{props.description}</p>
      </div>
      {props.actions ? (
        <div className={styles.usageCardHeaderActions}>{props.actions}</div>
      ) : null}
    </div>
  );
}

function SubscriptionWindowsCard(props: {
  subscriptionUsage: UsageViewSnapshot["subscriptionUsage"];
}): JSX.Element {
  return (
    <div className={styles.subscriptionWindowsPanel}>
      {props.subscriptionUsage.map((providerUsage) => (
        <div
          key={`${providerUsage.provider}-${providerUsage.planLabel}`}
          className={styles.subscriptionProviderSection}
          data-testid={`subscription-provider-${providerUsage.provider}`}
        >
          <div className={styles.subscriptionProviderHeader}>
            <div className={styles.subscriptionProviderTitle}>
              {`${providerUsage.providerLabel} ${providerUsage.planLabel}`.trim()}
            </div>
          </div>
          <div className={styles.subscriptionProviderRows}>
            {providerUsage.rows.map((row) => (
              <div
                key={`${providerUsage.provider}-${row.key}`}
                className={styles.subscriptionUsageRow}
                data-testid={`subscription-row-${providerUsage.provider}-${row.key}`}
              >
                <div className={styles.subscriptionUsageCopy}>
                  <div className={styles.subscriptionUsageLabel}>{row.label}</div>
                  <div className={styles.subscriptionUsageMeta}>
                    {formatSubscriptionRowMeta(row)}
                  </div>
                </div>
                <div className={styles.subscriptionUsageMeter}>
                  <div className={styles.subscriptionUsageBar}>
                    <InlineBar
                      value={row.usedPercent}
                      total={100}
                      tone={colorForVendor(providerUsage.provider)}
                    />
                  </div>
                  <div className={styles.subscriptionUsagePercent}>
                    {formatSubscriptionUsedPercent(row.usedPercent)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function UsageHeatmap(props: {
  todayDayKey: string;
  dailyActivity: Array<{
    dayKey: string;
    totalCostUsd: number;
    totalTokens: number;
    activeSessionCount: number;
    costSource: string;
  }>;
}): JSX.Element {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [heatmapColumns, setHeatmapColumns] = useState(HEATMAP_DEFAULT_COLUMNS);
  const [tooltip, setTooltip] = useState<HeatmapTooltipState | null>(null);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) {
      return undefined;
    }

    const updateColumns = () => {
      const nextColumns = resolveHeatmapColumnCount(shell.clientWidth);
      setHeatmapColumns((current) =>
        current === nextColumns ? current : nextColumns
      );
    };

    updateColumns();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateColumns);
      return () => {
        window.removeEventListener("resize", updateColumns);
      };
    }

    const observer = new ResizeObserver(() => {
      updateColumns();
    });
    observer.observe(shell);
    return () => {
      observer.disconnect();
    };
  }, []);

  const heatmap = useMemo(
    () => buildHeatmap(props.todayDayKey, props.dailyActivity, heatmapColumns),
    [props.todayDayKey, props.dailyActivity, heatmapColumns]
  );
  const gridStyle = {
    "--usage-heatmap-columns": `${heatmap.columns.length}`
  } as CSSProperties;
  const updateTooltip = (
    clientX: number,
    clientY: number,
    label: string,
    details: string
  ) => {
    const tooltipWidth = 340;
    const horizontalPadding = 16;
    const verticalOffset = 12;
    const nextLeft = Math.min(
      Math.max(clientX, horizontalPadding + tooltipWidth / 2),
      window.innerWidth - horizontalPadding - tooltipWidth / 2
    );

    setTooltip({
      label,
      details,
      left: nextLeft,
      top: Math.max(clientY - verticalOffset, horizontalPadding)
    });
  };

  return (
    <div
      ref={shellRef}
      className={styles.usageHeatmapShell}
      data-testid="usage-heatmap"
    >
      <div className={styles.usageHeatmapBoard} style={gridStyle}>
        {tooltip ? (
          <div
            className={styles.usageHeatmapTooltip}
            data-testid="usage-heatmap-tooltip"
            role="tooltip"
            style={{
              left: `${tooltip.left}px`,
              top: `${tooltip.top}px`
            }}
          >
            <div className={styles.usageHeatmapTooltipLabel}>
              {tooltip.label}
            </div>
            <div className={styles.usageHeatmapTooltipDetails}>
              {tooltip.details}
            </div>
          </div>
        ) : null}
        <div className={styles.usageHeatmapLegendRow}>
          <div className={styles.usageHeatmapBoardLabel}>
            Usage Heatmap
          </div>
          <div className={styles.usageHeatmapLegend}>
            <span>Less</span>
            <div className={styles.usageHeatmapLegendScale}>
              {Array.from({ length: 5 }, (_, index) => (
                <span
                  key={`legend-${index}`}
                  className={styles.usageHeatmapLegendCell}
                  data-intensity={index}
                />
              ))}
            </div>
            <span>More</span>
          </div>
        </div>

        <div className={styles.usageHeatmapMonths}>
          {heatmap.monthLabels.map((label, index) => (
            <span key={`${index}-${label}`} className={styles.usageHeatmapMonth}>
              {label}
            </span>
          ))}
        </div>

        <div className={styles.usageHeatmapColumns}>
          {heatmap.columns.map((column, columnIndex) => (
            <div
              key={`column-${columnIndex}`}
              className={styles.usageHeatmapColumn}
            >
              {column.map((cell, cellIndex) => (
                <div
                  key={`${columnIndex}-${cellIndex}-${cell.dayKey ?? "placeholder"}`}
                  className={styles.usageHeatmapCell}
                  data-testid="usage-heatmap-cell"
                  data-day-key={cell.dayKey ?? ""}
                  data-total-tokens={`${cell.totalTokens}`}
                  data-cost-source={cell.costSource}
                  data-placeholder={cell.isPlaceholder ? "true" : "false"}
                  data-intensity={cell.intensity}
                  aria-label={`${cell.tooltipLabel} · ${cell.tooltipDetails}`}
                  onMouseEnter={(event) => {
                    updateTooltip(
                      event.clientX,
                      event.clientY,
                      cell.tooltipLabel,
                      cell.tooltipDetails
                    );
                  }}
                  onMouseMove={(event) => {
                    updateTooltip(
                      event.clientX,
                      event.clientY,
                      cell.tooltipLabel,
                      cell.tooltipDetails
                    );
                  }}
                  onMouseLeave={() => {
                    setTooltip(null);
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function formatSubscriptionUsedPercent(usedPercent: number): string {
  if (usedPercent > 0 && usedPercent < 1) {
    return "< 1%";
  }
  return `${Math.round(usedPercent)}%`;
}

function formatSubscriptionRowMeta(row: SubscriptionUsageRowVm): string {
  if (
    row.windowKind === "spend" &&
    typeof row.usedAmountUsd === "number" &&
    typeof row.limitAmountUsd === "number"
  ) {
    const currency = row.currency ?? "USD";
    const used = formatSubscriptionAmount(row.usedAmountUsd, currency);
    const limit = formatSubscriptionAmount(row.limitAmountUsd, currency);
    return `${used} / ${limit} · ${row.resetLabel}`;
  }
  return row.resetLabel;
}

function formatSubscriptionAmount(amount: number, currency: string): string {
  const hasFraction = Math.round(amount * 100) % 100 !== 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: hasFraction ? 2 : 0,
      maximumFractionDigits: 2
    }).format(amount);
  } catch {
    return hasFraction ? `$${amount.toFixed(2)}` : `$${amount.toFixed(0)}`;
  }
}

function TopModelsCard(props: {
  models: Array<{
    vendor: string;
    modelId: string;
    modelLabel: string;
    todayCostUsd: number;
    totalTokens: number;
  }>;
}): JSX.Element {
  const metric = resolveBreakdownMetric(
    props.models.map((model) => ({
      tokens: model.totalTokens,
      costUsd: model.todayCostUsd
    }))
  );

  return (
    <LinearBreakdownCard
      labelColumn="Model"
      barTestId="top-models-linear-bar"
      headerTestId="usage-model-table-header"
      rows={props.models.map((model) => ({
        key: `${model.vendor}:${model.modelId}`,
        label: model.modelLabel,
        title: model.modelLabel,
        tokens: model.totalTokens,
        costUsd: model.todayCostUsd,
        barValue: metric === "cost" ? model.todayCostUsd : model.totalTokens,
        rowTestId: `usage-model-row-${model.modelId}`,
        tokenTestId: `usage-model-tokens-${model.modelId}`
      }))}
    />
  );
}

function DirectoryHotspotsCard(props: {
  directories: Array<{
    directoryPath: string;
    directoryLabel: string;
    todayCostUsd: number;
    todayTokens: number;
  }>;
}): JSX.Element {
  const metric = resolveBreakdownMetric(
    props.directories.map((directory) => ({
      tokens: directory.todayTokens,
      costUsd: directory.todayCostUsd
    }))
  );

  return (
    <LinearBreakdownCard
      labelColumn="Directory"
      barTestId="directory-hotspots-linear-bar"
      rows={props.directories.map((directory) => ({
        key: directory.directoryPath,
        label: directory.directoryLabel,
        title: directory.directoryPath,
        tokens: directory.todayTokens,
        costUsd: directory.todayCostUsd,
        barValue: metric === "cost" ? directory.todayCostUsd : directory.todayTokens
      }))}
      rowTestId={(row, index) => `directory-hotspot-row-${index}`}
    />
  );
}

function SalesCategoryCard(props: {
  tokenBreakdown: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    thinkingTokens: number;
    totalTokens: number;
  };
  tokenCostBreakdown: {
    inputCostUsd: number;
    outputCostUsd: number;
    cacheReadCostUsd: number;
    cacheWriteCostUsd: number;
    thinkingCostUsd: number;
    hasUnknownInputCost: boolean;
    hasUnknownOutputCost: boolean;
    hasUnknownCacheReadCost: boolean;
    hasUnknownCacheWriteCost: boolean;
    hasUnknownThinkingCost: boolean;
  };
}): JSX.Element {
  const categories = buildSalesCategories(
    props.tokenBreakdown,
    props.tokenCostBreakdown
  );
  const totalTokens = categories.reduce((sum, category) => sum + category.tokens, 0);

  if (totalTokens <= 0) {
    return <EmptyState text="No token category activity yet." />;
  }

  return (
    <LinearBreakdownCard
      labelColumn="Component"
      barTestId="token-mix-linear-bar"
      rows={categories.map((category) => ({
        key: category.key,
        label: category.label,
        tokens: category.tokens,
        costUsd: category.costUsd,
        hasUnknownCost: category.hasUnknownCost,
        barValue: category.tokens,
        rowTestId: `token-mix-row-${category.key}`,
        costTestId: `token-mix-cost-${category.key}`
      }))}
    />
  );
}

function LinearBreakdownCard(props: {
  labelColumn: string;
  rows: LinearBreakdownRow[];
  barTestId: string;
  headerTestId?: string;
  rowTestId?: (row: LinearBreakdownRow, index: number) => string | undefined;
}): JSX.Element {
  const rows = sortBreakdownRows(props.rows);
  const total = rows.reduce((sum, row) => sum + row.barValue, 0);
  const visibleRows = rows.filter((row) => row.barValue > 0);

  return (
    <div className={styles.tokenMixPanel}>
      <div
        className={styles.tokenMixLinearBar}
        data-testid={props.barTestId}
      >
        {visibleRows.map((row, index) => {
          const width = total > 0 ? (row.barValue / total) * 100 : 0;
          return (
            <div
              key={row.key}
              className={styles.tokenMixLinearSegment}
              style={{
                width: `${width}%`,
                backgroundColor: colorForBreakdownSeries(index)
              }}
            />
          );
        })}
      </div>

      <div className={styles.tokenMixTable}>
        <div
          className={styles.tokenMixTableHeader}
          data-testid={props.headerTestId}
        >
          <span>{props.labelColumn}</span>
          <span>Tokens</span>
          <span>Cost</span>
        </div>
        {rows.map((row, index) => (
          <div
            key={row.key}
            className={styles.tokenMixRow}
            data-testid={props.rowTestId?.(row, index) ?? row.rowTestId}
          >
            <span
              className={styles.tokenMixRowSwatch}
              style={{ backgroundColor: colorForBreakdownSeries(index) }}
            />
            <div
              className={styles.tokenMixRowTitle}
              title={row.title ?? row.label}
            >
              {row.label}
            </div>
            <div
              className={styles.tokenMixRowTokens}
              data-testid={row.tokenTestId}
            >
              {formatTokens(row.tokens)}
            </div>
            <div
              className={styles.tokenMixRowCost}
              data-testid={row.costTestId}
            >
              {row.hasUnknownCost ? "—" : formatUsageUsd(row.costUsd)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function InlineBar(props: {
  value: number;
  total: number;
  tone: string;
}): JSX.Element {
  const width = props.total > 0 ? Math.max(4, (props.value / props.total) * 100) : 0;

  return (
    <div className={styles.usageInlineBarTrack}>
      <div
        className={styles.usageInlineBarFill}
        style={{ width: `${width}%`, backgroundColor: props.tone }}
      />
    </div>
  );
}

function EmptyState(props: { text: string }): JSX.Element {
  return <div className={styles.usageEmpty}>{props.text}</div>;
}

function buildSummaryCards(snapshot: UsageViewSnapshot): SummaryCardDefinition[] {
  return [
    {
      key: "spend",
      value: formatUsageUsd(snapshot.totalTodayCostUsd),
      label: "Today Spend"
    },
    {
      key: "tokens",
      value: formatTokens(snapshot.totalTodayTokens),
      label: "Tracked Tokens"
    }
  ];
}

function buildHeatmap(
  todayDayKey: string,
  days: Array<{
    dayKey: string;
    totalCostUsd: number;
    totalTokens: number;
    activeSessionCount: number;
    costSource: string;
  }>,
  heatmapColumns: number
): {
  cells: HeatmapCell[];
  columns: HeatmapCell[][];
  monthLabels: string[];
} {
  const heatmapCellCount = heatmapColumns * HEATMAP_ROWS;
  const mergedDays = new Map<
    string,
    {
      dayKey: string;
      totalCostUsd: number;
      totalTokens: number;
      activeSessionCount: number;
      costSource: string;
    }
  >();

  for (const day of days) {
    const current = mergedDays.get(day.dayKey);
    if (!current) {
      mergedDays.set(day.dayKey, { ...day });
      continue;
    }
    current.totalCostUsd += day.totalCostUsd;
    current.totalTokens += day.totalTokens;
    current.activeSessionCount += day.activeSessionCount;
    current.costSource =
      current.costSource === day.costSource ? current.costSource : "partial";
  }

  const chronologicalDays: HeatmapCell[] = [];
  for (let index = 0; index < heatmapCellCount; index += 1) {
    const offset = heatmapCellCount - index - 1;
    const dayKey = shiftDayKey(todayDayKey, -offset);
    const day =
      mergedDays.get(dayKey) ?? {
        dayKey,
        totalCostUsd: 0,
        totalTokens: 0,
        activeSessionCount: 0,
        costSource: "reported"
      };

    chronologicalDays.push({
      dayKey,
      totalCostUsd: day.totalCostUsd,
      totalTokens: day.totalTokens,
      activeSessionCount: day.activeSessionCount,
      costSource: day.costSource,
      intensity: 0,
      tooltipLabel: "",
      tooltipDetails: "",
      isPlaceholder: false
    });
  }

  const maxTokens = Math.max(
    1,
    ...chronologicalDays.map((day) => day.totalTokens)
  );

  const placeholderCells: HeatmapCell[] = Array.from({
    length: heatmapCellCount - chronologicalDays.length
  }, () => ({
    dayKey: null,
    totalCostUsd: 0,
    totalTokens: 0,
    activeSessionCount: 0,
    costSource: "reported",
    intensity: 0,
    tooltipLabel: todayDayKey,
    tooltipDetails: `${formatUsageUsd(0)} · ${formatTokens(0)}`,
    isPlaceholder: true
  }));
  const cells: HeatmapCell[] = [
    ...placeholderCells,
    ...chronologicalDays.map((day) => ({
      ...day,
      intensity: intensityForValue(day.totalTokens, maxTokens),
      tooltipLabel: day.dayKey ?? "",
      tooltipDetails: `${formatUsageUsd(day.totalCostUsd)} · ${formatTokens(
        day.totalTokens
      )}`
    }))
  ];

  const columns = Array.from({ length: heatmapColumns }, (_, index) =>
    cells.slice(index * HEATMAP_ROWS, index * HEATMAP_ROWS + HEATMAP_ROWS)
  );

  return {
    cells,
    columns,
    monthLabels: buildMonthLabels(columns)
  };
}

function resolveHeatmapColumnCount(shellWidth: number): number {
  if (shellWidth <= 0) {
    return HEATMAP_DEFAULT_COLUMNS;
  }

  const availableWidth = Math.max(
    0,
    shellWidth - HEATMAP_BOARD_HORIZONTAL_PADDING_PX
  );
  const nextColumns = Math.floor(
    (availableWidth + HEATMAP_CELL_GAP_PX) /
      (HEATMAP_CELL_SIZE_PX + HEATMAP_CELL_GAP_PX)
  );

  return Math.max(
    HEATMAP_MIN_COLUMNS,
    Math.min(HEATMAP_MAX_COLUMNS, nextColumns)
  );
}

export function buildMonthLabels(columns: HeatmapCell[][]): string[] {
  let previousColumnLabel: string | null = null;
  let previousVisibleIndex: number | null = null;

  return columns.map((column, columnIndex) => {
    const firstRealCell = column.find(
      (cell) => cell.dayKey !== null && !cell.isPlaceholder
    );
    if (!firstRealCell?.dayKey) {
      return "";
    }
    const normalizedLabel = parseDayKey(firstRealCell.dayKey).toLocaleDateString("en-US", {
      month: "short"
    });
    if (normalizedLabel === previousColumnLabel) {
      return "";
    }

    previousColumnLabel = normalizedLabel;

    if (
      previousVisibleIndex !== null &&
      columnIndex - previousVisibleIndex < HEATMAP_MIN_MONTH_LABEL_GAP_COLUMNS
    ) {
      return "";
    }

    previousVisibleIndex = columnIndex;
    return normalizedLabel;
  });
}

function buildSubtitle(
  updatedAt: string,
  pricingCoverage:
    | {
        hasEstimatedCosts: boolean;
        hasMissingPricing: boolean;
      }
    | undefined
): string {
  const segments = [`Updated ${new Date(updatedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  })}`];
  if (pricingCoverage?.hasEstimatedCosts) {
    segments.push("includes estimated subscription spend");
  }
  return segments.join(" · ");
}

function intensityForValue(value: number, maxValue: number): number {
  if (value <= 0) {
    return 0;
  }
  const ratio = value / maxValue;
  if (ratio >= 0.75) {
    return 4;
  }
  if (ratio >= 0.45) {
    return 3;
  }
  if (ratio >= 0.2) {
    return 2;
  }
  return 1;
}

function shiftDayKey(dayKey: string, deltaDays: number): string {
  const date = parseDayKey(dayKey);
  date.setDate(date.getDate() + deltaDays);
  return toDayKey(date);
}

function parseDayKey(dayKey: string): Date {
  return new Date(`${dayKey}T00:00:00`);
}

function toDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildSalesCategories(tokenBreakdown: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens: number;
}, tokenCostBreakdown: {
  inputCostUsd: number;
  outputCostUsd: number;
  cacheReadCostUsd: number;
  cacheWriteCostUsd: number;
  thinkingCostUsd: number;
  hasUnknownInputCost: boolean;
  hasUnknownOutputCost: boolean;
  hasUnknownCacheReadCost: boolean;
  hasUnknownCacheWriteCost: boolean;
  hasUnknownThinkingCost: boolean;
}): Array<{
  key: string;
  label: string;
  tokens: number;
  costUsd: number;
  hasUnknownCost: boolean;
}> {
  return [
    {
      key: "cache-read",
      label: "Cache Read",
      tokens: tokenBreakdown.cacheReadTokens,
      costUsd: tokenCostBreakdown.cacheReadCostUsd,
      hasUnknownCost: tokenCostBreakdown.hasUnknownCacheReadCost
    },
    {
      key: "cache-create",
      label: "Cache Create",
      tokens: tokenBreakdown.cacheWriteTokens,
      costUsd: tokenCostBreakdown.cacheWriteCostUsd,
      hasUnknownCost: tokenCostBreakdown.hasUnknownCacheWriteCost
    },
    {
      key: "input",
      label: "Input",
      tokens: tokenBreakdown.inputTokens,
      costUsd: tokenCostBreakdown.inputCostUsd,
      hasUnknownCost: tokenCostBreakdown.hasUnknownInputCost
    },
    {
      key: "output",
      label: "Output",
      tokens: tokenBreakdown.outputTokens,
      costUsd: tokenCostBreakdown.outputCostUsd,
      hasUnknownCost: tokenCostBreakdown.hasUnknownOutputCost
    },
    {
      key: "thinking",
      label: "Thinking",
      tokens: tokenBreakdown.thinkingTokens,
      costUsd: tokenCostBreakdown.thinkingCostUsd,
      hasUnknownCost: tokenCostBreakdown.hasUnknownThinkingCost
    }
  ];
}

function colorForVendor(vendor: string): string {
  if (vendor === "claude") {
    return "#f59e0b";
  }
  if (vendor === "codex") {
    return "#465fff";
  }
  if (vendor === "gemini") {
    return "#8b5cf6";
  }
  return "#94a3b8";
}

function resolveBreakdownMetric(
  rows: Array<{ tokens: number; costUsd: number }>
): "tokens" | "cost" {
  return rows.some((row) => row.costUsd > 0) ? "cost" : "tokens";
}

function sortBreakdownRows(rows: LinearBreakdownRow[]): LinearBreakdownRow[] {
  return [...rows].sort((left, right) => {
    const barDelta = right.barValue - left.barValue;
    if (barDelta !== 0) {
      return barDelta;
    }
    const tokenDelta = right.tokens - left.tokens;
    if (tokenDelta !== 0) {
      return tokenDelta;
    }
    const costDelta = right.costUsd - left.costUsd;
    if (costDelta !== 0) {
      return costDelta;
    }
    return left.label.localeCompare(right.label);
  });
}

function colorForBreakdownSeries(index: number): string {
  const palette = [
    colorForVendor("codex"),
    "#34D399",
    colorForVendor("gemini"),
    "#F59E0B",
    "#F87171",
    "#94A3B8"
  ];
  return palette[index % palette.length];
}

function formatUsageUsd(value: number): string {
  if (value >= 1) {
    return `$${value.toFixed(2)}`;
  }
  if (value >= 0.01) {
    return `$${value.toFixed(2)}`;
  }
  if (value > 0) {
    return `$${value.toFixed(4)}`;
  }
  return "$0.00";
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}m`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return `${Math.round(value)}`;
}
