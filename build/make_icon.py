"""NEXUS ikonunu (altıgen + reaktör halkası) üretir: build/nexus.ico ve build/nexus.png. Özgün çizim, harici asset yok."""
import math
from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 512
img = Image.new("RGBA", (SIZE, SIZE), (3, 7, 11, 255))
d = ImageDraw.Draw(img)
c = SIZE / 2


def hexagon(r, rot=0):
    return [(c + r * math.cos(math.radians(60 * i + rot)), c + r * math.sin(math.radians(60 * i + rot))) for i in range(6)]


d.polygon(hexagon(230, 30), outline=(94, 216, 255, 255), width=14)
d.polygon(hexagon(170, 30), outline=(94, 216, 255, 140), width=6)
d.ellipse([c - 70, c - 70, c + 70, c + 70], outline=(255, 155, 60, 255), width=12)
d.ellipse([c - 22, c - 22, c + 22, c + 22], fill=(94, 216, 255, 255))
out = Path(__file__).parent
img.save(out / "nexus.png")
img.save(out / "nexus.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
