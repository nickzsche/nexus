"""Ortak ve sistem araçları: zaman, sistem bilgisi, hava, zamanlayıcı, web, hafıza, devir, uygulama, medya, pano.

Mümkün olan her araç Mac, Windows ve Linux'ta çalışır; platforma özel kısımlar `sys.platform` ile ayrılır.
"""
from __future__ import annotations

import ipaddress
import json
import re
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from datetime import datetime
from typing import Any, Callable
from urllib.parse import quote, urlparse

import psutil

from .. import chips, memory, paths, settings, store, story
from ..log import log
from .registry import arg_str, tool

IS_WIN, IS_MAC = paths.IS_WIN, paths.IS_MAC
MAX_TEXT = 6000
_UNSAFE_NAME = re.compile(r'[&|<>^%"\r\n;`$]')


def safe_emit(ctx: Any, event: str, payload: dict | None = None) -> None:
    """Olay göndermek hiçbir zaman aracı düşürmez."""
    try:
        ctx.emit(event, payload or {})
    except Exception as exc:
        log("emit hatası", event, repr(exc))


def clip(text: str, limit: int = MAX_TEXT) -> str:
    return text if len(text) <= limit else text[:limit] + f"\n…[{len(text) - limit} karakter kesildi]"


def run_cmd(cmd: list[str], timeout: float = 15.0) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, encoding="utf-8", errors="replace")


# ------------------------------------------------------------------ ağ koruması
def is_private_host(host: str) -> bool:
    """Ana makine adı/IP'si yerel, özel ağ, link-local, loopback ya da ayrılmış bir adrese çözülüyorsa True."""
    host = host.strip().strip("[]")
    if not host:
        return True
    try:
        infos = [ipaddress.ip_address(host)]
    except ValueError:
        try:
            infos = [ipaddress.ip_address(i[4][0]) for i in socket.getaddrinfo(host, None)]
        except OSError:
            return True                     # çözülemeyeni güvenli sayma
    return any(a.is_private or a.is_loopback or a.is_link_local or a.is_reserved or a.is_multicast or a.is_unspecified
               for a in infos)


# ------------------------------------------------------------------ zaman ve sistem
@tool("get_time", "Şu anki yerel tarih ve saati verir.")
def get_time(args: dict, ctx: Any) -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S %Z (%A)")


@tool("system_info", "İşlemci, bellek, disk, pil ve işletim sistemi özetini verir.")
def system_info(args: dict, ctx: Any) -> dict:
    vm, bat = psutil.virtual_memory(), psutil.sensors_battery()
    root = "C:\\" if IS_WIN else "/"
    du = psutil.disk_usage(root)
    return {
        "sistem": sys.platform, "cpu_yuzde": psutil.cpu_percent(interval=0.2), "cpu_cekirdek": psutil.cpu_count(),
        "ram_yuzde": vm.percent, "ram_gb": round(vm.total / 2**30, 1),
        "disk_yuzde": round(du.used / du.total * 100), "disk_bos_gb": round(du.free / 2**30, 1),
        "pil": None if bat is None else {"yuzde": round(bat.percent), "sarjda": bat.power_plugged},
        "acik_kalma_saat": round((time.time() - psutil.boot_time()) / 3600, 1),
    }


@tool("disk_usage", "Disk bölümlerinin doluluk durumunu listeler.")
def disk_usage(args: dict, ctx: Any) -> Any:
    out = []
    for p in psutil.disk_partitions(all=False):
        try:
            u = psutil.disk_usage(p.mountpoint)
        except OSError:
            continue
        out.append({"bolum": p.mountpoint, "yuzde": u.percent, "bos_gb": round(u.free / 2**30, 1)})
    return out or {"error": "Disk bilgisi alınamadı."}


