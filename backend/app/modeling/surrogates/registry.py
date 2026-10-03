from __future__ import annotations

from .base import SurrogateModel, SurrogateUnavailable
from .gp import HeteroscedasticGP
from .tabpfn_model import TabPFNSurrogate, tabpfn_status


def create_surrogate(name: str) -> SurrogateModel:
    if name == "gp":
        return HeteroscedasticGP()
    if name == "tabpfn":
        return TabPFNSurrogate()
    raise SurrogateUnavailable(f"알 수 없는 대리모델: {name}")


def surrogate_catalog() -> list[dict]:
    ok, reason = tabpfn_status()
    return [
        {"name": "gp", "label": "Gaussian Process", "available": True, "experimental": False,
         "status": "기본 모델", "decomposition_exact": True},
        {"name": "tabpfn", "label": "TabPFN", "available": ok, "experimental": True,
         "status": reason, "decomposition_exact": False},
    ]
