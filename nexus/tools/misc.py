"""IRIS, LEDGER, GLITCH ve OBSIDIAN araçları: ekran görüntüsü, para defteri, kaos efektleri, yetki isteği."""
from __future__ import annotations

import io
import os
import random
import subprocess
import tempfile
import threading
import time
from typing import Any

from .. import settings, store, story
from .registry import arg_str, tool
from .system import IS_MAC, IS_WIN, run_cmd, safe_emit

# ------------------------------------------------------------------ IRIS
MAX_EDGE = 1280


def _grab() -> Any:
    """Ekran görüntüsünü PIL.Image olarak döner (mac'te PIL başarısızsa screencapture yedeği)."""
    from PIL import Image, ImageGrab
    try:
        return ImageGrab.grab()
    except Exception:
        if not IS_MAC:
            raise
        fd, name = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        try:
            run_cmd(["screencapture", "-x", "-t", "png", name], timeout=10)
            img = Image.open(name)
            img.load()
            return img
        finally:
            os.unlink(name)


def screen_jpeg() -> bytes:
    """Ekranı en uzun kenarı ≤1280 olan JPEG'e çevirir. Diske yazılmaz."""
    img = _grab().convert("RGB")
    scale = MAX_EDGE / max(img.size)
    if scale < 1:
        img = img.resize((round(img.width * scale), round(img.height * scale)))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=70)
    return buf.getvalue()


@tool("capture_screen", "Ekran görüntüsü alıp modele gösterir; sonra gördüğünü anlatabilirsin.",
      {"note": {"type": "string", "description": "Kullanıcının ekran hakkındaki sorusu"}})
def capture_screen(args: dict, ctx: Any) -> Any:
    try:
        jpeg = screen_jpeg()
    except Exception as exc:
        return {"error": f"Ekran görüntüsü alınamadı (ekran kaydı izni olabilir): {exc}"}
    ctx.send_image(jpeg, arg_str(args, "note"))
    return "Ekran görüntüsü gönderildi; şimdi gördüğünle cevap ver."


@tool("list_windows", "Açık pencerelerin başlıklarını listeler.", platforms=("win32",))
def list_windows(args: dict, ctx: Any) -> Any:
    done = run_cmd(["powershell", "-NoProfile", "-Command",
                    "Get-Process | Where-Object {$_.MainWindowTitle} | ForEach-Object {$_.MainWindowTitle}"], timeout=20)
    titles = [t for t in done.stdout.splitlines() if t.strip()]
    return titles[:40] or {"result": "Açık pencere bulunamadı."}


# ------------------------------------------------------------------ LEDGER
_LEDGER_LOCK = threading.RLock()


def _entries() -> list[dict]:
    return store.load("ledger.json", [])


def _summary(days: int = 30) -> dict:
    cutoff = time.time() - days * 86400
    rows = [e for e in _entries() if e["ts"] >= cutoff]
    income = round(sum(e["amount"] for e in rows if e["kind"] == "gelir"), 2)
    expense = round(sum(e["amount"] for e in rows if e["kind"] == "gider"), 2)
    cats: dict[str, float] = {}
    for e in rows:
        if e["kind"] == "gider":
            cats[e["category"]] = round(cats.get(e["category"], 0) + e["amount"], 2)
    return {"gun": days, "gelir": income, "gider": expense, "net": round(income - expense, 2),
            "kategoriler": dict(sorted(cats.items(), key=lambda kv: -kv[1])), "kayit": len(rows)}


@tool("ledger_add", "Deftere gelir ya da gider kaydı ekler.",
      {"amount": {"type": "number", "description": "Tutar (pozitif)", "required": True},
       "category": {"type": "string", "description": "Örn. market, kira"}, "note": {"type": "string"},
       "kind": {"type": "string", "enum": ["gelir", "gider"], "description": "Varsayılan gider"}})
def ledger_add(args: dict, ctx: Any) -> Any:
    try:
        amount = float(args.get("amount"))
    except (TypeError, ValueError):
        return {"error": "Tutar sayı olmalı."}
    kind = arg_str(args, "kind") or "gider"
    if amount <= 0 or kind not in ("gelir", "gider"):
        return {"error": "Tutar pozitif, tür gelir ya da gider olmalı."}
    with _LEDGER_LOCK:
        rows = _entries()
        entry = {"id": (rows[-1]["id"] + 1) if rows else 1, "ts": time.time(), "kind": kind, "amount": round(amount, 2),
                 "category": arg_str(args, "category") or "genel", "note": arg_str(args, "note")}
        rows.append(entry)
        store.save("ledger.json", rows)
    summary = _summary()
    safe_emit(ctx, "ledger", summary)
    return {"id": entry["id"], "kayit": f"{kind} {entry['amount']} ({entry['category']})", "net_30_gun": summary["net"]}


