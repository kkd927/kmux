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
  locatorKind: "host",
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

const CONNECTION_TEXT_FIELDS: Array<{
  key: keyof Pick<EditorDraft, "user" | "identityFile">;
  label: string;
  placeholder: string;
}> = [
  { key: "user", label: "User", placeholder: "OpenSSH default" },
  {
    key: "identityFile",
    label: "Identity file",
    placeholder: "~/.ssh/id_ed25519"
  }
];

const ADVANCED_TEXT_FIELDS: Array<{
  key: keyof Pick<
    EditorDraft,
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
  {
    key: "defaultRemoteCwd",
    label: "Default workspace folder",
    placeholder: "Leave empty to start in the remote home folder"
  },
  {
    key: "shellOverride",
    label: "Default shell",
    placeholder: "/bin/zsh"
  },
  {
    key: "bootstrapShellOverride",
    label: "Bootstrap shell",
    placeholder: "Only for unknown login shells"
  },
  {
    key: "installPathOverride",
    label: "Install root",
    placeholder: "Host-local path"
  },
  {
    key: "authorityPathOverride",
    label: "Authority root",
    placeholder: "Host-local path"
  },
  {
    key: "statePathOverride",
    label: "State root",
    placeholder: "Host-local path"
  },
  {
    key: "runtimePathOverride",
    label: "Runtime root",
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
    () =>
      snapshot?.profiles.find((profile) => profile.id === selectedId) ?? null,
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
        preferredId ?? selectedId ?? connections.profiles[0]?.id ?? null;
      setSelectedId(
        nextId && connections.profiles.some((profile) => profile.id === nextId)
          ? nextId
          : (connections.profiles[0]?.id ?? null)
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
    <div
      className={styles.settingsCategory}
      data-testid="ssh-connections-settings"
    >
      <header className={styles.settingsCategoryHeader}>
        <h3>SSH Connections</h3>
        <p>
          Connect through your system OpenSSH setup. kmux never stores passwords
          or private-key passphrases.
        </p>
      </header>

      <section
        className={`${styles.settingsSection} ${styles.sshConnectionsSection}`}
      >
        <div className={styles.sshConnectionsToolbar}>
          <div>
            <strong>Saved connections</strong>
            <span>
              {snapshot
                ? `${snapshot.profiles.length} saved · ${snapshot.profiles.filter((profile) => profile.verifiedTarget).length} verified`
                : "Loading connections…"}
            </span>
          </div>
          <div className={styles.sshToolbarActions}>
            <button
              type="button"
              className={styles.sshActionButton}
              title="Import or update aliases from ~/.ssh/config"
              disabled={!availableAliases?.length || Boolean(busy)}
              onClick={() =>
                availableAliases &&
                void run("import", async () => {
                  const imported =
                    await window.kmux.importSshConfigAliases(availableAliases);
                  setSnapshot(imported);
                  setSelectedId(imported.profiles[0]?.id ?? null);
                })
              }
            >
              Sync SSH config
            </button>
            <button
              type="button"
              className={`${styles.sshActionButton} ${styles.sshPrimaryAction}`}
              disabled={Boolean(busy)}
              onClick={() => setEditor({ ...EMPTY_EDITOR })}
            >
              <span aria-hidden="true">＋</span>
              New connection
            </button>
          </div>
        </div>

        {snapshot && snapshot.profiles.length === 0 && !editor ? (
          <div className={styles.sshOnboarding}>
            <strong>Add your first remote host</strong>
            <span>
              Use an alias from ~/.ssh/config or enter a host name directly.
            </span>
          </div>
        ) : (
          <div
            className={styles.sshConnectionLayout}
            data-single={snapshot?.profiles.length ? undefined : "true"}
          >
            {snapshot?.profiles.length ? (
              <div className={styles.sshConnectionList} role="listbox">
                {snapshot.profiles.map((profile) => (
                  <button
                    key={profile.id}
                    type="button"
                    role="option"
                    className={styles.sshConnectionListItem}
                    aria-selected={profile.id === selectedId}
                    data-selected={profile.id === selectedId}
                    onClick={() => {
                      setSelectedId(profile.id);
                      setEditor(null);
                    }}
                  >
                    <span className={styles.sshConnectionItemHeader}>
                      <strong>{profile.name}</strong>
                      <span
                        className={styles.sshConnectionState}
                        data-status={profileStatus(profile).status}
                      >
                        {profileStatus(profile).label}
                      </span>
                    </span>
                    <span className={styles.sshConnectionEndpoint}>
                      {profile.effectiveConnection
                        ? `${profile.effectiveConnection.user}@${profile.effectiveConnection.hostName}:${profile.effectiveConnection.port}`
                        : (profile.sshConfigHost ?? profile.host)}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
            <div
              className={styles.sshConnectionDetails}
              data-mode={editor ? "editor" : "details"}
            >
              {editor ? (
                <SshProfileEditor
                  draft={editor}
                  disabled={Boolean(busy)}
                  onChange={setEditor}
                  onCancel={() => setEditor(null)}
                  onSave={() => void saveEditor()}
                />
              ) : selected ? (
                <div className={styles.sshSelectedProfile}>
                  <SshProfileDetails profile={selected} />
                  <div className={styles.sshDetailsActions}>
                    <button
                      type="button"
                      className={styles.sshActionButton}
                      disabled={Boolean(busy)}
                      onClick={() => setEditor(profileToEditor(selected))}
                    >
                      Edit profile
                    </button>
                    <button
                      type="button"
                      className={styles.sshActionButton}
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void run("duplicate", async () => {
                          const duplicate =
                            await window.kmux.duplicateSshProfile(selected.id);
                          await reload(true, duplicate.id);
                        })
                      }
                    >
                      Duplicate
                    </button>
                    <button
                      type="button"
                      className={`${styles.sshActionButton} ${styles.sshPrimaryAction}`}
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void run("test", async () => {
                          const tested = await window.kmux.testSshProfile(
                            selected.id
                          );
                          setSnapshot(tested);
                          setSelectedId(selected.id);
                        })
                      }
                    >
                      {busy === "test" ? "Testing…" : "Test connection"}
                    </button>
                  </div>

                  <details className={styles.sshMaintenance}>
                    <summary>
                      <span>
                        <strong>Advanced management</strong>
                        <small>
                          Authority binding and remote runtime tools
                        </small>
                      </span>
                    </summary>
                    <div className={styles.sshMaintenanceBody}>
                      <p>
                        These actions are only needed when the remote host
                        identity or installed kmux runtime changes.
                      </p>
                      <div className={styles.sshMaintenanceActions}>
                        <button
                          type="button"
                          className={styles.sshActionButton}
                          disabled={!selected.verifiedTarget || Boolean(busy)}
                          onClick={() => {
                            const confirmed = window.confirm(
                              `Rebind “${selected.name}” to the authority it reaches now?\n\nThis creates a new immutable target binding. Existing workspaces and retained sessions stay bound to target ${selected.verifiedTarget?.targetId ?? "unknown"} and are not moved or deleted.`
                            );
                            if (!confirmed) return;
                            void run("rebind", async () => {
                              const rebound =
                                await window.kmux.rebindSshProfile(selected.id);
                              setSnapshot(rebound);
                              setSelectedId(selected.id);
                            });
                          }}
                        >
                          {busy === "rebind"
                            ? "Rebinding…"
                            : "Rebind authority…"}
                        </button>
                        <button
                          type="button"
                          className={styles.sshActionButton}
                          disabled={!selected.verifiedTarget || Boolean(busy)}
                          onClick={() => {
                            void run("runtime-clean", async () => {
                              const report = await window.kmux.cleanSshRuntime(
                                selected.id
                              );
                              setRuntimeResult(
                                `Runtime clean completed: removed ${report.removed.length}, live ${report.live.length}, repair required ${report.incompleteOrCorrupt.length}.`
                              );
                            });
                          }}
                        >
                          {busy === "runtime-clean"
                            ? "Cleaning…"
                            : "Clean runtime"}
                        </button>
                        <button
                          type="button"
                          className={styles.sshActionButton}
                          disabled={!selected.verifiedTarget || Boolean(busy)}
                          onClick={() => {
                            const confirmed = window.confirm(
                              `Reset the installed kmux runtime for “${selected.name}”?\n\nThe next connection will reinstall it. Reset is refused while a workspace, retained session, live keeper, or another process still references this target. Session journals, worktrees, and remote authority are preserved.`
                            );
                            if (!confirmed) return;
                            void run("runtime-reset", async () => {
                              const report = await window.kmux.resetSshRuntime(
                                selected.id
                              );
                              setRuntimeResult(
                                report.status === "reset"
                                  ? `Runtime generation ${report.generation} was reset.`
                                  : `Runtime generation ${report.generation} was already absent.`
                              );
                              await reload(true, selected.id);
                            });
                          }}
                        >
                          {busy === "runtime-reset"
                            ? "Resetting…"
                            : "Reset runtime…"}
                        </button>
                        <button
                          type="button"
                          className={`${styles.sshActionButton} ${styles.sshDangerAction}`}
                          disabled={Boolean(busy)}
                          onClick={() =>
                            void run("delete", async () => {
                              await window.kmux.deleteSshProfile(selected.id);
                              await reload(false);
                            })
                          }
                        >
                          Delete profile
                        </button>
                      </div>
                    </div>
                  </details>
                </div>
              ) : (
                <div className={styles.sshDetailsEmpty}>
                  <strong>Select a connection</strong>
                  <span>
                    Its route, verification, and runtime details appear here.
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
        {error ? (
          <div className={styles.sshFeedback} data-tone="error" role="alert">
            {error}
          </div>
        ) : null}
        {runtimeResult ? (
          <div className={styles.sshFeedback} data-tone="success" role="status">
            {runtimeResult}
          </div>
        ) : null}
      </section>

      <section
        className={`${styles.settingsSection} ${styles.sshRetainedSection}`}
      >
        <div className={styles.sshRetainedHeader}>
          <span>
            <strong>Retained remote sessions</strong>
            <small>
              Disconnected sessions kept on a remote host for later recovery.
            </small>
          </span>
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
                    {session.reason} · {session.processState} · target{" "}
                    {session.resourceKey.targetId}
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
          <p className={styles.sshRetainedEmpty}>
            No retained remote sessions.
          </p>
        )}
      </section>
    </div>
  );
}

function SshProfileDetails({
  profile
}: {
  profile: SshProfileVm;
}): JSX.Element {
  const effective = profile.effectiveConnection;
  const target = profile.verifiedTarget;
  const status = profileStatus(profile);
  const effectiveRoute = effective
    ? `${effective.user}@${effective.hostName}:${effective.port}`
    : "Not resolved";
  return (
    <div className={styles.sshConnectionFacts}>
      <header>
        <span className={styles.sshProfileIdentity}>
          <span className={styles.sshProfileTitleRow}>
            <h4>{profile.name}</h4>
            <span
              className={styles.sshConnectionState}
              data-status={status.status}
            >
              {status.label}
            </span>
          </span>
          <code>{effectiveRoute}</code>
        </span>
      </header>

      <div className={styles.sshOverviewGrid}>
        <Fact
          label="Locator"
          value={profile.sshConfigHost ?? profile.host ?? "—"}
        />
        <Fact label="Effective route" value={effectiveRoute} />
        <Fact
          label="Remote runtime"
          value={
            target?.runtimeVersion
              ? `${target.runtimeVersion} · ${target.platform ?? "unknown"}/${target.arch ?? "unknown"}`
              : "Not verified"
          }
        />
        <Fact
          label="Last verified"
          value={formatTimestamp(target?.lastVerifiedAt)}
        />
      </div>

      <details className={styles.sshTechnicalDetails}>
        <summary>
          <span>
            <strong>Identity &amp; technical details</strong>
            <small>Host key, policy, authority, and runtime capabilities</small>
          </span>
        </summary>
        <div className={styles.sshTechnicalFacts}>
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
          <Fact
            label="Execution node ID"
            value={target?.executionNodeId ?? "Not verified"}
          />
          <Fact
            label="Authenticated principal"
            value={
              target
                ? `${target.authenticatedPrincipal.accountName} (uid ${target.authenticatedPrincipal.uid})`
                : "Not verified"
            }
          />
          <Fact
            label="Runtime ABI"
            value={
              target
                ? `${target.platform ?? "unknown"}/${target.arch ?? "unknown"}/${target.abi ?? "unknown"}`
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
        </div>
      </details>

      {profile.lastError ? (
        <div className={styles.sshProfileError} role="status">
          <strong>Last connection error</strong>
          <span>{profile.lastError.message}</span>
          <small>{formatTimestamp(profile.lastError.at)}</small>
        </div>
      ) : null}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className={styles.sshFact}>
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
  const [advancedOpen, setAdvancedOpen] = useState(() =>
    hasAdvancedProfileOptions(props.draft)
  );
  const update = <K extends keyof EditorDraft>(key: K, value: EditorDraft[K]) =>
    props.onChange({ ...props.draft, [key]: value });
  const hasAdvancedOptions = hasAdvancedProfileOptions(props.draft);
  return (
    <div className={styles.sshProfileEditor}>
      <header className={styles.sshEditorHeader}>
        <span>
          <h4>{props.draft.id ? "Edit connection" : "New connection"}</h4>
          <p>
            {props.draft.id
              ? "Update how kmux reaches this host."
              : "Add an OpenSSH alias or a host directly."}
          </p>
        </span>
      </header>

      <div className={styles.sshEditorSection}>
        <div className={styles.sshEditorSectionHeader}>
          <strong>Connection</strong>
          <span>Required route and connection details</span>
        </div>
        <div className={styles.sshEditorGrid}>
          <label className={styles.sshEditorField}>
            <span>Name</span>
            <input
              value={props.draft.name}
              placeholder="Production server"
              disabled={props.disabled}
              onChange={(event) => update("name", event.currentTarget.value)}
            />
          </label>
          <label className={styles.sshEditorField}>
            <span>Connection source</span>
            <select
              value={props.draft.locatorKind}
              disabled={props.disabled}
              onChange={(event) =>
                update(
                  "locatorKind",
                  event.currentTarget.value as "alias" | "host"
                )
              }
            >
              <option value="alias">OpenSSH config alias</option>
              <option value="host">Host name or address</option>
            </select>
          </label>
          <label className={styles.sshEditorField}>
            <span>
              {props.draft.locatorKind === "alias" ? "SSH alias" : "Host"}
            </span>
            <input
              value={props.draft.locator}
              placeholder={
                props.draft.locatorKind === "alias"
                  ? "my-server"
                  : "server.example.com"
              }
              disabled={props.disabled}
              onChange={(event) => update("locator", event.currentTarget.value)}
            />
          </label>
          <label className={styles.sshEditorField}>
            <span>Port</span>
            <input
              type="number"
              min={1}
              max={65535}
              placeholder="22"
              value={props.draft.port}
              disabled={props.disabled}
              onChange={(event) => update("port", event.currentTarget.value)}
            />
          </label>
          {CONNECTION_TEXT_FIELDS.map((field) => (
            <label
              key={field.key}
              className={styles.sshEditorField}
              data-span={field.key === "identityFile" ? "full" : undefined}
            >
              <span>{field.label}</span>
              <input
                value={props.draft[field.key]}
                placeholder={field.placeholder}
                disabled={props.disabled}
                onChange={(event) =>
                  update(field.key, event.currentTarget.value)
                }
              />
            </label>
          ))}
        </div>
      </div>

      <details
        className={styles.sshAdvancedOptions}
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
      >
        <summary>
          <span>
            <strong>Advanced options</strong>
            <small>
              Workspace folder, shell, storage, environment, and agent
              forwarding
            </small>
          </span>
          <span className={styles.sshOptionsState}>
            {hasAdvancedOptions ? "Configured" : "Using defaults"}
          </span>
        </summary>
        <div className={styles.sshAdvancedBody}>
          <div className={styles.sshEditorGrid}>
            {ADVANCED_TEXT_FIELDS.map((field) => (
              <label
                key={field.key}
                className={styles.sshEditorField}
                data-span={
                  field.key === "defaultRemoteCwd" ? "full" : undefined
                }
              >
                <span>{field.label}</span>
                <input
                  value={props.draft[field.key]}
                  placeholder={field.placeholder}
                  disabled={props.disabled}
                  onChange={(event) =>
                    update(field.key, event.currentTarget.value)
                  }
                />
              </label>
            ))}
            <label className={styles.sshEditorField}>
              <span>Session retained-data quota (MiB)</span>
              <input
                type="number"
                min={64}
                placeholder="Default"
                value={props.draft.sessionRetentionQuotaMiB}
                disabled={props.disabled}
                onChange={(event) =>
                  update("sessionRetentionQuotaMiB", event.currentTarget.value)
                }
              />
            </label>
            <label className={styles.sshEditorField}>
              <span>Target retained-data quota (MiB)</span>
              <input
                type="number"
                min={256}
                placeholder="Default"
                value={props.draft.targetRetentionQuotaMiB}
                disabled={props.disabled}
                onChange={(event) =>
                  update("targetRetentionQuotaMiB", event.currentTarget.value)
                }
              />
            </label>
            <label className={styles.sshEditorField} data-span="full">
              <span>Environment overrides (JSON)</span>
              <textarea
                rows={5}
                value={props.draft.envJson}
                disabled={props.disabled}
                onChange={(event) =>
                  update("envJson", event.currentTarget.value)
                }
              />
            </label>
            <label className={styles.sshForwardAgentField} data-span="full">
              <input
                type="checkbox"
                checked={props.draft.forwardAgent}
                disabled={props.disabled}
                onChange={(event) =>
                  update("forwardAgent", event.currentTarget.checked)
                }
              />
              <span>
                <strong>Forward SSH agent</strong>
                <small>Enable only for hosts you trust.</small>
              </span>
            </label>
          </div>
        </div>
      </details>

      <div className={styles.sshEditorActions}>
        <button
          type="button"
          className={styles.sshActionButton}
          disabled={props.disabled}
          onClick={props.onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className={`${styles.sshActionButton} ${styles.sshPrimaryAction}`}
          disabled={props.disabled}
          onClick={props.onSave}
        >
          Save connection
        </button>
      </div>
    </div>
  );
}

function profileStatus(profile: SshProfileVm): {
  status: "verified" | "error" | "resolved" | "untested";
  label: string;
} {
  if (profile.lastError) {
    return { status: "error", label: "Needs attention" };
  }
  if (profile.verifiedTarget) {
    return { status: "verified", label: "Verified" };
  }
  if (profile.effectiveConnection) {
    return { status: "resolved", label: "Resolved" };
  }
  return { status: "untested", label: "Not tested" };
}

function hasAdvancedProfileOptions(draft: EditorDraft): boolean {
  return (
    ADVANCED_TEXT_FIELDS.some((field) => draft[field.key].trim().length > 0) ||
    draft.sessionRetentionQuotaMiB.trim().length > 0 ||
    draft.targetRetentionQuotaMiB.trim().length > 0 ||
    draft.envJson.trim() !== "{}" ||
    draft.forwardAgent
  );
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "Not verified";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
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
    targetRetentionQuotaMiB: profile.targetRetentionQuotaMiB?.toString() ?? "",
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
