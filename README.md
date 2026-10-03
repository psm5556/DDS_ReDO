# DDS ReDO — Recipe Design Optimization

개발 단계의 공정 레시피를 **적은 실험으로** 찾는 **산포 인지형 능동학습 DOE** 웹앱입니다 (DDS 플랫폼 모듈).
엔지니어는 앱이 제안한 조건으로 실험하고 결과만 입력합니다. 앱은 평균(μ)과 **산포(σ)**를 함께 학습해, 흔들림이 작은(강건한) **추천 레시피**와 **다음에 할 실험**을 제안합니다.

![능동학습 결과 화면](docs/manual/img/12-step2.png)

- **처음 쓰는 분**: [사용 매뉴얼](docs/USER_MANUAL.md) (그림으로 보는 단계별 안내)
- **이 UI 디자인을 다른 프로젝트에 쓰려면**: [DESIGN.md](DESIGN.md) (토큰·컴포넌트·레이아웃·UX 규칙, 복사해 쓰는 [tokens.css](frontend/src/design/tokens.css) + [kit.css](frontend/src/design/kit.css), [미리보기](docs/design/preview.html))
- **개발자**: 개발 지침은 [`CLAUDE.md`](CLAUDE.md), 현재 상태와 남은 작업은 [`docs/HANDOFF.md`](docs/HANDOFF.md)를 보세요.

## 사용 흐름

![사용 흐름](docs/manual/img/00-cycle.png)

1. **DOE 만들기**: 인자·응답·목표를 표로 입력합니다(엑셀 표를 붙여넣어도 됩니다). 이미 해 둔 실험 데이터가 있으면 그 표에서 설정을 자동으로 채울 수 있습니다.
2. **첫 실험 계획**: 앱이 인자 공간을 고르게 덮는 첫 실험(반복 포함)을 만들거나, 기존 데이터를 가져와 시작합니다.
3. **① 실험 데이터 입력**: 실험 시트(QR 포함)를 인쇄해 실험하고, 결과를 엑셀처럼 입력하거나 붙여넣습니다. 입력은 자동 저장됩니다.
4. **② 능동학습 결과**: 추천 레시피, 목표 달성 점수, 응답별 규격 만족 확률을 보고 다음 실험을 확정합니다. 이 과정을 ①→②로 반복합니다.

## 주요 기능

| 영역 | 기능 |
|---|---|
| 모델링 | 이분산 Gaussian Process (평균 GP + log(s²) 산포 GP), 산포·모델 불확실성 분리, LOO 검증(커버리지·RMSE), TabPFN(실험적, 기능 플래그) |
| 최적화 | 다목적(Desirability) 레시피 최적화, 규격 만족 확률·평균∓kσ·품질 손실 기준, 파레토 대안, 후보 풀 기반 획득 + Kriging Believer 배치, 부분 완료 상태에서 다음 제안 |
| 입력 | 엑셀식 그리드(Enter 이동·붙여넣기·드래그 복사), 머리글·런 ID 자동 매칭, 즉시 검증(형식·허용 범위·예측 이탈), 자동 저장·오프라인 임시 저장, 태블릿 카드 입력, QR 실험 시트 |
| 데이터 | 기존 실험 데이터 가져오기(0차, 중복 감지), 기존 데이터에서 DOE 설정 자동 생성, 엑셀(.xlsx) 다운로드 — 사내 보안상 파일 **업로드**는 없음(클립보드 사용) |
| 분석 | 평균·산포·불확실성·확률 지도, 인자별 영향, 모든 응답을 한 번에 보는 조건 시뮬레이션 |
| 협업 | 멤버 역할(소유자·편집자·실험자·열람자), 예측 페이지 공유(사람·부서·사업부·전사, 스냅샷/실시간, 만료·철회·열람 기록), 감사 로그 |
| 화면 | 미니멀 디자인, 다크 모드, 사이드바 너비 조절·접기(Ctrl+B), 주요 작업은 클릭 5번 이내 |
| 보안 | 서버 측 권한 검사(IDOR 차단), 사내 인증 어댑터(Mock은 개발 전용), CSRF 헤더, 외부 CDN·텔레메트리 없음(폰트 포함 모두 번들) |

