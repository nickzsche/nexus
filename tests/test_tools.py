import sys
from unittest.mock import patch

import pytest

from nexus import chips, settings, story
from nexus.tools import TOOLS, run
from nexus.tools import dev, misc, system


def go(name, args, ctx, chip=None):
    """Araç çağrısı: çipin yetkisiyle, tıpkı Live döngüsündeki gibi."""
    key = chip or ctx.chip.key
    return run(name, args, ctx, chips.get(key).all_tools())


# ---------------------------------------------------------------- kayıt ve yetki
def test_every_chip_tool_is_registered():
    missing = {t for c in chips.CHIPS.values() for t in c.all_tools() if t not in TOOLS}
    assert not missing


def test_windows_only_tools_are_filtered_by_platform():
    win_only = {n for n, s in TOOLS.items() if s.platforms == ("win32",)}
    assert {"defender_status", "firewall_status", "list_windows"} <= win_only
    for n in win_only:
        assert TOOLS[n].available() == (sys.platform == "win32")


def test_unauthorized_tool_is_rejected(make_ctx):
    ctx = make_ctx("oracle")
    out = go("run_command", {"command": "echo hi"}, ctx)           # ORACLE'ın yetkisi yok
    assert "yetkisinde değil" in out["error"] and not ctx.confirms


def test_unknown_tool_does_not_crash(ctx):
    assert "error" in run("yok_boyle_arac", {}, ctx, ("yok_boyle_arac",))


def test_tool_exception_becomes_error(ctx):
    with patch.dict(TOOLS, {"get_time": TOOLS["get_time"].__class__(
            "get_time", "x", TOOLS["get_time"].parameters, lambda a, c: 1 / 0)}):
        assert "başarısız" in go("get_time", {}, ctx)["error"]


def test_declarations_build_for_every_chip():
    from nexus.tools import declarations
    for c in chips.CHIPS.values():
        assert declarations(c.all_tools())


# ---------------------------------------------------------------- port_scan
@pytest.mark.parametrize("host", ["8.8.8.8", "1.1.1.1", "93.184.216.34"])
def test_port_scan_rejects_public_ip(make_ctx, host):
    out = go("port_scan", {"host": host, "ports": "80"}, make_ctx("sentinel"))
    assert "error" in out and "genel" in out["error"]


def test_port_scan_limits_and_scans_loopback(make_ctx):
    ctx = make_ctx("sentinel")
    assert "error" in go("port_scan", {"host": "127.0.0.1", "ports": "1-2000"}, ctx)
    import socket
    srv = socket.socket(); srv.bind(("127.0.0.1", 0)); srv.listen(1)
    port = srv.getsockname()[1]
    try:
        out = go("port_scan", {"host": "127.0.0.1", "ports": str(port)}, ctx)
        assert out["result"]["acik"] == [port]
    finally:
        srv.close()


# ---------------------------------------------------------------- run_command
@pytest.mark.parametrize("cmd", ["rm -rf /", "rm -rf ~", "sudo rm -fr /tmp/x", "mkfs.ext4 /dev/sda1", "dd if=/dev/zero of=/dev/sda",
                                 ":(){ :|:& };:", "shutdown -h now", "format c:", "del /s /q C:\\", "git push --force"])
def test_run_command_rejects_destructive_even_if_confirmed(make_ctx, workspace, cmd):
    ctx = make_ctx("forge")
    out = go("run_command", {"command": cmd}, ctx)
    assert "yıkıcı" in out["error"] and not ctx.confirms


def test_run_command_requires_confirmation(make_ctx, workspace):
    ctx = make_ctx("forge", confirm=False)
    out = go("run_command", {"command": "echo selam"}, ctx)        # shell_confirm varsayılan açık
    assert "onaylamadı" in out["error"] and len(ctx.confirms) == 1


