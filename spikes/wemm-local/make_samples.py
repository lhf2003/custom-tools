# 生成视觉测试样本（独立于 spike_wemm.py，不依赖 torch）
import os
import subprocess

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLES = os.path.join(HERE, "samples")
FFMPEG = r"D:\Java\ffmpeg-7.0.2-essentials_build\bin\ffmpeg.exe"

os.makedirs(SAMPLES, exist_ok=True)
specs = [
    ("err500.png", (200, 40, 40), "500 Internal Server Error"),
    ("success.png", (40, 130, 200), "Submit Success"),
    ("launcher.png", (60, 60, 60), "nervis Launcher Alt+Space"),
    ("sql.png", (240, 200, 90), "DELETE FROM t WHERE id=1"),
]
for name, color, text in specs:
    p = os.path.join(SAMPLES, name)
    if not os.path.exists(p):
        img = Image.new("RGB", (640, 360), color)
        ImageDraw.Draw(img).text((40, 160), text, fill=(255, 255, 255))
        img.save(p)
        print("made", name)
for name, src in [("err.mp4", "err500.png"), ("sql.mp4", "sql.png")]:
    p = os.path.join(SAMPLES, name)
    if not os.path.exists(p):
        subprocess.run(
            [FFMPEG, "-y", "-loop", "1", "-i", os.path.join(SAMPLES, src),
             "-t", "10", "-pix_fmt", "yuv420p", p],
            check=True, capture_output=True,
        )
        print("made", name)
print("samples ready")
