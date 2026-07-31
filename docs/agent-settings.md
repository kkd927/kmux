# Agent settings

kmux can launch a compatible wrapper instead of a vendor's native CLI and can
replace its transcript store. Edit the kmux `settings.json` file through
**Settings → Open settings.json**, then restart the app. Manual changes are
loaded only during app startup.

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

Local vendor profiles live directly under `agents`. Optional SSH profiles live
under `agents.ssh`. The supported vendors are `claude`, `codex`, and
`antigravity`. A local profile is never inherited by SSH.

- `command` is a command found through `PATH` or an executable path. Omitting
  it uses the native command (`claude`, `codex`, or `agy`).
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
the native vendor command. Agent settings do not change authentication files,
vendor settings, hooks, subscription quota checks, or commands typed manually
in a terminal. Configure at most one active execution profile per vendor and
environment.
