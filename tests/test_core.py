"""Orkestratör: demo beyni ile çip takma, devir, onay, hikâye ve araçların bağlanması."""
import threading
import time

import pytest

from nexus import chips, rivalry, settings, story
from nexus.core import Core


@pytest.fixture
def core():
    c = Core(demo=True, null_audio=True)
    c.debug = True
    events = []
    c.set_emitter(lambda e, p: events.append((e, p)))
    c.events = events
    c.start()
    yield c
    c.shutdown()


def until(cond, timeout=3.0):
    end = time.time() + timeout
    while not cond():
        assert time.time() < end, "zaman aşımı"
        time.sleep(.02)


def lines(core, who=None):
    return [p for e, p in core.events if e == "line" and (who is None or p["who"] == who)]


def test_starts_in_demo_and_mounts_last_chip(core):
    until(lambda: any(e == "chip" for e, _ in core.events))
    assert core.demo and core.active == "atlas"
    p = core.state_payload()
    assert len(p["roster"]) == 10 and p["active"] == "atlas" and "ledger" in p and "matrix" in p


def test_mount_changes_chip_and_emits_theme_and_greeting(core):
    core.mount("forge")
    until(lambda: any(p.get("key") == "forge" for e, p in core.events if e == "chip"))
    until(lambda: lines(core, "forge"))
    assert core.active == "forge" and settings.get("last_chip") == "forge"
    chip_evt = [p for e, p in core.events if e == "chip" and p["key"] == "forge"][0]
    assert chip_evt["colors"]["main"] == "#FF8A3C" and chip_evt["voice"] == "Puck"


def test_text_gets_tool_result_in_demo(core):
    core.send_text("saat kaç")
    until(lambda: any("get_time" in p["text"] for p in lines(core, "atlas")))
    assert any(p["kind"] == "user" for p in lines(core, "user"))


def test_chained_chip_cannot_be_mounted_then_repaired(core):
    code = story.grant()
    core.mount("atlas")
    until(lambda: any(e == "error" for e, _ in core.events))
    assert story.locked() and core.state_payload()["story"]["locked"]
    assert [r for r in core.state_payload()["roster"] if r["key"] == "nova"][0]["disabled"]
    assert core.repair("yanlis") is False
    assert core.repair(code.lower()) is True and not story.locked()
    assert any(e == "story" for e, _ in core.events)


def test_confirm_blocks_until_answer(core):
    result = {}

    def ask():
        result["ok"] = core.confirm("Komut çalıştır", "git status", timeout=3)

    t = threading.Thread(target=ask)
    t.start()
    until(lambda: any(e == "confirm" for e, _ in core.events))
    cid = [p for e, p in core.events if e == "confirm"][0]["id"]
    core.answer_confirm(cid, True)
    t.join(2)
    assert result["ok"] is True


def test_confirm_times_out_as_denied(core):
    assert core.confirm("x", timeout=.2) is False


def test_handoff_switches_chip_after_turn_complete(core):
    until(lambda: any(e == "chip" for e, _ in core.events))
    msg = core.request_handoff("sentinel", "güvenlik durumuna bak")
    assert "SENTINEL" in msg and core._pending_handoff == ("sentinel", "güvenlik durumuna bak")
    before = rivalry.score("atlas", "sentinel")
    core.loop.call_soon_threadsafe(core._on_turn_complete)
    until(lambda: core.active == "sentinel", 5)
    assert any(e == "handoff" and p == {"from": "atlas", "to": "sentinel"} for e, p in core.events)
    assert rivalry.score("atlas", "sentinel") == before + 1            # dosta devir +1


def test_handoff_rejects_unknown_active_and_chained(core):
    assert "başarısız" in core.request_handoff("yok", "x")
    assert "başarısız" in core.request_handoff("atlas", "x")           # zaten aktif
    story.grant()
    assert "başarısız" in core.request_handoff("nova", "x")


def test_tools_respect_chip_permissions(core):
    until(lambda: any(e == "chip" for e, _ in core.events))
    assert "error" in core._run_tool("port_scan", {"host": "127.0.0.1"})         # ATLAS'ın yetkisi yok
    assert "result" in core._run_tool("get_time", {})


def test_peace_and_vote_update_matrix(core):
    a = rivalry.score("atlas", "obsidian")
    m = core.make_peace("atlas", "obsidian")
    assert m["atlas"]["obsidian"] == a + 10


