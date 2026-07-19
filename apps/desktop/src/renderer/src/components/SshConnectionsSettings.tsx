import { useEffect, useMemo, useState } from "react";

import type {
  RetainedRemoteSessionsSnapshot,
  SshConnectionsSnapshot,
  SshProfileDraftDto,
  SshProfileVm
} from "@kmux/proto";

import styles from "../styles/App.module.css";

type EditorDraft = {
  id?: string;
  locatorKind: "alias" | "host";
  name: string;
  locator: string;
  user: string;
  port: string;
  identityFile: string;
  defaultRemoteCwd: string;
  shellOverride: string;
  bootstrapShellOverride: string;
  installPathOverride: string;
  authorityPathOverride: string;
  statePathOverride: string;
  runtimePathOverride: string;
  sessionRetentionQuotaMiB: string;
  targetRetentionQuotaMiB: string;
  envJson: string;
  forwardAgent: boolean;
};

const EMPTY_EDITOR: EditorDraft = {
  locatorKind: "alias",
  name: "",
  locator: "",
  user: "",
  port: "",
  identityFile: "",
  defaultRemoteCwd: "",
  shellOverride: "",
  bootstrapShellOverride: "",
  installPathOverride: "",
  authorityPathOverride: "",
  statePathOverride: "",
  runtimePathOverride: "",
  sessionRetentionQuotaMiB: "",
  targetRetentionQuotaMiB: "",
  envJson: "{}",
  forwardAgent: false
};

const TEXT_FIELDS: Array<{
  key: keyof Pick<
    EditorDraft,
    | "user"
    | "identityFile"
    | "defaultRemoteCwd"
    | "shellOverride"
    | "bootstrapShellOverride"
    | "installPathOverride"
    | "authorityPathOverride"
    | "statePathOverride"
    | "runtimePathOverride"
  >;
  label: string;
  placeholder: string;
}> = [
  { key: "user", label: "User", placeholder: "OpenSSH default" },
  {
    key: "identityFile",
    label: "Identity file",
    placeholder: "/Users/me/.ssh/id_ed25519"
  },
  {
    key: "defaultRemoteCwd",
    label: "Default remote cwd",
    placeholder: "/home/me/project"
  },
  {
    key: "shellOverride",
    label: "Default shell override",
    placeholder: "/bin/zsh"
  },
  {
    key: "bootstrapShellOverride",
    label: "Bootstrap shell override",
    placeholder: "Only for unknown login shells"
  },
  {
    key: "installPathOverride",
    label: "Install root override",
    placeholder: "Host-local path"
  },
  {
    key: "authorityPathOverride",
    label: "Authority root override",
    placeholder: "Host-local path"
  },
  {
    key: "statePathOverride",
    label: "State root override",
    placeholder: "Host-local path"
  },
  {
    key: "runtimePathOverride",
    label: "Runtime root override",
    placeholder: "Ephemeral host-local path"
  }
];

