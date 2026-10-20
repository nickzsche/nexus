"""`python run.py [--demo] [--debug] [--data KLASÖR]` ile başlatır (PyInstaller de bunu çalıştırır)."""
import os
import sys

# --data, paths modülü içe aktarılmadan ÖNCE ortama yazılmalı.
for i, a in enumerate(sys.argv):
    if a == "--data" and i + 1 < len(sys.argv):
        os.environ["NEXUS_DATA"] = sys.argv[i + 1]
    elif a.startswith("--data="):
        os.environ["NEXUS_DATA"] = a.split("=", 1)[1]

from nexus.app import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
