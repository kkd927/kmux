# Agent settings

kmux can launch a compatible wrapper instead of a vendor's native CLI and can
index additional transcript stores. Edit the kmux `settings.json` file through
**Settings → Open settings.json**, then restart the app. Manual changes are
loaded only during app startup.

```json
{
  "settingsVersion": 5,
  "agents": {
    "local": {
      "claude": {
        "command": "ccs",
        "args": ["enterprise"],
        "additionalSessionRoots": [
          "~/.ccs/shared/context-groups/default/projects"
        ]
      },
      "codex": {
        "command": "ccsxp",
        "args": []
      }
    },
    "ssh": {
      "claude": {
        "command": "claude",
        "args": []
      }
    }
  }
}
```

The supported scopes are `local` and `ssh`; the supported vendors are
`claude`, `codex`, and `antigravity`.

- `command` is a command found through `PATH` or an executable path. Omitting
  it uses the native command (`claude`, `codex`, or `agy`).
- `args` are fixed arguments inserted after `command` and before kmux's
  operation arguments. For example, the Claude configuration above resumes a
  session as `ccs enterprise --resume <id>`.
- `additionalSessionRoots` adds compatible transcript roots without replacing
  the vendor's default store. These roots feed both session history and
  token/cost usage.

Session roots may be absolute or begin with `~/`. For local settings, `~`
means the desktop user's home. For SSH settings, it means the authenticated
remote user's home. Environment variables, globs, and shell expressions are
not expanded. Missing or inaccessible additional roots are skipped.

kmux checks the configured command on the target where the session would run.
If it is unavailable, resume is disabled; kmux does not silently fall back to
the native vendor command. Agent settings do not change authentication files,
vendor settings, hooks, subscription quota checks, or commands typed manually
in a terminal.
