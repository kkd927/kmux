import { useEffect, useMemo, useState } from "react";

import type {
  ExternalAgentSessionVm,
  ExternalAgentSessionsSnapshot
} from "@kmux/proto";

import { useExternalAgentSessions } from "../hooks/useExternalAgentSessions";
import styles from "../styles/App.module.css";

const SESSION_PAGE_SIZE = 30;
const SESSION_VENDOR_FILTERS = [
  { key: "codex", label: "Codex" },
  { key: "gemini", label: "Gemini" },
  { key: "claude", label: "Claude" }
] as const;

type SessionVendorFilter = (typeof SESSION_VENDOR_FILTERS)[number]["key"];
type SessionFilter = "all" | SessionVendorFilter;

interface ExternalSessionsPanelProps {
  snapshot: ExternalAgentSessionsSnapshot;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onResume: (key: string) => void;
}

export function ExternalSessionsPanelContainer(): JSX.Element {
  const { snapshot, loading, error, refresh } = useExternalAgentSessions();
  const [resumeError, setResumeError] = useState<string | null>(null);

  return (
    <ExternalSessionsPanel
      snapshot={snapshot}
      loading={loading}
      error={resumeError ?? error}
      onRefresh={() => {
        setResumeError(null);
        void refresh();
      }}
      onResume={(key) => {
        setResumeError(null);
        void window.kmux.resumeExternalAgentSession(key).catch((caught) => {
          setResumeError(
            caught instanceof Error ? caught.message : "Could not resume session"
          );
        });
      }}
    />
  );
}

