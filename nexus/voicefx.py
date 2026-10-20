"""Çip ses efektleri: durumlu (parça sınırında tık yapmayan) ve vektörel (gerçek zamanın çok altında) zincirler.

Her efekt `process(x: float32 dizi) -> float32 dizi` ile akış halinde çalışır; durum parçalar arasında taşınır,
yani tek parça ile 40 ms'lik parçalarla işlemek aynı sonucu verir. Giriş/çıkış 24 kHz mono int16 PCM.
"""
from __future__ import annotations

import zlib
from typing import Iterable

import numpy as np
from scipy import signal

SR = 24000


# --------------------------------------------------------------------------- yardımcılar
def _to_float(pcm: bytes | np.ndarray) -> np.ndarray:
    a = np.frombuffer(pcm, dtype="<i2") if isinstance(pcm, (bytes, bytearray)) else np.asarray(pcm)
    return a.astype(np.float32) / 32768.0 if a.dtype == np.int16 else a.astype(np.float32)


def _to_int16(x: np.ndarray) -> np.ndarray:
    return (np.clip(x, -1.0, 1.0) * 32767.0).astype(np.int16)


class Effect:
    """Taban sınıf: `mix` kuru/ıslak oranı, `process` durumlu akış işlemi."""

    def __init__(self, mix: float = 1.0) -> None:
        self.mix = mix
        self.n = 0                                     # işlenen toplam örnek sayısı (mutlak zaman)

    def reset(self) -> None:
        self.n = 0

    def wet(self, x: np.ndarray) -> np.ndarray:        # alt sınıflar yazar
        return x

    def process(self, x: np.ndarray) -> np.ndarray:
        y = self.wet(x)
        self.n += len(x)
        return y if self.mix >= 1.0 else (x * (1.0 - self.mix) + y * self.mix).astype(np.float32)


class _Biquad(Effect):
    def __init__(self, b: np.ndarray, a: np.ndarray, mix: float = 1.0) -> None:
        super().__init__(mix)
        self.b, self.a = b, a
        self.zi = signal.lfilter_zi(b, a) * 0.0

    def reset(self) -> None:
        super().reset()
        self.zi = signal.lfilter_zi(self.b, self.a) * 0.0

    def wet(self, x: np.ndarray) -> np.ndarray:
        y, self.zi = signal.lfilter(self.b, self.a, x, zi=self.zi)
        return y.astype(np.float32)


def _rbj(kind: str, f0: float, q: float = .707, gain_db: float = 0.0, sr: int = SR) -> tuple[np.ndarray, np.ndarray]:
    w0 = 2 * np.pi * f0 / sr
    cw, sw = np.cos(w0), np.sin(w0)
    alpha = sw / (2 * q)
    A = 10 ** (gain_db / 40)
    if kind == "hp":
        b = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2]; a = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == "lp":
        b = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2]; a = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == "bp":
        b = [alpha, 0, -alpha]; a = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == "highshelf":
        s = 2 * np.sqrt(A) * alpha
        b = [A * ((A + 1) + (A - 1) * cw + s), -2 * A * ((A - 1) + (A + 1) * cw), A * ((A + 1) + (A - 1) * cw - s)]
        a = [(A + 1) - (A - 1) * cw + s, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - s]
    else:
        raise ValueError(kind)
    b, a = np.array(b, dtype=np.float64), np.array(a, dtype=np.float64)
    return b / a[0], a / a[0]


class HighPass(_Biquad):
    def __init__(self, f: float, mix: float = 1.0) -> None:
        super().__init__(*_rbj("hp", f), mix=mix)


class BandPass(_Biquad):
    """Telsiz bandı: yüksek geçiren + alçak geçiren art arda (düz üst/alt kenar)."""

    def __init__(self, lo: float, hi: float, mix: float = 1.0) -> None:
        hb, ha = _rbj("hp", lo)
        lb, la = _rbj("lp", hi)
        sos = np.vstack([np.r_[hb, ha], np.r_[lb, la]])
        Effect.__init__(self, mix)
        self.sos = sos
        self.zi = np.zeros((2, 2))

    def reset(self) -> None:
        Effect.reset(self)
        self.zi = np.zeros((2, 2))

    def wet(self, x: np.ndarray) -> np.ndarray:
        y, self.zi = signal.sosfilt(self.sos, x, zi=self.zi)
        return y.astype(np.float32)


