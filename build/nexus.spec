# -*- mode: python ; coding: utf-8 -*-
# PyInstaller onedir. Windows'ta: pyinstaller build/nexus.spec  →  dist/NEXUS/NEXUS.exe
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

ROOT = Path(SPECPATH).parent
IS_WIN = sys.platform == "win32"

hidden = collect_submodules("nexus")
if IS_WIN:
    hidden += ["webview.platforms.edgechromium", "clr", "keyring.backends.Windows"]
elif sys.platform == "darwin":
    hidden += ["webview.platforms.cocoa"]
else:
    hidden += ["webview.platforms.gtk"]

datas = [
    (str(ROOT / "nexus" / "hud" / "web"), "nexus/hud/web"),
    (str(ROOT / "nexus" / "prompts"), "nexus/prompts"),
    (str(ROOT / "licenses"), "licenses"),
]

a = Analysis(
    [str(ROOT / "run.py")],
    pathex=[str(ROOT)],
    datas=datas,
    hiddenimports=hidden,
    excludes=["tkinter", "pytest", "playwright"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="NEXUS",
    console=False,
    icon=str(ROOT / "build" / "nexus.ico") if IS_WIN else None,
)
coll = COLLECT(exe, a.binaries, a.datas, name="NEXUS")
