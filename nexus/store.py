"""Atomik JSON okuma/yazma. Bozuk dosya uygulamayı düşürmez, varsayılana dönülür."""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

from . import paths

_LOCK = threading.RLock()


def _path(name: str) -> Path:
    return paths.DATA_DIR / name


def load(name: str, default: Any) -> Any:
    with _LOCK:
        try:
            return json.loads(_path(name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return default


def save(name: str, data: Any) -> None:
    with _LOCK:
        target = _path(name)
        tmp = target.with_suffix(target.suffix + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, target)
