@echo off
REM NEXUS Windows derlemesi: venv -> bağımlılıklar -> PyInstaller. Çıktı: dist\NEXUS\NEXUS.exe
setlocal
cd /d "%~dp0\.."
if not exist .venv (
  py -3.12 -m venv .venv || goto :fail
)
call .venv\Scripts\activate.bat || goto :fail
python -m pip install --upgrade pip || goto :fail
pip install -r requirements.txt pyinstaller || goto :fail
python build\make_icon.py || goto :fail
pyinstaller --noconfirm --distpath dist --workpath build\work build\nexus.spec || goto :fail
echo.
echo Hazir: dist\NEXUS\NEXUS.exe
exit /b 0
:fail
echo Derleme basarisiz oldu.
exit /b 1
