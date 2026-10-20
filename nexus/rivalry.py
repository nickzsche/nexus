"""Çipler arası ilişki: puanlar (−100…+100), olaylar, araya girme seçimi, arena sonuçları."""
from __future__ import annotations

import random
import threading
import time
from itertools import combinations

from . import chips, settings, store

_FILE = "rivalry.json"
_LOCK = threading.RLock()
MAX_EVENTS = 60
INTERJECT_THRESHOLD = -15
COMBO_THRESHOLD = 60

# başlangıç puanları (çiftin sırası önemsiz)
_RAW = {
    ("atlas", "nova"): 40, ("atlas", "obsidian"): -70, ("atlas", "sentinel"): 30, ("atlas", "forge"): 25,
    ("atlas", "iris"): 20, ("atlas", "pulse"): 30, ("atlas", "ledger"): 20, ("atlas", "oracle"): 35, ("atlas", "glitch"): -10,
    ("nova", "obsidian"): -45, ("nova", "sentinel"): 5, ("nova", "forge"): 15, ("nova", "iris"): 25,
    ("nova", "pulse"): 10, ("nova", "ledger"): -5, ("nova", "oracle"): 20, ("nova", "glitch"): 30,
    ("obsidian", "sentinel"): -72, ("obsidian", "forge"): -35, ("obsidian", "iris"): -20, ("obsidian", "pulse"): -30,
    ("obsidian", "ledger"): -25, ("obsidian", "oracle"): -40, ("obsidian", "glitch"): -30,
    ("sentinel", "forge"): -20, ("sentinel", "iris"): 10, ("sentinel", "pulse"): 25, ("sentinel", "ledger"): 5,
    ("sentinel", "oracle"): -15, ("sentinel", "glitch"): -50,
    ("forge", "iris"): 15, ("forge", "pulse"): -25, ("forge", "ledger"): -10, ("forge", "oracle"): 10, ("forge", "glitch"): -20,
    ("iris", "pulse"): 10, ("iris", "ledger"): 0, ("iris", "oracle"): 30, ("iris", "glitch"): 5,
    ("pulse", "ledger"): 5, ("pulse", "oracle"): 0, ("pulse", "glitch"): -35,
    ("ledger", "oracle"): -20, ("ledger", "glitch"): -40,
    ("oracle", "glitch"): -25,
}
BASE: dict[str, int] = {"|".join(sorted(k)): v for k, v in _RAW.items()}

DRAMA = {  # seviye → (araya girme olasılığı, bekleme sn, karşılık verme olasılığı)
    "sakin": (0.0, 0, 0.0),
    "normal": (0.28, 90, 0.5),
    "kaos": (0.65, 20, 0.9),
}

_last_interject = 0.0
_last_spoke: dict[str, float] = {}


def _key(a: str, b: str) -> str:
    return "|".join(sorted((a, b)))


def _data() -> dict:
    d = store.load(_FILE, {})
    d.setdefault("scores", {})
    d.setdefault("events", [])
    return d


def score(a: str, b: str) -> int:
    if a == b:
        return 100
    with _LOCK:
        return int(_data()["scores"].get(_key(a, b), BASE.get(_key(a, b), 0)))


def label(s: int) -> str:
    if s <= -70: return "ezeli düşman"
    if s <= -40: return "düşman"
    if s <= -15: return "gergin"
    if s < 15: return "nötr"
    if s < 50: return "iyi"
    return "kardeş"


def _log_event(d: dict, a: str, b: str, delta: int, reason: str) -> None:
    d["events"].append({"ts": time.time(), "a": a, "b": b, "delta": delta, "reason": reason})
    del d["events"][:-MAX_EVENTS]


def bump(a: str, b: str, delta: int, reason: str = "") -> int:
    """Puanı değiştirir (−100…+100'e sıkıştırılır), olayı kaydeder, yeni puanı döner."""
    if a == b:
        return 100
    with _LOCK:
        d = _data()
        new = max(-100, min(100, score(a, b) + delta))
        d["scores"][_key(a, b)] = new
        _log_event(d, a, b, delta, reason)
        store.save(_FILE, d)
        return new


def win(winner: str, loser: str) -> int:
    return bump(winner, loser, -6, f"{winner.upper()} arenada {loser.upper()}'ı yendi")


def make_peace(a: str, b: str) -> int:
    return bump(a, b, +10, f"{a.upper()} ve {b.upper()} barıştı")


def combo(a: str, b: str) -> bool:
    return a != b and score(a, b) >= COMBO_THRESHOLD


def events(limit: int = 8) -> list[dict]:
    with _LOCK:
        return _data()["events"][-limit:][::-1]


def matrix(keys: tuple[str, ...] | None = None) -> dict[str, dict[str, int]]:
    keys = keys or chips.ORDER
    return {a: {b: score(a, b) for b in keys} for a in keys}


def reset_runtime() -> None:
    global _last_interject
    _last_interject = 0.0
    _last_spoke.clear()


def note_spoke(chip: str, now: float | None = None) -> None:
    _last_spoke[chip] = now if now is not None else time.time()


def _drama() -> tuple[float, int, float]:
    return DRAMA.get(settings.get("drama"), DRAMA["normal"])


def pick_interjector(active: str, text: str, available: list[str] | tuple[str, ...],
                     rng: random.Random | None = None, now: float | None = None) -> str | None:
    """Aktif çiple puanı ≤ −15 olan adaylardan biri; konu adayın alanına değerse ağırlık ×2.5,
    yakın zamanda konuşmuşsa ×0.3. Dostlar asla araya girmez; 'sakin' seviyede hiç girilmez."""
    global _last_interject
    prob, cooldown, _ = _drama()
    now = now if now is not None else time.time()
    rng = rng or random
    if prob <= 0 or now - _last_interject < cooldown:
        return None
    low = text.lower()
    cands: list[tuple[str, float]] = []
    for k in available:
        if k == active or k not in chips.CHIPS:
            continue
        s = score(active, k)
        if s > INTERJECT_THRESHOLD:
            continue
        w = (-s) / 10.0
        if any(word in low for word in chips.get(k).domain):
            w *= 2.5
        if now - _last_spoke.get(k, 0.0) < 60:
            w *= 0.3
        cands.append((k, w))
    if not cands or rng.random() >= prob:
        return None
    pick = rng.choices([c[0] for c in cands], weights=[c[1] for c in cands])[0]
    _last_interject = now
    return pick


def wants_retort(rng: random.Random | None = None) -> bool:
    return (rng or random).random() < _drama()[2]


def prompt_block(chip: str) -> str:
    lines = []
    for other in chips.ORDER:
        if other == chip:
            continue
        s = score(chip, other)
        if abs(s) >= 15:
            note = " (birlikte iyi çalışırsınız)" if combo(chip, other) else ""
            lines.append(f"- {chips.get(other).name}: {label(s)} ({s:+d}){note}")
    recent = [e for e in events(20) if chip in (e["a"], e["b"])][:5]
    out = []
    if lines:
        out.append("Diğer çiplerle ilişkin (üslubuna yansıt, iş yine de yapılır):\n" + "\n".join(lines))
    if recent:
        out.append("Son olaylar:\n" + "\n".join(f"- {e['reason']}" for e in recent))
    return "\n\n".join(out)


def all_pairs() -> list[tuple[str, str]]:
    return list(combinations(chips.ORDER, 2))
