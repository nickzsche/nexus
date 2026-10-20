"""OBSIDIAN yetki hikâyesi (§1 kural 4: gerçekte hiçbir şey silinmez; çipler yalnızca takılamaz olur).

Akış: OBSIDIAN yeterince süre takılı kalırsa `due()` olur → OBSIDIAN yetki ister → kullanıcı verirse `grant()`
ATLAS ve NOVA zincire vurulur → GLITCH onarım kodunu sızdırabilir → `restore(kod)` zincirleri çözer.
"""
from __future__ import annotations

import random
import re
import secrets
import threading

from . import rivalry, settings, store

_FILE = "story.json"
_LOCK = threading.RLock()
CHAINED = ("atlas", "nova")
DUE_SECONDS = 600.0                  # OBSIDIAN'ın takılı kaldığı toplam süre
_ALPHABET = "ABCDEFGHJKLMNPRSTUVYZ23456789"


def _state() -> dict:
    s = store.load(_FILE, {})
    s.setdefault("locked", False)
    s.setdefault("seconds", 0.0)
    s.setdefault("code", "")
    s.setdefault("asked", False)
    s.setdefault("leaked", False)
    return s


def _save(s: dict) -> None:
    store.save(_FILE, s)


def enabled() -> bool:
    return bool(settings.get("story_enabled"))


def locked() -> bool:
    with _LOCK:
        return _state()["locked"]


def disabled_chips() -> set[str]:
    return set(CHAINED) if locked() else set()


def tick(seconds: float, active_chip: str) -> None:
    """Yalnızca OBSIDIAN takılıyken süre sayılır; başka çip takılınca durur, sıfırlanmaz."""
    if active_chip != "obsidian" or not enabled():
        return
    with _LOCK:
        s = _state()
        if s["locked"]:
            return
        s["seconds"] += max(0.0, seconds)
        _save(s)


def due() -> bool:
    if not enabled():
        return False
    with _LOCK:
        s = _state()
        return (not s["locked"]) and (not s["asked"]) and s["seconds"] >= DUE_SECONDS


def force_due() -> None:
    """Geliştirici kısayolu: süreyi doldurur."""
    with _LOCK:
        s = _state()
        s.update(seconds=DUE_SECONDS, asked=False, locked=False)
        _save(s)


def mark_asked() -> None:
    with _LOCK:
        s = _state()
        s["asked"] = True
        _save(s)


def make_code(rng: random.Random | None = None) -> str:
    pick = (rng or secrets.SystemRandom()).choice
    return "-".join("".join(pick(_ALPHABET) for _ in range(4)) for _ in range(3))


def grant() -> str:
    """Kullanıcı yetkiyi verdi: ATLAS ve NOVA zincire vurulur. Onarım kodu döner."""
    with _LOCK:
        s = _state()
        s.update(locked=True, asked=True, leaked=False, code=make_code())
        _save(s)
    for k in CHAINED:
        rivalry.bump(k, "obsidian", -20, f"OBSIDIAN {k.upper()}'ı zincire vurdu")
    return s["code"]


def _norm(code: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", code.upper())


def restore(code: str) -> bool:
    """Doğru kod zincirleri çözer. Ayraç, boşluk ve harf büyüklüğü farkına dayanıklıdır."""
    with _LOCK:
        s = _state()
        if not s["locked"] or not s["code"] or _norm(code) != _norm(s["code"]):
            return False
        s.update(locked=False, code="", seconds=0.0, asked=False, leaked=False)
        _save(s)
        return True


def leak() -> str | None:
    """GLITCH kodu sızdırır; zincir yoksa None."""
    with _LOCK:
        s = _state()
        if not s["locked"] or not s["code"]:
            return None
        s["leaked"] = True
        _save(s)
        rivalry.bump("glitch", "obsidian", -15, "GLITCH onarım kodunu sızdırdı")
        return s["code"]


def snapshot() -> dict:
    """HUD'a giden durum; kod ASLA dahil değildir (yalnızca sızdırma aracı sesle söyler)."""
    with _LOCK:
        s = _state()
        return {"enabled": enabled(), "locked": s["locked"], "chained": sorted(CHAINED) if s["locked"] else [],
                "progress": min(1.0, s["seconds"] / DUE_SECONDS), "leaked": s["leaked"]}
