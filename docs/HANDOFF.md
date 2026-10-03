# 인수인계: 현재 구현 상태와 남은 작업

claude.ai 대화에서 만든 첫 구현을 Claude Code로 이어서 개발하기 위한 문서입니다.
작업 전 `CLAUDE.md`(개발 지침)를 함께 읽으십시오. 작업이 끝날 때마다 이 문서의 상태를 갱신하십시오.

## 현재 상태 요약
| 영역 | 상태 |
|---|---|
| 백엔드 (FastAPI) | 구현 완료, `pytest` 18개 통과 |
| 모델링 (GP, 획득, 검증) | 구현 완료, 합성 데이터로 검증 |
| TabPFN 어댑터 | **코드만 작성, 실제 실행 미검증** (가중치 없는 환경에서 작성) |
| 프론트엔드 (React) | 대부분 작성. **화면 3개 미작성 → 빌드 실패 상태** |
| 사내 로그인 연계 | 구조만 준비 (`backend/app/auth/corporate.py`), 사양 대기 |

## 남은 작업 (우선순위 순)
1. **프론트엔드 미작성 화면 3개** — `frontend/src/App.tsx`가 import하고 있어 현재 `npm run build`가 실패합니다.
   - `pages/RunEntryPage.tsx` (`/projects/:pid/runs/:rid`): QR 스캔으로 들어오는 런 1건 입력 화면.
     `GET /api/projects/{pid}/runs/{rid}`로 불러와 `components/RunCard.tsx`를 그대로 사용하고, 저장은 `POST /api/projects/{pid}/results`.
     저장 후 같은 배치의 다음 미완료 런으로 이동하는 버튼을 둡니다. 태블릿 기준으로 큰 입력칸.
   - `pages/PrintPage.tsx` (`/projects/:pid/print?batch=<id>`): A4 인쇄용 실험 시트. TopBar 없음(`no-print` 클래스, `styles.css`의 `.print-sheet`).
     런 ID, 실행 순서, 인자 계획값(단위·세팅 정밀도), 반복 표시, 응답 기입란(빈 칸), 메모란, **런별 QR 코드**(`qrcode` 패키지, 내용은 `${origin}/projects/{pid}/runs/{runId}`). 상단에 프로젝트명·배치·인쇄일, `window.print()` 버튼.
   - `pages/SharedPage.tsx` (`/shared/:token`): 공유받은 예측 페이지.
     `GET /api/shared/{token}` 응답(프로젝트·인자·응답·best·surface·effects·warnings·validation·raw)을 `RecipeCard`, `TwinMaps`(initial=응답의 surface, `view_simulate`일 때만 `POST /api/shared/{token}/surface`로 축 변경), `EffectsPlots`, `WhatIf`(`POST /api/shared/{token}/predict`)로 표시.
     상단에 소유자, 스냅샷 기준 시각 또는 "실시간", TabPFN이면 "평가용" 표시. 403이면 "접근 권한이 없습니다" + 접근 요청(`POST /api/shared/{token}/request-access`, 메시지 입력), 410이면 철회·만료 안내.
2. `npm run build` 통과 후 브라우저에서 전체 흐름 점검: 로그인 → 데모 프로젝트 → 결과 입력(붙여넣기·자동저장·엑셀 업로드) → 분석 → 제안 → 배치 생성 → 공유 → 다른 계정으로 열람.
   발견한 화면 오류를 고치고, 프론트엔드 E2E 테스트(결과 입력 그리드)를 추가합니다 (CLAUDE.md 10장).
3. 주요 화면 사용성 점검 (CLAUDE.md 7.6절): 실제 엔지니어 3~5명 대상 테스트 계획 작성.
4. 사내 개발 전환 시 작업 (아래 "프로토타입 단순화" 해소).

## 프로토타입 단순화 (CLAUDE.md와 다른 점 — 사내 개발 시 해소)
- **GP 구현**: BoTorch/GPyTorch 대신 scikit-learn GP를 사용 (의존성 경량화). `SurrogateModel` 인터페이스는 지침대로이므로 구현체만 교체하면 됩니다.
  산포 모델은 log(s²)에 **가중 리지 선형 추세 + GP 잔차**를 사용합니다 (반복점이 적을 때 GP 진폭이 0으로 붕괴해 산포가 상수로 추정되는 문제를 막기 위해 추가).
- **DB**: 기본 SQLite, 마이그레이션 없이 `create_all`. 운영은 PostgreSQL + Alembic 도입 필요.
- **비동기 작업 큐 없음**: 모델 계산을 요청 안에서 동기 실행 (데모 규모에서 수 초). 전사 운영 전 작업 큐·사용자별 동시 실행 제한 도입 필요 (CLAUDE.md 8.5절).
- **인자·응답 정의**: 별도 테이블 대신 `Project.config`(JSON, Pydantic 검증)에 저장.
- **범주형·이산 인자, 제약 조건, 다목적(qNEHVI)**: 미구현 (Phase 2).
- **알림, 오프라인 PWA**: 미구현. 결과 입력 화면은 브라우저 localStorage 임시 저장 + 재시도만 구현.
- **접근 요청**: 별도 테이블 없이 감사 로그(`share.access_request`)로 기록.

## 검증되지 않은 것
- TabPFN: `tabpfn` 패키지의 `TabPFNRegressor(model_path=..., n_estimators=..., random_state=...)`, `predict(X, output_type="mean" | "quantiles", quantiles=[...])` 사용을 가정했습니다.
  사내 서버에서 설치 버전 문서로 API를 확인하고, 네트워크 차단 상태에서 로드·예측되는지, 텔레메트리 비활성화가 되는지 테스트를 추가하십시오. 라이선스 확인 전에는 기능 플래그를 켜지 마십시오.
- 프론트엔드 전체: 타입 검사는 미작성 화면 3개를 빼면 통과했지만, 브라우저에서 실행해 보지 않았습니다.

## 데모 데이터 (`python -m app.seed --reset`)
- 조직: 반도체사업부(식각공정개발팀, 증착공정개발팀), 디스플레이사업부, 소재사업부
- 데모 프로젝트 "Poly-Si 식각 레시피 개발 (데모)": 인자 3개(RF 파워, 챔버 압력, Cl₂ 유량), 응답 2개(식각률 목표 320, 규격 300~340 / 균일도 망소).
  모의 공정은 압력이 높고 유량이 낮을수록 산포가 커지도록 설계됨 → 강건 최적이 평균 최적과 다르게 나와야 정상.
  초기 설계 18회 완료, 2차 제안 배치 4건 계획, 증착공정개발팀에 스냅샷 공유.

## 주요 파일
- 모델링: `backend/app/modeling/` (space, design, data, surrogates/{base,gp,variance,tabpfn_model,registry}, objectives, acquisition, validation, surfaces)
- 권한: `backend/app/authz/__init__.py`, 인증: `backend/app/auth/`
- API: `backend/app/routers/` (auth, meta, projects, runs, analysis, sharing)
- 프론트 섹션: `frontend/src/sections/`, 공통 컴포넌트: `frontend/src/components/`, 디자인 토큰: `frontend/src/styles.css` (μ=청록, σ=보라, 모델 불확실성=회청색 점선 — 앱 전체 공통 의미 색상)
