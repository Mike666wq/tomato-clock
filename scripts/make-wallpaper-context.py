# 把主界面截图合成到真实壁纸上（开发期工具，不参与打包）。
#
# 为什么合成而不是直接抓桌面：
#   GDI 抓的是屏幕最终合成结果，前面盖着别的窗口就拍不到界面；
#   而为了"桌面干净"去最小化用户的窗口（Win+D / 枚举窗口）是副作用很大的操作。
#   合成 = 界面像素是真的（CDP 抓的窗口自己）+ 壁纸是真的（用户当前的壁纸），
#   缺的是窗口阴影那一层。
#
# 用法：
#   python scripts/make-wallpaper-context.py <界面截图.png> <壁纸图> <输出.png> [x_dip] [y_dip]
#
# 坐标用 DIP（逻辑像素），脚本自己乘缩放比。

import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 屏幕物理分辨率（这台机器 GDI 抓 1707x1067，缩放比 1.5）
SCREEN_W, SCREEN_H = 2560, 1600
SCALE = 1.5


def cover(im, w, h):
    """把图按"填满"裁成 w×h，不拉伸变形"""
    src_ratio = im.width / im.height
    dst_ratio = w / h
    if src_ratio > dst_ratio:
        new_h = h
        new_w = int(h * src_ratio)
    else:
        new_w = w
        new_h = int(w / src_ratio)
    im = im.resize((new_w, new_h), Image.LANCZOS)
    left = (new_w - w) // 2
    top = (new_h - h) // 2
    return im.crop((left, top, left + w, top + h))


def main():
    if len(sys.argv) < 4:
        print('用法：python scripts/make-wallpaper-context.py <界面图> <壁纸图> <输出> [x_dip] [y_dip]')
        sys.exit(1)

    shot_path = sys.argv[1]
    wall_path = sys.argv[2]
    out_path = sys.argv[3]
    x_dip = int(sys.argv[4]) if len(sys.argv) > 4 else 133
    y_dip = int(sys.argv[5]) if len(sys.argv) > 5 else 80

    shot = Image.open(shot_path).convert('RGB')
    wall = cover(Image.open(wall_path).convert('RGB'), SCREEN_W, SCREEN_H)

    # 界面截图是 CDP 拍的 1.5 倍图，放回物理像素尺寸
    shot = shot.resize((int(shot.width / SCALE), int(shot.height / SCALE)), Image.LANCZOS)
    wall.paste(shot, (int(x_dip * SCALE), int(y_dip * SCALE)))

    out = os.path.join(ROOT, out_path) if not os.path.isabs(out_path) else out_path
    os.makedirs(os.path.dirname(out), exist_ok=True)
    wall.save(out)
    print(f'[wallpaper-context] saved {out} ({wall.width}x{wall.height})')


if __name__ == '__main__':
    main()
