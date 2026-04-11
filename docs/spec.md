# kmux Electron MVP 기술 명세서

작성일: 2026-04-09

## 1. 제품 정의

`kmux`는 `cmux`와 유사한 멀티워크스페이스 터미널 앱이지만, 이번 브랜치에서는 `Electron + xterm.js + node-pty` 기반의 macOS 우선 MVP로 구현한다.

핵심 목표:

1. 브라우저 없이 `workspace + pane + surface + notification + automation` 완성
2. `cmux.png` 기준의 완성도 높은 macOS형 UI
3. 수십 개 workspace/surface 규모에서 체감 성능 유지
4. renderer가 PTY/session/state source of truth를 소유하지 않는 구조

비목표:

- 내장 브라우저
- SSH relay
- multi-window UI 노출
- Windows 지원

## 2. 아키텍처

구조는 [`0002-electron-xterm-mvp-architecture.md`](/Users/kkd927/Projects/kmux/docs/decisions/0002-electron-xterm-mvp-architecture.md)를 따른다.

프로세스:

- `electron-main`: 단일 writer, persistence, socket API, metadata scheduling
- `pty-host`: `node-pty`와 `@xterm/headless` 기반 session runtime
- `renderer`: visible `xterm.js` mount, split UI, sidebar, overlays

하드 규칙:

- renderer는 PTY를 직접 소유하지 않는다
- hidden surface는 DOM terminal을 유지하지 않는다
- 모든 state mutation은 main reducer를 통해서만 일어난다
- stable `windowId/workspaceId/paneId/surfaceId/sessionId`를 유지한다
- visible-only rendering을 지킨다

## 3. 기능 범위

### 3.1 Workspace

- 생성, 선택, 이름 변경, 닫기
- next/prev, 1..9 direct select
- open folder로 workspace 생성
- sidebar 토글
- workspace switcher
- 순서 persistence

### 3.2 Pane / Surface

- split right/down UI
- split left/right/up/down API
- pane focus 4방향
- pane resize
- pane close
- pane 당 surface 탭 다중 지원
- surface 생성, 포커스, 이름 변경, 닫기, close others, next/prev, 1..9 select

### 3.3 Terminal

- shell launch
- resize
- copy/paste
- IME
- selection
- search/find next/find prev
- copy mode
- OSC 기반 cwd/title/bell 처리
- attach snapshot + incremental output

### 3.4 Sidebar / Notifications

- workspace row name
- cwd/path summary
- git branch
- local ports 최대 3개
- unread badge
- pane attention ring
- status pill
- progress bar
- log feed
- notification center
- latest unread jump

### 3.5 Automation

- CLI
- Unix domain socket JSON-RPC
- `workspace.list/create/select/current/close`
- `surface.split/list/focus/send_text/send_key`
- `notification.create/list/clear`
- `sidebar.set_status/clear_status/set_progress/clear_progress/log/clear_log/sidebar_state`
- `system.ping/capabilities/identify`

## 4. 검증 기준

- `cmux.png`와 동일한 창 크롬, 사이드바, pane header, split geometry, dark palette 유지
- pane body 내용은 기능 검증 대상으로 보고 시각 diff에서는 마스킹 가능
- `npm run test`, `npm run build` 통과
- app launch 후 workspace, split, surface, notification, socket, restore 동작
- 문제 발견 시 수정 후 재검증 반복

## 5. 구현 구조

```text
apps/
  desktop/
    src/main/
    src/preload/
    src/pty-host/
    src/renderer/
packages/
  core/
  proto/
  persistence/
  metadata/
  cli/
  ui/
```

## 6. 환경 변수

- `KMUX_SOCKET_PATH`
- `KMUX_SOCKET_MODE`
- `KMUX_WORKSPACE_ID`
- `KMUX_SURFACE_ID`
- `KMUX_AUTH_TOKEN`
- `TERM_PROGRAM=kmux`

## 7. 우선순위

1. 앱이 실행되고 visible terminals가 붙을 것
2. workspace/pane/surface 상태모델과 persistence가 일관될 것
3. automation과 notifications가 동작할 것
4. `cmux.png`와 시각적으로 유사할 것