@tool("network_stats", "Ağ trafiğinin anlık hızını (kB/sn) ölçer.")
def network_stats(args: dict, ctx: Any) -> dict:
    a = psutil.net_io_counters()
    time.sleep(0.5)
    b = psutil.net_io_counters()
    return {"indirme_kbps": round((b.bytes_recv - a.bytes_recv) / 0.5 / 1024, 1),
            "yukleme_kbps": round((b.bytes_sent - a.bytes_sent) / 0.5 / 1024, 1)}


@tool("battery_status", "Pil durumunu verir.")
def battery_status(args: dict, ctx: Any) -> Any:
    b = psutil.sensors_battery()
    if b is None:
        return {"result": "Bu cihazda pil yok."}
    return {"yuzde": round(b.percent), "sarjda": b.power_plugged,
            "kalan_dk": None if b.secsleft in (psutil.POWER_TIME_UNLIMITED, psutil.POWER_TIME_UNKNOWN) else round(b.secsleft / 60)}


@tool("kill_process", "Bir süreci sonlandırır (pid ile). Her seferinde kullanıcıdan onay istenir.",
      {"pid": {"type": "integer", "description": "Süreç numarası", "required": True}})
def kill_process(args: dict, ctx: Any) -> Any:
    import os
    pid = int(args.get("pid", 0))
    if pid <= 4 or pid == os.getpid() or pid == os.getppid():
        return {"error": "Bu süreç korumalı, sonlandırılamaz."}
    try:
        proc = psutil.Process(pid)
        name = proc.name()
    except psutil.NoSuchProcess:
        return {"error": f"{pid} numaralı süreç yok."}
    if not ctx.confirm("Süreç sonlandırılsın mı?", f"{name} (pid {pid})", 30.0):
        return {"error": "Kullanıcı onaylamadı, süreç sonlandırılmadı."}
    try:
        proc.terminate()
        proc.wait(timeout=3)
    except psutil.TimeoutExpired:
        proc.kill()
    except psutil.AccessDenied:
        return {"error": "Erişim reddedildi."}
    return f"{name} sonlandırıldı."


# ------------------------------------------------------------------ hava durumu ve web
def _http_get_json(url: str) -> dict:
    import httpx
    r = httpx.get(url, timeout=10, follow_redirects=True, headers={"user-agent": "NEXUS"})
    r.raise_for_status()
    return r.json()


@tool("get_weather", "Bir yerin anlık hava durumunu verir (boşsa bulunduğun yer).",
      {"location": {"type": "string", "description": "Şehir adı, boş = otomatik"}})
def get_weather(args: dict, ctx: Any) -> Any:
    loc = quote(arg_str(args, "location"))
    j = _http_get_json(f"https://wttr.in/{loc}?format=j1&lang=tr")
    cur = j["current_condition"][0]
    area = (j.get("nearest_area") or [{}])[0]
    desc = (cur.get("lang_tr") or cur.get("weatherDesc") or [{}])[0].get("value", "")
    return {"yer": ((area.get("areaName") or [{}])[0]).get("value", ""), "sicaklik_c": int(cur["temp_C"]),
            "hissedilen_c": int(cur["FeelsLikeC"]), "durum": desc, "nem": int(cur["humidity"]),
            "ruzgar_kmh": int(cur["windspeedKmph"])}