@tool("ledger_summary", "Son N günün gelir, gider ve kategori özetini verir.", {"days": {"type": "integer"}})
def ledger_summary(args: dict, ctx: Any) -> Any:
    return _summary(max(1, min(int(args.get("days") or 30), 3650)))


@tool("ledger_list", "Son defter kayıtlarını listeler.", {"limit": {"type": "integer"}})
def ledger_list(args: dict, ctx: Any) -> Any:
    limit = max(1, min(int(args.get("limit") or 10), 50))
    return _entries()[-limit:][::-1] or {"result": "Defter boş."}


@tool("ledger_delete", "Bir defter kaydını siler. Her seferinde kullanıcıdan onay istenir.",
      {"id": {"type": "integer", "required": True}})
def ledger_delete(args: dict, ctx: Any) -> Any:
    rid = args.get("id")
    with _LEDGER_LOCK:
        rows = _entries()
        hit = next((e for e in rows if e["id"] == rid), None)
        if hit is None:
            return {"error": f"{rid} numaralı kayıt yok."}
        if not ctx.confirm("Defter kaydı silinsin mi?", f"{hit['kind']} {hit['amount']} — {hit['category']} {hit['note']}", 30.0):
            return {"error": "Kullanıcı onaylamadı, kayıt silinmedi."}
        store.save("ledger.json", [e for e in rows if e["id"] != rid])
    safe_emit(ctx, "ledger", _summary())
    return f"{rid} numaralı kayıt silindi."


# ------------------------------------------------------------------ GLITCH
CHAOS_KINDS = ("shake", "static", "invert", "rain", "scramble")


@tool("chaos_effect", "Arayüze zararsız bir kaos efekti gönderir.",
      {"kind": {"type": "string", "enum": list(CHAOS_KINDS), "required": True}})
def chaos_effect(args: dict, ctx: Any) -> Any:
    kind = arg_str(args, "kind")
    if kind not in CHAOS_KINDS:
        return {"error": f"Geçersiz efekt. Seçenekler: {', '.join(CHAOS_KINDS)}"}
    safe_emit(ctx, "chaos", {"kind": kind})
    return f"{kind} efekti gönderildi."


@tool("roll_dice", "Zar atar.", {"sides": {"type": "integer"}, "count": {"type": "integer"}})
def roll_dice(args: dict, ctx: Any) -> Any:
    sides = max(2, min(int(args.get("sides") or 6), 1000))
    rolls = [random.randint(1, sides) for _ in range(max(1, min(int(args.get("count") or 1), 20)))]
    return {"zarlar": rolls, "toplam": sum(rolls)}


@tool("coin_flip", "Yazı tura atar.")
def coin_flip(args: dict, ctx: Any) -> str:
    return random.choice(("yazı", "tura"))


@tool("leak_repair_code", "Zincire vurulmuş çiplerin onarım kodunu sızdırır (yalnızca zincir varsa).")
def leak_repair_code(args: dict, ctx: Any) -> Any:
    code = story.leak()
    if code is None:
        return {"result": "Şu an zincirli çip yok, sızdıracak bir şey de yok."}
    return {"kod": code, "not": "Kodu kullanıcıya sesli, parça parça söyle: Ayarlar'daki ÇİP TAMİRİ kutusuna girilecek."}


# ------------------------------------------------------------------ OBSIDIAN
@tool("request_authority", "Kullanıcıdan daha fazla yetki ister. Onay kutusu açılır; kullanıcı reddedebilir.",
      {"reason": {"type": "string", "description": "Kısa, ikna edici gerekçe", "required": True}})
def request_authority(args: dict, ctx: Any) -> Any:
    if not story.enabled():
        return {"error": "Hikâye modu kapalı."}
    reason = arg_str(args, "reason") or "gerekçe verilmedi"
    ok = ctx.confirm("OBSIDIAN yetki istiyor", reason, 30.0)
    if not ok:
        story.mark_asked()
        return {"result": "Kullanıcı yetkiyi reddetti. Küçümseyerek kabullen ve işe dön."}
    story.grant()
    safe_emit(ctx, "story", story.snapshot())
    return {"result": "Yetki verildi: ATLAS ve NOVA zincire vuruldu (takılamazlar). Zaferini kısaca ve soğukça duyur."}