## 구조
```
backend/    FastAPI + SQLAlchemy(SQLite/PostgreSQL) + scikit-learn(GP), 선택적으로 TabPFN
  app/modeling/   대리모델·획득·다목적 최적화·검증    app/auth, app/authz   인증 어댑터·권한 정책
  app/routers/    API                                    tests/                pytest (API·권한·모델)
frontend/   React + TypeScript + Vite + Plotly
  src/pages, src/guide, src/sections, src/components    e2e/  Playwright E2E
  scripts/manual-shots.mjs  사용 매뉴얼 그림 생성
docs/       HANDOFF.md(진행 상황), USER_MANUAL.md(사용 매뉴얼), manual/img(매뉴얼 그림), design/(UI 키트 미리보기)
DESIGN.md   디자인 시스템 — 다른 프로젝트에 재사용하는 방법
```

## 로컬 실행 (Windows PowerShell)
```powershell
# 백엔드
cd backend
py -3.11 -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
python -m app.seed --reset          # 개발용 조직·사용자·데모 DOE 2개 생성
uvicorn app.main:app --port 8000

# 프론트엔드 (새 터미널)
cd frontend
npm install
npm run dev                         # http://localhost:5173  (/api 는 8000으로 프록시)
```
개발 환경(`REDO_ENV=dev`, 기본값)에서는 로그인 화면에서 Mock 사용자를 골라 들어갑니다.
데모 계정: 김서연(데모 DOE 소유자), 이도윤(실험자), 박지호(열람자·부서 공유 수신), 최유나(다른 사업부).
데모 DOE: **Poly-Si 식각 레시피 개발**(응답 2개, 2차 진행 중), **CMP 슬러리 배합 최적화**(응답 3개, 1차 완료).

> Windows에서는 `uvicorn --reload`가 멈추는 경우가 있어 `--reload` 없이 실행하고, 백엔드 코드를 바꾸면 다시 시작하세요.

## 테스트
```powershell
cd backend;  python -m pytest -q                       # API·권한·모델 테스트
cd frontend; npm run build                             # tsc --strict + 번들
cd frontend; $env:REDO_PYTHON="python"; npm run e2e    # Playwright E2E (별도 e2e.db·포트 8011/5181로 자동 기동, 설치된 Chrome 사용)
```

## 매뉴얼 그림 다시 만들기
화면이 바뀌면 [사용 매뉴얼](docs/USER_MANUAL.md)의 그림을 다시 찍습니다. 개발 DB를 건드리지 않도록 별도 DB·포트를 씁니다.
```powershell
cd backend;  $env:REDO_DATABASE_URL="sqlite:///./manual.db"; python -m app.seed --reset; python -m uvicorn app.main:app --port 8021
cd frontend; $env:REDO_API_TARGET="http://localhost:8021"; npx vite --port 5191 --strictPort
cd frontend; npm run manual:shots                      # docs/manual/img/*.png 생성 (주황색 번호 표시 포함)
```

## 주요 환경변수 (`backend/.env`, 접두사 `REDO_`)
| 변수 | 기본값 | 설명 |
|---|---|---|
| `REDO_ENV` | dev | dev / test / prod (prod에서 Mock 인증이면 기동 거부) |
| `REDO_DATABASE_URL` | sqlite:///./redo.db | PostgreSQL: `postgresql+psycopg://...` |
| `REDO_SECRET_KEY` | dev-only-change-me | 세션 서명 키 (운영 필수) |
| `REDO_AUTH_MODE` | mock | mock / corporate (사내 로그인 연계, 사양 수령 후 구현) |
| `REDO_TABPFN_ENABLED` | false | TabPFN 기능 플래그 |
| `REDO_TABPFN_MODEL_PATH` | | 서버에 미리 받아 둔 가중치 파일 경로 |
| `REDO_TABPFN_MODEL_SHA256` | | 가중치 해시 (시작 시 검증) |

프론트엔드 개발 서버는 `REDO_API_TARGET`(기본 `http://localhost:8000`)으로 `/api`를 프록시합니다.

## TabPFN (실험적)
`pip install -r requirements-tabpfn.txt` 후 가중치를 서버에 내려받아 경로를 지정합니다. 런타임 자동 다운로드는 하지 않습니다.
패키지의 텔레메트리는 설치 버전 문서에 있는 환경변수로 끄세요. **가중치 라이선스는 버전마다 다르며, 최신 버전은 운영·사내 의사결정 사용에 상용 라이선스가 필요할 수 있습니다. 운영 전 법무 확인 필수** (CLAUDE.md 6.2절).

## 벤치마크
```powershell
cd backend
python -m scripts.benchmark --seeds 5 --iters 6 --batch 4
```