class Shelf(_Biquad):
    """Yüksek raf: `gain` +0.35 gibi (0 = etkisiz) oransal parlaklık artışı."""

    def __init__(self, f: float, gain: float, mix: float = 1.0) -> None:
        super().__init__(*_rbj("highshelf", f, .707, gain_db=gain * 18.0), mix=mix)


class FIRLow(Effect):
    def __init__(self, f: float, taps: int = 101, mix: float = 1.0) -> None:
        super().__init__(mix)
        self.h = signal.firwin(taps, f, fs=SR).astype(np.float64)
        self.zi = np.zeros(taps - 1)

    def reset(self) -> None:
        super().reset()
        self.zi = np.zeros_like(self.zi)

    def wet(self, x: np.ndarray) -> np.ndarray:
        y, self.zi = signal.lfilter(self.h, [1.0], x, zi=self.zi)
        return y.astype(np.float32)


class Ring(Effect):
    def __init__(self, f: float, mix: float = 1.0) -> None:
        super().__init__(mix)
        self.f = f

    def wet(self, x: np.ndarray) -> np.ndarray:
        t = (self.n + np.arange(len(x))) / SR
        return (x * np.sin(2 * np.pi * self.f * t)).astype(np.float32)


class Tremolo(Effect):
    def __init__(self, rate: float, depth: float) -> None:
        super().__init__(1.0)
        self.rate, self.depth = rate, depth

    def wet(self, x: np.ndarray) -> np.ndarray:
        t = (self.n + np.arange(len(x))) / SR
        return (x * (1 - self.depth * .5 * (1 + np.sin(2 * np.pi * self.rate * t)))).astype(np.float32)


class Drive(Effect):
    def __init__(self, amount: float, mix: float = 1.0) -> None:
        super().__init__(mix)
        self.k = amount

    def wet(self, x: np.ndarray) -> np.ndarray:
        return (np.tanh(x * self.k) / np.tanh(self.k)).astype(np.float32)


class Crush(Effect):
    def __init__(self, bits: int, hold: int = 1, mix: float = 1.0) -> None:
        super().__init__(mix)
        self.levels, self.hold = float(2 ** (bits - 1)), max(1, hold)
        self.last = 0.0

    def reset(self) -> None:
        super().reset()
        self.last = 0.0

    def wet(self, x: np.ndarray) -> np.ndarray:
        q = np.round(x * self.levels) / self.levels
        if self.hold > 1:
            idx = (self.n + np.arange(len(x))) % self.hold
            src = np.arange(len(x)) - idx                      # bloğun ilk örneği (negatifse önceki parçadan tutulan değer)
            q = np.where(src >= 0, q[np.maximum(src, 0)], self.last)
            self.last = float(q[-1])
        return q.astype(np.float32)


