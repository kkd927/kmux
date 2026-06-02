<div align="center">

# kmux

**Run Claude Code, Codex CLI, and Gemini CLI side-by-side — without losing track of any of them.**

A macOS workspace for AI coding agents: parallel sessions, integrated usage, instant resume, worktree-safe branches.

[![CI](https://github.com/kkd927/kmux/actions/workflows/ci.yml/badge.svg)](https://github.com/kkd927/kmux/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/kkd927/kmux?display_name=tag&style=flat&logo=github)](https://github.com/kkd927/kmux/releases/latest)
[![macOS](https://img.shields.io/badge/platform-macOS-000?logo=apple&logoColor=fff)](https://github.com/kkd927/kmux/releases/latest)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-a78bfa)](./CONTRIBUTING.md)

<br>

English | <a href="README.ja.md">日本語</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.ko.md">한국어</a> | <a href="README.es.md">Español</a>

<br>
<br>

<a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-arm64.dmg"><img alt="Download for Apple Silicon" src="./docs/assets/readme/download-apple-silicon.svg" height="72"></a>
&nbsp;
<a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-x64.dmg"><img alt="Download for Intel Mac" src="./docs/assets/readme/download-intel-mac.svg" height="72"></a>

<br>
<br>

<img src="./docs/assets/readme/hero.png" alt="kmux — AI coding agent workspace" width="1000">

</div>

<br>

## ✨ Why kmux?

If you've started leaning on **Claude Code**, **Codex CLI**, and **Gemini CLI** for real work, you've already hit the friction: three terminals, three rate limits, three session histories, and no good way to keep them from stepping on each other inside the same repo.

**kmux** is a macOS workspace built around exactly that workflow:

- Park each agent in its own workspace and run them in parallel
- Get native macOS notifications when any agent needs input or finishes
- Track combined usage and remaining session budgets in one sidebar
- Jump back into any past Claude/Codex/Gemini session with one click
- Spin up a `git worktree` so two agents can edit the same repo on different branches safely

It's keyboard-first by design — every workflow is reachable from the home row — but that's how it gets out of your way, not the headline.

<br>

## 🚀 Highlights

<table>
<tr>
<td width="50%" valign="top">

### 📊 Unified Usage Dashboard

Track Claude Code, Codex CLI, and Gemini CLI side-by-side in one right-sidebar panel. The 5-hour session window, weekly window, and monthly spend roll up across all three providers — so you can see remaining session budget at a glance.

A daily heatmap, today's spend, top-spending models, and per-project hotspots round out the view, replacing a stack of `usage` commands with a single live dashboard.

</td>
<td width="50%" valign="top">

<img src="./docs/assets/readme/usage-dashboard.png" alt="Unified usage dashboard" width="100%">

</td>
</tr>
<tr>
<td width="50%" valign="top">

<img src="./docs/assets/readme/session-history.png" alt="Cross-agent session history" width="100%">

</td>
<td width="50%" valign="top">

### 🕘 Cross-Agent Session History

kmux indexes the local session logs for all three agents — Claude (`~/.claude/projects`), Codex (`~/.codex/sessions`), Gemini (`~/.gemini/tmp`) — and surfaces them in one filterable panel.

Click any row to resume that session. kmux focuses an existing surface for the same `cwd` if one is open, or spins up a fresh workspace and runs `claude --resume`, `codex resume`, or `gemini --resume` for you.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🌳 Worktree Workspaces

Right-click any workspace → **Convert to Worktree Workspace** to lock it onto a fresh `git worktree`. Now two agents can edit the same repo on different branches without fighting over the working tree.

kmux tracks the worktree lifecycle — branch name, dirty state, and removal, including a confirmation prompt before deleting a worktree with uncommitted changes — so the working copy never gets orphaned.

</td>
<td width="50%" valign="top">

<img src="./docs/assets/readme/worktree-workspace.png" alt="Worktree workspace" width="100%">

</td>
</tr>
</table>

<br>

### Everything else you'd expect from a serious terminal

- **Split panes & surface tabs** — group server, logs, and agent shells in one pane
- **Smart sidebar** — auto-detected `cwd`, git branch, active ports, and unread badges per workspace
- **Workspace persistence** — full layout restore on app launch
- **Command palette** (`⌘ ⇧ P`), terminal search (`⌘ F`), vim-style copy mode
- **Native macOS look** — proper title-bar integration, dark palette, retina-tuned rendering

<br>

## 📦 Install

<p>
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-arm64.dmg"><img alt="Download for Apple Silicon" src="./docs/assets/readme/download-apple-silicon.svg" height="72"></a>
  &nbsp;
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-x64.dmg"><img alt="Download for Intel Mac" src="./docs/assets/readme/download-intel-mac.svg" height="72"></a>
</p>

1. Click the button that matches your Mac (M1/M2/M3/M4 → Apple Silicon, older Intel Macs → Intel)
2. Open the downloaded `.dmg` and drag **kmux** into your `Applications` folder
3. On first launch, macOS may ask you to confirm — click **Open**

<br>

## 🏁 Quick Start

1. Launch kmux and press `⌘ N` to create a workspace
2. Inside it, run your agent — `claude`, `codex`, or `gemini`
3. Toggle the sidebar with `⌘ B` to see the **Usage** and **Sessions** panels
4. Press `⌘ N` again to park another agent in its own workspace — or right-click a workspace → **Convert to Worktree Workspace** if both should touch the same repo
5. When an agent needs input or finishes, a native macOS notification fires and the workspace picks up an attention badge

<br>

## ⌨️ Keyboard Shortcuts

> Every shortcut here is also reachable from the command palette (`⌘ ⇧ P`).

### Workspaces

| Shortcut  | Action                          |
| :-------- | :------------------------------ |
| `⌘ N`     | New workspace                   |
| `⌘ ]`     | Next workspace                  |
| `⌘ [`     | Previous workspace              |
| `⌘ 1`–`9` | Switch to workspace by number   |
| `⌘ ⇧ R`   | Rename workspace                |
| `⌘ ⇧ W`   | Close workspace                 |
| `⌘ B`     | Toggle sidebar                  |

### Panes

| Shortcut              | Action                   |
| :-------------------- | :----------------------- |
| `⌘ D`                 | Split right (vertical)   |
| `⌘ ⇧ D`               | Split down (horizontal)  |
| `⌥ ⌘ ←` `→` `↑` `↓`   | Focus pane directionally |
| `⌥ ⇧ ⌘ ←` `→` `↑` `↓` | Resize pane              |
| `⌥ ⌘ K`               | Close pane               |

### Surface Tabs

| Shortcut  | Action                       |
| :-------- | :--------------------------- |
| `⌘ T`     | New surface tab              |
| `⌃ Tab`   | Next surface                 |
| `⌃ ⇧ Tab` | Previous surface             |
| `⌃ 1`–`9` | Switch to surface by number  |
| `⌘ W`     | Close surface                |
| `⌃ ⌘ W`   | Close other surfaces         |

### Terminal & Utilities

| Shortcut        | Action               |
| :-------------- | :------------------- |
| `⌘ ⇧ P`         | Command palette      |
| `⌘ F`           | Search in terminal   |
| `⌘ G` / `⌘ ⇧ G` | Find next / previous |
| `⌘ C` / `⌘ V`   | Copy / paste         |
| `⌘ ⇧ M`         | Vim-style copy mode  |
| `⌘ I`           | Toggle notifications |
| `⌘ ⇧ U`         | Toggle usage dashboard |
| `⌘ ,`           | Open settings        |

<br>

## 📚 Resources

|                          |                                                                                                        |
| :----------------------- | :----------------------------------------------------------------------------------------------------- |
| 📖 **Product Spec**      | [docs/product-spec.md](./docs/product-spec.md) — full feature spec, including automation socket & CLI  |
| 🏗️ **Architecture ADR**  | [docs/adr/0002-electron-xterm-mvp-architecture.md](./docs/adr/0002-electron-xterm-mvp-architecture.md) |
| 🛠️ **Development Guide** | [docs/development.md](./docs/development.md) — build from source, dev loop, debugging                  |
| 🤝 **Contributing**      | [CONTRIBUTING.md](./CONTRIBUTING.md)                                                                   |
| 📜 **Code of Conduct**   | [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)                                                             |
| 🔒 **Security Policy**   | [SECURITY.md](./SECURITY.md)                                                                           |

<br>

<div align="center">

---

**kmux** — your AI coding agents, side-by-side.

<sub>macOS only · Pre-release · Actively developed</sub>

</div>
