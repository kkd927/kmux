<div align="center">

# kmux

**Claude Code, Codex CLI, Gemini CLI를 나란히 실행하고, 하나도 놓치지 마세요.**

AI 코딩 에이전트를 위한 macOS 워크스페이스: 병렬 세션, 통합 사용량 대시보드, 즉각적인 세션 재개, 워크트리(worktree) 안전 브랜치.

[![CI](https://github.com/kkd927/kmux/actions/workflows/ci.yml/badge.svg)](https://github.com/kkd927/kmux/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/kkd927/kmux?display_name=tag&style=flat&logo=github)](https://github.com/kkd927/kmux/releases/latest)
[![macOS](https://img.shields.io/badge/platform-macOS-000?logo=apple&logoColor=fff)](https://github.com/kkd927/kmux/releases/latest)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-a78bfa)](./CONTRIBUTING.md)

<br>

<a href="README.md">English</a> | <a href="README.ja.md">日本語</a> | <a href="README.zh-CN.md">简体中文</a> | 한국어 | <a href="README.es.md">Español</a>

<br>
<br>

<a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-arm64.dmg"><img alt="Apple Silicon용 다운로드" src="./docs/assets/readme/download-apple-silicon.svg" height="72"></a>
&nbsp;
<a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-x64.dmg"><img alt="Intel Mac용 다운로드" src="./docs/assets/readme/download-intel-mac.svg" height="72"></a>

<br>
<br>

<img src="./docs/assets/readme/hero.png" alt="kmux — AI 코딩 에이전트 워크스페이스" width="1000">

</div>

<br>

## ✨ 왜 kmux인가요?

실무에서 **Claude Code**, **Codex CLI**, **Gemini CLI**를 활발히 사용하기 시작했다면 이미 다음과 같은 불편함을 겪으셨을 겁니다: 3개의 터미널, 3개의 속도 제한(Rate limit), 3개의 세션 기록, 그리고 같은 리포지토리 안에서 에이전트들이 서로의 작업을 방해하지 않도록 안전하게 분리할 수 있는 마땅한 방법이 없다는 점입니다.

**kmux**는 정확히 이러한 에이전트 워크플로우를 해결하기 위해 구축된 macOS 전용 워크스페이스입니다:

- 각 에이전트를 자체 독립된 워크스페이스에 배치하고 병렬로 동시 실행
- 에이전트가 입력을 요청하거나 작업을 완료하면 macOS 시스템 알림 수신
- 단일 사이드바에서 모든 제공자의 통합 사용량과 남은 세션 예산을 실시간 추적
- 마우스 클릭 한 번으로 과거 Claude/Codex/Gemini 세션으로 즉시 복귀
- `git worktree`를 생성하여 두 에이전트가 동일한 리포지토리의 서로 다른 브랜치를 동시에 안전하게 작업하도록 분리

키보드 중심(Keyboard-first)의 키매핑 설계로 홈 로우(Home row)를 벗어나지 않고 모든 워크플로우를 제어할 수 있어, 개발 흐름을 방해하지 않고 도구 본연의 가치에 집중할 수 있도록 돕습니다.

<br>

## 🚀 주요 특징

<table>
<tr>
<td width="50%" valign="top">

### 📊 통합 사용량 대시보드

우측 사이드바 패널에서 Claude Code, Codex CLI, Gemini CLI 사용량을 실시간으로 모니터링하세요. 5시간 세션 윈도우, 주간 사용량, 월별 지출이 모든 제공자에 걸쳐 통합 계산되므로 남은 예산을 즉시 파악할 수 있습니다.

일일 히트맵, 오늘의 지출, 가장 많이 지출한 모델, 프로젝트별 핫스팟 등 다양하고 유용한 인사이트를 제공하여, 번거로운 `usage` 명령어들 대신 단 하나의 라이브 대시보드로 모든 것을 시각화합니다.

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

kmux는 세 에이전트의 로컬 세션 로그(Claude: `~/.claude/projects`, Codex: `~/.codex/sessions`, Gemini: `~/.gemini/tmp`)를 자동으로 인덱싱하여 하나의 필터링 가능한 패널에 통합 제공합니다.

특정 행을 클릭하기만 하면 해당 세션을 바로 복구합니다. kmux는 동일한 `cwd`(작업 디렉토리)의 기존 화면이 열려 있다면 해당 화면에 포커스하고, 그렇지 않으면 새 워크스페이스를 즉시 생성하여 `claude --resume`, `codex resume`, 또는 `gemini --resume`을 실행합니다.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🌳 워크트리(Worktree) 워크스페이스

워크스페이스를 우클릭하고 **Convert to Worktree Workspace**를 선택하면 새 `git worktree`로 고정됩니다. 이제 두 에이전트가 작업 디렉토리를 복잡하게 어지럽히지 않고 동일한 리포지토리의 서로 다른 브랜치를 독립적으로 안전하게 편집할 수 있습니다.

kmux는 브랜치 이름, 변경 사항(dirty state), 워크트리 해제 상태 등 생명주기를 완벽하게 추적하며, 커밋되지 않은 변경 사항이 남아있는 워크트리를 삭제하기 전에 확인 대화 상자를 띄워 작업물의 누락이나 유실을 철저하게 방지합니다.

</td>
<td width="50%" valign="top">

<img src="./docs/assets/readme/worktree-workspace.png" alt="워크트리 워크스페이스" width="100%">

</td>
</tr>
</table>

<br>

### 전문 터미널 수준의 모든 기능 내장

- **분할 창(Split panes) 및 화면 탭(Surface tabs)** — 개발 서버, 로그, 에이전트 쉘을 하나의 화면에 유연하게 그룹화
- **스마트 사이드바** — 워크스페이스별 `cwd`, git 브랜치, 활성 포트, 읽지 않은 알림 배지 자동 감지
- **워크스페이스 영속성** — 앱 재실행 시 레이아웃 및 화면 상태 자동 복원
- **명령 팔레트** (`⌘ ⇧ P`), 터미널 검색 (`⌘ F`), Vim 스타일의 단축키 복사 모드 지원
- **네이티브 macOS UI** — 일체감 있는 타이틀바, 다크 모드 맞춤 디자인, Retina 최적화 터미널 렌더링

<br>

## 📦 설치 방법

<p>
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-arm64.dmg"><img alt="Apple Silicon용 다운로드" src="./docs/assets/readme/download-apple-silicon.svg" height="72"></a>
  &nbsp;
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-x64.dmg"><img alt="Intel Mac용 다운로드" src="./docs/assets/readme/download-intel-mac.svg" height="72"></a>
</p>

1. 사용 중인 Mac 사양에 맞는 버튼을 클릭합니다 (M1/M2/M3/M4 등 Apple Silicon 기기 → Apple Silicon, 구형 Intel Mac 기기 → Intel)
2. 다운로드한 `.dmg` 파일을 열고 **kmux**를 `응용 프로그램(Applications)` 폴더로 끌어다 놓습니다.
3. 최초 실행 시 macOS 보안 확인 팝업창이 뜨면 **열기**를 클릭해 진행합니다.

<br>

## 🏁 빠른 시작

1. kmux를 실행하고 `⌘ N`을 눌러 첫 워크스페이스를 생성합니다.
2. 터미널 창에서 원하는 에이전트(`claude`, `codex`, `gemini` 중 하나)를 실행합니다.
3. `⌘ B`를 눌러 사이드바를 열고 **Usage** 대시보드와 **Sessions** 목록을 확인합니다.
4. `⌘ N`을 다시 눌러 새 에이전트를 독립된 워크스페이스에서 실행하거나, 동일한 리포지토리를 여러 에이전트가 참조할 경우 워크스페이스를 우클릭한 후 **Convert to Worktree Workspace**를 선택합니다.
5. 에이전트가 입력을 기다리거나 작업을 완료하면 macOS 시스템 알림이 발송되고, 해당 워크스페이스 아이콘에 알림 배지가 표시됩니다.

<br>

## ⌨️ 키보드 단축키

> 모든 단축키는 명령 팔레트(`⌘ ⇧ P`)를 통해서도 바로 접근하여 실행할 수 있습니다.

### 워크스페이스 (Workspaces)

| 단축키    | 기능                            |
| :-------- | :------------------------------ |
| `⌘ N`     | 새 워크스페이스 생성            |
| `⌘ ]`     | 다음 워크스페이스로 이동        |
| `⌘ [`     | 이전 워크스페이스로 이동        |
| `⌘ 1`–`9` | 지정한 번호의 워크스페이스로 이동 |
| `⌘ ⇧ R`   | 워크스페이스 이름 변경          |
| `⌘ ⇧ W`   | 워크스페이스 닫기               |
| `⌘ B`     | 사이드바 열기/닫기 토글          |

### 분할 창 (Panes)

| 단축키                | 기능                     |
| :-------------------- | :----------------------- |
| `⌘ D`                 | 세로로 창 분할 (우측)     |
| `⌘ ⇧ D`               | 가로로 창 분할 (하단)     |
| `⌥ ⌘ ←` `→` `↑` `↓`   | 방향키 방향의 분할 창 포커스 |
| `⌥ ⇧ ⌘ ←` `→` `↑` `↓` | 분할 창 크기 조절         |
| `⌥ ⌘ K`               | 분할 창 닫기             |

### 화면 탭 (Surface Tabs)

| 단축키    | 기능                       |
| :-------- | :------------------------- |
| `⌘ T`     | 새 화면 탭 생성            |
| `⌃ Tab`   | 다음 화면으로 이동         |
| `⌃ ⇧ Tab` | 이전 화면으로 이동         |
| `⌃ 1`–`9` | 지정한 번호의 화면으로 이동 |
| `⌘ W`     | 화면 닫기                  |
| `⌃ ⌘ W`   | 다른 화면들 모두 닫기      |

### 터미널 및 유틸리티 (Terminal & Utilities)

| 단축키          | 기능               |
| :-------------- | :----------------- |
| `⌘ ⇧ P`         | 명령 팔레트 열기   |
| `⌘ F`           | 터미널 내 문자 검색 |
| `⌘ G` / `⌘ ⇧ G` | 다음 / 이전 찾기   |
| `⌘ C` / `⌘ V`   | 복사 / 붙여넣기    |
| `⌘ ⇧ M`         | Vim 스타일 복사 모드 |
| `⌘ I`           | 알림 기능 토글     |
| `⌘ ⇧ U`         | 사용량 대시보드 토글 |
| `⌘ ,`           | 환경설정 창 열기   |

<br>

## 📚 관련 문서 및 리소스

|                          |                                                                                                        |
| :----------------------- | :----------------------------------------------------------------------------------------------------- |
| 📖 **제품 상세 스펙**      | [docs/product-spec.md](./docs/product-spec.md) — 자동화 소켓 및 CLI를 포함한 전체 기능 상세 명세서 |
| 🏗️ **아키텍처 ADR**  | [docs/adr/0002-electron-xterm-mvp-architecture.md](./docs/adr/0002-electron-xterm-mvp-architecture.md) |
| 🛠️ **개발 가이드** | [docs/development.md](./docs/development.md) — 소스 빌드, 개발 주기, 디버깅 가이드                  |
| 🤝 **기여하기**      | [CONTRIBUTING.md](./CONTRIBUTING.md)                                                                   |
| 📜 **행동 강령**   | [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)                                                             |
| 🔒 **보안 정책**   | [SECURITY.md](./SECURITY.md)                                                                           |

<br>

<div align="center">

---

**kmux** — AI 코딩 에이전트를 나란히 편리하게 활용해보세요.

<sub>macOS 전용 · 시험 버전 · 활발히 개발 중</sub>

</div>
