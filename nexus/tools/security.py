"""SENTINEL araçları: güvenlik durumu, port taraması, süreç ve bağlantı denetimi, dosya özeti.

Yalnızca kullanıcının kendi makinesinde ve yerel ağında, savunma amaçlı çalışır.
"""
from __future__ import annotations

import hashlib
import json
import socket
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import psutil

from .registry import arg_str, tool
from .system import IS_WIN, is_private_host, run_cmd

MAX_PORTS = 1024
COMMON_PORTS = (21, 22, 23, 25, 53, 80, 110, 135, 139, 143, 443, 445, 993, 995, 1433, 3306, 3389, 5432, 5900, 8080, 8443)


def _powershell_json(script: str) -> Any:
    done = run_cmd(["powershell", "-NoProfile", "-Command", script + " | ConvertTo-Json -Compress"], timeout=30)
    if done.returncode or not done.stdout.strip():
        return {"error": done.stderr.strip()[:200] or "PowerShell yanıt vermedi."}
    return json.loads(done.stdout)


@tool("defender_status", "Windows Defender (antivirüs) durumunu verir.", platforms=("win32",))
def defender_status(args: dict, ctx: Any) -> Any:
    return _powershell_json("Get-MpComputerStatus | Select-Object AntivirusEnabled,RealTimeProtectionEnabled,"
                            "AntivirusSignatureLastUpdated,QuickScanAge")


@tool("firewall_status", "Windows güvenlik duvarı profillerinin durumunu verir.", platforms=("win32",))
def firewall_status(args: dict, ctx: Any) -> Any:
    return _powershell_json("Get-NetFirewallProfile | Select-Object Name,Enabled")


def parse_ports(spec: str) -> list[int]:
    """'22,80,100-120' → sıralı port listesi. En fazla 1024 port, 1-65535 aralığı."""
    ports: set[int] = set()
    for part in spec.replace(" ", "").split(","):
        if not part:
            continue
        lo, _, hi = part.partition("-")
        a, b = int(lo), int(hi or lo)
        if a > b or a < 1 or b > 65535:
            raise ValueError(f"Geçersiz port aralığı: {part}")
        ports.update(range(a, b + 1))
        if len(ports) > MAX_PORTS:
            raise ValueError(f"En fazla {MAX_PORTS} port taranabilir.")
    if not ports:
        raise ValueError("Taranacak port yok.")
    return sorted(ports)


def _open(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=0.4):
            return True
    except OSError:
        return False


@tool("port_scan", "Yerel makinede ya da özel ağdaki bir adreste açık portları tarar (genel IP'ler reddedilir).",
      {"host": {"type": "string", "description": "127.0.0.1, 192.168.x.x vb. Boşsa yerel makine"},
       "ports": {"type": "string", "description": "Örn. '22,80,443' ya da '1-1024'. Boşsa yaygın portlar"}})
def port_scan(args: dict, ctx: Any) -> Any:
    host = arg_str(args, "host") or "127.0.0.1"
    if not is_private_host(host):
        return {"error": "Yalnızca yerel makine ve özel ağ adresleri taranabilir; genel IP'ler taranmaz."}
    try:
        ports = parse_ports(arg_str(args, "ports")) if arg_str(args, "ports") else list(COMMON_PORTS)
    except ValueError as exc:
        return {"error": str(exc)}
    with ThreadPoolExecutor(max_workers=64) as pool:
        states = list(pool.map(lambda p: _open(host, p), ports))
    open_ports = [p for p, ok in zip(ports, states) if ok]
    return {"host": host, "taranan": len(ports), "acik": open_ports}


@tool("list_processes", "En çok kaynak kullanan süreçleri listeler.",
      {"limit": {"type": "integer", "description": "Kaç süreç (varsayılan 10)"},
       "sort": {"type": "string", "enum": ["cpu", "memory"]}})
def list_processes(args: dict, ctx: Any) -> Any:
    limit = max(1, min(int(args.get("limit") or 10), 30))
    key = "memory_percent" if arg_str(args, "sort") == "memory" else "cpu_percent"
    procs = list(psutil.process_iter(["pid", "name", "cpu_percent", "memory_percent"]))
    procs.sort(key=lambda p: p.info.get(key) or 0, reverse=True)
    return [{"pid": p.info["pid"], "ad": p.info["name"], "cpu": round(p.info["cpu_percent"] or 0, 1),
             "bellek": round(p.info["memory_percent"] or 0, 1)} for p in procs[:limit]]


@tool("network_connections", "Dinleyen portları ve kurulu ağ bağlantılarını listeler.")
def network_connections(args: dict, ctx: Any) -> Any:
    try:
        conns = psutil.net_connections(kind="inet")
    except (psutil.AccessDenied, PermissionError):
        return {"error": "Bağlantı listesi için yetki yok (yönetici/root gerekir)."}
    out = []
    for c in conns:
        if c.status not in ("LISTEN", "ESTABLISHED"):
            continue
        out.append({"durum": c.status, "yerel": f"{c.laddr.ip}:{c.laddr.port}" if c.laddr else "",
                    "uzak": f"{c.raddr.ip}:{c.raddr.port}" if c.raddr else "", "pid": c.pid})
    return out[:40] or {"result": "Aktif bağlantı yok."}


@tool("file_hash", "Bir dosyanın özet değerini (sha256/sha1/md5) hesaplar.",
      {"path": {"type": "string", "required": True}, "algo": {"type": "string", "enum": ["sha256", "sha1", "md5"]}})
def file_hash(args: dict, ctx: Any) -> Any:
    algo = arg_str(args, "algo") or "sha256"
    if algo not in ("sha256", "sha1", "md5"):
        return {"error": "Desteklenen algoritmalar: sha256, sha1, md5."}
    path = Path(arg_str(args, "path")).expanduser()
    if not path.is_file():
        return {"error": "Dosya bulunamadı."}
    h = hashlib.new(algo)
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return {"dosya": path.name, algo: h.hexdigest()}
