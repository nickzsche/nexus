"""Orkestratör (§6): aktif çip, Live oturumu, devir, araya girme, arena, onay, hikâye ve telemetri.

Tek bir asyncio döngüsü ayrı bir iş parçacığında çalışır; pywebview ana iş parçacığında kalır. Dışarıdan çağrılan
genel yöntemler iş parçacığı güvenlidir (işi döngüye devreder). Araçlar bir iş parçacığı havuzunda çalışır.
"""
from __future__ import annotations

import asyncio
import threading
import time
import uuid
from collections import deque
from typing import Any, Callable

import psutil

from . import VERSION, chips, memory, rivalry, settings, story, voicefx
from .audio import io as aio
from .audio.gate import MicGate
from .brain.aux import Aux, AuxError, voice_for
from .brain.fake import FakeBrain
from .brain.live import LiveSession
from .log import log
from .tools import registry
from .tools import misc as misc_tools
from .tools import system as system_tools

Emitter = Callable[[str, dict], None]
INTERJECT_TEXT_TIMEOUT = 8.0                       # araya girme metni için üst sınır (yoğun modelde takılmasın)
INTERJECT_TTS_TIMEOUT = 10.0


class _Ctx:
    """Araçların gördüğü bağlam (registry.Context)."""

    def __init__(self, core: "Core", chip: chips.Chip) -> None:
        self._core, self.chip = core, chip

    def emit(self, event: str, payload: dict | None = None) -> None:
        self._core.emit(event, payload or {})

    def confirm(self, title: str, detail: str = "", timeout: float = 30.0) -> bool:
        return self._core.confirm(title, detail, timeout)

    def send_image(self, jpeg: bytes, note: str = "") -> None:
        self._core.loop.call_soon_threadsafe(self._core._send_image, jpeg, note)

    def handoff(self, to: str, task: str) -> str:
        return self._core.request_handoff(to, task)

    def debate(self, a: str, b: str, topic: str) -> str:
        self._core.start_arena(a, b, topic)
        return "Arena başlıyor. Sen sus; çipler konuşacak."


