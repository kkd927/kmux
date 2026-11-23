import { useCallback, useEffect, useMemo, useState } from "react";

import type { AgentDescriptorDto, KmuxSettings } from "@kmux/proto";

import styles from "../styles/App.module.css";
import { Codicon } from "./Codicon";

type SkillCoverage = {
  agentId: string;
  support: "supported" | "unsupported";
  state:
    | "not-installed"
    | "installed"
    | "update-available"
    | "needs-attention"
    | "unsupported";
  path?: string;
  reason?: string;
};

type PendingAction = {
  action: "install" | "update";
  agentIds: string[];
};

export function OrchestrationSettings(props: {
  workerPolicy?: KmuxSettings["orchestrationWorkerPolicy"];
  onWorkerPolicyChange?: (
    policy: NonNullable<KmuxSettings["orchestrationWorkerPolicy"]>
  ) => void;
}): JSX.Element {
  const [agents, setAgents] = useState<AgentDescriptorDto[]>([]);
  const [coverage, setCoverage] = useState<SkillCoverage[]>([]);
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const nextAgents = await window.kmux.getAgentCatalog();
      const nextCoverage =
        nextAgents.length === 0
          ? []
          : ((await window.kmux.orchestrationSkill({
              method: "orchestration.skill.status",
              params: { agentIds: nextAgents.map((agent) => agent.id) }
            })) as SkillCoverage[]);
      setAgents(nextAgents);
      setCoverage(nextCoverage);
      setSelectedAgentIds((current) =>
        current.filter((agentId) =>
          nextCoverage.some(
            (item) =>
              item.agentId === agentId &&
              (item.state === "not-installed" ||
                item.state === "update-available")
          )
        )
      );
      setPendingAction(null);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const coverageByAgent = useMemo(
    () => new Map(coverage.map((item) => [item.agentId, item])),
    [coverage]
  );
  const aggregateState = aggregateSkillState(coverage);
  const installable = selectedForState(
    coverage,
    selectedAgentIds,
    "not-installed"
  );
  const updatable = selectedForState(
    coverage,
    selectedAgentIds,
    "update-available"
  );

  function prepareAction(action: PendingAction["action"]): void {
    const agentIds = action === "install" ? installable : updatable;
    if (agentIds.length > 0) setPendingAction({ action, agentIds });
  }

  async function confirmAction(): Promise<void> {
    if (!pendingAction) return;
    setBusy(true);
    try {
      await window.kmux.orchestrationSkill({
        method: "orchestration.skill.install",
        params: { agentIds: pendingAction.agentIds, confirm: true }
      });
      setSelectedAgentIds([]);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.settingsCategory}>
      <div className={styles.settingsCategoryHeader}>
        <h3>Orchestration</h3>
        <p>Manage Worker terminals and Agent guidance.</p>
      </div>

      <section className={styles.settingsSection}>
        <div className={styles.settingsSectionHeader}>Worker terminals</div>
        {(["succeeded", "failed"] as const).map((outcome) => (
          <div className={styles.settingsRow} key={outcome}>
            <label htmlFor={`worker-terminal-${outcome}`}>
              {outcome === "succeeded"
                ? "After successful task"
                : "After failed task"}
            </label>
            <select
              id={`worker-terminal-${outcome}`}
              value={props.workerPolicy?.[outcome] ?? "retain"}
              onChange={(event) =>
                props.onWorkerPolicyChange?.({
                  succeeded: props.workerPolicy?.succeeded ?? "retain",
                  failed: props.workerPolicy?.failed ?? "retain",
                  [outcome]:
                    event.target.value === "release" ? "release" : "retain"
                })
              }
            >
              <option value="retain">Keep open</option>
              <option value="release">Close after result review</option>
            </select>
          </div>
        ))}
        <div className={styles.settingsInfo}>
          Applies to new Runs only. Terminals stay open until the Coordinator
          reviews the result. Closing preserves terminal history. Active Workers
          and terminals taken over by you are never automatically closed.
        </div>
      </section>

      <section className={styles.orchestrationSkillOverview}>
        <div>
          <span className={styles.orchestrationEyebrow}>AGENT SKILL</span>
          <strong>kmux-orchestration</strong>
          <p>
            A compact discovery stub that loads the guide matching the running
            kmux CLI.
          </p>
        </div>
        <span
          className={styles.orchestrationStatusPill}
          data-state={aggregateState}
        >
          {aggregateStateLabel(aggregateState)}
        </span>
      </section>

      <div className={styles.settingsInfo}>
        Installation is always explicit. Opening, editing, publishing, or
        running a workflow never writes to an Agent skill directory.
      </div>

      <section className={styles.settingsSection}>
        <div className={styles.settingsSectionHeader}>
          <span>Agent destinations</span>
          <button
            type="button"
            className={styles.orchestrationRefreshButton}
            disabled={busy || loading}
            onClick={() => void refresh()}
          >
            <Codicon name="refresh" /> {loading ? "Checking…" : "Re-check"}
          </button>
        </div>

        {error ? (
          <div className={styles.orchestrationError} role="alert">
            {error}
          </div>
        ) : null}

        <div className={styles.orchestrationAgentList}>
          {agents.map((agent) => {
            const item = coverageByAgent.get(agent.id);
            const actionable =
              item?.state === "not-installed" ||
              item?.state === "update-available";
            const selected = selectedAgentIds.includes(agent.id);
            return (
              <label
                key={agent.id}
                className={styles.orchestrationAgentRow}
                data-supported={item?.support === "supported"}
              >
                <input
                  type="checkbox"
                  disabled={busy || !actionable || pendingAction !== null}
                  checked={selected}
                  onChange={(event) =>
                    setSelectedAgentIds((current) =>
                      event.target.checked
                        ? [...current, agent.id]
                        : current.filter((agentId) => agentId !== agent.id)
                    )
                  }
                />
                <span className={styles.orchestrationAgentIdentity}>
                  <span className={styles.orchestrationAgentMark}>
                    {agent.presentation?.shortLabel ??
                      agent.displayName.slice(0, 2).toUpperCase()}
                  </span>
                  <span>
                    <strong>{agent.displayName}</strong>
                    <small>{agent.id}</small>
                  </span>
                </span>
                <span className={styles.orchestrationAgentDestination}>
                  <strong>{skillStateLabel(item)}</strong>
                  <small>
                    {item?.path ??
                      item?.reason ??
                      "No skill placement capability declared"}
                  </small>
                </span>
                <span className={styles.orchestrationScopeBadge}>
                  {agent.skillPlacement?.scopes.join(" · ") ?? "unsupported"}
                </span>
              </label>
            );
          })}
          {!loading && agents.length === 0 ? (
            <div className={styles.orchestrationEmptyState}>
              No registered coding Agents are available.
            </div>
          ) : null}
        </div>

        {pendingAction ? (
          <div className={styles.orchestrationConfirmation}>
            <div>
              <strong>
                Confirm{" "}
                {pendingAction.action === "install" ? "installation" : "update"}
              </strong>
              <p>Only these reviewed global destinations will be written:</p>
              <ul>
                {pendingAction.agentIds.map((agentId) => {
                  const item = coverageByAgent.get(agentId);
                  return (
                    <li key={agentId}>
                      <strong>{agentId}</strong>
                      <code>{item?.path}</code>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className={styles.orchestrationActions}>
              <button
                type="button"
                disabled={busy}
                onClick={() => setPendingAction(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                data-primary="true"
                disabled={busy}
                onClick={() => void confirmAction()}
              >
                {busy ? "Working…" : `Confirm ${pendingAction.action}`}
              </button>
            </div>
          </div>
        ) : (
          <div className={styles.orchestrationActions}>
            <button
              type="button"
              disabled={busy || installable.length === 0}
              onClick={() => prepareAction("install")}
            >
              Install selected
            </button>
            <button
              type="button"
              disabled={busy || updatable.length === 0}
              onClick={() => prepareAction("update")}
            >
              Update selected
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function selectedForState(
  coverage: readonly SkillCoverage[],
  selectedAgentIds: readonly string[],
  state: SkillCoverage["state"]
): string[] {
  return coverage
    .filter(
      (item) => selectedAgentIds.includes(item.agentId) && item.state === state
    )
    .map((item) => item.agentId);
}

function aggregateSkillState(
  coverage: readonly SkillCoverage[]
): "not-installed" | "partial" | "installed" | "update" | "attention" {
  const supported = coverage.filter((item) => item.support === "supported");
  if (supported.some((item) => item.state === "needs-attention")) {
    return "attention";
  }
  if (supported.some((item) => item.state === "update-available")) {
    return "update";
  }
  const installed = supported.filter(
    (item) => item.state === "installed"
  ).length;
  if (supported.length > 0 && installed === supported.length)
    return "installed";
  if (installed > 0) return "partial";
  return "not-installed";
}

function aggregateStateLabel(
  state: ReturnType<typeof aggregateSkillState>
): string {
  if (state === "installed") return "Installed";
  if (state === "partial") return "Partially installed";
  if (state === "update") return "Update available";
  if (state === "attention") return "Needs attention";
  return "Not installed";
}

function skillStateLabel(item: SkillCoverage | undefined): string {
  if (!item) return "Checking";
  if (item.state === "not-installed") return "Not installed";
  if (item.state === "installed") return "Installed";
  if (item.state === "update-available") return "Update available";
  if (item.state === "needs-attention") return "Needs attention";
  return "Unsupported";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
