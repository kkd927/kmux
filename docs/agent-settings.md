# Agent settings

kmux can launch a compatible wrapper instead of an agent's native CLI and can
replace its transcript store. Edit `settings.json` through **Settings → Open
settings.json**. Manual file changes are loaded during app startup.

```json
{
  "settingsVersion": 6,
  "agents": {
    "claude": {
      "command": "ccs",
      "args": ["enterprise", "--"],
      "sessionRoot": "~/.ccs/shared/context-groups/default/projects"
    },
    "codex": {
      "command": "ccsxp",
      "args": []
    },
    "ssh": {
      "claude": {
        "command": "claude-remote",
        "args": [],
        "sessionRoot": "~/.claude/projects"
      }
    }
  }
}
```

Local profiles continue to live directly under `agents`; optional SSH profiles
live under the reserved `agents.ssh` key. All other keys are open, validated
agent IDs. Unknown IDs are preserved and shown with a neutral label, but this
build will not execute them. A local profile is never inherited by SSH.

- `command` is a command found through `PATH` or an executable path. Omitting
  it uses the command declared by the registered agent.
- `args` are fixed arguments inserted after `command` and before kmux's
  operation arguments. For example, the Claude configuration above resumes a
  session as `ccs enterprise -- --resume <id>`. A literal `--` can be included
  as its own array element when a wrapper requires pass-through arguments.
- `sessionRoot` replaces the vendor's native transcript root for both session
  history and token/cost usage. Omitting it uses the native root.

Session roots may be absolute or begin with `~/`. For local settings, `~`
means the desktop user's home. For SSH settings, it means the authenticated
remote user's home. Environment variables, globs, and shell expressions are
not expanded. A missing or inaccessible custom root produces no sessions;
kmux does not fall back to the native root. Existing roots are resolved to
their real path, so a CCS store symlink is supported:

```bash
ln -s ~/.ccs/shared/context-groups/default/projects ~/.claude/projects
```

kmux checks the configured command on the target where the session would run.
If it is unavailable, resume is disabled; kmux does not silently fall back to
the native agent command. Agent settings do not change authentication files,
agent-native configuration, hooks, subscription quota checks, or commands typed
manually in a terminal. Configure at most one active execution profile per
agent and environment.
