"""HUD köprüsü: Python ⇄ JS.

Python → JS: `Emitter.emit(event, payload)` → `window.NX.on(event, payload)`.
JS → Python: `Api` sınıfı (pywebview js_api); hepsi `core` nesnesine delege eder.

`core` (core.py) şu yöntemleri sağlar: state_payload(), mount(chip), send_text(text), set_mic(on),
start_arena(a, b, topic), vote(winner_or_draw), make_peace(a, b) -> matris, answer_confirm(id, ok),
repair(code) -> bool, test_voice(chip, voice), set_emitter(fn).

`state_payload()` beklenen biçim (eksik alanlar HUD'da varsayılana düşer):
    {"roster": [chips.roster()...], "active": "atlas", "matrix": {a: {b: puan}}, "events": [...],
     "story": {"locked": bool, ...}, "timers": [...], "ledger": {...}, "model": "gemini-3.8-live", "version": "1.0.0"}
"""
from __future__ import annotations

import json
import os
import queue
import threading
import time
from typing import Any, Callable

from .. import paths, settings
from ..log import log

MAX_PER_SEC = 30
_MIN_GAP = 1.0 / MAX_PER_SEC


class Emitter:
    """Olayları JS'e iter. Saniyede en fazla 30 çağrı; 'telemetry' birleştirilir (son değer kazanır)."""

    def __init__(self, window: Any, clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], None] = time.sleep, autostart: bool = True) -> None:
        self._window = window
        self._clock, self._sleep = clock, sleep
        self._q: "queue.Queue[tuple[str, Any]]" = queue.Queue()
        self._telemetry: Any = None
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._closed = False
        self._last = -1e9
        self._thread: threading.Thread | None = None
        if autostart:
            self._thread = threading.Thread(target=self._loop, name="hud-emitter", daemon=True)
            self._thread.start()

    def emit(self, event: str, payload: dict | None = None) -> None:
        if self._closed:
            return
        if event == "telemetry":
            with self._lock:
                self._telemetry = payload or {}
        else:
            self._q.put((event, payload or {}))
        self._wake.set()

    def close(self) -> None:
        self._closed = True
        self._wake.set()

    def pending(self) -> int:
        with self._lock:
            return self._q.qsize() + (1 if self._telemetry is not None else 0)

    def _next(self) -> tuple[str, Any] | None:
        try:
            return self._q.get_nowait()
        except queue.Empty:
            pass
        with self._lock:
            if self._telemetry is not None:
                item, self._telemetry = ("telemetry", self._telemetry), None
                return item
        return None

    def pump(self) -> bool:
        """Bir olay gönderir (hız sınırına uyarak). Gönderecek şey yoksa False."""
        item = self._next()
        if item is None:
            return False
        wait = self._last + _MIN_GAP - self._clock()
        if wait > 0:
            self._sleep(wait)
        self._last = self._clock()
        self._send(*item)
        return True

    def _send(self, event: str, payload: Any) -> None:
        js = f"NX.on({json.dumps(event, ensure_ascii=False)}, {json.dumps(payload, ensure_ascii=False, default=str)})"
        try:
            self._window.evaluate_js(js)
        except Exception:                       # pencere kapandı ya da henüz hazır değil: sessizce yut
            pass

    def _loop(self) -> None:
        while not self._closed:
            if not self.pump():
                self._wake.wait(0.5)
                self._wake.clear()


def _ok(**extra: Any) -> dict:
    return {"ok": True, **extra}


def _fail(exc: Exception) -> dict:
    return {"ok": False, "error": str(exc)}


class Api:
    """pywebview js_api. Her yöntem JSON-serileştirilebilir değer döner, hata fırlatmaz."""

    def __init__(self, core: Any) -> None:
        self._core = core

    def state(self) -> dict:
        try:
            s = dict(self._core.state_payload())
            s.setdefault("settings", settings.snapshot())
            s["has_key"] = bool(settings.api_key())
            return s
        except Exception as exc:
            log("state hatası", repr(exc))
            return {"error": str(exc), "settings": settings.snapshot(), "has_key": False}

    def settings_get(self) -> dict:
        return settings.snapshot()

    def settings_set(self, key: str, value: Any) -> dict:
        try:
            settings.set(key, value)
            return _ok(settings=settings.snapshot())
        except Exception as exc:
            return _fail(exc)

    def set_api_key(self, key: str) -> dict:
        try:
            settings.set_api_key(key or "")
            return _ok(has_key=bool(settings.api_key()))
        except Exception as exc:
            return _fail(Exception("anahtar kaydedilemedi"))        # ayrıntıda anahtar geçebilir, loglanmaz

    def has_api_key(self) -> bool:
        return bool(settings.api_key())

    def devices(self) -> dict:
        try:
            from ..audio import io
            return io.devices()
        except Exception as exc:
            return {"input": [], "output": [], "error": str(exc)}

    def mount(self, chip: str) -> dict:
        return self._call(self._core.mount, chip)

    def send_text(self, text: str) -> dict:
        return self._call(self._core.send_text, text)

    def mic(self, on: bool) -> dict:
        return self._call(self._core.set_mic, bool(on))

    def arena(self, a: str, b: str, topic: str) -> dict:
        return self._call(self._core.start_arena, a, b, topic)

    def vote(self, winner_or_draw: str) -> dict:
        return self._call(self._core.vote, winner_or_draw)

    def make_peace(self, a: str, b: str) -> dict:
        try:
            return _ok(matrix=self._core.make_peace(a, b))
        except Exception as exc:
            return _fail(exc)

    def answer(self, confirm_id: str, ok: bool) -> dict:
        return self._call(self._core.answer_confirm, confirm_id, bool(ok))

    def repair(self, code: str) -> dict:
        try:
            return _ok(restored=bool(self._core.repair(code)))
        except Exception as exc:
            return _fail(exc)

    def test_voice(self, chip: str, voice: str) -> dict:
        return self._call(self._core.test_voice, chip, voice)

    def dev(self, cmd: str) -> dict:
        """Geliştirici kısayolları; yalnızca --debug ile çalışır."""
        if not getattr(self._core, "debug", False):
            return {"ok": False, "error": "debug kapalı"}
        if cmd == "story_due":
            return self._call(self._core.force_story_due)
        return {"ok": False, "error": f"bilinmeyen komut: {cmd}"}

    def open_data_folder(self) -> dict:
        try:
            path = str(paths.DATA_DIR)
            if paths.IS_WIN:
                os.startfile(path)              # type: ignore[attr-defined]
            else:
                import subprocess
                subprocess.Popen(["open" if paths.IS_MAC else "xdg-open", path])
            return _ok(path=path)
        except Exception as exc:
            return _fail(exc)

    @staticmethod
    def _call(fn: Callable[..., Any], *args: Any) -> dict:
        try:
            fn(*args)
            return _ok()
        except Exception as exc:
            log("köprü hatası", getattr(fn, "__name__", "?"), repr(exc))
            return _fail(exc)


def build_window(core: Any, debug: bool = False) -> Any:
    """pywebview penceresini kurar ve Emitter'ı core'a bağlar. (app.py `webview.start` çağırır.)"""
    import webview

    window = webview.create_window(
        "NEXUS", url=str(paths.WEB_DIR / "index.html"), js_api=Api(core),
        width=1440, height=900, min_size=(1100, 700), background_color="#03070B",
    )
    emitter = Emitter(window)
    core.set_emitter(emitter.emit)
    window.events.closed += emitter.close
    window._nexus_emitter = emitter                      # kapanana kadar canlı kalsın
    return window
