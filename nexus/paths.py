"""Yollar. Test ve geliştirmede NEXUS_DATA ile veri klasörü değiştirilebilir."""
from __future__ import annotations

import os
import sys
from pathlib import Path

IS_WIN = sys.platform == "win32"
IS_MAC = sys.platform == "darwin"
FROZEN = bool(getattr(sys, "frozen", False))


def _code_root() -> Path:
    if FROZEN:
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)) / "nexus"
    return Path(__file__).resolve().parent


def _data_dir() -> Path:
    override = os.environ.get("NEXUS_DATA")
    if override:
        base = Path(override)
    elif IS_WIN:
        base = Path(os.environ.get("APPDATA", Path.home())) / "NEXUS"
    elif IS_MAC:
        base = Path.home() / "Library" / "Application Support" / "NEXUS"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "nexus"
    base.mkdir(parents=True, exist_ok=True)
    return base


ROOT = _code_root()
DATA_DIR = _data_dir()
WEB_DIR = ROOT / "hud" / "web"
PROMPTS_DIR = ROOT / "prompts"