export function SshConnectionsSettings(): JSX.Element {
  const [snapshot, setSnapshot] = useState<SshConnectionsSnapshot | null>(null);
  const [retained, setRetained] =
    useState<RetainedRemoteSessionsSnapshot | null>(null);
  const [availableAliases, setAvailableAliases] = useState<string[] | null>(
    null
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorDraft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runtimeResult, setRuntimeResult] = useState<string | null>(null);
  const selected = useMemo(
    () => snapshot?.profiles.find((profile) => profile.id === selectedId) ?? null,
    [selectedId, snapshot]
  );

  useEffect(() => {
    void reload(true);
  }, []);

  async function reload(resolveEffective = false, preferredId?: string) {
    try {
      const [connections, retainedSessions, aliases] = await Promise.all([
        window.kmux.getSshConnections(resolveEffective),
        window.kmux.getRetainedRemoteSessions(),
        window.kmux.listSshConfigAliases()
      ]);
      setSnapshot(connections);
      setRetained(retainedSessions);
      setAvailableAliases(aliases);
      const nextId =
        preferredId ??
        selectedId ??
        connections.profiles[0]?.id ??
        null;
      setSelectedId(
        nextId && connections.profiles.some((profile) => profile.id === nextId)
          ? nextId
          : connections.profiles[0]?.id ?? null
      );
      setError(null);
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  async function run(name: string, action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(name);
    setError(null);
    setRuntimeResult(null);
    try {
      await action();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function saveEditor(): Promise<void> {
    if (!editor) return;
    await run("save", async () => {
      const saved = await window.kmux.saveSshProfile({
        ...(editor.id === undefined ? {} : { id: editor.id }),
        profile: editorToProfile(editor)
      });
      setEditor(null);
      await reload(true, saved.id);
    });
  }

  return (
    <div className={styles.settingsCategory} data-testid="ssh-connections-settings">
      <div className={styles.settingsCategoryHeader}>
        <h3>SSH Connections</h3>
        <p>
          Saved locators use system OpenSSH. Passwords and private-key
          passphrases are never stored in kmux settings.
        </p>
      </div>
      <div className={styles.settingsSection}>
        <div className={styles.settingsSectionHeader}>
          <strong>Saved SSH Connections</strong>
          <span className={styles.settingsSectionMeta}>
            {snapshot ? snapshot.profiles.length : "Loading…"}
          </span>
        </div>
        <div className={styles.sshConnectionLayout}>
          <div className={styles.sshConnectionList} role="listbox">
            {snapshot?.profiles.map((profile) => (
              <button
                key={profile.id}
                type="button"
                role="option"
                aria-selected={profile.id === selectedId}
                data-selected={profile.id === selectedId}
                onClick={() => {
                  setSelectedId(profile.id);
                  setEditor(null);
                }}
              >
                <strong>{profile.name}</strong>
                <span>
                  {profile.effectiveConnection
                    ? `${profile.effectiveConnection.user}@${profile.effectiveConnection.hostName}:${profile.effectiveConnection.port}`
                    : profile.sshConfigHost ?? profile.host}
                </span>
              </button>
            ))}
            {snapshot && snapshot.profiles.length === 0 ? (
              <p>No saved SSH connections.</p>
            ) : null}
          </div>
          <div className={styles.sshConnectionDetails}>
            {editor ? (
              <SshProfileEditor
                draft={editor}
                disabled={Boolean(busy)}
                onChange={setEditor}
                onCancel={() => setEditor(null)}
                onSave={() => void saveEditor()}
              />
            ) : selected ? (
              <SshProfileDetails profile={selected} />
            ) : (
              <p>Select a connection or add a new one.</p>
            )}
          </div>
        </div>
        <div className={styles.modalActions}>
          <button
            type="button"
            disabled={Boolean(busy)}
            onClick={() => setEditor({ ...EMPTY_EDITOR })}
          >
            Add
          </button>
          <button
            type="button"
            disabled={!selected || Boolean(busy)}
            onClick={() => selected && setEditor(profileToEditor(selected))}
          >
            Edit
          </button>
          <button
            type="button"
            disabled={!selected || Boolean(busy)}
            onClick={() =>
              selected &&
              void run("duplicate", async () => {
                const duplicate = await window.kmux.duplicateSshProfile(
                  selected.id
                );
                await reload(true, duplicate.id);
              })
            }
          >
            Duplicate
          </button>
          <button
            type="button"
            disabled={!selected || Boolean(busy)}
            onClick={() =>
              selected &&
              void run("test", async () => {
                const tested = await window.kmux.testSshProfile(selected.id);
                setSnapshot(tested);
                setSelectedId(selected.id);
              })
            }
          >
            {busy === "test" ? "Testing…" : "Test Connection"}
          </button>
          <button
            type="button"
            disabled={!selected?.verifiedTarget || Boolean(busy)}
            onClick={() => {
              if (!selected) return;
              const confirmed = window.confirm(
                `Rebind “${selected.name}” to the authority it reaches now?\n\nThis creates a new immutable target binding. Existing workspaces and retained sessions stay bound to target ${selected.verifiedTarget?.targetId ?? "unknown"} and are not moved or deleted.`
              );
              if (!confirmed) return;
              void run("rebind", async () => {
                const rebound = await window.kmux.rebindSshProfile(selected.id);
                setSnapshot(rebound);
                setSelectedId(selected.id);
              });
            }}
          >
            {busy === "rebind" ? "Rebinding…" : "Rebind Authority…"}
          </button>
          <button
            type="button"
            disabled={!selected?.verifiedTarget || Boolean(busy)}
            onClick={() => {
              if (!selected) return;
              void run("runtime-clean", async () => {
                const report = await window.kmux.cleanSshRuntime(selected.id);
                setRuntimeResult(
                  `Runtime clean completed: removed ${report.removed.length}, live ${report.live.length}, repair required ${report.incompleteOrCorrupt.length}.`
                );
              });
            }}
          >
            {busy === "runtime-clean" ? "Cleaning…" : "Clean Runtime"}
          </button>
          <button
            type="button"
            disabled={!selected?.verifiedTarget || Boolean(busy)}
            onClick={() => {
              if (!selected) return;
              const confirmed = window.confirm(
                `Reset the installed kmux runtime for “${selected.name}”?\n\nThe next connection will reinstall it. Reset is refused while a workspace, retained session, live keeper, or another process still references this target. Session journals, worktrees, and remote authority are preserved.`
              );
              if (!confirmed) return;
              void run("runtime-reset", async () => {
                const report = await window.kmux.resetSshRuntime(selected.id);
                setRuntimeResult(
                  report.status === "reset"
                    ? `Runtime generation ${report.generation} was reset.`
                    : `Runtime generation ${report.generation} was already absent.`
                );
                await reload(true, selected.id);
              });
            }}
          >
            {busy === "runtime-reset" ? "Resetting…" : "Reset Runtime…"}
          </button>
          <button
            type="button"
            disabled={!selected || Boolean(busy)}
            onClick={() =>
              selected &&
              void run("delete", async () => {
                await window.kmux.deleteSshProfile(selected.id);
                await reload(false);
              })
            }
          >
            Delete
          </button>
          <button
            type="button"
            disabled={!availableAliases?.length || Boolean(busy)}
            onClick={() =>
              availableAliases &&
              void run("import", async () => {
                const imported = await window.kmux.importSshConfigAliases(
                  availableAliases
                );
                setSnapshot(imported);
                setSelectedId(imported.profiles[0]?.id ?? null);
              })
            }
          >
            Import/Sync OpenSSH Aliases
          </button>
        </div>
        {error ? (
          <div className={styles.worktreeError} role="alert">
            {error}
          </div>
        ) : null}
        {runtimeResult ? <div role="status">{runtimeResult}</div> : null}
      </div>
      <div className={styles.settingsSection}>
        <div className={styles.settingsSectionHeader}>
          <strong>Retained remote sessions</strong>
          <span className={styles.settingsSectionMeta}>
            {retained ? retained.sessions.length : "Loading…"}
          </span>
        </div>
        {retained?.sessions.length ? (
          <div className={styles.sshRetainedList}>
            {retained.sessions.map((session) => (
              <div key={session.resourceKey.sessionId}>
                <span>
                  <strong>{session.launch.title ?? session.launch.cwd}</strong>
                  <small>
                    {session.reason} · {session.processState} · target {session.resourceKey.targetId}
                  </small>
                </span>
                <button
                  type="button"
                  disabled={!session.canTerminate || Boolean(busy)}
                  onClick={() =>
                    void run("terminate", async () => {
                      await window.kmux.terminateRetainedRemoteSession(
                        session.resourceKey
                      );
                      await reload(false);
                    })
                  }
                >
                  Terminate
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p>No retained remote sessions.</p>
        )}
      </div>
    </div>
  );
}

function SshProfileDetails({ profile }: { profile: SshProfileVm }): JSX.Element {
  const effective = profile.effectiveConnection;
  const target = profile.verifiedTarget;
  return (
    <div className={styles.sshConnectionFacts}>
      <h4>{profile.name}</h4>
      <Fact label="Locator" value={profile.sshConfigHost ?? profile.host ?? "—"} />
      <Fact
        label="Effective route"
        value={
          effective
            ? `${effective.user}@${effective.hostName}:${effective.port}`
            : "Not resolved"
        }
      />
      <Fact
        label="Policy hash"
        value={effective?.policyHash ?? "Not resolved"}
      />
      <Fact
        label="Host key fingerprint"
        value={target?.sshHostKeyFingerprint ?? "Not reported by OpenSSH"}
      />
      <Fact
        label="Installation ID"
        value={target?.remoteInstallationId ?? "Not verified"}
      />
      <Fact label="Execution node ID" value={target?.executionNodeId ?? "Not verified"} />
      <Fact
        label="Authenticated principal"
        value={
          target
            ? `${target.authenticatedPrincipal.accountName} (uid ${target.authenticatedPrincipal.uid})`
            : "Not verified"
        }
      />
      <Fact
        label="Remote runtime"
        value={
          target?.runtimeVersion
            ? `${target.runtimeVersion} · ${target.platform ?? "unknown"}/${target.arch ?? "unknown"}/${target.abi ?? "unknown"}`
            : "Not verified"
        }
      />
      <Fact
        label="Persistence"
        value={target?.persistenceLevel ?? "Not verified"}
      />
      <Fact
        label="Capabilities"
        value={target?.capabilities?.join(", ") || "Not verified"}
      />
      {profile.lastError ? (
        <div className={styles.worktreeError}>
          <strong>Last connection/bootstrap error</strong>
          <span>{profile.lastError.message}</span>
          <small>{profile.lastError.at}</small>
        </div>
      ) : null}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}

function SshProfileEditor(props: {
  draft: EditorDraft;
  disabled: boolean;
  onChange: (draft: EditorDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}): JSX.Element {
  const update = <K extends keyof EditorDraft>(
    key: K,
    value: EditorDraft[K]
  ) => props.onChange({ ...props.draft, [key]: value });
  return (
    <div className={styles.sshProfileEditor}>
      <label>
        <span>Name</span>
        <input
          value={props.draft.name}
          disabled={props.disabled}
          onChange={(event) => update("name", event.currentTarget.value)}
        />
      </label>
      <label>
        <span>Locator type</span>
        <select
          value={props.draft.locatorKind}
          disabled={props.disabled}
          onChange={(event) =>
            update("locatorKind", event.currentTarget.value as "alias" | "host")
          }
        >
          <option value="alias">OpenSSH config alias</option>
          <option value="host">Explicit host</option>
        </select>
      </label>
      <label>
        <span>{props.draft.locatorKind === "alias" ? "Alias" : "Host"}</span>
        <input
          value={props.draft.locator}
          disabled={props.disabled}
          onChange={(event) => update("locator", event.currentTarget.value)}
        />
      </label>
      <label>
        <span>Port</span>
        <input
          type="number"
          min={1}
          max={65535}
          value={props.draft.port}
          disabled={props.disabled}
          onChange={(event) => update("port", event.currentTarget.value)}
        />
      </label>
      {TEXT_FIELDS.map((field) => (
        <label key={field.key}>
          <span>{field.label}</span>
          <input
            value={props.draft[field.key]}
            placeholder={field.placeholder}
            disabled={props.disabled}
            onChange={(event) => update(field.key, event.currentTarget.value)}
          />
        </label>
      ))}
      <label>
        <span>Session retained-data quota (MiB)</span>
        <input
          type="number"
          min={64}
          value={props.draft.sessionRetentionQuotaMiB}
          disabled={props.disabled}
          onChange={(event) =>
            update("sessionRetentionQuotaMiB", event.currentTarget.value)
          }
        />
      </label>
      <label>
        <span>Target retained-data quota (MiB)</span>
        <input
          type="number"
          min={256}
          value={props.draft.targetRetentionQuotaMiB}
          disabled={props.disabled}
          onChange={(event) =>
            update("targetRetentionQuotaMiB", event.currentTarget.value)
          }
        />
      </label>
      <label>
        <span>Environment overrides (JSON)</span>
        <textarea
          rows={5}
          value={props.draft.envJson}
          disabled={props.disabled}
          onChange={(event) => update("envJson", event.currentTarget.value)}
        />
      </label>
      <label className={styles.checkboxRow}>
        <input
          type="checkbox"
          checked={props.draft.forwardAgent}
          disabled={props.disabled}
          onChange={(event) =>
            update("forwardAgent", event.currentTarget.checked)
          }
        />
        <span>Enable agent forwarding for this profile</span>
      </label>
      <div className={styles.modalActions}>
        <button type="button" disabled={props.disabled} onClick={props.onCancel}>
          Cancel
        </button>
        <button type="button" disabled={props.disabled} onClick={props.onSave}>
          Save
        </button>
      </div>
    </div>
  );
}

function profileToEditor(profile: SshProfileVm): EditorDraft {
  return {
    id: profile.id,
    locatorKind: profile.sshConfigHost === undefined ? "host" : "alias",
    name: profile.name,
    locator: profile.sshConfigHost ?? profile.host ?? "",
    user: profile.user ?? "",
    port: profile.port?.toString() ?? "",
    identityFile: profile.identityFile ?? "",
    defaultRemoteCwd: profile.defaultRemoteCwd ?? "",
    shellOverride: profile.shellOverride ?? "",
    bootstrapShellOverride: profile.bootstrapShellOverride ?? "",
    installPathOverride: profile.installPathOverride ?? "",
    authorityPathOverride: profile.authorityPathOverride ?? "",
    statePathOverride: profile.statePathOverride ?? "",
    runtimePathOverride: profile.runtimePathOverride ?? "",
    sessionRetentionQuotaMiB:
      profile.sessionRetentionQuotaMiB?.toString() ?? "",
    targetRetentionQuotaMiB:
      profile.targetRetentionQuotaMiB?.toString() ?? "",
    envJson: JSON.stringify(profile.env ?? {}, null, 2),
    forwardAgent: profile.forwardAgent === true
  };
}

function editorToProfile(editor: EditorDraft): SshProfileDraftDto {
  let env: Record<string, string> | undefined;
  try {
    const parsed = JSON.parse(editor.envJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Environment overrides must be a JSON object");
    }
    env = Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([key, value]) => {
        if (typeof value !== "string") {
          throw new Error("Environment override values must be strings");
        }
        return [key, value];
      })
    );
  } catch (cause) {
    throw cause instanceof Error ? cause : new Error(String(cause));
  }
  const text = (value: string) => value.trim() || undefined;
  const number = (value: string) =>
    value.trim() ? Number.parseInt(value, 10) : undefined;
  return {
    name: editor.name.trim(),
    ...(editor.locatorKind === "alias"
      ? { sshConfigHost: editor.locator.trim() }
      : { host: editor.locator.trim() }),
    ...(text(editor.user) ? { user: text(editor.user) } : {}),
    ...(number(editor.port) === undefined ? {} : { port: number(editor.port) }),
    ...(text(editor.identityFile)
      ? { identityFile: text(editor.identityFile) }
      : {}),
    ...(text(editor.defaultRemoteCwd)
      ? { defaultRemoteCwd: text(editor.defaultRemoteCwd) }
      : {}),
    ...(text(editor.shellOverride)
      ? { shellOverride: text(editor.shellOverride) }
      : {}),
    ...(text(editor.bootstrapShellOverride)
      ? { bootstrapShellOverride: text(editor.bootstrapShellOverride) }
      : {}),
    ...(text(editor.installPathOverride)
      ? { installPathOverride: text(editor.installPathOverride) }
      : {}),
    ...(text(editor.authorityPathOverride)
      ? { authorityPathOverride: text(editor.authorityPathOverride) }
      : {}),
    ...(text(editor.statePathOverride)
      ? { statePathOverride: text(editor.statePathOverride) }
      : {}),
    ...(text(editor.runtimePathOverride)
      ? { runtimePathOverride: text(editor.runtimePathOverride) }
      : {}),
    ...(number(editor.sessionRetentionQuotaMiB) === undefined
      ? {}
      : { sessionRetentionQuotaMiB: number(editor.sessionRetentionQuotaMiB) }),
    ...(number(editor.targetRetentionQuotaMiB) === undefined
      ? {}
      : { targetRetentionQuotaMiB: number(editor.targetRetentionQuotaMiB) }),
    ...(Object.keys(env).length === 0 ? {} : { env }),
    forwardAgent: editor.forwardAgent
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
