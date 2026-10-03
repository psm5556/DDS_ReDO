"""앱 설정. 환경변수(REDO_ 접두사) 또는 .env 파일로 지정한다."""
from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="REDO_", env_file=".env", extra="ignore")

    env: Literal["dev", "test", "prod"] = "dev"
    database_url: str = "sqlite:///./redo.db"
    secret_key: str = "dev-only-change-me"
    session_cookie: str = "redo_session"
    session_max_age_sec: int = 60 * 60 * 12

    # 인증: mock(개발 전용) | corporate(사내 로그인 연계, 추후 구현)
    auth_mode: Literal["mock", "corporate"] = "mock"
    frontend_origin: str = "http://localhost:5173"

    # 휴지통 보관 기간(일)
    trash_retention_days: int = 30

    # 모델링
    candidate_pool_size: int = 4000
    max_batch_size: int = 12
    loo_max_points: int = 40

    # TabPFN (실험적, 기능 플래그)
    tabpfn_enabled: bool = False
    tabpfn_model_path: str = ""
    tabpfn_model_sha256: str = ""
    tabpfn_n_estimators: int = 8


@lru_cache
def get_settings() -> Settings:
    return Settings()


def validate_settings(s: Settings) -> None:
    """운영 환경에서 위험한 설정이면 기동을 거부한다."""
    if s.env == "prod":
        if s.auth_mode == "mock":
            raise RuntimeError("운영(prod) 환경에서는 Mock 인증을 사용할 수 없습니다. REDO_AUTH_MODE=corporate 로 설정하세요.")
        if s.secret_key == "dev-only-change-me":
            raise RuntimeError("운영 환경에서는 REDO_SECRET_KEY를 반드시 설정해야 합니다.")
