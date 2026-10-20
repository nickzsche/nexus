"""Uygulama: tek örnek kilidi, çekirdek ve pywebview penceresi."""
from __future__ import annotations

import argparse
import os
import sys

from . import APP_NAME, VERSION, paths
from .log import log


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="nexus", description=f"{APP_NAME} {VERSION}")
    p.add_argument("--demo", action="store_true", help="API anahtarı olmadan sahte beyinle çalış")
    p.add_argument("--debug", action="store_true", help="DevTools ve geliştirici kısayolları")
    p.add_argument("--data", metavar="KLASÖR", help="Veri klasörü (NEXUS_DATA)")
    return p.parse_args(argv)


class SingleInstance:
    """Windows'ta adlandırılmış mutex, diğerlerinde dosya kilidi."""

    def __init__(self) -> None:
        self._handle = None
        self.ok = self._acquire()

    def _acquire(self) -> bool:
        if paths.IS_WIN:
            import ctypes
            self._handle = ctypes.windll.kernel32.CreateMutexW(None, False, "Global\\NEXUS_SINGLE_INSTANCE")
            return ctypes.windll.kernel32.GetLastError() != 183          # ERROR_ALREADY_EXISTS
        import fcntl
        self._handle = open(paths.DATA_DIR / ".lock", "w")
        try:
            fcntl.flock(self._handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            return False

    @staticmethod
    def focus_existing() -> None:
        if paths.IS_WIN:
            import ctypes
            hwnd = ctypes.windll.user32.FindWindowW(None, APP_NAME)
            if hwnd:
                ctypes.windll.user32.ShowWindow(hwnd, 9)                  # SW_RESTORE
                ctypes.windll.user32.SetForegroundWindow(hwnd)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    lock = SingleInstance()
    if not lock.ok:
        SingleInstance.focus_existing()
        print("NEXUS zaten çalışıyor.", file=sys.stderr)
        return 0

    from .core import Core
    from .hud import bridge
    import webview

    core = Core(demo=args.demo)
    core.debug = args.debug
    log(f"{APP_NAME} {VERSION} başlıyor", "demo" if core.demo else "canlı", "debug" if args.debug else "")
    window = bridge.build_window(core, debug=args.debug)
    window.events.closed += core.shutdown
    webview.start(core.start, debug=args.debug)
    return 0


if __name__ == "__main__":
    sys.exit(main())
