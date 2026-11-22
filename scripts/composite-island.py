# 把灵动岛的透明截图合成到深色 / 浅色壁纸上，用来验收伪毛玻璃在两种背景下的表现。
# 用法：python scripts/composite-island.py

from PIL import Image
import os

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
shots = os.path.join(root, 'docs', 'shots')
src = os.path.join(shots, 'r7-灵动岛-伪毛玻璃-win.png')
isl = Image.open(src).convert('RGBA')


def over(bg, name):
    canvas = Image.new('RGBA', (700, 240), bg + (255,))
    px = canvas.load()
    for y in range(canvas.height):
        for x in range(canvas.width):
            k = (x / canvas.width) * 18
            px[x, y] = (
                min(255, int(bg[0] + k)),
                min(255, int(bg[1] + k)),
                min(255, int(bg[2] + k)),
                255,
            )
    canvas.alpha_composite(isl, ((700 - isl.width) // 2, 0))
    out = os.path.join(shots, name)
    canvas.convert('RGB').save(out)
    print('saved', out)


over((16, 18, 22), 'r7-胶囊-深色壁纸.png')
over((228, 228, 232), 'r7-胶囊-浅色壁纸.png')