def _fetch(url: str, max_bytes: int = 500_000, hops: int = 4) -> str:
    """Yönlendirmeleri tek tek doğrulayarak sayfayı indirir (SSRF'e karşı her adım denetlenir)."""
    import httpx
    with httpx.Client(follow_redirects=False, timeout=15, headers={"user-agent": "Mozilla/5.0 NEXUS"}) as client:
        for _ in range(hops + 1):
            p = urlparse(url)
            if p.scheme not in ("http", "https") or not p.hostname or is_private_host(p.hostname):
                raise ValueError("Yerel ya da özel ağ adresleri okunmaz.")
            with client.stream("GET", url) as r:
                if r.status_code in (301, 302, 303, 307, 308) and r.headers.get("location"):
                    url = str(httpx.URL(url).join(r.headers["location"]))
                    continue
                r.raise_for_status()
                body = b"".join(c for c, _ in zip(r.iter_bytes(), range(max_bytes // 1024 + 8)))[:max_bytes]
                return body.decode(r.encoding or "utf-8", "replace")
    raise ValueError("Çok fazla yönlendirme.")


@tool("read_url", "Bir web sayfasının metnini okur (http/https).",
      {"url": {"type": "string", "description": "Tam adres", "required": True}})
def read_url(args: dict, ctx: Any) -> Any:
    url = arg_str(args, "url")
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        return {"error": "Yalnızca http/https adresleri okunur."}
    if is_private_host(p.hostname):
        return {"error": "Yerel ya da özel ağ adresleri okunmaz."}
    try:
        html = _fetch(url)
    except ValueError as exc:
        return {"error": str(exc)}
    text = re.sub(r"<(script|style|noscript)[^>]*>.*?</\1>", " ", html, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return clip(re.sub(r"\s+", " ", text).strip())


# ------------------------------------------------------------------ zamanlayıcı
_TIMERS: dict[int, dict] = {}
_TIMER_LOCK = threading.RLock()
_NEXT_ID = 1
_CALLBACK: Callable[[str, float], None] | None = None


def set_timer_callback(fn: Callable[[str, float], None] | None) -> None:
    """Süre dolunca core'u haberdar eder: fn(label, saniye)."""
    global _CALLBACK
    _CALLBACK = fn


def _timer_list() -> list[dict]:
    now = time.time()
    with _TIMER_LOCK:
        return [{"id": i, "label": t["label"], "kalan_sn": max(0, round(t["due"] - now))} for i, t in sorted(_TIMERS.items())]


def clear_timers() -> None:
    with _TIMER_LOCK:
        for t in _TIMERS.values():
            t["timer"].cancel()
        _TIMERS.clear()


def _fire(tid: int, ctx: Any) -> None:
    with _TIMER_LOCK:
        t = _TIMERS.pop(tid, None)
    if not t:
        return
    safe_emit(ctx, "timer_done", {"id": tid, "label": t["label"]})
    safe_emit(ctx, "timers", {"timers": _timer_list()})
    if _CALLBACK:
        try:
            _CALLBACK(t["label"], t["seconds"])
        except Exception as exc:
            log("zamanlayıcı geri çağrısı hatası", repr(exc))


@tool("set_timer", "Geri sayım zamanlayıcısı kurar.",
      {"seconds": {"type": "number", "description": "Saniye"}, "minutes": {"type": "number", "description": "Dakika"},
       "label": {"type": "string", "description": "Ad"}})
def set_timer(args: dict, ctx: Any) -> Any:
    global _NEXT_ID
    secs = float(args.get("seconds") or 0) + 60 * float(args.get("minutes") or 0)
    if not 0 < secs <= 24 * 3600:
        return {"error": "Süre 1 saniye ile 24 saat arasında olmalı."}
    label = arg_str(args, "label") or "zamanlayıcı"
    with _TIMER_LOCK:
        tid, _NEXT_ID = _NEXT_ID, _NEXT_ID + 1
        timer = threading.Timer(secs, _fire, args=(tid, ctx))
        timer.daemon = True
        _TIMERS[tid] = {"label": label, "due": time.time() + secs, "seconds": secs, "timer": timer}
        timer.start()
    safe_emit(ctx, "timers", {"timers": _timer_list()})
    return {"id": tid, "label": label, "saniye": round(secs)}


@tool("list_timers", "Çalışan zamanlayıcıları ve kalan süreleri listeler.")
def list_timers(args: dict, ctx: Any) -> Any:
    return _timer_list() or {"result": "Çalışan zamanlayıcı yok."}


@tool("cancel_timer", "Bir zamanlayıcıyı iptal eder (id ya da ad ile).",
      {"id": {"type": "integer"}, "label": {"type": "string"}})
def cancel_timer(args: dict, ctx: Any) -> Any:
    tid, label = args.get("id"), arg_str(args, "label").lower()
    with _TIMER_LOCK:
        hit = [i for i, t in _TIMERS.items() if i == tid or (label and label in t["label"].lower())]
        for i in hit:
            _TIMERS.pop(i)["timer"].cancel()
    safe_emit(ctx, "timers", {"timers": _timer_list()})
    return f"{len(hit)} zamanlayıcı iptal edildi." if hit else {"error": "Eşleşen zamanlayıcı yok."}


# ------------------------------------------------------------------ hafıza, notlar, devir
@tool("save_memory", "Kullanıcı hakkındaki kalıcı bir bilgiyi kaydeder.",
      {"text": {"type": "string", "required": True}, "only_me": {"type": "boolean", "description": "Yalnızca bu çipin notu"}})
def save_memory(args: dict, ctx: Any) -> str:
    own = getattr(getattr(ctx, "chip", None), "key", None) if args.get("only_me") else None
    memory.add(arg_str(args, "text"), own)
    return "Kaydedildi."


@tool("delete_memory", "Kullanıcının artık istemediği bir kaydı, içindeki ifadeyle bulup siler.",
      {"match": {"type": "string", "required": True}})
def delete_memory(args: dict, ctx: Any) -> Any:
    n = memory.delete(arg_str(args, "match"))
    return f"{n} kayıt silindi." if n else {"error": "Eşleşen kayıt bulunamadı."}


@tool("add_note", "Kullanıcı için bir not alır.", {"text": {"type": "string", "required": True}})
def add_note(args: dict, ctx: Any) -> str:
    notes = store.load("notes.json", [])
    notes.append({"id": (notes[-1]["id"] + 1) if notes else 1, "ts": time.time(), "text": arg_str(args, "text")})
    store.save("notes.json", notes[-200:])
    return "Not alındı."


@tool("list_notes", "Notları listeler; isteğe bağlı olarak içinde arar.", {"query": {"type": "string"}})
def list_notes(args: dict, ctx: Any) -> Any:
    q = arg_str(args, "query").lower()
    rows = [n for n in store.load("notes.json", []) if q in n["text"].lower()][-20:]
    return [{"id": n["id"], "text": n["text"]} for n in rows] or {"result": "Not yok."}


@tool("handoff", "İşi başka bir çipe devreder (kendi alanına girmeyen işler için).",
      {"to": {"type": "string", "description": "Hedef çip anahtarı (atlas, nova, forge...)", "required": True},
       "task": {"type": "string", "description": "Devredilen işin eksiksiz tarifi", "required": True}})
def handoff(args: dict, ctx: Any) -> Any:
    to, task = arg_str(args, "to").lower(), arg_str(args, "task")
    if to not in chips.CHIPS:
        return {"error": f"Bilinmeyen çip: {to}. Seçenekler: {', '.join(chips.ORDER)}"}
    if to == getattr(getattr(ctx, "chip", None), "key", None):
        return {"error": "Zaten bu çipsin."}
    if to in story.disabled_chips():
        return {"error": f"{to.upper()} zincire vurulmuş, devredilemez."}
    if not task:
        return {"error": "Devredilecek iş boş."}
    return ctx.handoff(to, task)


@tool("start_debate", "İki çipi bir konuda tartıştırır (arena).",
      {"a": {"type": "string", "required": True}, "b": {"type": "string", "required": True},
       "topic": {"type": "string", "required": True}})
def start_debate(args: dict, ctx: Any) -> Any:
    a, b, topic = arg_str(args, "a").lower(), arg_str(args, "b").lower(), arg_str(args, "topic")
    bad = [k for k in (a, b) if k not in chips.CHIPS]
    if bad or a == b:
        return {"error": "İki farklı ve geçerli çip anahtarı ver."}
    if {a, b} & story.disabled_chips():
        return {"error": "Zincire vurulmuş çip tartışmaya katılamaz."}
    return ctx.debate(a, b, topic)


# ------------------------------------------------------------------ uygulamalar ve tarayıcı
def _name_ok(name: str) -> bool:
    return bool(name) and len(name) <= 80 and not _UNSAFE_NAME.search(name)


@tool("open_app", "Bilgisayarda bir uygulamayı adıyla açar.", {"name": {"type": "string", "required": True}})
def open_app(args: dict, ctx: Any) -> Any:
    name = arg_str(args, "name")
    if not _name_ok(name):
        return {"error": "Geçersiz uygulama adı."}
    if IS_MAC:
        cmd = ["open", "-a", name]
    elif IS_WIN:
        cmd = ["cmd", "/c", "start", "", name]
    else:
        cmd = ["gtk-launch", name]
    try:
        done = run_cmd(cmd)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"error": f"{name} açılamadı: {exc}"}
    return f"{name} açıldı." if done.returncode == 0 else {"error": f"{name} açılamadı: {done.stderr.strip()[:200]}"}


@tool("close_app", "Bir uygulamayı adıyla kapatır (nazikçe; zorla değil).", {"name": {"type": "string", "required": True}})
def close_app(args: dict, ctx: Any) -> Any:
    name = arg_str(args, "name")
    if not _name_ok(name):
        return {"error": "Geçersiz uygulama adı."}
    if IS_MAC:
        cmd = ["osascript", "-e", f'tell application "{name}" to quit']
    elif IS_WIN:
        cmd = ["taskkill", "/IM", name if name.lower().endswith(".exe") else name + ".exe"]
    else:
        cmd = ["pkill", "-x", name]
    try:
        done = run_cmd(cmd)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"error": f"{name} kapatılamadı: {exc}"}
    return f"{name} kapatıldı." if done.returncode == 0 else {"error": f"{name} kapatılamadı: {done.stderr.strip()[:200]}"}


@tool("list_apps", "Kurulu uygulamaların adlarını listeler.")
def list_apps(args: dict, ctx: Any) -> Any:
    from pathlib import Path
    names: set[str] = set()
    if IS_MAC:
        names = {p.stem for d in ("/Applications", str(Path.home() / "Applications")) for p in Path(d).glob("*.app")}
    elif IS_WIN:
        import os
        for base in (os.environ.get("ProgramData", ""), os.environ.get("APPDATA", "")):
            root = Path(base) / "Microsoft/Windows/Start Menu/Programs"
            names |= {p.stem for p in root.rglob("*.lnk")} if root.is_dir() else set()
    else:
        names = {p.stem for d in ("/usr/share/applications",) for p in Path(d).glob("*.desktop")}
    return sorted(names, key=str.lower)[:80] or {"error": "Uygulama listesi alınamadı."}


@tool("open_url", "Bir web adresini varsayılan tarayıcıda açar (http/https).",
      {"url": {"type": "string", "required": True}})
def open_url(args: dict, ctx: Any) -> Any:
    url = arg_str(args, "url")
    if not re.match(r"^https?://", url, re.I):
        return {"error": "Yalnızca http/https adresleri açılır."}
    webbrowser.open(url)
    return f"{url} açıldı."


# ------------------------------------------------------------------ medya ve pano
_WIN_KEYS = {"play_pause": 0xB3, "next": 0xB0, "previous": 0xB1, "volume_up": 0xAF, "volume_down": 0xAE, "mute": 0xAD}
_MEDIA_ACTIONS = ("play_pause", "next", "previous", "volume_up", "volume_down", "mute", "volume_set")


def _media_mac(action: str, level: int | None) -> subprocess.CompletedProcess:
    player = ('if application "Spotify" is running then\ntell application "Spotify" to {c}\n'
              'else\ntell application "Music" to {c}\nend if')
    cmds = {"play_pause": player.format(c="playpause"), "next": player.format(c="next track"),
            "previous": player.format(c="previous track"),
            "volume_up": "set volume output volume ((output volume of (get volume settings)) + 10)",
            "volume_down": "set volume output volume ((output volume of (get volume settings)) - 10)",
            "mute": "set volume output muted (not (output muted of (get volume settings)))",
            "volume_set": f"set volume output volume {int(level or 0)}"}
    return run_cmd(["osascript", "-e", cmds[action]])


@tool("media_control", "Çalan medyayı ve ses düzeyini yönetir.",
      {"action": {"type": "string", "enum": list(_MEDIA_ACTIONS), "required": True},
       "level": {"type": "integer", "description": "volume_set için 0-100"}})
def media_control(args: dict, ctx: Any) -> Any:
    action = arg_str(args, "action")
    if action not in _MEDIA_ACTIONS:
        return {"error": f"Geçersiz eylem: {action}"}
    level = args.get("level")
    if action == "volume_set" and not (isinstance(level, (int, float)) and 0 <= level <= 100):
        return {"error": "level 0 ile 100 arasında olmalı."}
    try:
        if IS_MAC:
            done = _media_mac(action, level)
            if done.returncode:
                return {"error": done.stderr.strip()[:200] or "Medya komutu başarısız."}
        elif IS_WIN:
            import ctypes
            if action == "volume_set":
                for _ in range(50):
                    ctypes.windll.user32.keybd_event(_WIN_KEYS["volume_down"], 0, 0, 0)
                for _ in range(round(level / 2)):
                    ctypes.windll.user32.keybd_event(_WIN_KEYS["volume_up"], 0, 0, 0)
            else:
                ctypes.windll.user32.keybd_event(_WIN_KEYS[action], 0, 0, 0)
        else:
            mp = {"play_pause": ["playerctl", "play-pause"], "next": ["playerctl", "next"], "previous": ["playerctl", "previous"],
                  "volume_up": ["amixer", "set", "Master", "5%+"], "volume_down": ["amixer", "set", "Master", "5%-"],
                  "mute": ["amixer", "set", "Master", "toggle"], "volume_set": ["amixer", "set", "Master", f"{int(level or 0)}%"]}
            run_cmd(mp[action])
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"error": f"Medya kontrolü başarısız: {exc}"}
    return "Tamam."


@tool("play_music", "Bir şarkı ya da sanatçıyı YouTube ya da Spotify'da arayıp açar.",
      {"query": {"type": "string", "required": True}, "provider": {"type": "string", "enum": ["youtube", "spotify"]}})
def play_music(args: dict, ctx: Any) -> Any:
    q, prov = arg_str(args, "query"), arg_str(args, "provider") or "youtube"
    if not q:
        return {"error": "Ne çalınacağını söylemedin."}
    if prov == "spotify" and IS_MAC:
        run_cmd(["open", f"spotify:search:{q}"])
        return f"Spotify'da '{q}' aranıyor."
    webbrowser.open("https://www.youtube.com/results?search_query=" + quote(q))
    return f"YouTube'da '{q}' açıldı."


@tool("clipboard_read", "Panodaki metni okur.")
def clipboard_read(args: dict, ctx: Any) -> Any:
    cmd = (["pbpaste"] if IS_MAC else ["powershell", "-NoProfile", "-Command", "Get-Clipboard -Raw"] if IS_WIN
           else ["xclip", "-selection", "clipboard", "-o"])
    try:
        done = run_cmd(cmd)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"error": f"Pano okunamadı: {exc}"}
    return clip(done.stdout) or {"result": "Pano boş."}


@tool("clipboard_write", "Metni panoya kopyalar.", {"text": {"type": "string", "required": True}})
def clipboard_write(args: dict, ctx: Any) -> Any:
    text = arg_str(args, "text")
    cmd = ["pbcopy"] if IS_MAC else ["clip"] if IS_WIN else ["xclip", "-selection", "clipboard"]
    try:
        subprocess.run(cmd, input=text, text=True, encoding="utf-8", timeout=10, check=True)
    except (OSError, subprocess.SubprocessError) as exc:
        return {"error": f"Panoya yazılamadı: {exc}"}
    return "Panoya kopyalandı."
