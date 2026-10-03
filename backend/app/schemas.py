"""API 스키마 및 프로젝트 설정 검증."""
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

KEY_PATTERN = r"^[a-z][a-z0-9_]{0,39}$"


class FactorDef(BaseModel):
    key: str = Field(pattern=KEY_PATTERN)
    name: str = Field(min_length=1, max_length=100)
    unit: str = ""
    low: float
    high: float
    step: float = Field(gt=0, description="세팅 가능한 정밀도 (예: 1 → 1 단위로만 세팅 가능)")
    scale: Literal["linear", "log"] = "linear"

    @model_validator(mode="after")
    def _check(self) -> "FactorDef":
        if self.high <= self.low:
            raise ValueError(f"'{self.name}'의 상한이 하한보다 커야 합니다.")
        if self.scale == "log" and self.low <= 0:
            raise ValueError(f"'{self.name}'은 로그 스케일이므로 하한이 0보다 커야 합니다.")
        if (self.high - self.low) / self.step < 2:
            raise ValueError(f"'{self.name}'의 범위가 세팅 정밀도에 비해 너무 좁습니다.")
        return self


class ResponseDef(BaseModel):
    key: str = Field(pattern=KEY_PATTERN)
    name: str = Field(min_length=1, max_length=100)
    unit: str = ""
    goal: Literal["maximize", "minimize", "target"] = "maximize"
    target: float | None = None
    lsl: float | None = None
    usl: float | None = None
    input_min: float | None = None  # 입력 허용 범위(오타 검출용)
    input_max: float | None = None
    decimals: int = Field(default=3, ge=0, le=8)

    @model_validator(mode="after")
    def _check(self) -> "ResponseDef":
        if self.goal == "target" and self.target is None:
            raise ValueError(f"'{self.name}'은 목표값(망목) 특성이므로 목표값을 입력해야 합니다.")
        if self.lsl is not None and self.usl is not None and self.lsl >= self.usl:
            raise ValueError(f"'{self.name}'의 규격 하한(LSL)이 상한(USL)보다 작아야 합니다.")
        if self.goal == "target" and self.target is not None:
            if (self.lsl is not None and self.target < self.lsl) or (self.usl is not None and self.target > self.usl):
                raise ValueError(f"'{self.name}'의 목표값이 규격 범위 밖에 있습니다.")
        return self


class ProjectSettings(BaseModel):
    mode: Literal["explore", "optimize", "robust"] = "robust"
    robust_objective: Literal["spec_prob", "taguchi", "mean_k_sigma"] = "spec_prob"
    k_sigma: float = Field(default=2.0, ge=0, le=6)
    batch_size: int = Field(default=4, ge=1, le=24)
    budget_runs: int = Field(default=40, ge=1, le=10000)
    default_surrogate: Literal["gp", "tabpfn"] = "gp"
    design_method: Literal["sobol", "lhs"] = "sobol"
    initial_points: int | None = Field(default=None, ge=2, le=500)
    replicate_fraction: float = Field(default=0.25, ge=0, le=1)
    replicates_per_point: int = Field(default=3, ge=2, le=10)
    primary_response: str | None = None


class ProjectConfig(BaseModel):
    factors: list[FactorDef] = Field(min_length=1, max_length=20)
    responses: list[ResponseDef] = Field(min_length=1, max_length=10)
    settings: ProjectSettings = ProjectSettings()

    @model_validator(mode="after")
    def _check(self) -> "ProjectConfig":
        fk = [f.key for f in self.factors]
        rk = [r.key for r in self.responses]
        if len(set(fk)) != len(fk):
            raise ValueError("인자 키가 중복되었습니다.")
        if len(set(rk)) != len(rk):
            raise ValueError("응답 키가 중복되었습니다.")
        if self.settings.primary_response is None:
            self.settings.primary_response = rk[0]
        elif self.settings.primary_response not in rk:
            raise ValueError("주 응답(primary_response)이 응답 목록에 없습니다.")
        if self.settings.robust_objective == "spec_prob":
            r = self.response(self.settings.primary_response)
            if r.lsl is None and r.usl is None and self.settings.mode == "robust":
                self.settings.robust_objective = "taguchi" if r.goal == "target" else "mean_k_sigma"
        return self

    def response(self, key: str) -> ResponseDef:
        for r in self.responses:
            if r.key == key:
                return r
        raise KeyError(key)

    def recommended_initial_points(self) -> int:
        d = len(self.factors)
        return max(2 * d + 2, 10)


# ---------- 사용자 ----------
class UserOut(BaseModel):
    id: int
    user_key: str
    name: str
    email: str | None = None
    department: str | None = None
    department_id: int | None = None
    business_unit: str | None = None
    business_unit_id: int | None = None
    system_role: str


class OrgUnitOut(BaseModel):
    type: Literal["department", "business_unit"]
    id: int
    name: str


