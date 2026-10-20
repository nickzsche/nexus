"""Basit günlük: dosyaya ve stderr'e yazar. API anahtarlarını maskeler."""
from __future__ import annotations

import re
import sys
import threading
import time

from . import paths

_KEY = re.compile(r"AIza[0-9A-Za-z_\-]{20,}")
_LOCK = threading.Lock()
_MAX = 1_000_000  # bayt; aşınca eski dosya .1'e taşınır


def mask(text: str) -> str:
    return _KEY.sub("AIza…", text)


def log(*parts: object) -> None:
    line = mask(f"{time.strftime('%H:%M:%S')} " + " ".join(str(p) for p in parts))
    try:
        sys.stderr.write(line + "\n")
    except Exception:  # stderr yoksa (pencereli exe) sessizce geç
        pass
    path = paths.DATA_DIR / "nexus.log"
    with _LOCK:
        try:
            if path.exists() and path.stat().st_size > _MAX:
                path.replace(path.with_suffix(".log.1"))
            with path.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError:
            pass
