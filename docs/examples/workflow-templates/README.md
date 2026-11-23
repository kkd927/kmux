# 개발자용 재사용 Workflow 템플릿

특정 프로젝트의 테스트 실행본 대신, 실행할 때 작업과 Agent를 입력해 사용하는 UI 편집기 문서다. `workflow`, 노드별 `position`·`definition`, `edges`를 포함한다.

| 템플릿 | UI 가져오기 JSON | 실행 입력 예시 |
|---|---|---|
| 1. 계획 승인 → 구현 → 독립 리뷰 → 수정·재리뷰 | [case1.workflow.json](case1.workflow.json) | [case1.inputs.example.json](case1.inputs.example.json) |
| 2. 병렬 조사·설계 → 합류 구현 → 검증 | [case2.workflow.json](case2.workflow.json) | [case2.inputs.example.json](case2.inputs.example.json) |
| 3. 격리 A/B 구현 → 사용자 선택 → 선택본 병합 | [case3.workflow.json](case3.workflow.json) | [case3.inputs.example.json](case3.inputs.example.json) |
| 4. worktree·환경 준비 → 개발 → 검증 | [case4.workflow.json](case4.workflow.json) | [case4.inputs.example.json](case4.inputs.example.json) |
| 5. Issue 읽기 → 재현 → 수정·리뷰 → 로컬 PR 초안 | [case5.workflow.json](case5.workflow.json) | [case5.inputs.example.json](case5.inputs.example.json) |
| 6. Epic 계획·설계 → 작업 배정 → 통합 리뷰·검증 | [case6.workflow.json](case6.workflow.json) | [case6.inputs.example.json](case6.inputs.example.json) |

## 사용 방법

1. 대상 프로젝트의 workspace에서 **Workflows → New workflow → JSON**을 연다.
2. 원하는 `caseN.workflow.json`의 전체 내용을 붙여넣고 **Design → Save**한다.
3. **Run** 화면에서 작업, 검증 명령과 각 역할의 Agent를 입력한다. 입력 필드 대신 **Edit inputs as JSON**에서 예시 입력을 수정해 사용할 수도 있다.
4. 계획 승인이나 A/B 선택 Gate가 나타나면, 실제 결과를 확인한 사용자가 선택한다.

수정 전 앱 빌드에서는 가져오기 전에 새 Workflow 화면의 `workflow.definitionId`를 복사해 템플릿의 같은 필드에 넣는다. 수정된 로컬 빌드는 저장 대상의 ID를 자동으로 유지한다.

템플릿은 Run 입력을 실제 `inputMappings`로 필요한 Worker와 Shell에 전달한다. 프롬프트의 `{task}` 같은 문자열을 치환하는 방식이 아니다. Worker는 Runtime이 전달한 resolved inputs를 읽는다.

## 공통 입력

| 입력 | 용도 |
|---|---|
| `task` | 수행할 작업 또는 Epic. 5번에서는 Issue가 주 입력이므로 기본 안내 문구가 있다. |
| `acceptanceCriteria` | 완료 조건. 선택 입력이며 비어 있으면 작업 요구사항과 프로젝트 규칙을 기준으로 판단한다. |
| `constraints` | 범위·호환성·수정 제외 사항 등 추가 제약. 선택 입력. |
| `validationCommand` | 현재 프로젝트의 실제 검증 명령. 예: `pytest -q`, `go test ./...`, `npm test`. 필수 입력이며 템플릿에 특정 명령을 고정하지 않았다. |
| `reportDirectory` | 선택 사항인 보고서 저장 디렉터리의 절대 경로. 비워 두면 별도 파일 없이 전체 유용한 결과를 완료 결과에 반환한다. 지정할 때는 작업 트리 밖의 디렉터리를 사용한다. |
| `…Agent` | 역할별 실행 Agent. Run 화면에서 선택한다. 템플릿에는 provider·모델·thinking level을 고정하지 않았으며 선택한 Agent의 기존 설정을 사용한다. |

입력 예시의 `npm test`, `npm ci`, Agent 값 등은 설명용이다. 사용 중인 프로젝트와 설치된 Agent에 맞춰 바꾼다. 예시 값은 템플릿의 기본값으로 실행되지 않는다.

## 템플릿별 동작

### 1. 구현·독립 리뷰·재리뷰

읽기 전용 계획 작성 → 사용자의 계획 승인 → 구현 → 독립 리뷰를 수행한다. 수정은 최대 두 번이며 마지막 수정 뒤에는 세 번째 독립 리뷰를 한다. 이전 리뷰의 실제 지적은 Loop carry로 다음 리뷰에 전달된다. 깨끗한 리뷰 뒤에 Shell이 `validationCommand`를 실행한다.

