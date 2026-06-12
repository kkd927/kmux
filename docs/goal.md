docs/adr/0004-linux-platform-support-and-os-neutral-architecture.md 와 docs/plans/2026-06-10-linux-platform-support-breakdown.md 를 기준으로
kmux의 Linux desktop 지원 및 OS-neutral architecture 구현을 end-to-end로 진행해줘.

목표는 “Linux에서 단순 실행되는 앱”이 아니라, 기존 macOS 앱 동작을 보존하면서 kmux의 주요 agent workflow를 Linux desktop AppImage 앱에서도 완성
도 있게 지원하는 것이다. 특히 terminal output continuity, split pane, surface switch, session restore, multiple agent sessions, hooks,
notifications, usage/subscription, external session discovery/resume, updater, packaging까지 release-scope로 취급해라.

작업 원칙:
- 먼저 ADR 0004와 breakdown 문서를 정독하고, 현재 코드 구조를 확인한 뒤 Phase 순서대로 진행해라.
- 구현 중 문서와 실제 코드가 충돌하면 즉시 근거를 확인하고, 필요한 경우 문서를 보정하거나 구현 계획을 갱신해라.
- 기존 macOS behavior는 compatibility baseline이다. macOS config/runtime path, KMUX_SOCKET_PATH, shell/env/login-shell behavior, hook
  installation, Codex wrapper, terminal restore/split/surface/output continuity가 깨지면 안 된다.
- Linux 지원 때문에 process.platform 분기를 terminal/pane/restore/rendering/agent workflow 코드에 흩뿌리지 말고, ADR의 platform boundary에 맞춰
  main/shared/platform/persistence/ptyProtocol 등 명시적 경계로 이동해라.
- 구현은 milestone/Phase 단위로 작게 진행하고, 각 Phase가 끝날 때마다 자체 코드리뷰를 수행해라. 리뷰는 버그, macOS regression, architecture
  boundary 위반, 테스트 누락, Linux release blocker 누락 순서로 엄격히 확인해라.
- 자체 리뷰에서 발견한 Critical/Important 이슈는 다음 Phase로 넘어가기 전에 직접 수정하고 재검증해라.
- 작업 중 리팩터링은 실제 복잡도 감소, 중복 제거, ADR boundary 정렬, 테스트 가능성 향상에 필요한 범위로 제한해라. 무관한 대규모 정리는 하지 마
  라.
- dirty worktree가 있으면 사용자 변경을 되돌리지 말고, 관련 변경만 조심해서 다뤄라.

진행 순서:
1. Phase 0 Linux spike/fact log
    - Ubuntu Desktop/AppImage/node-pty/updater/hook env/credential/storage/subprocess/GPU/notification 관련 검증 가능한 항목을 먼저 확인해라.
    - 로컬 환경에서 직접 검증할 수 없는 실제 Linux desktop/VM 항목은 fake하지 말고, 정확히 blocked/manual validation으로 기록해라.
    - spike code/config는 disposable로 취급하고, durable output은 fact log와 architecture impact다.

2. Phase 1 socket/path robustness
    - resolveAppPaths() 형태를 Phase 1부터 목표 형태로 도입하고, CLI/desktop socket equality와 side-effect-free resolver를 테스트해라.
    - connect-first socket startup, stale socket handling, explicit runtime isolation, single-instance-lock 판단을 구현/검증해라.

3. Phase 2 platform skeleton
    - macOS behavior-preserving platform boundary를 만든다.
    - unsupported platform handling, renderer descriptor IPC, opener/updater/desktop identity boundary를 추가한다.
    - macOS characterization tests를 먼저 확보하고 유지해라.

4. Phase 3 Linux app paths/storage separation
    - XDG config/runtime/state/data/cache, runtime validation, nativeCacheRoot, rawOutputRoot, diagnostics/capture/attachment roots를 명시적으로
      분리해라.
    - non-socket storage가 XDG_RUNTIME_DIR/KMUX_RUNTIME_DIR/socket dirname에서 파생되지 않도록 고쳐라.
    - node-pty native extraction compatibility decision을 명시적으로 구현하고 테스트해라.

5. Phase 4 shell launch policy/hook runtime env
    - apps/desktop/src/shared/ptyProtocol.ts 를 만들고 ShellLaunchPolicy를 serializable contract로 정의해라.
    - Linux shell preference, shell env recovery, hook runtime env, KMUX_AGENT_BIN_DIR, KMUX_NODE_PATH, wrapper PATH prepend, Codex wrapper 독립
      설치를 구현해라.
7. Walking Skeleton Gate
    - 이 gate를 실제 merge gate처럼 취급해라.
    - Linux dev app launch, CLI/desktop same socket, safe claim, pty spawn through ShellLaunchPolicy, hook env, renderer descriptor, split/
      surface/restore output continuity, macOS tests green을 확인해라.

8. Phase 6 agent storage/credentials/subprocess/watch
    - AgentStorageRoots를 도입하고 usage/external session/hooks/subscription/metadata에 전파해라.
    - Linux에서 macOS security command가 호출되지 않게 하고, verified credential source가 없는 provider는 정상 unavailable state로 처리해라.
      버하게 해라.
    - @kmux/ui와 shared/platform/keyboardPolicy.ts ownership을 중복 없이 유지해라.
    - Linux native chrome, renderer descriptor, font inventory fc-list fallback, xterm cell metrics/output continuity를 검증해라.

10. Phase 8 packaging/updater/desktop identity/notifications
    - 기존 mac package/release check는 유지하고 Linux package/release check를 추가해라.
    - AppImage, latest-linux.yml, electron-updater, desktop file/icon/app id/WM class/notification identity를 구현해라.
    - Linux public publishing은 stable RC gate 전까지 명시적으로 막아라.

11. Phase 9 stable RC validation
    - breakdown의 Required Linux checks와 validation matrix를 기준으로 검증해라.
    - Linux desktop/manual validation이 필요한 항목은 실제 결과 또는 명확한 blocked 상태로 남겨라.
    - 사용자/릴리스 문서까지 업데이트해라.

각 Phase 완료 시 반드시 수행:
- 관련 unit/integration/e2e/package smoke 중 실행 가능한 테스트를 실행해라.
- macOS regression risk가 있는 변경이면 macOS 관련 테스트와 package smoke/check를 우선 검증해라.
- 자체 코드리뷰 결과를 짧게 기록해라: Findings, fixes applied, remaining risk/manual validation.
- 다음 Phase로 넘어가기 전에 docs/plans breakdown 체크리스트와 실제 구현 상태가 어긋나지 않는지 확인해라.

완료 기준:
- ADR 0004의 architectural decisions가 코드에 반영되어야 한다.
- 기존 macOS 앱의 핵심 동작과 테스트가 유지되어야 한다.
- Linux desktop 앱이 kmux 주요 기능을 feature-complete하게 지원해야 한다.
- Linux stable build는 RC gate 통과 전 public publishing되지 않아야 한다.
- renderer/pty-host는 serializable policy/descriptor를 소비하고, main-only service를 직접 가져오지 않아야 한다.
- agent output continuity가 최종 검증의 1급 요구사항으로 남아 있어야 한다.

최종 응답에는 다음을 포함해라:
- 완료된 Phase 목록
- 주요 구현 파일
- 실행한 테스트와 결과
- Linux manual validation이 필요한 항목과 상태
- macOS compatibility 확인 결과
- 남은 release blocker가 있으면 명확히 표시