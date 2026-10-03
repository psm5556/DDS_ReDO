# DDS ReDO — Recipe Design Optimization

개발 단계 공정 레시피를 적은 실험으로 찾기 위한 **산포 인지형 능동학습 DOE** 웹앱입니다 (DDS 플랫폼 모듈).
개발 지침은 [`CLAUDE.md`](CLAUDE.md), 현재 상태와 남은 작업은 [`docs/HANDOFF.md`](docs/HANDOFF.md)를 보세요.

## 구조
- `backend/` FastAPI + SQLAlchemy + scikit-learn (GP), 선택적으로 TabPFN
- `frontend/` React + TypeScript + Vite + Plotly

## 로컬 실행 (Windows PowerShell)
```powershell
# 백엔드
cd backend
py -3.11 -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
python -m app.seed --reset          # 개발용 조직·사용자·데모 프로젝트 생성
uvicorn app.main:app --reload --port 8000
python -m pytest -q                 # 테스트

# 프론트엔드 (새 터미널)
cd frontend
npm install
npm run dev                         # http://localhost:5173  (/api 는 8000으로 프록시)
```
개발 환경(`REDO_ENV=dev`, 기본값)에서는 로그인 화면에서 Mock 사용자를 골라 들어갑니다.
데모 계정: 김서연(데모 프로젝트 소유자), 이도윤(실험자), 박지호(열람자·부서 공유 수신), 최유나(다른 사업부).

## 주요 환경변수 (`backend/.env`, 접두사 `REDO_`)
| 변수 | 기본값 | 설명 |
|---|---|---|
| `REDO_ENV` | dev | dev / test / prod (prod에서 Mock 인증이면 기동 거부) |
| `REDO_DATABASE_URL` | sqlite:///./redo.db | PostgreSQL: `postgresql+psycopg://...` |
| `REDO_SECRET_KEY` | dev-only-change-me | 세션 서명 키 (운영 필수) |
| `REDO_AUTH_MODE` | mock | mock / corporate (사내 로그인 연계, 미구현) |
| `REDO_TABPFN_ENABLED` | false | TabPFN 기능 플래그 |
| `REDO_TABPFN_MODEL_PATH` | | 서버에 미리 받아 둔 가중치 파일 경로 |
| `REDO_TABPFN_MODEL_SHA256` | | 가중치 해시 (시작 시 검증) |

## TabPFN (실험적)
`pip install -r requirements-tabpfn.txt` 후 가중치를 서버에 내려받아 경로를 지정합니다. 런타임 자동 다운로드는 하지 않습니다.
패키지의 텔레메트리는 설치 버전 문서에 있는 환경변수로 끄세요. **가중치 라이선스는 버전마다 다르며, 최신 버전은 운영·사내 의사결정 사용에 상용 라이선스가 필요할 수 있습니다. 운영 전 법무 확인 필수** (CLAUDE.md 6.2절).

## 벤치마크
```powershell
cd backend
python -m scripts.benchmark --seeds 5 --iters 6 --batch 4
```
