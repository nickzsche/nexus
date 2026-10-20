"""Hafıza: bütün çiplerin ortak bildikleri ve çipe özel notlar. Yerel JSON."""
from __future__ import annotations

import threading
import time

from . import store

_FILE = "memory.json"
_LOCK = threading.RLock()
MAX_ITEMS = 200


def _load() -> dict:
    data = store.load(_FILE, {})
    data.setdefault("shared", [])
    data.setdefault("chips", {})
    return data


def add(text: str, chip: str | None = None) -> None:
    text = text.strip()
    if not text:
        raise ValueError("boş kayıt")
    with _LOCK:
        data = _load()
        bucket = data["shared"] if chip is None else data["chips"].setdefault(chip, [])
        if any(i["text"].lower() == text.lower() for i in bucket):
            return                                   # aynı bilgi iki kez yazılmaz
        bucket.append({"text": text, "ts": time.time()})
        del bucket[:-MAX_ITEMS]
        store.save(_FILE, data)


def delete(match: str, chip: str | None = None) -> int:
    match = match.strip().lower()
    if not match:
        return 0
    with _LOCK:
        data = _load()
        buckets = [data["shared"]] + list(data["chips"].values()) if chip is None else [data["chips"].get(chip, [])]
        removed = 0
        for b in buckets:
            keep = [i for i in b if match not in i["text"].lower()]
            removed += len(b) - len(keep)
            b[:] = keep
        store.save(_FILE, data)
        return removed


def items(chip: str | None = None) -> list[str]:
    with _LOCK:
        data = _load()
        bucket = data["shared"] if chip is None else data["chips"].get(chip, [])
        return [i["text"] for i in bucket]


def prompt_block(chip: str) -> str:
    shared, own = items(None)[-30:], items(chip)[-15:]
    lines = []
    if shared:
        lines.append("Kullanıcı hakkında bildiklerin:\n" + "\n".join(f"- {t}" for t in shared))
    if own:
        lines.append("Senin kendi notların:\n" + "\n".join(f"- {t}" for t in own))
    return "\n\n".join(lines)
