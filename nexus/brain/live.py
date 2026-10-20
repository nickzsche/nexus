"""Gemini Live oturumu (§5.1): ses-sese konuşma, araç çağrıları, kesinti, otomatik yeniden bağlanma.

Çip değişince yeni oturum açılır (ses ve sistem talimatı oturum ortasında değişmez). Aynı çip için kopuşta
oturum sürdürme tutamacı (handle) ile sessizce yeniden bağlanılır. Tüm geri çağrılar olay döngüsü iş parçacığında çalışır.
"""
from __future__ import annotations

import asyncio
import time
from typing import Any, Awaitable, Callable

from .. import chips, prompts, settings
from ..log import log
from ..tools import registry
from .aux import voice_for

RETRYABLE_MODEL = ("not found", "not supported", "permission", "quota", "404", "403", "429", "unsupported", "unavailable")
FATAL_KEY = ("api key not valid", "api_key_invalid", "invalid api key", "unauthenticated", "401")
BACKOFF = (1, 2, 4, 8, 15)
BAD_MODEL_TTL = 600.0                    # kota/yok diyen model bu kadar süre atlanır (her çip değişiminde yeniden denenmesin)
_BAD_MODELS: dict[str, float] = {}

ToolRunner = Callable[[str, dict], dict]        # (name, args) -> {"result"|"error": ...}; iş parçacığında çalışır


class LiveError(RuntimeError):
    pass


