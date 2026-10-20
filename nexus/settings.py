"""Ayarlar. API anahtarı keyring'de durur, settings.json'a yazılmaz."""
from __future__ import annotations

import os
import threading
from typing import Any

from . import store

_SERVICE = "NEXUS"
_USER = "gemini_api_key"
_LOCK = threading.RLock()
_MEMORY_KEY = ""  # keyring yoksa yalnızca bu oturum için

DEFAULTS: dict[str, Any] = {
    "user_name": "",
    "drama": "normal",            # sakin | normal | kaos
    "story_enabled": True,
    "mic_enabled": True,
    "input_device": None,
    "output_device": None,
    "barge_rms": 0.06,
    "voice_overrides": {},
    "fx_intensity": {},           # çip → 0.0–1.5
    "workspace": "",
    "shell_confirm": True,
    "live_models": ["gemini-2.5-flash-native-audio-latest"],     # kullanıcının seçtiği model: Gemini 2.5 Flash Live
    "text_model": "gemini-flash-latest",
    "tts_models": ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"],
    "last_chip": "atlas",
    "onboarded": False,
}
DRAMA_LEVELS = ("sakin", "normal", "kaos")


def _all() -> dict[str, Any]:
    return {**DEFAULTS, **store.load("settings.json", {})}


def get(key: str, default: Any = None) -> Any:
    with _LOCK:
        return _all().get(key, default if default is not None else DEFAULTS.get(key))


def set(key: str, value: Any) -> None:  # noqa: A001 - köprü API'siyle aynı ad
    if key not in DEFAULTS:
        raise KeyError(f"Bilinmeyen ayar: {key}")
    if key == "drama" and value not in DRAMA_LEVELS:
        raise ValueError(f"drama şunlardan biri olmalı: {DRAMA_LEVELS}")
    with _LOCK:
        data = store.load("settings.json", {})
        data[key] = value
        store.save("settings.json", data)


def snapshot() -> dict[str, Any]:
    """HUD'a gönderilen ayarlar; anahtar asla dahil değildir."""
    return _all()


def api_key() -> str:
    env = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if env:
        return env
    try:
        import keyring
        return keyring.get_password(_SERVICE, _USER) or _MEMORY_KEY
    except Exception:
        return _MEMORY_KEY


def set_api_key(key: str) -> None:
    global _MEMORY_KEY
    key = key.strip()
    try:
        import keyring
        if key:
            keyring.set_password(_SERVICE, _USER, key)
        else:
            try:
                keyring.delete_password(_SERVICE, _USER)
            except Exception:
                pass
        _MEMORY_KEY = ""
    except Exception:
        _MEMORY_KEY = key
