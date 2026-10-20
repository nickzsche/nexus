"""Çip sistem talimatı: ortak kurallar + karakter + ilişkiler + hafıza + (varsa) ek bağlam."""
from __future__ import annotations

from datetime import datetime

from . import chips, memory, paths, rivalry, settings, story


def _base() -> str:
    return (paths.PROMPTS_DIR / "base.md").read_text(encoding="utf-8").strip()


def system_instruction(chip_key: str, extra: str = "") -> str:
    chip = chips.get(chip_key)
    now = datetime.now().astimezone().strftime("%A %d %B %Y, %H:%M")
    parts = [
        f"Adın {chip.name} ({chip.role}).",
        chip.character,
        _base(),
        f"Şu an: {now}.",
    ]
    user = settings.get("user_name")
    if user:
        parts.append(f"Kullanıcının adı: {user}.")
    if chip.address:
        parts.append(f"Kullanıcıya '{chip.address}' diye hitap et.")
    parts.append("Çalışma klasörü: " + (settings.get("workspace") or "ayarlanmamış") + ".")
    chained = story.disabled_chips()
    if chained:
        parts.append("Zincire vurulmuş (takılamaz) çipler: " + ", ".join(chips.get(k).name for k in chained if k in chips.CHIPS) + ".")
    rel = rivalry.prompt_block(chip_key)
    if rel:
        parts.append(rel)
    mem = memory.prompt_block(chip_key)
    if mem:
        parts.append(mem)
    if extra:
        parts.append(extra)
    return "\n\n".join(parts)