# ---------- 프로젝트 ----------
class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    tags: list[str] = []
    config: ProjectConfig


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    tags: list[str] | None = None
    status: Literal["active", "completed", "archived"] | None = None
    config: ProjectConfig | None = None
    change_reason: str = ""


class ProjectSummary(BaseModel):
    id: int
    name: str
    description: str
    status: str
    tags: list[str]
    owner: UserOut
    business_unit: str | None
    my_role: str
    runs_total: int
    runs_done: int
    runs_open: int
    batches: int
    updated_at: datetime
    deleted_at: datetime | None = None
    primary_response: str | None = None


class ProjectDetail(ProjectSummary):
    config: ProjectConfig
    warnings: list[str] = []


class MemberIn(BaseModel):
    user_id: int
    role: Literal["editor", "runner", "viewer"]


class MemberOut(BaseModel):
    user: UserOut
    role: str


class TransferIn(BaseModel):
    new_owner_id: int


# ---------- 설계·런 ----------
class InitialDesignIn(BaseModel):
    n_points: int | None = Field(default=None, ge=2, le=500)
    method: Literal["sobol", "lhs"] | None = None
    replicate_fraction: float | None = Field(default=None, ge=0, le=1)
    replicates_per_point: int | None = Field(default=None, ge=2, le=10)
    seed: int = 0


class RunOut(BaseModel):
    id: int
    batch_id: int
    batch_seq: int
    code: str
    replicate_no: int
    run_order: int
    is_replicate_of_existing: bool
    status: str
    planned: dict[str, float]
    actual: dict[str, float]
    fail_reason: str
    deviation_note: str
    reason: str
    values: dict[str, float | None]
    excluded: dict[str, bool]
    notes: dict[str, str]
    updated_at: datetime


class BatchOut(BaseModel):
    id: int
    seq: int
    kind: str
    surrogate: str | None
    acquisition: dict
    note: str
    created_at: datetime
    created_by: str
    runs_total: int
    runs_done: int


class ResultRow(BaseModel):
    run_id: int
    actual: dict[str, float] | None = None
    values: dict[str, float | None] | None = None
    status: Literal["planned", "running", "done", "failed", "infeasible"] | None = None
    fail_reason: str | None = None
    deviation_note: str | None = None
    note: str | None = None


class ResultsIn(BaseModel):
    rows: list[ResultRow]


class ExcludeIn(BaseModel):
    response_key: str
    excluded: bool
    reason: str = Field(min_length=1)


class ManualRunIn(BaseModel):
    points: list[dict[str, float]] = Field(min_length=1)
    note: str = ""
    kind: Literal["manual", "confirmation"] = "manual"


# ---------- 분석 ----------
SurrogateName = Literal["gp", "tabpfn"]


class AnalysisIn(BaseModel):
    response_key: str | None = None
    surrogate: SurrogateName | None = None
    validate_model: bool = True


class SurfaceIn(BaseModel):
    response_key: str | None = None
    surrogate: SurrogateName | None = None
    x_factor: str
    y_factor: str
    fixed: dict[str, float] = {}
    resolution: int = Field(default=35, ge=10, le=80)


class PredictIn(BaseModel):
    response_key: str | None = None
    surrogate: SurrogateName | None = None
    points: list[dict[str, float]] = Field(min_length=1, max_length=200)


class RecommendIn(BaseModel):
    response_key: str | None = None
    surrogate: SurrogateName | None = None
    batch_size: int | None = Field(default=None, ge=1, le=24)
    mode: Literal["explore", "optimize", "robust"] | None = None
    robust_objective: Literal["spec_prob", "taguchi", "mean_k_sigma"] | None = None
    k_sigma: float | None = None
    seed: int = 0


class AcceptProposalIn(BaseModel):
    proposals: list[dict] = Field(min_length=1)
    surrogate: str
    surrogate_version: str = ""
    acquisition: dict = {}
    note: str = ""


class CompareIn(BaseModel):
    response_key: str | None = None


# ---------- 공유 ----------
class ShareCreate(BaseModel):
    target_type: Literal["user", "department", "business_unit", "company"]
    target_id: int | None = None
    permission: Literal["view", "view_simulate"] = "view_simulate"
    mode: Literal["snapshot", "live"] = "snapshot"
    response_key: str | None = None
    surrogate: SurrogateName | None = None
    include_raw: bool = False
    expires_at: datetime | None = None

    @model_validator(mode="after")
    def _check(self) -> "ShareCreate":
        if self.target_type != "company" and self.target_id is None:
            raise ValueError("공유 대상을 선택하세요.")
        return self


class ShareOut(BaseModel):
    id: int
    token: str
    project_id: int
    project_name: str
    target_type: str
    target_id: int | None
    target_label: str
    permission: str
    mode: str
    response_key: str
    surrogate: str
    include_raw: bool
    expires_at: datetime | None
    created_at: datetime
    created_by: str
    revoked_at: datetime | None
    view_count: int = 0