export function ExternalSessionsPanel(
  props: ExternalSessionsPanelProps
): JSX.Element {
  const [visibleCount, setVisibleCount] = useState(SESSION_PAGE_SIZE);
  const [activeFilter, setActiveFilter] = useState<SessionFilter>("all");
  const sessions = props.snapshot.sessions;
  const availableVendorFilters = useMemo(() => {
    const vendors = new Set(sessions.map((session) => session.vendor));
    return SESSION_VENDOR_FILTERS.filter((filter) => vendors.has(filter.key));
  }, [sessions]);
  const visibleFilters = useMemo(
    () =>
      availableVendorFilters.length > 1
        ? ([{ key: "all", label: "ALL" }, ...availableVendorFilters] as const)
        : [],
    [availableVendorFilters]
  );
  const effectiveFilter =
    activeFilter === "all" ||
    availableVendorFilters.some((filter) => filter.key === activeFilter)
      ? activeFilter
      : "all";
  const filteredSessions = useMemo(
    () =>
      effectiveFilter === "all"
        ? sessions
        : sessions.filter((session) => session.vendor === effectiveFilter),
    [effectiveFilter, sessions]
  );
  const visibleSessions = useMemo(
    () => filteredSessions.slice(0, visibleCount),
    [filteredSessions, visibleCount]
  );
  const remainingCount = Math.max(
    0,
    filteredSessions.length - visibleSessions.length
  );

  useEffect(() => {
    setVisibleCount(SESSION_PAGE_SIZE);
  }, [props.snapshot.updatedAt]);

  useEffect(() => {
    if (effectiveFilter !== activeFilter) {
      setActiveFilter(effectiveFilter);
    }
  }, [activeFilter, effectiveFilter]);

  const activeFilterLabel = labelForFilter(effectiveFilter);
  const hasAnySessions = sessions.length > 0;
  const description = describeSessionCount(
    effectiveFilter,
    filteredSessions.length,
    sessions.length
  );

  return (
    <div
      className={styles.externalSessionsPanel}
      data-testid="external-sessions-panel"
    >
      <div className={styles.externalSessionsHeader}>
        <div className={styles.externalSessionsHeaderCopy}>
          <h3 className={styles.externalSessionsTitle}>Sessions</h3>
          <p className={styles.externalSessionsDescription}>{description}</p>
        </div>
        <div className={styles.externalSessionsActions}>
          {visibleFilters.length > 0 ? (
            <div
              className={styles.externalSessionsFilterGroup}
              aria-label="Filter sessions by agent"
            >
              {visibleFilters.map((filter) => (
                <button
                  key={filter.key}
                  type="button"
                  className={styles.externalSessionsFilterButton}
                  data-active={effectiveFilter === filter.key ? "true" : "false"}
                  aria-pressed={effectiveFilter === filter.key}
                  onClick={() => {
                    setVisibleCount(SESSION_PAGE_SIZE);
                    setActiveFilter(filter.key);
                  }}
                >
                  {filter.label}
                </button>
              ))}
            </div>
          ) : null}
          <button
            type="button"
            className={styles.externalSessionsRefreshButton}
            onClick={props.onRefresh}
            disabled={props.loading}
            aria-label="Refresh sessions"
            title="Refresh sessions"
          >
            <RefreshIcon />
          </button>
        </div>
      </div>

      {props.error ? (
        <div className={styles.externalSessionsNotice}>{props.error}</div>
      ) : null}

      {props.loading && sessions.length === 0 ? (
        <div className={styles.externalSessionsEmpty}>Loading sessions...</div>
      ) : null}

      {!props.loading && !hasAnySessions ? (
        <div className={styles.externalSessionsEmpty}>
          No local agent sessions found.
        </div>
      ) : null}

      {!props.loading && hasAnySessions && filteredSessions.length === 0 ? (
        <div className={styles.externalSessionsEmpty}>
          No {activeFilterLabel} sessions found.
        </div>
      ) : null}

      {filteredSessions.length > 0 ? (
        <div className={styles.externalSessionsTableWrap}>
          <table className={styles.externalSessionsTable}>
            <thead className={styles.externalSessionsTableHead}>
              <tr>
                <th scope="col">Vendor</th>
                <th scope="col">Workspace</th>
                <th scope="col">Title</th>
                <th scope="col">Time</th>
              </tr>
            </thead>
            <tbody className={styles.externalSessionsTableBody}>
              {visibleSessions.map((session) => (
                <ExternalSessionRow
                  key={session.key}
                  session={session}
                  onResume={props.onResume}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {remainingCount > 0 ? (
        <button
          type="button"
          className={styles.externalSessionsMoreButton}
          onClick={() =>
            setVisibleCount((current) => current + SESSION_PAGE_SIZE)
          }
        >
          Load more ({remainingCount})
        </button>
      ) : null}
    </div>
  );
}

function ExternalSessionRow(props: {
  session: ExternalAgentSessionVm;
  onResume: (key: string) => void;
}): JSX.Element {
  const workspaceName = props.session.cwd ? basename(props.session.cwd) : "—";
  const canResume = props.session.canResume;
  const resume = () => {
    if (canResume) {
      props.onResume(props.session.key);
    }
  };

  return (
    <tr
      className={styles.externalSessionRow}
      data-testid="external-session-row"
      data-vendor={props.session.vendor}
      data-disabled={canResume ? "false" : "true"}
      tabIndex={canResume ? 0 : -1}
      role="button"
      aria-disabled={!canResume}
      title={props.session.resumeCommandPreview}
      aria-label={`Resume ${props.session.vendorLabel} session ${props.session.title}`}
      onClick={resume}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          resume();
        }
      }}
    >
      <td className={styles.externalSessionCell}>
        <span className={styles.externalSessionVendor}>
          {props.session.vendorLabel}
        </span>
      </td>
      <td className={styles.externalSessionCell}>
        <span
          className={styles.externalSessionProject}
          title={props.session.cwd ?? undefined}
        >
          {workspaceName}
        </span>
      </td>
      <td className={styles.externalSessionTitleCell}>
        <span
          className={styles.externalSessionTitle}
          data-testid="external-session-title"
          title={props.session.title}
        >
          {props.session.title}
        </span>
      </td>
      <td
        className={`${styles.externalSessionCell} ${styles.externalSessionTimeCell}`}
      >
        <span className={styles.externalSessionTime}>
          {props.session.relativeTimeLabel}
        </span>
      </td>
    </tr>
  );
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function describeSessionCount(
  activeFilter: SessionFilter,
  filteredCount: number,
  totalCount: number
): string {
  const visibleCount = activeFilter === "all" ? totalCount : filteredCount;
  return `(${visibleCount})`;
}

function labelForFilter(filter: SessionFilter): string {
  switch (filter) {
    case "all":
      return "local agent";
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "gemini":
      return "Gemini";
  }
}

function RefreshIcon(): JSX.Element {
  return (
    <svg
      className={styles.externalSessionsRefreshIcon}
      width="14"
      height="14"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M16.25 7.083A6.25 6.25 0 1 0 17.5 10"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M16.25 3.75v3.333h-3.333"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