class LiveSession:
    def __init__(self, *, run_tool: ToolRunner,
                 on_audio: Callable[[bytes], None] = lambda b: None,
                 on_line: Callable[[str, str, bool], None] = lambda who, text, final: None,
                 on_status: Callable[[str], None] = lambda s: None,
                 on_turn_complete: Callable[[], None] = lambda: None,
                 on_interrupted: Callable[[], None] = lambda: None,
                 on_tool: Callable[[str, dict, dict], None] = lambda n, a, r: None,
                 on_error: Callable[[str, bool], None] = lambda msg, fatal: None,
                 connect: Callable[[str, Any], Any] | None = None) -> None:
        self.run_tool = run_tool
        self.on_audio, self.on_line, self.on_status = on_audio, on_line, on_status
        self.on_turn_complete, self.on_interrupted = on_turn_complete, on_interrupted
        self.on_tool, self.on_error = on_tool, on_error
        self._connect = connect
        self.chip_key = ""
        self.extra = ""
        self.handle: str | None = None
        self.model = ""
        self._out: asyncio.Queue | None = None
        self._task: asyncio.Task | None = None
        self._stopping = False
        self._cancelled: set[str] = set()
        self._in_text: list[str] = []
        self._out_text: list[str] = []
        self._first_audio = True

    # ------------------------------------------------------------------ yaşam döngüsü
    async def start(self, chip_key: str, extra: str = "") -> None:
        await self.stop()
        self.chip_key, self.extra, self.handle = chip_key, extra, None   # yeni çip = yeni oturum, handle yok
        self._stopping = False
        self._out = asyncio.Queue()
        self._task = asyncio.create_task(self._supervise(), name="live-supervisor")

    async def stop(self) -> None:
        self._stopping = True
        task, self._task = self._task, None
        if task:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    # ------------------------------------------------------------------ gönderme (iş parçacığı güvenli değil: olay döngüsünden çağır)
    def send_audio(self, pcm: bytes) -> None:
        self._put(("audio", pcm))

    def send_text(self, text: str) -> None:
        self._put(("text", text))

    def send_image(self, jpeg: bytes, note: str = "") -> None:
        self._put(("image", jpeg, note))

    def _put(self, item: tuple) -> None:
        if self._out is not None:
            self._out.put_nowait(item)

    # ------------------------------------------------------------------ gözetmen: bağlan, kopunca yeniden bağlan
    async def _supervise(self) -> None:
        attempt = 0
        while not self._stopping:
            self.on_status("connecting")
            try:
                await self._session_once()
                attempt = 0                                  # temiz kapanış (GoAway vb.): hemen yeniden bağlan
            except asyncio.CancelledError:
                raise
            except LiveError as exc:
                self.on_error(str(exc), True)
                self.on_status("error")
                return
            except Exception as exc:
                msg = str(exc)
                if any(k in msg.lower() for k in FATAL_KEY):
                    self.on_error("API anahtarı geçersiz.", True)
                    self.on_status("error")
                    return
                wait = BACKOFF[min(attempt, len(BACKOFF) - 1)]
                attempt += 1
                log("live kopuk, yeniden bağlanılıyor", wait, repr(exc)[:160])
                self.on_error(f"Bağlantı koptu, {wait} sn sonra yeniden denenecek.", False)
                await asyncio.sleep(wait)

    def _config(self) -> Any:
        from google.genai import types
        chip = chips.get(self.chip_key)
        return types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            speech_config={"voice_config": {"prebuilt_voice_config": {"voice_name": voice_for(self.chip_key)}}},
            system_instruction=prompts.system_instruction(self.chip_key, self.extra),
            tools=registry.declarations(chip.all_tools()),
            input_audio_transcription={},
            output_audio_transcription={},
            context_window_compression=types.ContextWindowCompressionConfig(sliding_window=types.SlidingWindow()),
            session_resumption=types.SessionResumptionConfig(handle=self.handle),
        )

    def _connector(self, model: str, config: Any):
        if self._connect is not None:
            return self._connect(model, config)
        key = settings.api_key()
        if not key:
            raise LiveError("API anahtarı yok.")
        from google import genai
        return genai.Client(api_key=key).aio.live.connect(model=model, config=config)

    async def _session_once(self) -> None:
        """Modelleri sırayla dener; biri 'yok / desteklenmiyor / yetki / kota' derse sıradakine geçer."""
        last: Exception | None = None
        now = time.monotonic()
        models = list(settings.get("live_models"))
        usable = [m for m in models if _BAD_MODELS.get(m, 0) < now] or models      # hepsi kötüyse hepsini dene
        for model in usable:
            try:
                async with self._connector(model, self._config()) as session:
                    self.model = model
                    await self._pump(session)
                return
            except asyncio.CancelledError:
                raise
            except LiveError:
                raise
            except Exception as exc:
                last = exc
                if any(k in str(exc).lower() for k in RETRYABLE_MODEL) and not self.handle:
                    _BAD_MODELS[model] = time.monotonic() + BAD_MODEL_TTL
                    log("live modeli reddetti, sıradaki deneniyor", model, repr(exc)[:120])
                    continue
                raise
        raise last or LiveError("Kullanılabilir Live modeli yok.")

    # ------------------------------------------------------------------ oturum içi
    async def _pump(self, session: Any) -> None:
        from google.genai import types
        sender = asyncio.create_task(self._sender(session, types), name="live-sender")
        try:
            while not self._stopping:
                got_any = False
                async for msg in session.receive():          # her tur sonunda biter; döngü yeniden alır
                    got_any = True
                    if await self._handle(session, msg, types):
                        return                                # GoAway: yeniden bağlan
                if not got_any:
                    raise ConnectionError("oturum kapandı")
        finally:
            sender.cancel()

    async def _sender(self, session: Any, types: Any) -> None:
        while True:
            item = await self._out.get()
            kind = item[0]
            try:
                if kind == "audio":
                    await session.send_realtime_input(audio=types.Blob(data=item[1], mime_type="audio/pcm;rate=16000"))
                elif kind == "text":
                    try:
                        await session.send_realtime_input(text=item[1])
                    except Exception:
                        await session.send_client_content(turns={"role": "user", "parts": [{"text": item[1]}]}, turn_complete=True)
                elif kind == "image":
                    await session.send_realtime_input(video=types.Blob(data=item[1], mime_type="image/jpeg"))
                    if item[2]:
                        await session.send_realtime_input(text=item[2])
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log("live gönderme hatası", kind, repr(exc)[:120])

    def _flush_lines(self) -> None:
        for who, buf in (("user", self._in_text), ("ai", self._out_text)):
            if buf:
                self.on_line(who, "".join(buf).strip(), True)
                buf.clear()

    async def _handle(self, session: Any, msg: Any, types: Any) -> bool:
        """Bir sunucu mesajını işler. True dönerse oturum yeniden bağlanmalıdır (GoAway)."""
        if getattr(msg, "setup_complete", None) is not None:
            self.on_status("listening")
        sc = getattr(msg, "server_content", None)
        if sc is not None:
            if getattr(sc, "interrupted", False):
                self._out_text.clear()
                self._first_audio = True
                self.on_interrupted()
            mt = getattr(sc, "model_turn", None)
            for part in (getattr(mt, "parts", None) or []):
                data = getattr(getattr(part, "inline_data", None), "data", None)
                if data:
                    if self._first_audio:
                        self._first_audio = False
                        self.on_status("speaking")
                    self.on_audio(data)
            it = getattr(getattr(sc, "input_transcription", None), "text", None)
            if it:
                self._in_text.append(it)
                self.on_line("user", "".join(self._in_text), False)
                self.on_status("thinking")
            ot = getattr(getattr(sc, "output_transcription", None), "text", None)
            if ot:
                self._out_text.append(ot)
                self.on_line("ai", "".join(self._out_text), False)
            if getattr(sc, "turn_complete", False):
                self._flush_lines()
                self._first_audio = True
                self.on_status("listening")
                self.on_turn_complete()
        tc = getattr(msg, "tool_call", None)
        if tc is not None and getattr(tc, "function_calls", None):
            self.on_status("thinking")
            asyncio.create_task(self._run_calls(session, tc.function_calls, types))
        canc = getattr(msg, "tool_call_cancellation", None)
        if canc is not None:
            self._cancelled.update(getattr(canc, "ids", None) or [])
        upd = getattr(msg, "session_resumption_update", None)
        if upd is not None and getattr(upd, "resumable", False) and getattr(upd, "new_handle", None):
            self.handle = upd.new_handle
        if getattr(msg, "go_away", None) is not None:
            log("live GoAway: yeniden bağlanılıyor")
            return True
        return False

    async def _run_calls(self, session: Any, calls: list, types: Any) -> None:
        loop = asyncio.get_running_loop()
        responses = []
        for c in calls:
            name, args = c.name, dict(c.args or {})
            result = await loop.run_in_executor(None, self.run_tool, name, args)
            self.on_tool(name, args, result)
            if c.id in self._cancelled:                       # iptal edilen çağrının sonucu atılır
                self._cancelled.discard(c.id)
                continue
            responses.append(types.FunctionResponse(id=c.id, name=name, response=result))
        if responses:
            try:
                await session.send_tool_response(function_responses=responses)
            except Exception as exc:
                log("araç yanıtı gönderilemedi", repr(exc)[:120])