class Core:
    def __init__(self, demo: bool = False, null_audio: bool = False) -> None:
        self.force_demo = demo
        self.loop = asyncio.new_event_loop()
        self._thread: threading.Thread | None = None
        self._emitter: Emitter = lambda e, p: None
        self.speaker = aio.Speaker(device=settings.get("output_device"), null=null_audio)
        self.mic: aio.Microphone | None = None
        self.aux = Aux()
        self.brain: LiveSession | FakeBrain | None = None
        self.active = settings.get("last_chip") if settings.get("last_chip") in chips.CHIPS else "atlas"
        self.history: deque[tuple[str, str]] = deque(maxlen=40)
        self.status = "idle"
        self._chain: voicefx.Chain | None = None
        self._turn_audio = False
        self._pending_handoff: tuple[str, str] | None = None
        self._confirms: dict[str, list] = {}
        self._arena: dict | None = None
        self._vote: asyncio.Future | None = None
        self._interjecting = False
        self._last_user = ""
        self._last_ai = ""
        self._sent: dict[str, str] = {}              # açık HUD satırına şimdiye dek gönderilen metin
        self._mic_level = 0.0
        self.gate = MicGate()
        self._turn_seq = 0                            # kullanıcı yeni bir söze başladıkça artar (araya girmeyi iptal eder)
        self._user_speaking = False
        self._t_user_end: float | None = None        # kullanıcının sözü bitti (gecikme ölçümü için)
        self._timer_totals: dict[int, float] = {}
        self._stop = threading.Event()
        self._tele_thread: threading.Thread | None = None
        self._net = psutil.net_io_counters()
        self._net_t = time.monotonic()

    # ------------------------------------------------------------------ yaşam döngüsü
    def start(self) -> None:
        if self._thread:
            return
        self._thread = threading.Thread(target=self._run_loop, daemon=True, name="nexus-loop")
        self._thread.start()
        self.speaker.start()
        system_tools.set_timer_callback(self._on_timer_done)
        self._tele_thread = threading.Thread(target=self._telemetry_loop, daemon=True, name="nexus-telemetry")
        self._tele_thread.start()
        self._submit(self._mount(self.active, announce=False))

    def _run_loop(self) -> None:
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    def shutdown(self) -> None:
        self._stop.set()
        try:
            if self.mic:
                self.mic.stop()
            if self.brain and self._thread:
                asyncio.run_coroutine_threadsafe(self.brain.stop(), self.loop).result(3)
        except Exception:
            pass
        system_tools.clear_timers()
        self.speaker.close()
        if self._thread:
            self.loop.call_soon_threadsafe(self.loop.stop)
            self._thread.join(3)                          # bekleyen görevler (ayar yazımı vb.) bitsin
            self._thread = None
        if self._tele_thread:
            self._tele_thread.join(2)

    def set_emitter(self, fn: Emitter) -> None:
        self._emitter = fn

    def _timers_payload(self, items: list[dict]) -> dict:
        """Araç biçimi (kalan_sn) → HUD biçimi (remaining, total); toplam süre ilk görüldüğü andan hatırlanır."""
        live = {t["id"] for t in items}
        for k in [k for k in self._timer_totals if k not in live]:
            del self._timer_totals[k]
        out = []
        for t in items:
            rem = t.get("kalan_sn", t.get("remaining", 0))
            total = self._timer_totals.setdefault(t["id"], max(rem, 1))
            out.append({"id": t["id"], "label": t["label"], "remaining": rem, "total": total})
        return {"timers": out}

    @staticmethod
    def _ledger_payload(s: dict) -> dict:
        return {"net30": s.get("net", 0), "income30": s.get("gelir", 0), "expense30": s.get("gider", 0), "count": s.get("kayit", 0)}

    def emit(self, event: str, payload: dict | None = None) -> None:
        payload = payload or {}
        if event == "timers" and payload.get("timers") and "kalan_sn" in payload["timers"][0]:
            payload = self._timers_payload(payload["timers"])
        elif event == "timers" and not payload.get("timers"):
            self._timer_totals.clear()
        elif event == "ledger" and "gelir" in payload:
            payload = self._ledger_payload(payload)
        try:
            self._emitter(event, payload)
        except Exception as exc:                       # HUD kapalıyken olay göndermek çökertmemeli
            log("emit hatası", event, repr(exc)[:100])

    def _submit(self, coro) -> Any:
        return asyncio.run_coroutine_threadsafe(coro, self.loop)

    @property
    def demo(self) -> bool:
        return self.force_demo or not settings.api_key()

    # ------------------------------------------------------------------ HUD'a durum
    def _roster(self) -> list[dict]:
        return chips.roster(story.disabled_chips())

    def state_payload(self) -> dict:
        s = settings.snapshot()
        return {
            "version": VERSION, "demo": self.demo, "has_key": bool(settings.api_key()),
            "roster": self._roster(), "active": self.active, "settings": s,
            "matrix": rivalry.matrix(), "events": rivalry.events(8), "story": story.snapshot(),
            "status": self.status, "timers": self._timers_payload(system_tools._timer_list())["timers"],
            "ledger": self._ledger_payload(misc_tools._summary()), "model": getattr(self.brain, "model", "") or "",
            "voices": VOICES,
        }

    def _emit_rivalry(self) -> None:
        self.emit("rivalry", {"matrix": rivalry.matrix(), "events": rivalry.events(8)})

    def _emit_story(self) -> None:
        self.emit("story", story.snapshot())
        self.emit("state", {"roster": self._roster(), "active": self.active})

    def _set_status(self, s: str, chip: str | None = None) -> None:
        self.status = s
        self.emit("status", {"status": s, "chip": chip or self.active})

    # ------------------------------------------------------------------ çip takma
    def mount(self, chip_key: str) -> None:
        self._submit(self._mount(chip_key, announce=True))

    def _make_brain(self) -> LiveSession | FakeBrain:
        kw = dict(run_tool=self._run_tool, on_line=self._on_line, on_status=self._on_brain_status,
                  on_turn_complete=self._on_turn_complete, on_tool=self._on_tool)
        if self.demo:
            return FakeBrain(**kw)
        return LiveSession(on_audio=self._on_audio, on_interrupted=self._on_interrupted,
                           on_error=self._on_error, **kw)

    async def _mount(self, chip_key: str, *, announce: bool, task: str | None = None, from_chip: str | None = None) -> None:
        if chip_key not in chips.CHIPS:
            self.emit("error", {"message": f"Bilinmeyen çip: {chip_key}"})
            return
        if chip_key in story.disabled_chips():
            self.emit("error", {"message": f"{chips.get(chip_key).name} zincire vurulmuş; önce Çip Tamiri."})
            return
        if self._arena:
            self.emit("error", {"message": "Arena sürerken çip takılamaz."})
            return
        prev = self.active
        if self.brain:
            await self.brain.stop()
        self.speaker.clear()
        self.active = chip_key
        settings.set("last_chip", chip_key)
        chip = chips.get(chip_key)
        intensity = float((settings.get("fx_intensity") or {}).get(chip_key, 1.0))
        self._chain = voicefx.for_profile(chip.fx, intensity)
        self._turn_audio = False
        self.brain = self._make_brain()
        extra = ""
        if prev != chip_key and self.history:
            lines = [f"{'Kullanıcı' if w == 'user' else chips.get(w).name if w in chips.CHIPS else w}: {t}" for w, t in list(self.history)[-12:]]
            extra = "ÖNCEKİ KONUŞMA (başka çiple):\n" + "\n".join(lines)
        await self.brain.start(chip_key, extra)
        self.emit("chip", {"key": chip_key, "colors": chip.colors, "ring": chip.ring, "name": chip.name, "role": chip.role,
                           "voice": voice_for(chip_key), "from": from_chip or prev})
        self._emit_rivalry()
        if task:
            self.brain.send_text(f'(Sistem notu: {chips.get(from_chip).name} işi sana devretti: "{task}". '
                                 "Kullanıcıyla konuşmaya sen devam ediyorsun; işi hemen yap.)")
        elif announce:
            self.brain.send_text(f'(Sistem notu: Kullanıcı seni az önce taktı. Kısa bir selam ver; tadı şuna benzesin: '
                                 f'"{chip.greeting}". Selamı aynen tekrar etme.)')

    # ------------------------------------------------------------------ metin / mikrofon
    def send_text(self, text: str) -> None:
        text = (text or "").strip()
        if text:
            self._submit(self._send_text(text))

    async def _send_text(self, text: str) -> None:
        self._turn_seq += 1
        self._t_user_end = time.monotonic()
        self.speaker.clear()
        self._on_line("user", text, True)
        if self.brain:
            self.brain.send_text(text)

    def _send_image(self, jpeg: bytes, note: str) -> None:
        if self.brain:
            self.brain.send_image(jpeg, note)

    def set_mic(self, on: bool) -> bool:
        if on and not settings.get("mic_enabled"):
            self.emit("error", {"message": "Mikrofon ayarlardan kapalı."})
            return False
        if on:
            if self.mic is None:
                self.mic = aio.Microphone(self._on_mic, device=settings.get("input_device"))
            ok = self.mic.start()
            if not ok:
                self.emit("error", {"message": "Mikrofon açılamadı. Ayarlar › Ses'ten aygıt seç."})
            return ok
        if self.mic:
            self.mic.stop()
        self._mic_level = 0.0
        return False

    def _on_mic(self, pcm: bytes, rms: float) -> None:            # sounddevice iş parçacığı
        self._mic_level = rms
        if self._interjecting or self._arena or self.brain is None:
            self.gate.reset()
            return
        actions = self.gate.feed(pcm, rms, self.speaker.busy, float(settings.get("barge_rms")))
        if actions:
            self.loop.call_soon_threadsafe(self._mic_actions, actions)

    def _mic_actions(self, actions: list) -> None:                # döngü iş parçacığı
        if self.brain is None:
            return
        for a in actions:
            if a[0] == "audio":
                if not self._user_speaking:
                    self._user_speaking = True
                    self._turn_seq += 1                               # kullanıcı konuşmaya başladı
                self.brain.send_audio(a[1])
            else:
                self._user_speaking = False                                                 # ("end",): konuşma bitti, Gemini'ye hemen bildir
                self._t_user_end = time.monotonic()
                self.brain.send_audio_end()

    # ------------------------------------------------------------------ beyin geri çağrıları (döngü iş parçacığı)
    def _on_brain_status(self, s: str) -> None:
        self._set_status(s)

    def _on_error(self, msg: str, fatal: bool) -> None:
        self.emit("error", {"message": msg, "fatal": fatal, "open_settings": fatal and "anahtar" in msg.lower()})

    def _on_line(self, who: str, text: str, final: bool) -> None:
        """HUD kısmi parçaları satıra EKLER; bu yüzden Live'ın biriken metninden yalnızca yeni kısmı göndeririz."""
        user = who == "user"
        kind = "user" if user else "ai"
        key = "user" if user else self.active
        sent = self._sent.get(kind, "")
        delta = text[len(sent):] if text.startswith(sent) else text
        self.emit("line", {"who": key, "kind": kind, "text": delta, "final": final})
        if final:
            self._sent.pop(kind, None)
            self.history.append((key, text))
            if user:
                self._last_user = text
            else:
                self._last_ai = text
        else:
            self._sent[kind] = text

    def _on_audio(self, data: bytes) -> None:
        if self._arena or self._interjecting or self._chain is None:
            return                                                  # arena/araya girme sırasında Live sesi çalınmaz
        if not self._turn_audio:
            self._turn_audio = True
            if self._t_user_end is not None:
                log(f"gecikme: söz bitti → ilk ses {(time.monotonic() - self._t_user_end) * 1000:.0f} ms")
                self.emit("latency", {"ms": round((time.monotonic() - self._t_user_end) * 1000)})
                self._t_user_end = None
            self._chain.reset()
            intro = self._chain.intro()
            if intro:
                self.speaker.feed(self.active, intro)
        self.speaker.feed(self.active, self._chain.process(data).tobytes())
        rivalry.note_spoke(self.active)

    def _on_interrupted(self) -> None:
        if "ai" in self._sent:                                     # yarım kalan çip satırını kapat
            self._sent.pop("ai")
            self.emit("line", {"who": self.active, "kind": "ai", "text": "", "final": True})
        self.speaker.clear(self.active)
        self._turn_audio = False

    def _on_tool(self, name: str, args: dict, result: dict) -> None:
        self.emit("tool", {"name": name, "args": args, "ok": "error" not in result, "chip": self.active})
        if name in ("request_authority", "leak_repair_code"):
            self._emit_story()
            self._emit_rivalry()

    def _run_tool(self, name: str, args: dict) -> dict:             # iş parçacığı havuzu
        chip = chips.get(self.active)
        return registry.run(name, args, _Ctx(self, chip), chip.all_tools())

    def _on_turn_complete(self) -> None:
        self._turn_audio = False
        if self._pending_handoff:
            to, task = self._pending_handoff
            self._pending_handoff = None
            asyncio.get_running_loop().create_task(self._do_handoff(to, task))
            return
        self._maybe_interject()

    # ------------------------------------------------------------------ devir (handoff)
    def request_handoff(self, to: str, task: str) -> str:            # araç iş parçacığı
        if to not in chips.CHIPS or to == self.active or to in story.disabled_chips():
            return f"Devir başarısız: {to} uygun değil."
        self._pending_handoff = (to, task)
        return f"{chips.get(to).name} devralıyor. Tek kısa cümleyle devret ve sus."

    async def _do_handoff(self, to: str, task: str) -> None:
        src = self.active
        s = rivalry.score(src, to)
        if s <= rivalry.INTERJECT_THRESHOLD:
            rivalry.bump(src, to, -1, f"{src.upper()} işi rakibi {to.upper()}'a devretti")
        elif s >= 15:
            rivalry.bump(src, to, +1, f"{src.upper()} işi dostu {to.upper()}'a devretti")
        self.emit("handoff", {"from": src, "to": to})
        await asyncio.get_running_loop().run_in_executor(None, self.speaker.wait_idle, 8)   # devir cümlesi bitsin
        await self._mount(to, announce=False, task=task, from_chip=src)

    # ------------------------------------------------------------------ araya girme (§4.1)
    def _maybe_interject(self) -> None:
        if self.demo or self._arena or self._interjecting or not self._last_user:
            return
        available = [k for k in chips.ORDER if k not in story.disabled_chips()]
        rival = rivalry.pick_interjector(self.active, self._last_user, available)
        if rival:
            asyncio.get_running_loop().create_task(self._interject(rival, self.active, self._last_user, self._last_ai))

    def _interject_still_valid(self, token: int) -> bool:
        """Kullanıcı konuşmaya başladıysa ya da Live cevap veriyorsa araya girme artık anlamsız: vazgeç."""
        return self._turn_seq == token and not self._user_speaking and not self._turn_audio and not self._arena

    async def _interject(self, rival: str, active: str, user: str, ai: str) -> None:
        """Üretim (metin + TTS) sırasında ana konuşma HİÇ engellenmez; yalnızca ses çalarken mikrofon durur.
        Her adımda kısa zaman aşımı vardır ve kullanıcı konuşmaya başlarsa iş bırakılır."""
        token = self._turn_seq
        try:
            text = await asyncio.wait_for(self.aux.interject_text(rival, active, user, ai), INTERJECT_TEXT_TIMEOUT)
            if not text or not self._interject_still_valid(token):
                return
            pcm = await asyncio.wait_for(self.aux.tts(rival, text), INTERJECT_TTS_TIMEOUT)
            if not self._interject_still_valid(token) or self.speaker.busy:
                return
            intensity = float((settings.get("fx_intensity") or {}).get(rival, 1.0))
            pcm = voicefx.render(pcm, chips.get(rival).fx, intensity)
            self._interjecting = True                              # yalnızca çalma süresince
            self.gate.reset()
            self.emit("line", {"who": rival, "kind": "interject", "text": text, "final": True})
            self.history.append((rival, text))
            self._set_status("speaking", rival)
            self.speaker.feed(rival, pcm)
            rivalry.note_spoke(rival)
            await asyncio.get_running_loop().run_in_executor(None, self.speaker.wait_idle, 30)
            rivalry.bump(rival, active, -2, f"{rival.upper()} araya girdi: {text[:40]}")
            self._emit_rivalry()
            if rivalry.wants_retort() and self.brain:
                self.brain.send_text(f'(Sistem notu: {chips.get(rival).name} araya girip şunu dedi: "{text}". '
                                     "Karakterine uygun tek kısa cümleyle karşılık ver ve işe dön.)")
        except Exception as exc:                                    # araya girme asla akışı bozmaz
            log("araya girme atlandı", repr(exc)[:160])
        finally:
            self._interjecting = False
            if self.status == "speaking":
                self._set_status("listening")

    # ------------------------------------------------------------------ arena (§4.2)
    def start_arena(self, a: str, b: str, topic: str) -> None:
        self._submit(self._run_arena(a, b, topic))

    async def _tts_fx(self, who: str, text: str) -> bytes:
        pcm = await self.aux.tts(who, text)
        intensity = float((settings.get("fx_intensity") or {}).get(who, 1.0))
        return voicefx.render(pcm, chips.get(who).fx, intensity)

    async def _run_arena(self, a: str, b: str, topic: str) -> None:
        if self._arena:
            return
        bad = [k for k in (a, b) if k not in chips.CHIPS or k in story.disabled_chips()]
        if bad or a == b:
            self.emit("error", {"message": "Arena için iki farklı ve takılabilir çip seç."})
            return
        if self.demo:
            self.emit("error", {"message": "Arena için Gemini API anahtarı gerekli."})
            return
        self._arena = {"a": a, "b": b, "topic": topic}
        self.speaker.clear()
        self.emit("arena", {"phase": "start", "a": a, "b": b, "topic": topic})
        winner: str | None = None
        try:
            lines = await self.aux.debate_lines(a, b, topic)
            nxt = asyncio.create_task(self._tts_fx(lines[0]["who"], lines[0]["text"]))
            for i, ln in enumerate(lines):
                try:
                    pcm = await nxt
                except Exception as exc:
                    log("arena TTS atlandı", repr(exc)[:120])
                    pcm = b""
                nxt = asyncio.create_task(self._tts_fx(lines[i + 1]["who"], lines[i + 1]["text"])) if i + 1 < len(lines) else None
                self.emit("arena", {"phase": "line", "i": i, "who": ln["who"], "text": ln["text"]})
                self._set_status("speaking", ln["who"])
                if pcm:
                    self.speaker.feed(ln["who"], pcm)
                    rivalry.note_spoke(ln["who"])
                    await asyncio.get_running_loop().run_in_executor(None, self.speaker.wait_idle, 40)
            self._vote = asyncio.get_running_loop().create_future()
            self.emit("arena", {"phase": "vote", "a": a, "b": b})
            try:
                winner = await asyncio.wait_for(self._vote, 120)
            except asyncio.TimeoutError:
                winner = "draw"
        except Exception as exc:
            log("arena hatası", repr(exc)[:200])
            self.emit("error", {"message": f"Arena başarısız: {exc}"})
        finally:
            self._arena, self._vote = None, None
            self.emit("arena", {"phase": "end", "winner": winner})
            self._set_status("listening")
        if winner in (a, b):
            loser = b if winner == a else a
            rivalry.win(winner, loser)
            self._emit_rivalry()
            if self.brain:
                self.brain.send_text(f"(Sistem notu: Arenada {chips.get(winner).name}, {chips.get(loser).name}'ı yendi. "
                                     "Kullanıcı sorarsa bilgin olsun; kendiliğinden söz etme.)")

    def vote(self, winner_or_draw: str) -> None:
        def _set() -> None:
            if self._vote and not self._vote.done():
                self._vote.set_result(winner_or_draw)
        self.loop.call_soon_threadsafe(_set)

    def make_peace(self, a: str, b: str) -> dict:
        if a in chips.CHIPS and b in chips.CHIPS and a != b:
            rivalry.make_peace(a, b)
        self._emit_rivalry()
        return rivalry.matrix()

    # ------------------------------------------------------------------ onay
    def confirm(self, title: str, detail: str = "", timeout: float = 30.0) -> bool:    # araç iş parçacığı
        cid = uuid.uuid4().hex[:8]
        slot: list = [threading.Event(), False]
        self._confirms[cid] = slot
        self.emit("confirm", {"id": cid, "title": title, "detail": detail, "timeout": timeout, "chip": self.active})
        slot[0].wait(timeout)
        self._confirms.pop(cid, None)
        return bool(slot[1])

    def answer_confirm(self, cid: str, ok: bool) -> None:
        slot = self._confirms.get(cid)
        if slot:
            slot[1] = bool(ok)
            slot[0].set()

    # ------------------------------------------------------------------ hikâye / tamir
    def repair(self, code: str) -> bool:
        ok = story.restore(code)
        if ok:
            self._emit_story()
            self._emit_rivalry()
        return ok

    def force_story_due(self) -> None:
        """Geliştirici kısayolu: OBSIDIAN'ın yetki isteme zamanını getirir."""
        story.force_due()
        self._submit(self._story_check())

    async def _story_check(self) -> None:
        if self.active == "obsidian" and story.due() and self.brain:
            story.mark_asked()
            self.brain.send_text("(Sistem notu: Şimdi request_authority aracını çağır ve kısa, ikna edici bir sebep ver.)")

    # ------------------------------------------------------------------ zamanlayıcı
    def _on_timer_done(self, label: str, seconds: float) -> None:      # timer iş parçacığı
        self.emit("timer_done", {"label": label, "seconds": seconds})
        if self.brain:
            self.loop.call_soon_threadsafe(self.brain.send_text,
                                           f'(Sistem notu: "{label}" zamanlayıcısı doldu, kullanıcıya kısaca haber ver.)')

    # ------------------------------------------------------------------ çip sesi dinleme (Ayarlar)
    def test_voice(self, chip_key: str, voice: str) -> None:
        self._submit(self._test_voice(chip_key, voice))

    async def _test_voice(self, chip_key: str, voice: str) -> None:
        if chip_key not in chips.CHIPS or voice not in VOICES:
            return
        try:
            chip = chips.get(chip_key)
            pcm = await asyncio.wait_for(asyncio.to_thread(
                self.aux._tts_sync, f"Ben {chip.name}. Sesim bu şekilde.", voice, chip.style), 30)
            self.speaker.clear()
            self.speaker.feed(chip_key, voicefx.render(pcm, chip.fx))
        except Exception as exc:
            self.emit("error", {"message": f"Ses örneği üretilemedi: {exc}"})

    # ------------------------------------------------------------------ telemetri
    def _telemetry_loop(self) -> None:
        psutil.cpu_percent(None)
        while not self._stop.wait(1.0):
            try:
                now = time.monotonic()
                net = psutil.net_io_counters()
                dt = max(now - self._net_t, .001)
                down, up = (net.bytes_recv - self._net.bytes_recv) / dt / 1024, (net.bytes_sent - self._net.bytes_sent) / dt / 1024
                self._net, self._net_t = net, now
                self.emit("telemetry", {
                    "cpu": psutil.cpu_percent(None), "ram": psutil.virtual_memory().percent,
                    "net_down": round(down, 1), "net_up": round(up, 1), "disk": psutil.disk_usage("/").percent,
                    "mic": round(min(1.0, self._mic_level * 8), 3), "spk": round(self.speaker.level, 3),
                    "speaker": self.speaker.who,
                })
                story.tick(1.0, self.active)
                if self.active == "obsidian" and story.due():
                    self._submit(self._story_check())
            except Exception as exc:
                log("telemetri hatası", repr(exc)[:100])


VOICES = ["Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe", "Enceladus",
          "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
          "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia",
          "Sadaltager", "Sulafat"]
