"""Demo beyni: API anahtarı yokken Live yerine çalışır (§6). Ses yoktur.

LiveSession ile aynı yüzeye sahiptir; yazılan metne çipin selamı ve (varsa) bir aracın sonucuyla cevap verir.
HUD'un ve araçların anahtarsız test edilebilmesi için gerekli.
"""
from __future__ import annotations

import asyncio
import re
from typing import Callable

from .. import chips

# (kalıp, araç, argümanlar)
_ROUTES = [
    (re.compile(r"saat|tarih|gün"), "get_time", {}),
    (re.compile(r"hava"), "get_weather", {}),
    (re.compile(r"sistem|cpu|bellek|ram"), "system_info", {}),
    (re.compile(r"zar"), "roll_dice", {}),
    (re.compile(r"yazı tura|yazi tura"), "coin_flip", {}),
]


class FakeBrain:
    model = "demo"

    def __init__(self, *, run_tool: Callable[[str, dict], dict], on_line=lambda w, t, f: None,
                 on_status=lambda s: None, on_turn_complete=lambda: None, on_tool=lambda n, a, r: None, **_ignored) -> None:
        self.run_tool, self.on_line, self.on_status = run_tool, on_line, on_status
        self.on_turn_complete, self.on_tool = on_turn_complete, on_tool
        self.chip_key = ""
        self._running = False

    async def start(self, chip_key: str, extra: str = "") -> None:
        self.chip_key, self._running = chip_key, True
        self.on_status("listening")

    async def stop(self) -> None:
        self._running = False

    @property
    def running(self) -> bool:
        return self._running

    def send_audio(self, pcm: bytes) -> None:       # demoda ses yok
        pass

    def send_audio_end(self) -> None:
        pass

    def send_image(self, jpeg: bytes, note: str = "") -> None:
        self.send_text(note or "Görüntüyü aldım (demo).")

    def send_text(self, text: str) -> None:
        asyncio.get_running_loop().create_task(self._reply(text))

    async def _reply(self, text: str) -> None:
        chip = chips.get(self.chip_key)
        self.on_status("thinking")
        await asyncio.sleep(.25)
        parts = []
        low = text.lower()
        if low.startswith("(sistem notu"):
            parts.append(chip.greeting)
        for pat, tool, args in _ROUTES:
            if pat.search(low) and tool in chip.all_tools():
                result = await asyncio.get_running_loop().run_in_executor(None, self.run_tool, tool, args)
                self.on_tool(tool, args, result)
                parts.append(f"{tool}: {result.get('result', result.get('error'))}")
                break
        if not parts:
            parts.append(f"{chip.greeting} (Demo modu: gerçek konuşma için API anahtarı gerekli.)")
        self.on_status("speaking")
        self.on_line("ai", "".join(parts), True)
        self.on_status("listening")
        self.on_turn_complete()
