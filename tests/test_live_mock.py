"""Live oturumu: sahte AsyncSession ile araç çağrısı, kesinti, model yedeği, yeniden bağlanma ve oturum sürdürme."""
import asyncio
from types import SimpleNamespace as NS

import pytest

from nexus import settings
from nexus.brain import live as livemod
from nexus.brain.live import LiveSession


class FakeSession:
    def __init__(self, turns):
        self.turns = list(turns)          # her eleman: o `receive()` çağrısında dönecek mesaj listesi
        self.tool_responses, self.realtime, self.client_content = [], [], []

    async def receive(self):
        if not self.turns:
            await asyncio.sleep(3600)
        for m in self.turns.pop(0):
            yield m

    async def send_realtime_input(self, **kw): self.realtime.append(kw)
    async def send_tool_response(self, function_responses): self.tool_responses.append(function_responses)
    async def send_client_content(self, **kw): self.client_content.append(kw)


class Conn:
    def __init__(self, session, error=None):
        self.session, self.error = session, error

    async def __aenter__(self):
        if self.error:
            raise self.error
        return self.session

    async def __aexit__(self, *a): return False


def sc(**kw):
    return NS(server_content=NS(**kw))


@pytest.fixture(autouse=True)
def fast(monkeypatch):
    monkeypatch.setattr(livemod, "BACKOFF", (0,))
    livemod._BAD_MODELS.clear()
    settings.set("live_models", ["m-one", "m-two"])


def make(connect, **cb):
    events = {"audio": [], "lines": [], "status": [], "tools": [], "intr": 0, "turn": 0, "errors": []}
    s = LiveSession(
        run_tool=cb.get("run_tool", lambda n, a: {"result": f"{n}-ok"}),
        on_audio=events["audio"].append,
        on_line=lambda w, t, f: events["lines"].append((w, t, f)),
        on_status=events["status"].append,
        on_turn_complete=lambda: events.__setitem__("turn", events["turn"] + 1),
        on_interrupted=lambda: events.__setitem__("intr", events["intr"] + 1),
        on_tool=lambda n, a, r: events["tools"].append((n, a, r)),
        on_error=lambda m, fatal: events["errors"].append((m, fatal)),
        connect=connect)
    return s, events


async def wait_for(cond, timeout=3.0):
    end = asyncio.get_event_loop().time() + timeout
    while not cond():
        assert asyncio.get_event_loop().time() < end, "zaman aşımı"
        await asyncio.sleep(.01)


async def test_tool_call_gets_tool_response():
    fs = FakeSession([[NS(setup_complete=NS()), NS(tool_call=NS(function_calls=[NS(id="c1", name="get_time", args={})]))]])
    s, ev = make(lambda m, c: Conn(fs))
    await s.start("atlas")
    await wait_for(lambda: fs.tool_responses)
    fr = fs.tool_responses[0][0]
    assert fr.id == "c1" and fr.name == "get_time" and fr.response == {"result": "get_time-ok"}
    assert ev["tools"][0][0] == "get_time"
    await s.stop()


async def test_cancelled_tool_call_response_is_dropped():
    fs = FakeSession([[NS(tool_call_cancellation=NS(ids=["c1"])), NS(tool_call=NS(function_calls=[NS(id="c1", name="get_time", args={})]))]])
    s, ev = make(lambda m, c: Conn(fs))
    await s.start("atlas")
    await wait_for(lambda: ev["tools"])
    await asyncio.sleep(.1)
    assert fs.tool_responses == []
    await s.stop()


async def test_audio_lines_interrupt_and_turn_complete():
    part = NS(inline_data=NS(data=b"\x01\x00" * 10))
    fs = FakeSession([[
        sc(model_turn=NS(parts=[part])),
        sc(input_transcription=NS(text="merhaba ")), sc(input_transcription=NS(text="nexus")),
        sc(output_transcription=NS(text="selam")),
        sc(interrupted=True),
        sc(output_transcription=NS(text="tamam")), sc(turn_complete=True),
    ]])
    s, ev = make(lambda m, c: Conn(fs))
    await s.start("atlas")
    await wait_for(lambda: ev["turn"] == 1)
    assert ev["audio"] == [b"\x01\x00" * 10]
    assert ev["intr"] == 1
    assert ("user", "merhaba nexus", True) in ev["lines"] and ("ai", "tamam", True) in ev["lines"]
    assert "speaking" in ev["status"] and "thinking" in ev["status"]
    await s.stop()