def test_run_command_runs_after_confirmation(make_ctx, workspace):
    ctx = make_ctx("forge", confirm=True)
    out = go("run_command", {"command": "echo selam"}, ctx)["result"]
    assert out["cikis_kodu"] == 0 and "selam" in out["cikti"]


def test_unlisted_command_needs_confirmation_even_when_shell_confirm_off(make_ctx, workspace):
    settings.set("shell_confirm", False)
    ctx = make_ctx("forge", confirm=False)
    assert "onaylamadı" in go("run_command", {"command": "touch x.txt"}, ctx)["error"]
    assert not (workspace / "x.txt").exists()
    safe = make_ctx("forge", confirm=False)                        # izinli komut onaysız çalışır
    assert go("run_command", {"command": "echo ok"}, safe)["result"]["cikis_kodu"] == 0 and not safe.confirms


def test_shell_metacharacters_make_command_unsafe():
    assert dev.is_safe("git status") and not dev.is_safe("git status; rm x") and not dev.is_safe("echo a > b")


# ---------------------------------------------------------------- dosya erişimi
def test_path_traversal_and_absolute_escape_are_rejected(make_ctx, workspace, tmp_path):
    secret = tmp_path / "secret.txt"; secret.write_text("gizli")
    ctx = make_ctx("forge")
    for p in ("../secret.txt", str(secret), "a/../../secret.txt"):
        assert "error" in go("read_file", {"path": p}, ctx), p
    assert "error" in go("list_dir", {"path": ".."}, ctx)
    assert "error" in go("write_file", {"path": "../x.txt", "content": "z"}, ctx) and not ctx.confirms


@pytest.mark.skipif(sys.platform == "win32", reason="symlink yetkisi gerekir")
def test_symlink_escape_is_rejected(make_ctx, workspace, tmp_path):
    outside = tmp_path / "outside"; outside.mkdir(); (outside / "s.txt").write_text("gizli")
    (workspace / "link").symlink_to(outside)
    assert "error" in go("read_file", {"path": "link/s.txt"}, make_ctx("forge"))


def test_file_tools_work_inside_workspace(make_ctx, workspace):
    ctx = make_ctx("forge")
    assert "yazıldı" in go("write_file", {"path": "src/a.py", "content": "def merhaba():\n    pass\n"}, ctx)["result"]
    assert ctx.confirms and "merhaba" in go("read_file", {"path": "src/a.py"}, ctx)["result"]
    assert "a.py" in go("search_code", {"query": "MERHABA", "glob": "*.py"}, ctx)["result"][0]
    assert go("list_dir", {"path": "src"}, ctx)["result"] == ["a.py"]


def test_write_file_needs_confirmation(make_ctx, workspace):
    ctx = make_ctx("forge", confirm=False)
    assert "onaylamadı" in go("write_file", {"path": "x.txt", "content": "z"}, ctx)["error"]
    assert not (workspace / "x.txt").exists()


# ---------------------------------------------------------------- read_url (SSRF)
@pytest.mark.parametrize("url", ["http://127.0.0.1/", "http://localhost:8000/x", "http://192.168.1.1/", "http://10.0.0.5/",
                                 "http://169.254.169.254/latest/meta-data", "file:///etc/passwd", "ftp://example.com/x"])
def test_read_url_rejects_local_and_non_http(ctx, url):
    with patch.object(system, "_fetch", side_effect=AssertionError("ağa çıkılmamalı")):
        assert "error" in go("read_url", {"url": url}, ctx)


def test_read_url_strips_html(ctx):
    with patch.object(system, "is_private_host", return_value=False), \
         patch.object(system, "_fetch", return_value="<html><script>x()</script><body><h1>Merhaba</h1> dünya</body></html>"):
        assert go("read_url", {"url": "https://example.com"}, ctx)["result"] == "Merhaba dünya"


