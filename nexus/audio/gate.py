"""Mikrofon kapısı: konuşmayı algılar, ortam gürültüsünü süzer ve konuşma bitince hemen haber verir.

Gemini konuşmanın bittiğini varsayılan olarak ~800 ms sessizlik bekleyerek anlar; bunu beklemek yerine
bitişi burada algılayıp `("end",)` ile `audio_stream_end` göndeririz (hibrit VAD). Konuşma yokken Gemini'ye
hiç ses gitmez; başlangıçtan önceki kısa sessizlik (preroll) eklenir, böylece ilk hece kesilmez.
"""
from __future__ import annotations

from collections import deque

Action = tuple  # ("audio", bytes) | ("end",)


class MicGate:
    def __init__(self, start_ms: int = 60, preroll_ms: int = 240, hang_ms: int = 350, min_thr: float = 0.02) -> None:
        self.start_ms, self.preroll_ms, self.hang_ms, self.min_thr = start_ms, preroll_ms, hang_ms, min_thr
        self.reset()

    def reset(self) -> None:
        self.floor = 0.01                 # ortam gürültü tabanı (0–1 rms)
        self.speaking = False
        self._hot_ms = 0
        self._quiet_ms = 0
        self._pre: deque[bytes] = deque()
        self._pre_ms = 0

    def threshold(self, speaker_busy: bool, barge: float) -> float:
        thr = max(self.min_thr, self.floor * 3.4)
        # Hoparlör çalarken yalnızca barge eşiğini belirgin aşan ses gerçek konuşma sayılır (yankı).
        return max(thr * 2.4, barge) if speaker_busy else thr

    def feed(self, pcm: bytes, rms: float, speaker_busy: bool = False, barge: float = 0.06) -> list[Action]:
        ms = len(pcm) * 1000 // 32000                      # 16 kHz mono int16
        loud = rms > self.threshold(speaker_busy, barge)
        out: list[Action] = []
        if not self.speaking:
            self.floor = min(0.08, max(0.003, self.floor * .985 + rms * .015))
            self._pre.append(pcm)
            self._pre_ms += ms
            while self._pre_ms > self.preroll_ms and self._pre:
                self._pre_ms -= len(self._pre.popleft()) * 1000 // 32000
            self._hot_ms = self._hot_ms + ms if loud else 0
            if self._hot_ms >= self.start_ms:
                self.speaking, self._quiet_ms = True, 0
                out += [("audio", c) for c in self._pre]
                self._pre.clear()
                self._pre_ms = 0
        else:
            out.append(("audio", pcm))
            self._quiet_ms = 0 if loud else self._quiet_ms + ms
            if self._quiet_ms >= self.hang_ms:
                self.speaking, self._hot_ms = False, 0
                out.append(("end",))
        return out