async def test_model_fallback_on_not_found():
    seen = []
    fs = FakeSession([[NS(setup_complete=NS())]])

    def connect(model, cfg):
        seen.append(model)
        return Conn(fs, error=RuntimeError("404 models/m-one is not found")) if model == "m-one" else Conn(fs)

    s, ev = make(connect)
    await s.start("atlas")
    await wait_for(lambda: "m-two" in seen and s.model == "m-two")
    assert seen[:2] == ["m-one", "m-two"]
    await s.stop()


async def test_reconnects_after_drop():
    calls = []
    fs = FakeSession([[NS(setup_complete=NS())]])

    def connect(model, cfg):
        calls.append(model)
        return Conn(fs, error=ConnectionError("kopuk")) if len(calls) == 1 else Conn(fs)

    s, ev = make(connect)
    await s.start("atlas")
    await wait_for(lambda: len(calls) >= 2 and "listening" in ev["status"])
    assert any(not fatal for _, fatal in ev["errors"])
    await s.stop()


async def test_goaway_reconnects_with_resumption_handle():
    configs = []
    first = FakeSession([[NS(session_resumption_update=NS(resumable=True, new_handle="H1")), NS(go_away=NS(time_left="5s"))]])
    second = FakeSession([[NS(setup_complete=NS())]])

    def connect(model, cfg):
        configs.append(cfg)
        return Conn(first if len(configs) == 1 else second)

    s, ev = make(connect)
    await s.start("atlas")
    await wait_for(lambda: len(configs) >= 2)
    assert configs[0].session_resumption.handle is None
    assert configs[1].session_resumption.handle == "H1"
    await s.stop()


async def test_invalid_key_is_fatal_and_stops():
    s, ev = make(lambda m, c: Conn(FakeSession([]), error=RuntimeError("API key not valid. Please pass a valid API key.")))
    await s.start("atlas")
    await wait_for(lambda: ev["errors"])
    assert ev["errors"][0][1] is True and "status" and "error" in ev["status"]
    await s.stop()


async def test_new_chip_starts_new_session_without_handle():
    configs = []
    sessions = [FakeSession([[NS(session_resumption_update=NS(resumable=True, new_handle="H1"))]]), FakeSession([[]])]

    def connect(model, cfg):
        configs.append(cfg)
        return Conn(sessions[min(len(configs) - 1, 1)])

    s, ev = make(connect)
    await s.start("atlas")
    await wait_for(lambda: s.handle == "H1")
    await s.start("forge")
    await wait_for(lambda: len(configs) >= 2)
    assert configs[-1].session_resumption.handle is None
    assert "Charon" not in str(configs[-1].speech_config) and "Puck" in str(configs[-1].speech_config)
    await s.stop()


async def test_send_helpers_reach_session():
    fs = FakeSession([[NS(setup_complete=NS())]])
    s, ev = make(lambda m, c: Conn(fs))
    await s.start("atlas")
    await wait_for(lambda: "listening" in ev["status"])
    s.send_audio(b"\x00\x00" * 8)
    s.send_text("selam")
    s.send_image(b"jpeg", "ekranda ne var?")
    await wait_for(lambda: len(fs.realtime) >= 4)
    kinds = [list(k)[0] for k in fs.realtime]
    assert kinds == ["audio", "text", "video", "text"]
    await s.stop()


async def test_rejected_model_is_skipped_on_next_session():
    seen = []

    def connect(model, cfg):
        seen.append(model)
        return Conn(FakeSession([[NS(setup_complete=NS())]]), error=RuntimeError("1011 exceeded your quota") if model == "m-one" else None)

    s, ev = make(connect)
    await s.start("atlas")
    await wait_for(lambda: s.model == "m-two")
    seen.clear()
    await s.start("forge")                      # yeni çip: kota diyen m-one tekrar denenmemeli
    await wait_for(lambda: s.model == "m-two" and seen)
    assert seen == ["m-two"]
    await s.stop()