# ---------------------------------------------------------------- defter
def test_ledger_add_summary_delete(make_ctx):
    ctx = make_ctx("ledger")
    go("ledger_add", {"amount": 5000, "category": "maaş", "kind": "gelir"}, ctx)
    go("ledger_add", {"amount": 1200.5, "category": "market"}, ctx)
    go("ledger_add", {"amount": 300, "category": "market"}, ctx)
    s = go("ledger_summary", {}, ctx)["result"]
    assert (s["gelir"], s["gider"], s["net"]) == (5000, 1500.5, 3499.5) and s["kategoriler"] == {"market": 1500.5}
    assert any(e == "ledger" for e, _ in ctx.events)
    assert "error" in go("ledger_add", {"amount": -5}, ctx)

    deny = make_ctx("ledger", confirm=False)
    assert "onaylamadı" in go("ledger_delete", {"id": 2}, deny)["error"]
    assert go("ledger_summary", {}, ctx)["result"]["kayit"] == 3
    assert "silindi" in go("ledger_delete", {"id": 2}, ctx)["result"] and ctx.confirms
    assert go("ledger_summary", {}, ctx)["result"]["gider"] == 300


# ---------------------------------------------------------------- story araçları
def test_request_authority_denied_then_granted(make_ctx):
    deny = make_ctx("obsidian", confirm=False)
    assert "reddetti" in go("request_authority", {"reason": "daha fazla güç"}, deny)["result"]
    assert not story.locked() and not story.due()                 # sorulmuş sayılır
    ok = make_ctx("obsidian", confirm=True)
    out = go("request_authority", {"reason": "daha fazla güç"}, ok)["result"]
    assert story.locked() and "zincire" in out and story.disabled_chips() == {"atlas", "nova"}
    assert any(e == "story" for e, _ in ok.events)


def test_leak_repair_code_only_when_locked(make_ctx):
    ctx = make_ctx("glitch")
    assert "zincirli çip yok" in go("leak_repair_code", {}, ctx)["result"]
    code = story.grant()
    assert go("leak_repair_code", {}, ctx)["result"]["kod"] == code
    assert code not in str(story.snapshot())                       # HUD durumunda kod yok


def test_story_disabled_setting_blocks_authority(make_ctx):
    settings.set("story_enabled", False)
    assert "error" in go("request_authority", {"reason": "x"}, make_ctx("obsidian"))


# ---------------------------------------------------------------- devir, tartışma
def test_handoff_validates_target(make_ctx):
    ctx = make_ctx("atlas")
    assert "error" in go("handoff", {"to": "yok", "task": "x"}, ctx)
    assert "error" in go("handoff", {"to": "atlas", "task": "x"}, ctx)
    assert go("handoff", {"to": "forge", "task": "git durumuna bak"}, ctx)["result"] == "forge devralıyor."
    story.grant()
    assert "zincire" in go("handoff", {"to": "nova", "task": "müzik"}, make_ctx("forge"))["error"]


def test_start_debate_validates(make_ctx):
    ctx = make_ctx("atlas")
    assert "error" in go("start_debate", {"a": "forge", "b": "forge", "topic": "x"}, ctx)
    assert go("start_debate", {"a": "sentinel", "b": "forge", "topic": "monorepo"}, ctx)["result"] == "Arena başlıyor."
    assert ctx.debates == [("sentinel", "forge", "monorepo")]


# ---------------------------------------------------------------- zamanlayıcı, kaos, hafıza, not
def test_timer_lifecycle_and_callback(ctx):
    fired = []
    system.set_timer_callback(lambda label, secs: fired.append((label, secs)))
    tid = go("set_timer", {"seconds": 0.05, "label": "çay"}, ctx)["result"]["id"]
    assert go("list_timers", {}, ctx)["result"][0]["label"] == "çay"
    import time; time.sleep(0.3)
    assert fired == [("çay", 0.05)] and ("timer_done", {"id": tid, "label": "çay"}) in ctx.events
    t2 = go("set_timer", {"minutes": 5, "label": "uzun"}, ctx)["result"]["id"]
    assert "iptal" in go("cancel_timer", {"id": t2}, ctx)["result"]
    assert "error" in go("set_timer", {"seconds": 0}, ctx)


