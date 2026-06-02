<div align="center">

# kmux

**并排运行 Claude Code、Codex CLI、Gemini CLI 和 Antigravity CLI —— 轻松掌控，绝不迷失。**

专为 AI 编码助手打造的 macOS 工作区：并行会话、统一用量仪表盘、即时恢复、支持工作区安全的 Git 分支。

[![CI](https://github.com/kkd927/kmux/actions/workflows/ci.yml/badge.svg)](https://github.com/kkd927/kmux/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/kkd927/kmux?display_name=tag&style=flat&logo=github)](https://github.com/kkd927/kmux/releases/latest)
[![macOS](https://img.shields.io/badge/platform-macOS-000?logo=apple&logoColor=fff)](https://github.com/kkd927/kmux/releases/latest)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-a78bfa)](./CONTRIBUTING.md)

<br>

<a href="README.md">English</a> | <a href="README.ja.md">日本語</a> | 简体中文 | <a href="README.ko.md">한국어</a> | <a href="README.es.md">Español</a>

<br>
<br>

<a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-arm64.dmg"><img alt="下载 Apple Silicon 版本" src="./docs/assets/readme/download-apple-silicon.svg" height="72"></a>
&nbsp;
<a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-x64.dmg"><img alt="下载 Intel Mac 版本" src="./docs/assets/readme/download-intel-mac.svg" height="72"></a>

<br>
<br>

<img src="./docs/assets/readme/hero.png" alt="kmux — AI 编码助手工作区" width="1000">

</div>

<br>

## ✨ 为什么选择 kmux？

如果你已经开始在实际工作中使用 **Claude Code**、**Codex CLI**、**Gemini CLI** 和 **Antigravity CLI**，你一定遇到过这些痛点：多个终端、多个助手界面、分散的会话历史，而且没有好办法能防止它们在同一个仓库中互相覆盖或干扰。

**kmux** 是专为解决这一工作流而构建的 macOS 专属工作区：

- 将每个助手放置在各自独立的虚拟工作区中并并行运行
- 当任何助手需要输入或完成任务时，接收 macOS 原生系统通知
- 在单个侧边栏中实时追踪所有服务商的合并用量和剩余会话预算
- 一键立即重回过去的 Claude/Codex/Gemini/Antigravity 会话
- 创建 `git worktree`，让两个助手可以在同一个仓库的不同分支上安全地进行编辑，互不干扰

其键盘优先（Keyboard-first）的按键映射设计让你可以无需离开主键盘区（Home row）即可控制整个工作流，自然融入你的开发习惯，绝不干扰你的编码专注度。

<br>

## 🚀 主要特点

<table>
<tr>
<td width="50%" valign="top">

### 📊 统一用量仪表盘

在侧边栏面板中并排实时监控 Claude Code、Codex CLI、Gemini CLI 和 Antigravity CLI。可用时，kmux 会从各服务商的本地记录汇总用量和状态；生命周期 hooks 只用于实时状态和通知。

提供每日热力图、今日支出、最高支出模型以及按项目划分的热点等实用洞察，取代繁琐的 `usage` 命令行，用一个实时直观的仪表盘实现一切可视化。

</td>
<td width="50%" valign="top">

<img src="./docs/assets/readme/usage-dashboard.png" alt="统一用量仪表盘" width="100%">

</td>
</tr>
<tr>
<td width="50%" valign="top">

<img src="./docs/assets/readme/session-history.png" alt="跨助手会话历史" width="100%">

</td>
<td width="50%" valign="top">

### 🕘 跨助手会话历史

kmux 会自动索引这四个助手的本地会话记录（Claude: `~/.claude/projects`，Codex: `~/.codex/sessions`，Gemini: `~/.gemini/tmp`，Antigravity: `~/.gemini/antigravity-cli`），并在一个可过滤的侧边栏面板中集中呈现。

只需点击任意一行即可瞬间恢复对应会话。如果已打开相同 `cwd`（工作目录）的现有窗口，kmux 会聚焦于该窗口；否则，它会立即启动一个全新工作区并自动为你执行 `claude --resume`、`codex resume`、`gemini --resume` 或 `agy --conversation`。

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🌳 工作树 (Worktree) 工作区

右键点击任意工作区并选择 **Convert to Worktree Workspace** 即可将其锁定到一个全新的 `git worktree`。现在，两个助手可以同时独立安全地编辑同一个仓库的不同分支，而无需担心工作目录冲突。

kmux 能完美追踪分支名称、未提交状态（dirty state）和工作树删除状态等生命周期。当删除包含未提交更改的工作树时，它会弹出确认对话框以彻底防止工作成果丢失。

</td>
<td width="50%" valign="top">

<img src="./docs/assets/readme/worktree-workspace.png" alt="工作树工作区" width="100%">

</td>
</tr>
</table>

<br>

### 专业终端级别的全套内置功能

- **分屏 (Split panes) 与窗口标签页 (Surface tabs)** — 将开发服务器、日志和助手 shell 灵活分组在同一个屏幕中
- **智能侧边栏** — 自动检测每个工作区的 `cwd`、git 分支、活动端口和未读通知徽章
- **工作区持久化** — 在应用重启时自动恢复先前的布局和屏幕状态
- **命令面板** (`⌘ ⇧ P`)、终端内搜索 (`⌘ F`)、支持 Vim 风格的快捷复制模式
- **原生 macOS UI** — 完美融合的标题栏、精心定制的暗黑模式、针对 Retina 视网膜屏幕优化渲染的终端

<br>

## 📦 安装方法

<p>
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-arm64.dmg"><img alt="下载 Apple Silicon 版本" src="./docs/assets/readme/download-apple-silicon.svg" height="72"></a>
  &nbsp;
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-x64.dmg"><img alt="下载 Intel Mac 版本" src="./docs/assets/readme/download-intel-mac.svg" height="72"></a>
</p>

1. 点击符合您 Mac 配置的按钮（M1/M2/M3/M4 等 Apple Silicon 芯片设备 → 适合 Apple Silicon，旧款 Intel Mac 设备 → 适合 Intel）
2. 打开下载的 `.dmg` 文件，将 **kmux** 拖入您的 `应用程序 (Applications)` 文件夹。
3. 首次启动时，若 macOS 弹出安全确认提示，点击 **打开** 即可继续。

<br>

## 🏁 快速开始

1. 启动 kmux 并按下 `⌘ N` 创建您的第一个工作区。
2. 在终端窗口中运行您需要的编码助手（`claude`、`codex`、`gemini` 或 `agy`）。
3. 按下 `⌘ B` 打开侧边栏，查看 **Usage** 用量仪表盘和 **Sessions** 列表。
4. 再次按下 `⌘ N` 在独立的虚拟工作区中运行另一个助手；或者，如果两个助手需要同时对同一个仓库进行编辑，请右键点击该工作区并选择 **Convert to Worktree Workspace**。
5. 当助手等待输入或完成任务时，系统会发送原生 macOS 通知，且相应的工作区图标上会显示通知徽章。

<br>

## ⌨️ 键盘快捷键

> 所有快捷键均可通过命令面板（`⌘ ⇧ P`）直接运行。

### 工作区 (Workspaces)

| 快捷键    | 功能                   |
| :-------- | :--------------------- |
| `⌘ N`     | 创建新工作区           |
| `⌘ ]`     | 切换至下一个工作区     |
| `⌘ [`     | 切换至上一个工作区     |
| `⌘ 1`–`9` | 切换至指定编号的工作区 |
| `⌘ ⇧ R`   | 重命名工作区           |
| `⌘ ⇧ W`   | 关闭当前工作区         |
| `⌘ B`     | 开/关侧边栏            |

### 分屏 (Panes)

| 快捷键                | 功能                     |
| :-------------------- | :----------------------- |
| `⌘ D`                 | 垂直分屏（向右分屏）     |
| `⌘ ⇧ D`               | 水平分屏（向下分屏）     |
| `⌥ ⌘ ←` `→` `↑` `↓`   | 按方向聚焦到对应的分屏窗 |
| `⌥ ⇧ ⌘ ←` `→` `↑` `↓` | 调整当前分屏窗大小       |
| `⌥ ⌘ K`               | 关闭当前分屏窗           |

### 标签页 (Surface Tabs)

| 快捷键    | 功能                   |
| :-------- | :--------------------- |
| `⌘ T`     | 新建窗口标签页         |
| `⌃ Tab`   | 切换至下一个标签页     |
| `⌃ ⇧ Tab` | 切换至上一个标签页     |
| `⌃ 1`–`9` | 切换至指定编号的标签页 |
| `⌘ W`     | 关闭当前标签页         |
| `⌃ ⌘ W`   | 关闭其他所有标签页     |

### 终端与实用工具 (Terminal & Utilities)

| 快捷键          | 功能                   |
| :-------------- | :--------------------- |
| `⌘ ⇧ P`         | 打开命令面板           |
| `⌘ F`           | 在终端内搜索字符       |
| `⌘ G` / `⌘ ⇧ G` | 查找下一个 / 上一个    |
| `⌘ C` / `⌘ V`   | 复制 / 粘贴            |
| `⌘ ⇧ M`         | Vim 风格的快捷复制模式 |
| `⌘ I`           | 切换开启/关闭通知      |
| `⌘ ⇧ U`         | 开/关用量仪表盘        |
| `⌘ ,`           | 打开设置窗口           |

<br>

## 📚 资源与相关文档

|                     |                                                                                                        |
| :------------------ | :----------------------------------------------------------------------------------------------------- |
| 📖 **产品详细规格** | [docs/product-spec.md](./docs/product-spec.md) — 包含自动化套接字与 CLI 在内的完整功能规格说明书       |
| 🏗️ **架构 ADR**     | [docs/adr/0002-electron-xterm-mvp-architecture.md](./docs/adr/0002-electron-xterm-mvp-architecture.md) |
| 🛠️ **开发指南**     | [docs/development.md](./docs/development.md) — 源码构建、开发迭代与调试指南                            |
| 🤝 **参与贡献**     | [CONTRIBUTING.md](./CONTRIBUTING.md)                                                                   |
| 📜 **行为准则**     | [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)                                                             |
| 🔒 **安全政策**     | [SECURITY.md](./SECURITY.md)                                                                           |

<br>

<div align="center">

---

**kmux** — 让您的 AI 编码助手齐头并进，并排高效运行。

<sub>macOS 专属 · 预发布测试版 · 积极开发中</sub>

</div>
