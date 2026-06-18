<div align="center">

# kmux

**AIコーディングエージェントの並行実行に最適化されたマルチセッションターミナルワークスペース。**

macOSおよびLinuxにおいて Claude Code、Codex CLI、Gemini CLI、Antigravity CLI を実行するために設計された、キーボード主体のターミナルエミュレータです。<br>並行エージェントセッションの管理、API利用状況の監視、ネイティブな git worktree による安全な複数ブランチでの並行作業を実現します。

[![CI](https://github.com/kkd927/kmux/actions/workflows/ci.yml/badge.svg)](https://github.com/kkd927/kmux/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/kkd927/kmux?display_name=tag&style=flat&logo=github)](https://github.com/kkd927/kmux/releases/latest)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-a78bfa)](./CONTRIBUTING.md)

<br>

<a href="README.md">English</a> | 日本語 | <a href="README.zh-CN.md">简体中文</a> | <a href="README.ko.md">한국어</a> | <a href="README.es.md">Español</a>

<br>
<br>

<p>
  <strong>macOS</strong><br>
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-arm64.dmg"><img alt="Apple Silicon向けダウンロード" src="./docs/assets/readme/download-apple-silicon.svg" height="72"></a>
  &nbsp;
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-x64.dmg"><img alt="Intel Mac向けダウンロード" src="./docs/assets/readme/download-intel-mac.svg" height="72"></a>
</p>
<p>
  <strong>Linux</strong><br>
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-linux-x64.AppImage"><img alt="Linux x64向けダウンロード" src="./docs/assets/readme/download-linux-x64.svg" height="72"></a>
  &nbsp;
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-linux-arm64.AppImage"><img alt="Linux ARM64向けダウンロード" src="./docs/assets/readme/download-linux-arm64.svg" height="72"></a>
</p>

<br>
<br>

<img src="./docs/assets/readme/hero.png" alt="kmux — AIコーディングエージェントターミナルワークスペース" width="1000">

</div>

<br>

## ✨ なぜ kmux なのか？

開発サーバーと並行して **Claude Code** や **Gemini CLI** などのCLIベースのAIエージェントを実行すると、ターミナルが乱雑になり、セッション履歴が断片化し、さらには同じ作業ディレクトリへ同時に書き込まれることでGitの競合が発生しやすくなります。

**kmux** は、エージェントのワークフロー向けに専用設計されたターミナルワークスペースを提供することで、これらの課題を解決します：

- **隔離された並行セッション**: 画面分割や垂直タブを活用し、環境の競合なしに複数のエージェントを同時に実行できます。
- **注意を促す通知**: エージェントがタスクを完了した際や、人間の入力を待機している際に、即座にデスクトップ通知やバッジで知らせます。
- **統合利用状況ダッシュボード**: 各エージェントプロバイダーのトークン消費量やAPI支出を、サイドバーの単一のダッシュボードで一元監視できます。
- **セッションの即時再開**: 過去のエージェントセッションのインデックス履歴をブラウズし、ワンクリックでセッションを再開できます。
- **ワークツリー（Worktree）ワークスペース**: 隔離された `git worktree` 環境を自動的に起動し、複数のエージェントが同じリポジトリの異なるブランチを安全に並行編集できるようにします。

<br>

## 🚀 主な特徴

<table>
<tr>
<td width="50%" valign="top">

### 📊 統合利用状況ダッシュボード

右側のサイドバーパネルで、Claude Code、Codex CLI、Gemini CLI、Antigravity CLI を並行して監視します。kmux はローカルのセッションログから直接利用データを取り込むため、各プロバイダー固有のコマンドで確認する手間を省き、単一のリアルタイムビジュアルダッシュボードで一元化できます。

日次ヒートマップ、本日の支出、最も支出の多いモデル、プロジェクトごとのホットスポットを表示します。

</td>
<td width="50%" valign="top">

<img src="./docs/assets/readme/usage-dashboard.png" alt="統合利用状況ダッシュボード" width="100%">

</td>
</tr>
<tr>
<td width="50%" valign="top">

<img src="./docs/assets/readme/session-history.png" alt="クロスエージェントセッション履歴" width="100%">

</td>
<td width="50%" valign="top">

### 🕘 クロスエージェントセッション履歴

kmuxは、4つのエージェントのローカルセッションデータベース（Claude: `~/.claude/projects`、Codex: `~/.codex/sessions`、Gemini: `~/.gemini/tmp`、Antigravity: `~/.gemini/antigravity-cli`）を自動的にインデックス登録し、検索可能なサイドバーに表示します。

セッションをクリックするだけで即座に再開できます。同一の作業ディレクトリ（`cwd`）の既存タブが開いていればそこにフォーカスし、開いていなければ新しいペインを起動して `claude --resume` や `codex resume` などの再開コマンドを自動実行します。

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🌳 ワークツリー（Worktree）ワークスペース

ワークスペースを右クリックして **Convert to Worktree Workspace** を選択すると、隔離された `git worktree` が作成されます。これにより、複数のエージェントがメインの作業ツリーを汚すことなく、同一リポジトリの異なるブランチを独立して安全に並行編集できます。

kmuxは、ブランチ状態、変更状況、削除時の安全確認など、ワークツリーのライフサイクル全体を追跡するため、作業内容の損失や孤立を防ぎます。

</td>
<td width="50%" valign="top">

<img src="./docs/assets/readme/worktree-workspace.png" alt="ワークツリーワークスペース" width="100%">

</td>
</tr>
</table>

<br>

### 🛠️ プロフェッショナル向けターミナル機能

- **分割ペインと画面タブ** — 開発サーバー、ログ、エージェントシェルを単一のワークスペース内に柔軟にグループ化します。
- **スマートサイドバー** — 現在の作業ディレクトリ（`cwd`）、gitブランチ、アクティブポート、未読の通知バッジを自動検出します。
- **レイアウトの永続性** — アプリの再起動時、直前のワークスペースレイアウト、アクティブタブ、作業ディレクトリを自動復元します。
- **Vimコピーモードと検索** — ターミナルバッファの検索（`⌘ F`）や、マウスを使わずにキーボード操作のみでテキストを選択・コピーできるVimスタイルコピーモードに対応しています。
- **コマンドパレット** — `⌘ ⇧ P` を使用して、すべての操作やカスタムワークスペースコマンドに素早くアクセスできます。

<br>

## 📦 インストール方法

<p>
  <strong>macOS</strong><br>
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-arm64.dmg"><img alt="Apple Silicon向けダウンロード" src="./docs/assets/readme/download-apple-silicon.svg" height="72"></a>
  &nbsp;
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-x64.dmg"><img alt="Intel Mac向けダウンロード" src="./docs/assets/readme/download-intel-mac.svg" height="72"></a>
</p>
<p>
  <strong>Linux</strong><br>
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-linux-x64.AppImage"><img alt="Linux x64向けダウンロード" src="./docs/assets/readme/download-linux-x64.svg" height="72"></a>
  &nbsp;
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-linux-arm64.AppImage"><img alt="Linux ARM64向けダウンロード" src="./docs/assets/readme/download-linux-arm64.svg" height="72"></a>
</p>

### macOS

1. お使いのMacの仕様に合ったボタンをクリックします（M1/M2/M3/M4などのApple Silicon搭載機 → Apple Silicon向け、古いIntel Mac搭載機 → Intel向け）
2. ダウンロードした `.dmg` ファイルを開き、**kmux** を「アプリケーション（Applications）」フォルダーにドラッグ＆ドロップします。
3. 初回起動時にmacOSのセキュリティ確認ポップアップが表示された場合は、「開く」をクリックして進めます。

### Linux

1. Linux CPUに合うAppImageを選びます（x64 → Intel/AMD 64-bit、ARM64 → ARM 64-bit）。
2. 実行権限を付与します：`chmod +x kmux-linux-x64.AppImage` または `chmod +x kmux-linux-arm64.AppImage`
3. 対応するファイルを実行します：`./kmux-linux-x64.AppImage` または `./kmux-linux-arm64.AppImage`

<br>

## 🏁 クイックスタート

1. kmuxを起動し、最初のワークスペースを作成します（macOSでは `⌘ N`）。
2. ターミナル内で、ローカルにインストールされているエージェントCLI（`claude`、`codex`、`gemini`、または `agy`）を実行します。
   > 💡 **注意**: kmuxはシステムにすでにインストールされているエージェントCLIを実行します。アプリ側でのAPIキー設定や専用のラッパー設定は不要です。
3. サイドバーを開き（macOSでは `⌘ B`）、**Usage** ダッシュボードと **Sessions** 一覧を確認します。
4. 新しいワークスペースを作成して別のエージェントを実行するか、同じリポジトリを複数のエージェントが参照する場合は、ワークスペースを右クリックして **Convert to Worktree Workspace** を選択します。
5. エージェントが入力を待っているか、タスクを完了すると、ネイティブデスクトップ通知が送信され、該当するワークスペースアイコンにバッジが表示されます。

<br>

## ⌨️ キーボードショートカット

> 以下のショートカットはmacOSのデフォルトです。Linuxではプラットフォーム固有のテキストショートカットを使用し、すべての操作はコマンドパレットからも実行できます。

### ワークスペース (Workspaces)

| ショートカット | アクション                         |
| :------------- | :--------------------------------- |
| `⌘ N`          | 新規ワークスペース作成             |
| `⌘ ]`          | 次のワークスペースへ移動           |
| `⌘ [`          | 前のワークスペースへ移動           |
| `⌘ 1`–`9`      | 指定した番号のワークスペースへ移動 |
| `⌘ ⇧ R`        | ワークスペース名変更               |
| `⌘ ⇧ W`        | ワークスペースを閉じる             |
| `⌘ B`          | サイドバーの表示/非表示を切り替え  |

### 分割ペイン (Panes)

| ショートカット        | アクション                           |
| :-------------------- | :----------------------------------- |
| `⌘ D`                 | 縦に画面を分割（右）                 |
| `⌘ ⇧ D`               | 横に画面を分割（下）                 |
| `⌥ ⌘ ←` `→` `↑` `↓`   | 矢印キー方向の分割ペインへフォーカス |
| `⌥ ⇧ ⌘ ←` `→` `↑` `↓` | 分割ペインのサイズ調整               |
| `⌥ ⌘ K`               | 分割ペインを閉じる                   |

### 画面タブ (Surface Tabs)

| ショートカット | アクション               |
| :------------- | :----------------------- |
| `⌘ T`          | 新規画面タブ作成         |
| `⌃ Tab`        | 次の画面へ移動           |
| `⌃ ⇧ Tab`      | 前の画面へ移動           |
| `⌃ 1`–`9`      | 指定した番号の画面へ移動 |
| `⌘ W`          | 画面を閉じる             |
| `⌃ ⌘ W`        | 他の画面をすべて閉じる   |

### ターミナルとユーティリティ (Terminal & Utilities)

| ショートカット  | アクション                       |
| :-------------- | :------------------------------- |
| `⌘ ⇧ P`         | コマンドパレットを開く           |
| `⌘ F`           | ターミナル内検索                 |
| `⌘ G` / `⌘ ⇧ G` | 次へ / 前へ検索                  |
| `⌘ C` / `⌘ V`   | コピー / ペースト                |
| `⌘ ⇧ M`         | Vimスタイルコピーモード          |
| `⌘ I`           | 通知機能の切り替え               |
| `⌘ ⇧ U`         | 利用状況ダッシュボードの切り替え |
| `⌘ ,`           | 設定画面を開く                   |

<br>

## 📚 関連ドキュメントとリソース

|                             |                                                                                                        |
| :-------------------------- | :----------------------------------------------------------------------------------------------------- |
| 📖 **製品仕様書**           | [docs/product-spec.md](./docs/product-spec.md) — 自動化ソケットとCLIを含むすべての機能詳細仕様書       |
| 🏗️ **アーキテクチャADR**    | [docs/adr/0002-electron-xterm-mvp-architecture.md](./docs/adr/0002-electron-xterm-mvp-architecture.md) |
| 🛠️ **開発ガイド**           | [docs/development.md](./docs/development.md) — ソースからのビルド、開発サイクル、デバッグガイド        |
| 🤝 **貢献について**         | [CONTRIBUTING.md](./CONTRIBUTING.md)                                                                   |
| 📜 **行動規範**             | [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)                                                             |
| 🔒 **セキュリティポリシー** | [SECURITY.md](./SECURITY.md)                                                                           |

<br>

<div align="center">

---

**kmux** — AIコーディングエージェントを並行して便利に活用しましょう。

<sub>macOS + Linux · プレリリース · 活発に開発中</sub>

</div>
