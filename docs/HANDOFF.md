# 인수인계: 현재 구현 상태와 남은 작업

claude.ai 대화에서 만든 첫 구현을 Claude Code로 이어서 개발하기 위한 문서입니다.
작업 전 `CLAUDE.md`(개발 지침)를 함께 읽으십시오. 작업이 끝날 때마다 이 문서의 상태를 갱신하십시오.

## 현재 상태 요약
| 영역 | 상태 |
|---|---|
| 백엔드 (FastAPI) | 구현 완료, `pytest` 22개 통과 |
| 모델링 (GP, 획득, 검증) | 구현 완료, 합성 데이터로 검증 |
| TabPFN 어댑터 | **코드만 작성, 실제 실행 미검증** (가중치 없는 환경에서 작성) |
| 프론트엔드 (React) | 전 화면 작성·브라우저 점검 완료, `npm run build` 통과, E2E(결과 입력 그리드) 7개 통과 |
| 사내 로그인 연계 | 구조만 준비 (`backend/app/auth/corporate.py`), 사양 대기 |

## 남은 작업 (우선순위 순)
1. ~~프론트엔드 미작성 화면 3개~~ — 완료: `pages/RunEntryPage.tsx`(QR 진입 런 입력, 다음 미완료 런 이동), `pages/PrintPage.tsx`(A4 시트, 런별 QR, 제안 모델 표시), `pages/SharedPage.tsx`(공유 예측, 403 접근 요청 / 410 철회·만료 안내). 타입 검사·빌드만 확인했고 브라우저 점검은 2번에서 합니다.
2. ~~브라우저 전체 흐름 점검 + 결과 입력 그리드 E2E~~ — 완료 (2026-10-03). 고친 것:
   - 결과 입력 그리드: '남은 실험만' 상태에서 자동 저장 시 방금 입력한 행이 사라지고 행 번호가 밀리던 문제 (보이는 행 목록을 필터 변경·재조회 때만 갱신)
   - 다음 실험 제안: 제안점의 μ·σ·규격 확률이 Kriging Believer 가상 관측으로 재적합한 모델에서 나와 실제보다 확실해 보이던 문제 (실제 데이터만으로 적합한 모델로 표시)
   - 사용자 검색: 검색어 없이 전체 사용자 목록을 내주던 API·화면 (개인정보 최소화)
   - 엑셀 업로드 오류 문구에 응답 키 대신 이름 표시, 화면 레이아웃(개요·인쇄 시트·태블릿 탭·런 ID 줄바꿈), 403 문구, React Router v7 경고
   - E2E 실행: `cd frontend; $env:REDO_PYTHON="<python 경로>"; npm run e2e` (별도 `backend/e2e.db`, 포트 8011/5181, 설치된 Chrome 사용)
2-1. ~~배치 구성 가상 관측이 산포 모델에 섞이는 문제~~ — 해결 (2026-10-03, 사용자 확인 후).
   - `TrainingData.virtual`: Kriging Believer 가상 관측은 평균 모델의 관측 수(`n`)에만 들어가고, 표본분산(`s2`)·반복 수(`n_real`)·산포 모델에서는 제외
   - 진행 중 런과 같은 조건이 다시 제안되면 '반복'으로 표시하고 이유를 안내
   - 합성 벤치마크(40 시드, 대응 비교): regret 차이 없음 (평균 +0.004, Wilcoxon p=0.89). 벤치마크에는 진행 중 런이 없어 주된 개선 상황(부분 완료 배치)은 반영되지 않음 → 6.3-3 그림자 모드·과거 데이터 재현에서 확인 필요
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
- 프론트엔드 전체: `npm run build`(tsc + vite)는 통과했지만, 브라우저에서 실행해 보지 않았습니다.

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
