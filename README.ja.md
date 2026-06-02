<div align="center">

# kmux

**Claude Code、Codex CLI、Gemini CLI、Antigravity CLIを並行して実行し、どれひとつ見失うことはありません。**

AIコーディングエージェントのためのmacOSワークスペース：並行セッション、統合利用状況ダッシュボード、即時再開、ワークツリー対応の安全なブランチ。

[![CI](https://github.com/kkd927/kmux/actions/workflows/ci.yml/badge.svg)](https://github.com/kkd927/kmux/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/kkd927/kmux?display_name=tag&style=flat&logo=github)](https://github.com/kkd927/kmux/releases/latest)
[![macOS](https://img.shields.io/badge/platform-macOS-000?logo=apple&logoColor=fff)](https://github.com/kkd927/kmux/releases/latest)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-a78bfa)](./CONTRIBUTING.md)

<br>

<a href="README.md">English</a> | 日本語 | <a href="README.zh-CN.md">简体中文</a> | <a href="README.ko.md">한국어</a> | <a href="README.es.md">Español</a>

<br>
<br>

<a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-arm64.dmg"><img alt="Apple Silicon向けダウンロード" src="./docs/assets/readme/download-apple-silicon.svg" height="72"></a>
&nbsp;
<a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-x64.dmg"><img alt="Intel Mac向けダウンロード" src="./docs/assets/readme/download-intel-mac.svg" height="72"></a>

<br>
<br>

<img src="./docs/assets/readme/hero.png" alt="kmux — AIコーディングエージェントワークスペース" width="1000">

</div>

<br>

## ✨ なぜ kmux なのか？

実務で **Claude Code**、**Codex CLI**、**Gemini CLI**、**Antigravity CLI** を活用し始めたなら、すでに次の問題に直面しているはずです：複数のターミナル、複数のエージェント画面、分散したセッション履歴、そして同じリポジトリ内でエージェント同士が競合しないように安全に分離する適切な方法がないことです。

**kmux** は、まさにこのエージェントのワークフローを解決するために構築されたmacOS専用ワークスペースです：

- 各エージェントを独自の独立したワークスペースに配置し、並行して同時実行
- エージェントが入力を要求した際や、タスクを完了した際にmacOSシステム通知を受信
- 単一のサイドバーで、すべてのプロバイダーの統合利用状況と残りのセッション予算をリアルタイムに追跡
- ワンクリックで過去の Claude/Codex/Gemini/Antigravity セッションに即座に復帰
- `git worktree` を作成し、2つのエージェントが同じリポジトリの異なるブランチを同時に安全に編集できるように分離

キーボードファースト（Keyboard-first）のキーマップ設計により、ホームロー（Home row）から手を離さずにすべてのワークフローを制御でき、開発フローを妨げることなく、ツール本来の価値に集中できます。

<br>

## 🚀 主な特徴

<table>
<tr>
<td width="50%" valign="top">

### 📊 統合利用状況ダッシュボード

右側のサイドバーパネルで、Claude Code、Codex CLI、Gemini CLI、Antigravity CLI を並べて監視します。利用可能なプロバイダーのローカル記録から利用状況と状態を統合し、ライフサイクルフックはライブ状態と通知に集中させます。

日次ヒートマップ、本日の支出、最も支出の多いモデル、プロジェクトごとのホットスポットなどの有用なインサイトを提供し、煩雑な `usage` コマンドの代わりに単一のライブダッシュボードで視覚化します。

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

kmuxは、4つのエージェントのローカルセッション記録（Claude: `~/.claude/projects`、Codex: `~/.codex/sessions`、Gemini: `~/.gemini/tmp`、Antigravity: `~/.gemini/antigravity-cli`）を自動的にインデックス登録し、フィルター可能な単一のパネルに統合して表示します。

特定の行をクリックするだけで、該当セッションを即座に復元します。kmuxは、同一の `cwd`（作業ディレクトリ）の既存の画面が開いていればその画面にフォーカスし、開いていなければ新しいワークスペースを起動して `claude --resume`、`codex resume`、`gemini --resume`、または `agy --conversation` を実行します。

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🌳 ワークツリー（Worktree）ワークスペース

ワークスペースを右クリックして **Convert to Worktree Workspace** を選択すると、新しい `git worktree` にロックされます。これにより、2つのエージェントが作業ディレクトリを乱雑にすることなく、同一リポジトリの異なるブランチを独立して安全に編集できます。

kmuxは、ブランチ名、変更状態（dirty state）、ワークツリーの削除状態などのライフサイクルを完全に追跡し、未コミットの変更が残っているワークツリーを削除する前に確認ダイアログを表示して、作業内容の損失を徹底的に防ぎます。

</td>
<td width="50%" valign="top">

<img src="./docs/assets/readme/worktree-workspace.png" alt="ワークツリーワークスペース" width="100%">

</td>
</tr>
</table>

<br>

### プロフェッショナルなターミナルレベルの機能を内蔵

- **分割ペイン（Split panes）および画面タブ（Surface tabs）** — 開発サーバー、ログ、エージェントシェルを1つの画面に柔軟にグループ化
- **スマートサイドバー** — ワークスペースごとの `cwd`、gitブランチ、アクティブポート、未読の通知バッジを自動検出
- **ワークスペースの永続性** — アプリ再起動時に以前のレイアウトと画面状態を自動復元
- **コマンドパレット**（`⌘ ⇧ P`）、ターミナル内検索（`⌘ F`）、Vimスタイルのコピーモードをサポート
- **ネイティブmacOS UI** — 一体感のあるタイトルバー、ダークモード対応デザイン、Retina最適化ターミナルレンダリング

<br>

## 📦 インストール方法

<p>
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-arm64.dmg"><img alt="Apple Silicon向けダウンロード" src="./docs/assets/readme/download-apple-silicon.svg" height="72"></a>
  &nbsp;
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-x64.dmg"><img alt="Intel Mac向けダウンロード" src="./docs/assets/readme/download-intel-mac.svg" height="72"></a>
</p>

1. お使いのMacの仕様に合ったボタンをクリックします（M1/M2/M3/M4などのApple Silicon搭載機 → Apple Silicon向け、古いIntel Mac搭載機 → Intel向け）
2. ダウンロードした `.dmg` ファイルを開き、**kmux** を「アプリケーション（Applications）」フォルダーにドラッグ＆ドロップします。
3. 初回起動時にmacOSのセキュリティ確認ポップアップが表示された場合は、「開く」をクリックして進めます。

<br>

## 🏁 クイックスタート

1. kmuxを起動し、`⌘ N` を押して最初のワークスペースを作成します。
2. ターミナルウィンドウで、実行したいエージェント（`claude`、`codex`、`gemini`、または `agy`）を実行します。
3. `⌘ B` を押してサイドバーを開き、**Usage** ダッシュボードと **Sessions** 一覧を確認します。
4. `⌘ N` を再度押して別のエージェントを独立したワークスペースで実行するか、同じリポジトリを複数のエージェントが参照する場合は、ワークスペースを右クリックして **Convert to Worktree Workspace** を選択します。
5. エージェントが入力を待っているか、タスクを完了すると、macOSシステム通知が送信され、該当するワークスペースアイコンに通知バッジが表示されます。

<br>

## ⌨️ キーボードショートカット

> すべてのショートカットは、コマンドパレット（`⌘ ⇧ P`）から直接実行することも可能です。

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

<sub>macOS専用 · プレリリース · 活発に開発中</sub>

</div>
