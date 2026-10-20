"""FORGE araçları: çalışma klasöründe dosya okuma/yazma, kod arama, git ve komut çalıştırma.

Hiçbir yol çalışma klasörünün dışına çıkamaz (.. ve symlink kaçışı engelli). Yıkıcı komutlar her koşulda reddedilir.
"""
from __future__ import annotations

import fnmatch
import os
import re
import shlex
import subprocess
from pathlib import Path
from typing import Any

from .. import settings
from .registry import arg_str, tool
from .system import IS_WIN, clip, run_cmd

MAX_READ = 100_000
MAX_WRITE = 1_000_000
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".idea", ".mypy_cache"}

# Her koşulda reddedilen kalıplar (onay verilse bile çalışmaz).
DESTRUCTIVE = [re.compile(p, re.I) for p in (
    r"\brm\s+(-\w*\s+)*-\w*[rf]\w*[rf]?\w*\b", r"\brm\s+.*--(recursive|force|no-preserve-root)",
    r"\bmkfs", r"\bdd\s+.*\bof=/dev/", r":\(\)\s*\{", r"\bformat\s+[a-z]:", r"\bdel\s+.*(/s|/q)\b",
    r"\b(rd|rmdir)\s+.*/s\b", r"\bshutdown\b", r"\b(reboot|halt|poweroff)\b", r"\bdiskpart\b",
    r"\breg\s+delete\b", r">\s*/dev/(sd|nvme|disk)", r"\bchmod\s+-R\s+[0-7]*7[0-7]*\s+/", r"\bcipher\s+/w",
    r"\bRemove-Item\b.*-Recurse", r"\bgit\s+push\s+.*--force", r"\bgit\s+clean\s+-\w*f",
)]
# Kabuk yönlendirme/zincir karakterleri içermeyen ve bu listede olan komutlar onaysız çalışabilir
# (yalnızca shell_confirm kapalıyken).
SAFE: dict[str, tuple[str, ...] | None] = {
    "git": ("status", "diff", "log", "show", "branch", "remote", "rev-parse", "ls-files", "blame"),
    "python": None, "python3": None, "pytest": None, "node": None,
    "npm": ("test", "run", "ls", "list", "view", "outdated"), "pip": ("list", "show", "freeze"),
    "ls": None, "dir": None, "cat": None, "type": None, "echo": None, "pwd": None, "whoami": None,
}
_SHELL_META = re.compile(r"[;&|<>`$\n]|\$\(")


def workspace() -> Path:
    raw = settings.get("workspace")
    return Path(raw).expanduser().resolve() if raw else Path.home().resolve()


def safe_path(rel: str, must_exist: bool = False) -> Path:
    """Çalışma klasörü içinde kalan yolu çözer; dışarı çıkıyorsa ValueError."""
    root = workspace()
    p = Path(rel or ".").expanduser()
    p = (p if p.is_absolute() else root / p).resolve()   # symlink'ler burada gerçek hedefe çözülür
    if p != root and root not in p.parents:
        raise ValueError("Yol çalışma klasörünün dışında; erişim reddedildi.")
    if must_exist and not p.exists():
        raise ValueError("Yol bulunamadı.")
    return p


def _guard(fn, *a):
    """ValueError'ı anlaşılır araç hatasına çevirir."""
    try:
        return fn(*a)
    except ValueError as exc:
        return {"error": str(exc)}


@tool("read_file", "Çalışma klasöründeki bir metin dosyasını okur.",
      {"path": {"type": "string", "required": True}})
def read_file(args: dict, ctx: Any) -> Any:
    def go(path: str):
        p = safe_path(path, True)
        if not p.is_file():
            raise ValueError("Bu bir dosya değil.")
        data = p.read_bytes()[:MAX_READ + 1]
        return clip(data.decode("utf-8", "replace"), MAX_READ)
    return _guard(go, arg_str(args, "path"))


@tool("list_dir", "Çalışma klasöründeki bir dizinin içeriğini listeler.", {"path": {"type": "string"}})
def list_dir(args: dict, ctx: Any) -> Any:
    def go(path: str):
        p = safe_path(path or ".", True)
        if not p.is_dir():
            raise ValueError("Bu bir dizin değil.")
        rows = sorted(p.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower()))[:200]
        return [x.name + ("/" if x.is_dir() else "") for x in rows]
    return _guard(go, arg_str(args, "path"))


@tool("search_code", "Çalışma klasöründeki dosyalarda metin arar (büyük/küçük harf duyarsız).",
      {"query": {"type": "string", "required": True}, "path": {"type": "string"},
       "glob": {"type": "string", "description": "Örn. *.py"}})
