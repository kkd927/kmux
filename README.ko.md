<div align="center">

# kmux

**AI 코딩 에이전트의 병렬 실행에 최적화된 멀티 세션 터미널 워크스페이스.**

macOS와 Linux에서 Claude Code, Codex CLI, Gemini CLI, Antigravity CLI를 위해 설계된 키보드 중심의 터미널 에뮬레이터입니다.<br>여러 에이전트의 실시간 세션 복구, 통합 API 사용량 대시보드, 그리고 안전한 git worktree 격리 환경을 제공합니다.

[![CI](https://github.com/kkd927/kmux/actions/workflows/ci.yml/badge.svg)](https://github.com/kkd927/kmux/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/kkd927/kmux?display_name=tag&style=flat&logo=github)](https://github.com/kkd927/kmux/releases/latest)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-a78bfa)](./CONTRIBUTING.md)

<br>

<a href="README.md">English</a> | <a href="README.ja.md">日本語</a> | <a href="README.zh-CN.md">简体中文</a> | 한국어 | <a href="README.es.md">Español</a>

<br>
<br>

<p>
  <strong>macOS</strong><br>
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-arm64.dmg"><img alt="Apple Silicon용 다운로드" src="./docs/assets/readme/download-apple-silicon.svg" height="72"></a>
  &nbsp;
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-x64.dmg"><img alt="Intel Mac용 다운로드" src="./docs/assets/readme/download-intel-mac.svg" height="72"></a>
</p>
<p>
  <strong>Linux</strong><br>
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-linux-x64.AppImage"><img alt="Linux x64용 다운로드" src="./docs/assets/readme/download-linux-x64.svg" height="72"></a>
  &nbsp;
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-linux-arm64.AppImage"><img alt="Linux ARM64용 다운로드" src="./docs/assets/readme/download-linux-arm64.svg" height="72"></a>
</p>

<br>
<br>

<img src="./docs/assets/readme/hero.png" alt="kmux — AI 코딩 에이전트 터미널 워크스페이스" width="1000">

</div>

<br>

## ✨ 왜 kmux인가요?

실무에서 **Claude Code**나 **Gemini CLI** 같은 CLI 기반 AI 에이전트를 실행해 보면 금방 터미널이 어지러워집니다. 여러 에이전트의 세션 기록은 파편화되며, 동일한 디렉토리에서 여러 에이전트가 코드를 수정하다가 Git 충돌이 발생하기 쉽습니다.

**kmux**는 이러한 에이전트 중심의 개발 흐름을 해결하기 위해 최적화된 터미널 워크스페이스를 제공합니다:

- **안전한 병렬 세션**: 개발 서버, 로그, 에이전트 쉘을 독립된 화면 분할(Split)과 탭으로 구성하여 충돌 없이 동시에 실행합니다.
- **포커스 알림 및 배지**: 에이전트가 작업을 완료하거나 인간의 입력(Prompt)을 기다릴 때 데스크톱 알림과 상태 배지로 즉시 알려줍니다.
- **통합 사용량 대시보드**: 여러 에이전트의 토큰 사용량과 API 누적 지출 비용을 사이드바에서 한눈에 실시간으로 모니터링합니다.
- **원클릭 세션 복구**: 이전에 진행하던 작업 세션을 자동으로 검색하고 클릭 한 번으로 이전 흐름을 그대로 이어갑니다.
- **워크트리(Worktree) 격리**: 동일한 저장소에서 작업하더라도 각각 독립된 `git worktree`를 생성하여 에이전트들이 서로의 소스 코드를 덮어쓰지 않도록 보호합니다.

<br>

## 🚀 주요 특징

<table>
<tr>
<td width="50%" valign="top">

### 📊 통합 사용량 대시보드

우측 사이드바 패널에서 Claude Code, Codex CLI, Gemini CLI, Antigravity CLI를 나란히 모니터링하세요. kmux는 로컬 세션 로그에서 직접 사용량 데이터를 수집하므로, 각 제공자별 터미널 사용량 조회를 번거롭게 실행할 필요 없이 실시간 그래픽 대시보드 하나로 통합 관리할 수 있습니다.

일일 히트맵, 오늘의 지출, 가장 많이 지출한 모델, 프로젝트별 핫스팟 인사이트를 제공합니다.

</td>
<td width="50%" valign="top">

<img src="./docs/assets/readme/usage-dashboard.png" alt="통합 사용량 대시보드" width="100%">

</td>
</tr>
<tr>
<td width="50%" valign="top">

<img src="./docs/assets/readme/session-history.png" alt="교차 에이전트 세션 기록" width="100%">

</td>
<td width="50%" valign="top">

### 🕘 교차 에이전트 세션 기록

kmux는 네 에이전트의 로컬 세션 데이터베이스(Claude: `~/.claude/projects`, Codex: `~/.codex/sessions`, Gemini: `~/.gemini/tmp`, Antigravity: `~/.gemini/antigravity-cli`)를 자동으로 인덱싱하여 검색 가능한 하나의 사이드바 패널로 집중 제공합니다.

특정 행을 클릭하기만 하면 해당 세션을 바로 복구합니다. 동일한 작업 디렉토리(`cwd`)의 기존 화면이 열려 있다면 해당 화면에 포커스하고, 그렇지 않으면 새 분할 창을 생성하여 `claude --resume`, `codex resume` 등의 복구 명령어를 자동으로 실행해 줍니다.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🌳 워크트리(Worktree) 워크스페이스

워크스페이스를 우클릭하고 **Convert to Worktree Workspace**를 선택하여 격리된 `git worktree`를 생성할 수 있습니다. 이제 여러 에이전트가 작업 디렉토리를 어지럽히지 않고 동일한 리포지토리의 서로 다른 브랜치를 동시에 안전하고 독립적으로 편집할 수 있습니다.

kmux는 브랜치 상태, 변경 사항, 워크트리 해제 안전 검사 등 전체 생명주기를 철저히 추적하므로 작업물이 유실되거나 분실되지 않습니다.

</td>
<td width="50%" valign="top">

<img src="./docs/assets/readme/worktree-workspace.png" alt="워크트리 워크스페이스" width="100%">

</td>
</tr>
</table>

<br>

### 🛠️ 전문 터미널 편의 기능

- **분할 창(Split panes) 및 화면 탭(Surface tabs)** — 개발 서버, 로그, 에이전트 쉘을 단일 워크스페이스 내에서 편리하게 그룹화합니다.
- **스마트 사이드바** — 현재 작업 디렉토리(`cwd`), git 브랜치, 활성 포트, 읽지 않은 알림 배지를 자동으로 감지합니다.
- **워크스페이스 영속성** — 앱을 다시 실행하더라도 이전의 화면 레이아웃, 활성 탭, 작업 디렉토리를 그대로 복원합니다.
- **Vim 단축키 복사 및 검색** — 터미널 문자 검색(`⌘ F`) 및 마우스 없이 키보드만으로 텍스트를 선택하고 복사할 수 있는 Vim 스타일 복사 모드를 지원합니다.
- **명령 팔레트** — `⌘ ⇧ P` 단축키로 모든 터미널 작업과 커스텀 워크스페이스 명령을 빠르게 실행할 수 있습니다.

<br>

## 📦 설치 방법

<p>
  <strong>macOS</strong><br>
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-arm64.dmg"><img alt="Apple Silicon용 다운로드" src="./docs/assets/readme/download-apple-silicon.svg" height="72"></a>
  &nbsp;
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-x64.dmg"><img alt="Intel Mac용 다운로드" src="./docs/assets/readme/download-intel-mac.svg" height="72"></a>
</p>
<p>
  <strong>Linux</strong><br>
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-linux-x64.AppImage"><img alt="Linux x64용 다운로드" src="./docs/assets/readme/download-linux-x64.svg" height="72"></a>
  &nbsp;
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-linux-arm64.AppImage"><img alt="Linux ARM64용 다운로드" src="./docs/assets/readme/download-linux-arm64.svg" height="72"></a>
</p>

### macOS

1. 사용 중인 Mac 사양에 맞는 버튼을 클릭합니다 (M1/M2/M3/M4 등 Apple Silicon 기기 → Apple Silicon, 구형 Intel Mac 기기 → Intel)
2. 다운로드한 `.dmg` 파일을 열고 **kmux**를 `응용 프로그램(Applications)` 폴더로 끌어다 놓습니다.
3. 최초 실행 시 macOS 보안 확인 팝업창이 뜨면 **열기**를 클릭해 진행합니다.

### Linux

1. Linux CPU에 맞는 AppImage를 선택합니다(x64 → Intel/AMD 64-bit, ARM64 → ARM 64-bit).
2. 실행 권한을 부여합니다: `chmod +x kmux-linux-x64.AppImage` 또는 `chmod +x kmux-linux-arm64.AppImage`
3. 맞는 파일을 실행합니다: `./kmux-linux-x64.AppImage` 또는 `./kmux-linux-arm64.AppImage`

<br>

## 🏁 빠른 시작

1. kmux를 실행하고 첫 워크스페이스를 생성합니다(macOS에서는 `⌘ N`).
2. 터미널 창에서 로컬에 설치된 에이전트 CLI(`claude`, `codex`, `gemini`, `agy` 중 하나)를 실행합니다.
   > 💡 **참고**: kmux는 사용자의 시스템에 설치되어 있는 에이전트 CLI를 그대로 실행합니다. 앱 자체에 별도의 API 키나 래퍼 설정을 요구하지 않습니다.
3. 사이드바를 열고(macOS에서는 `⌘ B`) **Usage** 대시보드와 **Sessions** 목록을 확인합니다.
4. 새 워크스페이스를 만들어 다른 에이전트를 실행하거나, 동일한 리포지토리를 여러 에이전트가 참조할 경우 워크스페이스를 우클릭한 후 **Convert to Worktree Workspace**를 선택합니다.
5. 에이전트가 입력을 기다리거나 작업을 완료하면 네이티브 데스크톱 알림이 발송되고, 해당 워크스페이스 아이콘에 알림 배지가 표시됩니다.

<br>

## ⌨️ 키보드 단축키

> 아래 단축키는 macOS 기본값입니다. Linux는 플랫폼별 텍스트 단축키를 사용하며, 모든 동작은 명령 팔레트에서도 사용할 수 있습니다.

### 워크스페이스 (Workspaces)

| 단축키    | 기능                              |
| :-------- | :-------------------------------- |
| `⌘ N`     | 새 워크스페이스 생성              |
| `⌘ ]`     | 다음 워크스페이스로 이동          |
| `⌘ [`     | 이전 워크스페이스로 이동          |
| `⌘ 1`–`9` | 지정한 번호의 워크스페이스로 이동 |
| `⌘ ⇧ R`   | 워크스페이스 이름 변경            |
| `⌘ ⇧ W`   | 워크스페이스 닫기                 |
| `⌘ B`     | 사이드바 열기/닫기 토글           |

### 분할 창 (Panes)

| 단축키                | 기능                         |
| :-------------------- | :--------------------------- |
| `⌘ D`                 | 세로로 창 분할 (우측)        |
| `⌘ ⇧ D`               | 가로로 창 분할 (하단)        |
| `⌥ ⌘ ←` `→` `↑` `↓`   | 방향키 방향의 분할 창 포커스 |
| `⌥ ⇧ ⌘ ←` `→` `↑` `↓` | 분할 창 크기 조절            |
| `⌥ ⌘ K`               | 분할 창 닫기                 |

### 화면 탭 (Surface Tabs)

| 단축키    | 기능                        |
| :-------- | :-------------------------- |
| `⌘ T`     | 새 화면 탭 생성             |
| `⌃ Tab`   | 다음 화면으로 이동          |
| `⌃ ⇧ Tab` | 이전 화면으로 이동          |
| `⌃ 1`–`9` | 지정한 번호의 화면으로 이동 |
| `⌘ W`     | 화면 닫기                   |
| `⌃ ⌘ W`   | 다른 화면들 모두 닫기       |

### 터미널 및 유틸리티 (Terminal & Utilities)

| 단축키          | 기능                 |
| :-------------- | :------------------- |
| `⌘ ⇧ P`         | 명령 팔레트 열기     |
| `⌘ F`           | 터미널 내 문자 검색  |
| `⌘ G` / `⌘ ⇧ G` | 다음 / 이전 찾기     |
| `⌘ C` / `⌘ V`   | 복사 / 붙여넣기      |
| `⌘ ⇧ M`         | Vim 스타일 복사 모드 |
| `⌘ I`           | 알림 기능 토글       |
| `⌘ ⇧ U`         | 사용량 대시보드 토글 |
| `⌘ ,`           | 환경설정 창 열기     |

<br>

## 📚 관련 문서 및 리소스

|                       |                                                                                                        |
| :-------------------- | :----------------------------------------------------------------------------------------------------- |
| 📖 **제품 상세 스펙** | [docs/product-spec.md](./docs/product-spec.md) — 자동화 소켓 및 CLI를 포함한 전체 기능 상세 명세서     |
| 🏗️ **아키텍처 ADR**   | [docs/adr/0002-electron-xterm-mvp-architecture.md](./docs/adr/0002-electron-xterm-mvp-architecture.md) |
| 🛠️ **개발 가이드**    | [docs/development.md](./docs/development.md) — 소스 빌드, 개발 주기, 디버깅 가이드                     |
| 🤝 **기여하기**       | [CONTRIBUTING.md](./CONTRIBUTING.md)                                                                   |
| 📜 **행동 강령**      | [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)                                                             |
| 🔒 **보안 정책**      | [SECURITY.md](./SECURITY.md)                                                                           |

<br>

<div align="center">

---

**kmux** — AI 코딩 에이전트를 나란히 편리하게 활용해보세요.

<sub>macOS + Linux · 시험 버전 · 활발히 개발 중</sub>

</div>
