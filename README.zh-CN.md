<div align="center">

# kmux

**专为并排运行 AI 编码助手而优化的多会话终端工作区。**

一款专为 macOS 和 Linux 上的 Claude Code、Codex CLI、Gemini CLI 和 Antigravity CLI 设计的以键盘为中心的终端模拟器。<br>用于管理并行助手会话、监控 API 用量，并通过原生 git worktrees 在不同分支上安全地进行并行开发。

[![CI](https://github.com/kkd927/kmux/actions/workflows/ci.yml/badge.svg)](https://github.com/kkd927/kmux/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/kkd927/kmux?display_name=tag&style=flat&logo=github)](https://github.com/kkd927/kmux/releases/latest)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-a78bfa)](./CONTRIBUTING.md)

<br>

<a href="README.md">English</a> | <a href="README.ja.md">日本語</a> | 简体中文 | <a href="README.ko.md">한국어</a> | <a href="README.es.md">Español</a>

<br>
<br>

<p>
  <strong>macOS</strong><br>
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-arm64.dmg"><img alt="下载 Apple Silicon 版本" src="./docs/assets/readme/download-apple-silicon.svg" height="72"></a>
  &nbsp;
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-x64.dmg"><img alt="下载 Intel Mac 版本" src="./docs/assets/readme/download-intel-mac.svg" height="72"></a>
</p>
<p>
  <strong>Linux</strong><br>
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-linux-x64.AppImage"><img alt="下载 Linux x64 版本" src="./docs/assets/readme/download-linux-x64.svg" height="72"></a>
  &nbsp;
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-linux-arm64.AppImage"><img alt="下载 Linux ARM64 版本" src="./docs/assets/readme/download-linux-arm64.svg" height="72"></a>
</p>

<br>
<br>

<img src="./docs/assets/readme/hero.png" alt="kmux — AI 编码助手终端工作区" width="1000">

</div>

<br>

## ✨ 为什么选择 kmux？

在运行诸如 **Claude Code** 或 **Gemini CLI** 等基于 CLI 的 AI 编码助手的同时还要运行开发服务器，很容易导致终端混乱、会话历史碎片化，并且当多个助手同时写入同一个工作目录时，极易引发 Git 冲突。

**kmux** 通过提供专为助手工作流设计的专用终端工作区来解决这些问题：

- **隔离的并行会话**：通过分屏和垂直标签页同时运行多个助手，避免环境冲突。
- **醒目的通知**：当助手完成任务或等待人工输入时，通过原生桌面通知和工作区徽章第一时间通知您。
- **统一的用量仪表盘**：在单个侧边栏中实时监控所有助手的 Token 消耗和 API 支出。
- **即时恢复会话**：浏览已索引的历史记录，一键恢复以往的助手会话。
- **工作树 (Worktree) 工作区**：自动创建隔离的 `git worktree` 环境，让多个助手可以安全地同时编辑同一个仓库的不同分支。

<br>

## 🚀 主要特点

<table>
<tr>
<td width="50%" valign="top">

### 📊 统一用量仪表盘

在侧边栏面板中并排实时监控 Claude Code、Codex CLI、Gemini CLI 和 Antigravity CLI。kmux 直接从本地会话日志中聚合用量数据，无需在各个终端中输入繁琐的命令，即可通过单个实时可视化仪表盘掌控全局。

提供每日热力图、今日支出、最高支出模型以及按项目划分的热点等洞察。

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

kmux 会自动索引这四个助手的本地会话数据库（Claude: `~/.claude/projects`，Codex: `~/.codex/sessions`，Gemini: `~/.gemini/tmp`，Antigravity: `~/.gemini/antigravity-cli`），并在一个可搜索的侧边栏中呈现。

只需点击会话即可瞬间恢复。如果已打开相同工作目录（`cwd`）的现有标签页，kmux 会自动聚焦；否则，它会启动一个全新分屏并自动运行恢复命令（例如 `claude --resume`、`codex resume` 等）。

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🌳 工作树 (Worktree) 工作区

右键点击任意工作区并选择 **Convert to Worktree Workspace** 即可创建隔离的 `git worktree`。这允许系统同时让多个助手安全独立地编辑同一个仓库的不同分支，而无需担心弄脏主工作树。

kmux 能完美追踪工作树的完整生命周期（分支状态、修改和删除安全检查），确保您的工作成果绝不丢失或成为孤儿。

</td>
<td width="50%" valign="top">

<img src="./docs/assets/readme/worktree-workspace.png" alt="工作树工作区" width="100%">

</td>
</tr>
</table>

<br>

### 🛠️ 专业终端实用功能

- **分屏与窗口标签页** — 在单个工作区中灵活分组合并开发服务器、日志和助手 shell。
- **智能侧边栏** — 自动检测当前工作目录（`cwd`）、git 分支、活动端口和未读通知徽章。
- **布局持久化** — 重启应用时，即时恢复您先前的精确工作区布局、活动标签页和目录。
- **Vim 复制模式与搜索** — 搜索终端缓冲区（`⌘ F`），并支持使用 Vim 风格的快捷键在不碰鼠标的情况下选择和复制文本。
- **命令面板** — 通过 `⌘ ⇧ P` 快捷键，快速访问所有操作和自定义工作区命令。

<br>

## 📦 安装方法

<p>
  <strong>macOS</strong><br>
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-arm64.dmg"><img alt="下载 Apple Silicon 版本" src="./docs/assets/readme/download-apple-silicon.svg" height="72"></a>
  &nbsp;
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-x64.dmg"><img alt="下载 Intel Mac 版本" src="./docs/assets/readme/download-intel-mac.svg" height="72"></a>
</p>
<p>
  <strong>Linux</strong><br>
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-linux-x64.AppImage"><img alt="下载 Linux x64 版本" src="./docs/assets/readme/download-linux-x64.svg" height="72"></a>
  &nbsp;
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-linux-arm64.AppImage"><img alt="下载 Linux ARM64 版本" src="./docs/assets/readme/download-linux-arm64.svg" height="72"></a>
</p>

### macOS

1. 点击符合您 Mac 配置的按钮（M1/M2/M3/M4 等 Apple Silicon 芯片设备 → 适合 Apple Silicon，旧款 Intel Mac 设备 → 适合 Intel）
2. 打开下载的 `.dmg` 文件，将 **kmux** 拖入您的 `应用程序 (Applications)` 文件夹。
3. 首次启动时，若 macOS 弹出安全确认提示，点击 **打开** 即可继续。

### Linux

1. 选择与你的 Linux CPU 匹配的 AppImage（x64 → Intel/AMD 64-bit，ARM64 → ARM 64-bit）。
2. 授予执行权限：`chmod +x kmux-linux-x64.AppImage` 或 `chmod +x kmux-linux-arm64.AppImage`
3. 运行对应文件：`./kmux-linux-x64.AppImage` 或 `./kmux-linux-arm64.AppImage`

<br>

## 🏁 快速开始

1. 启动 kmux 并创建您的第一个工作区（macOS 上为 `⌘ N`）。
2. 在终端窗口中运行您本地安装的编码助手 CLI（`claude`、`codex`、`gemini` 或 `agy`）。
   > 💡 **提示**：kmux 直接运行您系统上已安装的助手 CLI。它不需要您在应用内配置任何 API 密钥或自定义包装。
3. 打开侧边栏（macOS 上为 `⌘ B`），查看 **Usage** 用量仪表盘和 **Sessions** 列表。
4. 创建新工作区来独立运行另一个助手；或者，如果两个助手需要对同一个仓库进行编辑，请右键点击该工作区并选择 **Convert to Worktree Workspace**。
5. 当助手等待输入或完成任务时，系统会发送原生桌面通知，且相应的工作区图标上会显示通知徽章。

<br>

## ⌨️ 键盘快捷键

> 下方快捷键显示的是 macOS 默认值。Linux 使用平台专属的文本快捷键，所有操作也可通过命令面板运行。

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

<sub>macOS + Linux · 预发布测试版 · 积极开发中</sub>

</div>