최종 리뷰에도 지적이 남으면 사용자 Gate에서 멈춘다. Gate의 `stop`은 리뷰 통과를 의미하지 않으며 최종 검증 명령을 실행하지 않는다. 기본 한도는 수정 2회·리뷰 3회다.

### 2. 병렬 조사·설계

읽기 전용 조사와 설계를 병렬로 수행하고, 둘 다 완료돼야 구현을 시작한다. 구현자는 두 단계의 전체 유용한 구조화 결과를 모두 받는다. 독립 검증이 실패를 보고하면 개입 Gate에서 멈추고 최종 Shell 검증으로 넘어가지 않는다.

### 3. 격리 A/B 비교

추가 입력 `approachA`, `approachB`에 서로 다른 접근법을 적는다. 같은 작업과 검증 기준을 적용한다.

Git의 깨끗한 공통 기준 커밋이 필요하다. 기존 변경이 있으면 이를 보존한 채 중단하며 자동 stash·commit·reset을 하지 않는다. Runtime이 A/B worktree를 따로 만들고 두 구현이 병렬로 실행된다. 각 구현은 프로젝트에 설정된 Git identity로 자신의 변경만 로컬 commit한다.

실제 사용자 Gate의 A/B 선택에 따라 해당 commit만 원래 checkout으로 병합하고, 대안 worktree와 branch는 보존한다. 충돌이나 기준 커밋 변경은 강제로 처리하지 않는다. `stop`을 선택하면 병합하지 않는다.

### 4. 새 환경 준비

추가 입력 `setupCommand`, `baselineCommand`를 받는다. Runtime이 만든 새 worktree에서 환경 확인 → 의존성·도구 초기화 → 기본 검증 → 구현 → 독립 검증 → 최종 명령 순서로 실행한다.

Shell과 후속 Agent는 동일한 신뢰된 worktree receipt를 전달받는다. 준비 또는 기본 검증 명령이 실패하면 구현을 시작하지 않는다. `setupCommand`에는 프로젝트의 반복 실행 가능한 초기화 절차를 넣는다.

### 5. Issue에서 PR 초안까지

추가 입력 `issue`에 실제 Issue URL·참조 또는 본문을 넣는다. URL·참조를 조회할 때는 선택한 Agent가 사용할 수 있는 인증된 읽기 전용 GitHub 도구가 필요하다. 조회가 불가능하면 내용을 만들어 내지 않고 blocker로 보고한다.

실제 Issue 본문과 재현 결과를 수정·재리뷰·초안 단계까지 전달한다. 재현을 확인하지 못하면 수정과 초안 작성 전에 멈춘다. 수정 뒤에는 독립 리뷰와 최대 두 번의 후속 수정·재리뷰를 거치며, 리뷰 지적이나 검증 명령 실패가 남으면 초안을 작성하지 않는다.

`draftPath`는 생성할 로컬 초안의 경로이며 기본값은 `PR-DRAFT.md`다. 원격 PR 생성·push·댓글 게시 단계는 없다.

### 6. Epic과 여러 작업 패키지

기본 Agent 작업은 일곱 개다: 계획, 설계, 구현 A, 구현 B, 통합, 리뷰, 검증. 계획과 설계를 병렬로 수행하고, 계획자가 실제 저장소에 맞춰 A/B 작업 패키지의 목표·소유 경로·완료 조건을 정의한다. 특정 모듈이나 파일명을 미리 지정하지 않는다.

공유 worktree의 쓰기 충돌을 피하기 위해 구현 A → 구현 B → 통합은 순차 실행한다. 각 패키지는 여러 세부 작업을 묶을 수 있다. 리뷰 지적이 남으면 최종 검증 전에 사용자 개입을 요청한다. 일곱 단계의 재사용 골격이며, 임의 크기의 Epic 의존 그래프를 자동 생성하는 기능은 아니다.

## 결과와 검증 범위

단계 간 전달에 필요한 유용한 내용은 구조화 결과에 포함한다. 일반 단계는 `data.summary`, 리뷰는 구체적인 `findings`, 검증은 `passed`·`checks`·`issues`를 반환한다. 보고서 경로만 전달하고 핵심 내용을 생략하지 않는다.

Gate에서 `stop`으로 끝난 Run은 구현·리뷰·검증 성공을 뜻하지 않는다. `reviewResult`, `verification`, `validation`, `choice`, `prDraft` 등 실제 출력과 skipped 상태를 확인한다.

[템플릿 런타임 테스트](../../../packages/orchestration/src/developerTemplates.test.ts)는 입력 전달, 병렬 작업의 합류, 리뷰 횟수 제한, 선택 분기, 실패 뒤 후속 단계 차단을 검증한다.
