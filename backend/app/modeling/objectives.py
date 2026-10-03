"""모드별 목표 함수 (CLAUDE.md 5.4절). 값이 클수록 좋은 점수로 통일한다."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.stats import norm

from ..schemas import ProjectSettings, ResponseDef


@dataclass(frozen=True)
class Objective:
    mode: str              # explore | optimize | robust
    kind: str              # mean | spec_prob | taguchi | mean_k_sigma
    goal: str
    target: float | None
    lsl: float | None
    usl: float | None
    k: float

    @staticmethod
    def build(resp: ResponseDef, st: ProjectSettings, mode: str | None = None, robust_objective: str | None = None,
              k_sigma: float | None = None) -> "Objective":
        mode = mode or st.mode
        kind = "mean"
        crit = getattr(resp, "criterion", "auto")
        if mode != "explore" and crit != "auto" and robust_objective is None:
            # 응답별로 정한 최적화 기준이 있으면 그것을 따른다 (DOE 설정의 응답 표 한 행에서 지정)
            return Objective(mode="robust" if crit != "mean" else "optimize", kind=crit, goal=resp.goal, target=resp.target,
                             lsl=resp.lsl, usl=resp.usl, k=st.k_sigma if k_sigma is None else k_sigma)
        if mode == "robust":
            kind = robust_objective or st.robust_objective
            if kind == "spec_prob" and resp.lsl is None and resp.usl is None:
                kind = "taguchi" if resp.goal == "target" else "mean_k_sigma"
            if kind == "taguchi" and resp.goal != "target":
                kind = "mean_k_sigma"
        return Objective(mode=mode, kind=kind, goal=resp.goal, target=resp.target, lsl=resp.lsl, usl=resp.usl,
                         k=st.k_sigma if k_sigma is None else k_sigma)

    def score(self, mu: np.ndarray, sigma: np.ndarray) -> np.ndarray:
        """평균 mu, 산포 sigma(표준편차)에서의 점수. 브로드캐스팅 지원."""
        if self.kind == "mean":
            if self.goal == "maximize":
                return mu
            if self.goal == "minimize":
                return -mu
            return -np.abs(mu - (self.target or 0.0))
        if self.kind == "spec_prob":
            s = np.maximum(sigma, 1e-12)
            hi = norm.cdf((self.usl - mu) / s) if self.usl is not None else 1.0
            lo = norm.cdf((self.lsl - mu) / s) if self.lsl is not None else 0.0
            return hi - lo
        if self.kind == "taguchi":
            return -((mu - (self.target or 0.0)) ** 2 + sigma ** 2)
        # mean_k_sigma
        if self.goal == "maximize":
            return mu - self.k * sigma
        if self.goal == "minimize":
            return -(mu + self.k * sigma)
        return -(np.abs(mu - (self.target or 0.0)) + self.k * sigma)

    @property
    def label(self) -> str:
        return {
            "mean": {"maximize": "평균 최대화", "minimize": "평균 최소화", "target": "목표값에 평균 맞추기"}[self.goal],
            "spec_prob": "규격 만족 확률 최대화",
            "taguchi": "품질 손실(목표 편차² + 산포²) 최소화",
            "mean_k_sigma": f"평균{'−' if self.goal == 'maximize' else '+'}{self.k:g}σ 기준 최적화",
        }[self.kind] if self.mode != "explore" else "응답 표면 학습(불확실성 감소)"

    @property
    def score_label(self) -> str:
        return {"mean": "평균 기준 점수", "spec_prob": "규격 만족 확률", "taguchi": "−품질 손실",
                "mean_k_sigma": "강건 점수"}[self.kind]