def search_code(args: dict, ctx: Any) -> Any:
    def go(query: str, path: str, pattern: str):
        base = safe_path(path or ".", True)
        needle, hits = query.lower(), []
        for dirpath, dirs, files in os.walk(base):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for name in files:
                if pattern and not fnmatch.fnmatch(name, pattern):
                    continue
                f = Path(dirpath) / name
                try:
                    if f.is_symlink() or f.stat().st_size > 1_000_000:
                        continue
                    for n, line in enumerate(f.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
                        if needle in line.lower():
                            hits.append(f"{f.relative_to(workspace())}:{n}: {line.strip()[:160]}")
                            if len(hits) >= 50:
                                return hits
                except OSError:
                    continue
        return hits or {"result": "Eşleşme yok."}
    q = arg_str(args, "query")
    if not q:
        return {"error": "Arama metni boş."}
    return _guard(go, q, arg_str(args, "path"), arg_str(args, "glob"))


@tool("write_file", "Çalışma klasörüne dosya yazar. Her seferinde kullanıcıdan onay istenir.",
      {"path": {"type": "string", "required": True}, "content": {"type": "string", "required": True}})
def write_file(args: dict, ctx: Any) -> Any:
    content = args.get("content")
    if not isinstance(content, str) or len(content.encode("utf-8")) > MAX_WRITE:
        return {"error": "İçerik yok ya da 1 MB sınırını aşıyor."}
    try:
        p = safe_path(arg_str(args, "path"))
    except ValueError as exc:
        return {"error": str(exc)}
    if p.is_dir():
        return {"error": "Hedef bir dizin."}
    verb = "üzerine yazılacak" if p.exists() else "oluşturulacak"
    if not ctx.confirm("Dosya yazılsın mı?", f"{p} ({verb}, {len(content)} karakter)", 30.0):
        return {"error": "Kullanıcı onaylamadı, dosya yazılmadı."}
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return f"{p.name} yazıldı."


def _git(args: list[str]) -> Any:
    try:
        done = subprocess.run(["git", *args], cwd=str(workspace()), capture_output=True, text=True, timeout=20,
                              encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return {"error": "git kurulu değil."}
    except subprocess.TimeoutExpired:
        return {"error": "git zaman aşımına uğradı."}
    if done.returncode:
        return {"error": (done.stderr or done.stdout).strip()[:300] or "git başarısız."}
    return clip(done.stdout.strip()) or {"result": "Çıktı yok (temiz)."}


@tool("git_status", "Çalışma klasöründeki git deposunun durumunu verir.")
def git_status(args: dict, ctx: Any) -> Any:
    return _git(["status", "--short", "--branch"])


@tool("git_diff", "Git farkını gösterir (isteğe bağlı: yalnızca bir dosya).", {"path": {"type": "string"}})
def git_diff(args: dict, ctx: Any) -> Any:
    extra: list[str] = []
    if arg_str(args, "path"):
        try:
            extra = ["--", str(safe_path(arg_str(args, "path")))]
        except ValueError as exc:
            return {"error": str(exc)}
    return _git(["diff", "--stat", "--patch", *extra])


@tool("git_log", "Son git işlemelerini (commit) listeler.", {"count": {"type": "integer"}})
def git_log(args: dict, ctx: Any) -> Any:
    n = max(1, min(int(args.get("count") or 10), 50))
    return _git(["log", f"-{n}", "--pretty=format:%h %ad %an: %s", "--date=short"])


def is_destructive(command: str) -> bool:
    return any(p.search(command) for p in DESTRUCTIVE)


def is_safe(command: str) -> bool:
    """Kabuk özel karakteri içermeyen ve izinli listede olan komut."""
    if _SHELL_META.search(command):
        return False
    try:
        parts = shlex.split(command, posix=not IS_WIN)
    except ValueError:
        return False
    if not parts or parts[0].lower() not in SAFE:
        return False
    allowed = SAFE[parts[0].lower()]
    return allowed is None or (len(parts) > 1 and parts[1] in allowed)


@tool("run_command", "Çalışma klasöründe bir komut çalıştırır. Yıkıcı komutlar her zaman reddedilir; "
      "çoğu komut kullanıcıdan onay ister.",
      {"command": {"type": "string", "required": True}})
def run_command(args: dict, ctx: Any) -> Any:
    command = arg_str(args, "command")
    if not command or len(command) > 2000:
        return {"error": "Komut boş ya da çok uzun."}
    if is_destructive(command):
        return {"error": "Bu komut yıkıcı olarak sınıflandı ve çalıştırılmaz."}
    safe = is_safe(command)
    if settings.get("shell_confirm") or not safe:
        why = "" if safe else " (izinli listede değil)"
        if not ctx.confirm("Komut çalıştırılsın mı?", command + why, 30.0):
            return {"error": "Kullanıcı onaylamadı, komut çalıştırılmadı."}
    cwd = workspace()
    try:
        if safe:
            done = subprocess.run(shlex.split(command, posix=not IS_WIN), cwd=str(cwd), capture_output=True, text=True,
                                  timeout=60, encoding="utf-8", errors="replace", shell=IS_WIN)
        else:
            done = subprocess.run(command, cwd=str(cwd), shell=True, capture_output=True, text=True, timeout=60,
                                  encoding="utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        return {"error": "Komut 60 saniyede bitmedi, durduruldu."}
    except OSError as exc:
        return {"error": f"Komut başlatılamadı: {exc}"}
    out = clip((done.stdout + done.stderr).strip())
    return {"cikis_kodu": done.returncode, "cikti": out}
