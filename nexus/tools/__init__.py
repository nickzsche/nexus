"""Araç paketi: alt modülleri içe aktarmak araçları kayda alır."""
from __future__ import annotations

from importlib import import_module

from .registry import TOOLS, Context, declarations, run, tool  # noqa: F401

for _m in ("system", "security", "dev", "misc"):
    try:
        import_module(f"{__name__}.{_m}")
    except ModuleNotFoundError as _e:           # henüz yazılmamış modül uygulamayı düşürmez
        if _e.name != f"{__name__}.{_m}":
            raise