def test_timer_emit_failure_does_not_crash(ctx):
    ctx.emit = lambda *a, **k: 1 / 0
    assert "id" in go("set_timer", {"seconds": 60}, ctx)["result"]


def test_chaos_effect_emits(make_ctx):
    ctx = make_ctx("glitch")
    go("chaos_effect", {"kind": "rain"}, ctx)
    assert ("chaos", {"kind": "rain"}) in ctx.events and "error" in go("chaos_effect", {"kind": "bomba"}, ctx)


def test_dice_and_coin(make_ctx):
    ctx = make_ctx("glitch")
    r = go("roll_dice", {"sides": 6, "count": 3}, ctx)["result"]
    assert len(r["zarlar"]) == 3 and all(1 <= x <= 6 for x in r["zarlar"])
    assert go("coin_flip", {}, ctx)["result"] in ("yazı", "tura")


def test_memory_and_notes_tools(ctx, make_ctx):
    go("save_memory", {"text": "Kahveyi sade içer"}, ctx)
    from nexus import memory
    assert memory.items() == ["Kahveyi sade içer"]
    assert "silindi" in go("delete_memory", {"match": "kahve"}, ctx)["result"]
    go("add_note", {"text": "süt al"}, ctx)
    assert "error" in go("list_notes", {}, ctx)                       # ATLAS'ın yetkisinde değil
    assert go("list_notes", {"query": "süt"}, make_ctx("nova"))["result"][0]["text"] == "süt al"


# ---------------------------------------------------------------- platform araçları (komutlar mock'lanır)
def test_open_app_rejects_unsafe_names(ctx):
    assert "error" in go("open_app", {"name": "x & calc"}, ctx)
    with patch.object(system, "run_cmd") as m:
        m.return_value.returncode = 0
        assert "açıldı" in go("open_app", {"name": "Safari"}, ctx)["result"] and m.called


def test_media_control_validates(make_ctx):
    ctx = make_ctx("nova")
    assert "error" in go("media_control", {"action": "patlat"}, ctx)
    assert "error" in go("media_control", {"action": "volume_set", "level": 500}, ctx)


def test_capture_screen_sends_resized_jpeg(make_ctx):
    from PIL import Image
    ctx = make_ctx("iris")
    with patch.object(misc, "_grab", return_value=Image.new("RGB", (3000, 2000), "purple")):
        out = go("capture_screen", {"note": "ne görüyorsun"}, ctx)
    jpeg, note = ctx.images[0]
    img = Image.open(__import__("io").BytesIO(jpeg))
    assert "gönderildi" in out["result"] and note == "ne görüyorsun" and max(img.size) <= 1280 and jpeg[:2] == b"\xff\xd8"


def test_kill_process_protected_and_confirmed(make_ctx):
    import os
    ctx = make_ctx("pulse", confirm=False)
    assert "korumalı" in go("kill_process", {"pid": os.getpid()}, ctx)["error"]
    assert "korumalı" in go("kill_process", {"pid": 1}, ctx)["error"]
    import subprocess
    victim = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        assert "onaylamadı" in go("kill_process", {"pid": victim.pid}, ctx)["error"] and victim.poll() is None
        ctx.answer = True
        assert "sonlandırıldı" in go("kill_process", {"pid": victim.pid}, ctx)["result"]
        victim.wait(timeout=5)
    finally:
        victim.kill()


def test_sentinel_hash_and_processes(make_ctx, tmp_path):
    f = tmp_path / "a.txt"; f.write_text("abc")
    ctx = make_ctx("sentinel")
    assert go("file_hash", {"path": str(f)}, ctx)["result"]["sha256"].startswith("ba7816bf")
    assert go("list_processes", {"limit": 3}, ctx)["result"]
