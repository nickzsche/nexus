"""Test ortamı: NEXUS_DATA geçici klasöre yönlendirilir (modüller paths'i import anında okuduğu için en başta)."""
import os
import shutil
import tempfile

_TMP = tempfile.mkdtemp(prefix="nexus_test_")
os.environ["NEXUS_DATA"] = _TMP

import pytest  # noqa: E402

from nexus import chips, paths, rivalry  # noqa: E402
from nexus.tools import system  # noqa: E402


class FakeCtx:
    """Orkestratör yerine geçen sahte bağlam; olayları ve onay isteklerini kaydeder."""

    def __init__(self, chip="atlas", confirm=True):
        self.chip = chips.get(chip)
        self.answer = confirm
        self.events, self.confirms, self.images, self.handoffs, self.debates = [], [], [], [], []

    def emit(self, event, payload=None):
        self.events.append((event, payload or {}))

    def confirm(self, title, detail="", timeout=30.0):
        self.confirms.append((title, detail))
        return self.answer

    def send_image(self, jpeg, note=""):
        self.images.append((jpeg, note))

    def handoff(self, to, task):
        self.handoffs.append((to, task))
        return f"{to} devralıyor."

    def debate(self, a, b, topic):
        self.debates.append((a, b, topic))
        return "Arena başlıyor."


@pytest.fixture
def ctx():
    return FakeCtx()


@pytest.fixture
def make_ctx():
    return FakeCtx


@pytest.fixture(autouse=True)
def clean_state():
    """Her testten önce veri klasörü boşaltılır, çalışma zamanı durumu sıfırlanır."""
    for entry in paths.DATA_DIR.iterdir():
        try:
            shutil.rmtree(entry) if entry.is_dir() else entry.unlink()
        except FileNotFoundError:                 # arka plan iş parçacığı aynı anda siliyor olabilir
            pass
    system.clear_timers()
    system.set_timer_callback(None)
    rivalry.reset_runtime()
    yield
    system.clear_timers()


@pytest.fixture
def workspace(tmp_path):
    from nexus import settings
    ws = tmp_path / "ws"
    ws.mkdir()
    settings.set("workspace", str(ws))
    return ws


def pytest_sessionfinish(session, exitstatus):
    shutil.rmtree(_TMP, ignore_errors=True)
