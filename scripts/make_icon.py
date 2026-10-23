# 生成 Paper Reader 图标：圆角底 + 书本 + 左右双栏（中英对照意象）→ 多尺寸 ICO
from PIL import Image, ImageDraw
import os

S = 1024
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 圆角背景
d.rounded_rectangle([16, 16, S-16, S-16], radius=180, fill=(74, 111, 165, 255))

# 书本（白底）
bx0, by0, bx1, by1 = 200, 280, 824, 720
d.rounded_rectangle([bx0, by0, bx1, by1], radius=24, fill=(250, 249, 247, 255))
# 中缝
d.line([512, 300, 512, 700], fill=(200, 212, 232, 255), width=10)

# 左栏（英文，蓝）
blue = (74, 111, 165)
rows_l = [(248, 340, 200), (248, 396, 160), (248, 452, 220), (248, 508, 120), (248, 620, 180)]
for x, y, w in rows_l:
    a = int(255 * (0.85 - rows_l.index((x, y, w)) * 0.08))
    d.rounded_rectangle([x, y, x+w, y+26], radius=13, fill=blue + (a,))

# 右栏（中文，金）
gold = (232, 182, 76)
rows_r = [(552, 340, 180), (552, 396, 220), (552, 452, 140), (552, 508, 200), (552, 620, 160)]
for i, (x, y, w) in enumerate(rows_r):
    a = int(255 * (0.95 - i * 0.07))
    d.rounded_rectangle([x, y, x+w, y+26], radius=13, fill=gold + (a,))

os.makedirs('build', exist_ok=True)
img.save('build/icon.png')
# Windows ico（electron-builder 用）
img.save('build/icon.ico', sizes=[(16,16), (24,24), (32,32), (48,48), (64,64), (128,128), (256,256)])
print('icon done: build/icon.ico + icon.png')
