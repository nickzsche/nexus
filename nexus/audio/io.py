"""Ses giriş/çıkışı. Giriş 16 kHz, çıkış 24 kHz, mono int16.

`Speaker` konuşana göre etiketli bir kuyruk çalar (araya girmeler ve çip sesi karışmasın, `clear(who)` ile
yalnızca o konuşanın sesi silinsin). Ses aygıtı yoksa (CI, sunucu, demo) gerçek zamanlı çalışan sessiz bir
yedekle devam eder; uygulama düşmez.
"""
from __future__ import annotations

import io
import threading
import time
import wave
from collections import deque
from typing import Callable

import numpy as np
from scipy import signal

from ..log import log

IN_RATE = 16000
OUT_RATE = 24000
SILENCE = b"\x00\x00" * 320          # 20 ms @ 16 kHz


def devices() -> list[dict]:
    """Seçilebilir ses aygıtları; ses altyapısı yoksa boş liste."""
    try:
        import sounddevice as sd
        out = []
        for i, d in enumerate(sd.query_devices()):
            out.append({"index": i, "name": d["name"], "inputs": d["max_input_channels"], "outputs": d["max_output_channels"]})
        return out
    except Exception as exc:
        log("ses aygıtları okunamadı", repr(exc))
        return []


def pcm_from_wav(wav: bytes) -> tuple[bytes, int]:
    """WAV baytlarından mono int16 PCM ve örnekleme hızı."""
    with wave.open(io.BytesIO(wav)) as w:
        rate, ch, width = w.getframerate(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if width != 2:
        raise ValueError("yalnızca 16 bit WAV destekleniyor")
    a = np.frombuffer(raw, dtype="<i2")
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1).astype(np.int16)
    return a.tobytes(), rate


def resample(pcm: bytes, rate: int, target: int = OUT_RATE) -> bytes:
    if rate == target or not pcm:
        return pcm
    a = np.frombuffer(pcm, dtype="<i2").astype(np.float32)
    g = np.gcd(rate, target)
    y = signal.resample_poly(a, target // g, rate // g)
    return np.clip(y, -32768, 32767).astype("<i2").tobytes()


class Speaker:
    """Etiketli ses kuyruğu. feed(who, pcm) ekler; clear(who=None) siler; busy/who/level okunur."""

    def __init__(self, device: int | None = None, null: bool = False) -> None:
        self._q: deque[list] = deque()             # [who, memoryview]
        self._lock = threading.Lock()
        self._level = 0.0
        self._last_audio = 0.0
        self._who: str | None = None
        self._stream = None
        self._null = null
        self._stop = threading.Event()
        self._device = device

    # -- yaşam döngüsü
    def start(self) -> None:
        if not self._null:
            try:
                import sounddevice as sd
                self._stream = sd.RawOutputStream(samplerate=OUT_RATE, channels=1, dtype="int16", blocksize=480,
                                                  device=self._device, callback=self._callback)
                self._stream.start()
                return
            except Exception as exc:
                log("hoparlör açılamadı, sessiz yedek", repr(exc))
                self._null = True
        threading.Thread(target=self._null_loop, daemon=True, name="speaker-null").start()

    def close(self) -> None:
        self._stop.set()
        if self._stream is not None:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception:
                pass
            self._stream = None

    # -- kuyruk
    def feed(self, who: str, pcm: bytes) -> None:
        if pcm:
            with self._lock:
                self._q.append([who, memoryview(bytearray(pcm))])

    def clear(self, who: str | None = None) -> None:
        with self._lock:
            if who is None:
                self._q.clear()
            else:
                self._q = deque(i for i in self._q if i[0] != who)

    @property
    def busy(self) -> bool:
        with self._lock:
            return bool(self._q) or (time.monotonic() - self._last_audio) < .15

    @property
    def who(self) -> str | None:
        """Sırası gelen ya da şu an çalan konuşan; sessizken None."""
        with self._lock:
            if self._q:
                return self._q[0][0]
        return self._who if (time.monotonic() - self._last_audio) < .15 else None

    @property
    def level(self) -> float:
        return self._level

    def wait_idle(self, timeout: float = 30.0) -> bool:
        end = time.monotonic() + timeout
        while self.busy and time.monotonic() < end:
            time.sleep(.02)
        return not self.busy

    # -- çekirdek
    def _take(self, nbytes: int) -> bytes:
        out = bytearray()
        with self._lock:
            while len(out) < nbytes and self._q:
                who, mv = self._q[0]
                n = min(nbytes - len(out), len(mv))
                out += mv[:n]
                self._who = who
                if n == len(mv):
                    self._q.popleft()
                else:
                    self._q[0][1] = mv[n:]
        return bytes(out).ljust(nbytes, b"\x00")

    def _measure(self, data: bytes) -> None:
        a = np.frombuffer(data, dtype="<i2")
        rms = float(np.sqrt(np.mean(a.astype(np.float32) ** 2))) / 12000 if len(a) else 0.0
        self._level = min(1.0, self._level * .6 + rms * .4)
        if rms > 0.002:
            self._last_audio = time.monotonic()

    def _callback(self, outdata, frames, time_info, status) -> None:     # sounddevice iş parçacığı
        data = self._take(frames * 2)
        outdata[:] = data
        self._measure(data)

    def _null_loop(self) -> None:
        block = 480
        while not self._stop.is_set():
            self._measure(self._take(block * 2))
            time.sleep(block / OUT_RATE)


class Microphone:
    """16 kHz mono mikrofon; her parça için on_chunk(pcm_bytes, rms) çağrılır (rms 0–1)."""

    def __init__(self, on_chunk: Callable[[bytes, float], None], device: int | None = None, blocksize: int = 640) -> None:
        self._cb, self._device, self._block = on_chunk, device, blocksize
        self._stream = None
        self.active = False

    def start(self) -> bool:
        if self._stream is not None:
            return True
        try:
            import sounddevice as sd
            self._stream = sd.RawInputStream(samplerate=IN_RATE, channels=1, dtype="int16", blocksize=self._block,
                                             device=self._device, callback=self._callback)
            self._stream.start()
            self.active = True
            return True
        except Exception as exc:
            log("mikrofon açılamadı", repr(exc))
            self._stream = None
            self.active = False
            return False

    def stop(self) -> None:
        if self._stream is not None:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception:
                pass
        self._stream, self.active = None, False

    def _callback(self, indata, frames, time_info, status) -> None:
        data = bytes(indata)
        a = np.frombuffer(data, dtype="<i2")
        rms = float(np.sqrt(np.mean(a.astype(np.float32) ** 2))) / 32768 if len(a) else 0.0
        try:
            self._cb(data, rms)
        except Exception as exc:
            log("mikrofon geri çağrısı hatası", repr(exc))
