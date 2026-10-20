"""Emitter hız sınırı ve telemetri birleştirme; Api hata zarfı."""
import json

from nexus.hud.bridge import MAX_PER_SEC, Api, Emitter


class FakeWindow:
    def __init__(self):
        self.calls: list[str] = []

    def evaluate_js(self, js):
        self.calls.append(js)


class Clock:
    """Sahte saat: sleep zamanı ilerletir, böylece hız sınırı deterministik test edilir."""
    def __init__(self):
        self.t = 100.0
        self.slept = 0.0

    def now(self):
        return self.t

    def sleep(self, s):
        self.slept += s
        self.t += s


def make():
    w, c = FakeWindow(), Clock()
    return w, c, Emitter(w, clock=c.now, sleep=c.sleep, autostart=False)


def drain(e):
    while e.pump():
        pass


def test_telemetry_is_coalesced_last_value_wins():
    w, _, e = make()
    for i in range(50):
        e.emit("telemetry", {"cpu": i})
    drain(e)
    assert len(w.calls) == 1 and '"cpu": 49' in w.calls[0]


def test_other_events_keep_order_and_are_not_dropped():
    w, _, e = make()
    for i in range(10):
        e.emit("line", {"text": str(i)})
    drain(e)
    texts = [json.loads(c.split(", ", 1)[1][:-1])["text"] for c in w.calls]
    assert texts == [str(i) for i in range(10)]


def test_rate_limit_30_per_second():
    w, c, e = make()
    for i in range(61):
        e.emit("line", {"i": i})
    t0 = c.now()
    drain(e)
    elapsed = c.now() - t0
    assert len(w.calls) == 61
    assert elapsed >= 60 / MAX_PER_SEC - 1e-6          # 61 olay en az ~2 sn sürmeli


def test_closed_window_is_swallowed():
    class Dead:
        def evaluate_js(self, js):
            raise RuntimeError("pencere kapalı")
    e = Emitter(Dead(), autostart=False)
    e.emit("status", {"status": "idle"})
    assert e.pump() is True                            # hata yutulur, düşmez


def test_js_payload_is_valid_and_keeps_turkish():
    w, _, e = make()
    e.emit("line", {"text": "Çağrıyı yapıyorum şef"})
    drain(e)
    assert w.calls[0].startswith('NX.on("line", ') and "Çağrıyı" in w.calls[0]


def test_api_wraps_errors_and_delegates():
    class Core:
        def mount(self, chip):
            if chip == "x":
                raise ValueError("bilinmeyen çip")
        def repair(self, code): return code == "ok"
        def make_peace(self, a, b): return {"atlas": {}}
    api = Api(Core())
    assert api.mount("atlas") == {"ok": True}
    assert api.mount("x") == {"ok": False, "error": "bilinmeyen çip"}
    assert api.repair("ok") == {"ok": True, "restored": True}
    assert api.make_peace("a", "b")["ok"] is True
    json.dumps(api.settings_set("drama", "kaos"))
    assert api.settings_set("yok_boyle_ayar", 1)["ok"] is False