def test_story_dev_shortcut_makes_obsidian_ask(core):
    core.mount("obsidian")
    until(lambda: core.active == "obsidian")
    core.force_story_due()
    until(lambda: not story.due() and story._state()["asked"], 3)


def test_timer_events_use_hud_format(core):
    core.emit("timers", {"timers": [{"id": 1, "label": "çay", "kalan_sn": 120}]})
    p = [p for e, p in core.events if e == "timers"][-1]["timers"][0]
    assert p["remaining"] == 120 and p["total"] == 120
    core.emit("ledger", {"gelir": 100, "gider": 40, "net": 60, "kayit": 3})
    assert [p for e, p in core.events if e == "ledger"][-1] == {"net30": 60, "income30": 100, "expense30": 40, "count": 3}


def test_telemetry_has_hud_keys(core):
    until(lambda: any(e == "telemetry" for e, _ in core.events), 4)
    t = [p for e, p in core.events if e == "telemetry"][-1]
    assert {"cpu", "ram", "disk", "net_down", "net_up", "mic", "spk", "speaker"} <= set(t)


def test_partial_lines_send_only_new_text(core):
    """HUD parçaları satıra ekler: biriken metin değil, yalnızca yeni kısım gitmeli (tekrarlayan yazı hatası)."""
    core.events.clear()
    for text, final in [("Merhaba", False), ("Merhaba şef.", False), ("Merhaba şef. Nasılsın?", False), ("Merhaba şef. Nasılsın?", True)]:
        core._on_line("ai", text, final)
    got = [(p["text"], p["final"]) for e, p in core.events if e == "line"]
    assert got == [("Merhaba", False), (" şef.", False), (" Nasılsın?", False), ("", True)]
    assert "".join(t for t, _ in got) == "Merhaba şef. Nasılsın?"
    assert core.history[-1][1] == "Merhaba şef. Nasılsın?"


def test_interrupt_closes_open_ai_line(core):
    core.events.clear()
    core._on_line("ai", "Başlıyorum", False)
    core._on_interrupted()
    core._on_line("ai", "Tamam", False)
    core._on_line("ai", "Tamam", True)
    got = [(p["text"], p["final"]) for e, p in core.events if e == "line"]
    assert got == [("Başlıyorum", False), ("", True), ("Tamam", False), ("", True)]


def test_slow_interjection_never_blocks_live_audio_or_mic(core):
    """Hata: araya girme metni takılınca (30 sn) Live sesi atılıyor ve mikrofon kesiliyordu → hiç ses gelmiyordu."""
    import asyncio
    until(lambda: any(e == "chip" for e, _ in core.events))
    core._chain = __import__("nexus.voicefx", fromlist=["x"]).for_profile("none")

    async def very_slow(*a, **k):
        await asyncio.sleep(30)

    core.aux.interject_text = very_slow
    settings.set("drama", "kaos")
    core._last_user = "deploy ettim"
    rivalry.reset_runtime()
    core.loop.call_soon_threadsafe(core._maybe_interject)
    time.sleep(.3)                                              # araya girme üretimde bekliyor
    assert core._interjecting is False
    fed = []
    orig = core.speaker.feed
    core.speaker.feed = lambda who, pcm: (fed.append(len(pcm)), orig(who, pcm))[1]
    core._on_audio(b"\x10\x00" * 480)                           # Live cevabı: çalınmalı
    assert fed, "araya girme beklerken Live sesi atıldı"
    core.set_mic(False)
    assert core.gate is not None


def test_interjection_is_dropped_when_user_starts_speaking(core):
    import asyncio
    until(lambda: any(e == "chip" for e, _ in core.events))
    called = []

    async def text(*a, **k):
        await asyncio.sleep(.3)
        return "Deploy mu dedin?"

    async def tts(*a, **k):
        called.append("tts")
        return b"\x00\x00" * 2400

    core.aux.interject_text, core.aux.tts = text, tts
    core._last_user = "deploy"
    fut = asyncio.run_coroutine_threadsafe(core._interject("sentinel", "atlas", "deploy", "tamam"), core.loop)
    time.sleep(.1)
    core._turn_seq += 1                                         # kullanıcı konuşmaya başladı
    fut.result(3)
    assert called == [] and not any(p.get("kind") == "interject" for e, p in core.events if e == "line")