class _Delay:
    """Blok blok vektörel geri beslemeli gecikme: y[n] = x[n] + g·y[n−D]."""

    def __init__(self, delay: int, g: float) -> None:
        self.D, self.g = max(1, delay), g
        self.hist = np.zeros(self.D, dtype=np.float32)

    def reset(self) -> None:
        self.hist[:] = 0

    def comb(self, x: np.ndarray) -> np.ndarray:
        L, D = len(x), self.D
        ext = np.concatenate([self.hist, np.zeros(L, dtype=np.float32)])
        for i in range(0, L, D):
            m = min(D, L - i)
            ext[D + i:D + i + m] = x[i:i + m] + self.g * ext[i:i + m]
        out = ext[D:]
        self.hist = ext[-D:].copy()
        return out

    def allpass(self, x: np.ndarray, xin_hist: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """y[n] = −g·x[n] + x[n−D] + g·y[n−D]; x geçmişi de taşınır."""
        L, D = len(x), self.D
        ey = np.concatenate([self.hist, np.zeros(L, dtype=np.float32)])
        ex = np.concatenate([xin_hist, x])
        for i in range(0, L, D):
            m = min(D, L - i)
            ey[D + i:D + i + m] = -self.g * x[i:i + m] + ex[i:i + m] + self.g * ey[i:i + m]
        self.hist = ey[-D:].copy()
        return ey[D:], ex[-D:].copy()


class Comb(Effect):
    """Tarak filtresi (metalik tını): y = x + fb·y[n−D]."""

    def __init__(self, ms: float, fb: float, mix: float = 1.0) -> None:
        super().__init__(mix)
        self.d = _Delay(int(ms * SR / 1000), fb)
        self.norm = 1.0 / (1.0 + abs(fb))

    def reset(self) -> None:
        super().reset()
        self.d.reset()

    def wet(self, x: np.ndarray) -> np.ndarray:
        return (self.d.comb(x) * self.norm).astype(np.float32)


class Reverb(Effect):
    """Schroeder yankısı: 4 paralel tarak + 2 art arda tüm-geçiren. (süre sn, sönüm 0–1, ıslaklık)"""

    COMBS = (1557, 1617, 1491, 1422)      # 44.1 kHz referans gecikmeleri; 24 kHz'e ölçeklenir
    APS = (225, 556)

    def __init__(self, decay: float, damp: float, wet: float) -> None:
        super().__init__(wet)
        scale = SR / 44100
        self.combs = []
        for d in self.COMBS:
            D = int(d * scale)
            g = 10 ** (-3 * D / SR / max(decay, .05))          # RT60'a göre geri besleme
            self.combs.append(_Delay(D, min(g, .97)))
        self.aps = [_Delay(int(d * scale), .5) for d in self.APS]
        self.ap_x = [np.zeros(a.D, dtype=np.float32) for a in self.aps]
        self.lp = 1.0 - .8 * damp                                # tek kutuplu sönüm
        self.lz = np.zeros(1)

    def reset(self) -> None:
        super().reset()
        for c in self.combs + self.aps:
            c.reset()
        self.ap_x = [np.zeros(a.D, dtype=np.float32) for a in self.aps]
        self.lz = np.zeros(1)

    def wet(self, x: np.ndarray) -> np.ndarray:
        acc = sum(c.comb(x) for c in self.combs) / len(self.combs)
        y, self.lz = signal.lfilter([self.lp], [1, -(1 - self.lp)], acc, zi=self.lz)
        y = y.astype(np.float32)
        for i, ap in enumerate(self.aps):
            y, self.ap_x[i] = ap.allpass(y, self.ap_x[i])
        return y

    def process(self, x: np.ndarray) -> np.ndarray:        # lfilter zi'si düz bir durum değil; sabit tutuyoruz
        y = self.wet(x)
        self.n += len(x)
        return (x * (1.0 - self.mix * .5) + y * self.mix).astype(np.float32)


class Chorus(Effect):
    """Yavaş LFO ile modüle edilen gecikme (ms ± derinlik)."""

    def __init__(self, ms: float, depth_ms: float, rate: float = .4, mix: float = .5) -> None:
        super().__init__(mix)
        self.base, self.depth, self.rate = ms * SR / 1000, depth_ms * SR / 1000, rate
        self.keep = int(self.base + self.depth) + 4
        self.hist = np.zeros(self.keep, dtype=np.float32)

    def reset(self) -> None:
        super().reset()
        self.hist[:] = 0

    def wet(self, x: np.ndarray) -> np.ndarray:
        L = len(x)
        ext = np.concatenate([self.hist, x])
        n = self.n + np.arange(L)
        delay = self.base + self.depth * np.sin(2 * np.pi * self.rate * n / SR)
        pos = self.keep + np.arange(L) - delay
        i0 = np.floor(pos).astype(int)
        frac = (pos - i0).astype(np.float32)
        y = ext[i0] * (1 - frac) + ext[np.minimum(i0 + 1, len(ext) - 1)] * frac
        self.hist = ext[-self.keep:].copy()
        return y.astype(np.float32)


class Stutter(Effect):
    """Rastgele bloklarda bir önceki bloğu perde sıçramalı tekrarla. Kararlar mutlak blok indeksine bağlıdır,
    bu yüzden parça sınırlarından etkilenmez."""

    def __init__(self, p: float, ms: float, seed: int = 7) -> None:
        super().__init__(1.0)
        self.p, self.B, self.seed = p, max(8, int(ms * SR / 1000)), seed
        self.prev = np.zeros(self.B, dtype=np.float32)
        self.cur = np.zeros(self.B, dtype=np.float32)

    def reset(self) -> None:
        super().reset()
        self.prev[:] = 0
        self.cur[:] = 0

    def _plan(self, block: int) -> float:
        h = zlib.crc32(f"{self.seed}:{block}".encode()) / 2**32
        if h >= self.p:
            return 0.0
        return (.7, 1.0, 1.4, 1.9)[int(h / self.p * 4) % 4]

    def wet(self, x: np.ndarray) -> np.ndarray:
        out = x.copy()
        L, B, i = len(x), self.B, 0
        while i < L:
            absn = self.n + i
            blk, off = divmod(absn, B)
            m = min(B - off, L - i)
            ratio = self._plan(blk)
            if ratio:
                k = off + np.arange(m)
                out[i:i + m] = self.prev[(k * ratio).astype(int) % B]
            self.cur[off:off + m] = x[i:i + m]          # gerçek girişi sakla
            if off + m == B:
                self.prev, self.cur = self.cur.copy(), self.cur
            i += m
        return out


# --------------------------------------------------------------------------- zincir
class Chain:
    def __init__(self, effects: Iterable[Effect], intensity: float = 1.0, intro: np.ndarray | None = None) -> None:
        self.effects = list(effects)
        self.intensity = intensity
        self._intro = intro

    def reset(self) -> None:
        for e in self.effects:
            e.reset()

    def intro(self) -> bytes:
        """Tur başında çalınan kısa giriş sesi (örn. telsiz squelch + bip); yoksa boş bayt."""
        return b"" if self._intro is None else _to_int16(self._intro).tobytes()

    def process(self, pcm: bytes | np.ndarray) -> np.ndarray:
        x = _to_float(pcm)
        if not len(x):
            return np.zeros(0, dtype=np.int16)
        y = x
        for e in self.effects:
            y = e.process(y)
        k = self.intensity
        y = x + (y - x) * k if k != 1.0 else y
        return _to_int16(np.tanh(y * 1.05) / np.tanh(1.05) if np.max(np.abs(y)) > .98 else y)


def _radio_intro() -> np.ndarray:
    rng = np.random.default_rng(3)
    n = int(.12 * SR)
    noise = rng.standard_normal(n).astype(np.float32) * np.linspace(.35, 0, n, dtype=np.float32)
    t = np.arange(int(.09 * SR)) / SR
    beep = (np.sin(2 * np.pi * 1750 * t) * .3 * np.hanning(len(t))).astype(np.float32)
    return np.concatenate([noise * .4, np.zeros(int(.02 * SR), np.float32), beep])


PROFILES = {
    "hall":      lambda: [Reverb(.8, .45, .12)],
    "bright":    lambda: [Shelf(3500, .35), Reverb(.5, .3, .06)],
    "obsidian":  lambda: [FIRLow(5200, mix=.6), Ring(55, mix=.6), Comb(9, .48), Reverb(1.3, .55, .14)],
    "radio":     lambda: [BandPass(320, 3300), Drive(2.2), Crush(10, 2)],
    "workshop":  lambda: [Drive(1.8, mix=.3), Comb(22, .25, mix=.5)],
    "ether":     lambda: [Chorus(14, 4), Reverb(1.4, .6, .22), Shelf(5000, .25)],
    "pulse":     lambda: [Tremolo(1.2, .22), HighPass(120)],
    "dry":       lambda: [Drive(1.2, mix=.25)],
    "cathedral": lambda: [Chorus(22, 2), Reverb(2.2, .72, .3)],
    "glitch":    lambda: [Stutter(.14, 70), Crush(8), Ring(110, mix=.5)],
    "none":      lambda: [],
}


def for_profile(name: str, intensity: float = 1.0) -> Chain:
    """Her çağrıda yeni, bağımsız durumlu zincir döner."""
    if name not in PROFILES:
        raise KeyError(f"Bilinmeyen efekt profili: {name}")
    return Chain(PROFILES[name](), intensity, _radio_intro() if name == "radio" else None)


def render(pcm: bytes | np.ndarray, profile: str, intensity: float = 1.0) -> bytes:
    """Tek seferlik işleme (TTS çıktısı gibi tamamlanmış ses): int16 bayt döner."""
    return for_profile(profile, intensity).process(pcm).tobytes()
