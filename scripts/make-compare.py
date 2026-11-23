# 把三个风格的稿子拼成一张对比图（开发期工具，不参与打包）。
#
# 用法：
#   python scripts/make-compare.py
#
# 为什么用 Pillow 拼而不是用一个 HTML 装三个 iframe：
# 三个稿子并排是 1440px 宽，窗口开到 1560 在小屏上会被屏幕裁掉，
# capturePage 只拿到可见区域。拼图更稳，也不会把文字缩放糊掉。

from PIL import Image, ImageDraw, ImageFont

import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'docs', 'shots')
OUT = os.path.join(SHOTS, 'v05-三风格对比.png')

FONT_REG = r'C:\Windows\Fonts\msyh.ttc'
FONT_BOLD = r'C:\Windows\Fonts\msyhbd.ttc'

# 三个风格：(图名, 标题, 一句话)
PANELS = [
    ('v05-纸感-主界面.png', '一 · 纸感 Paper', '这是一张纸'),
    ('v05-霓虹-主界面.png', '二 · 玻璃霓虹 Neon Glass', '这是一块发光装置'),
    ('v05-系统感-主界面-深色.png', '三 · 系统感 iOS Native', '这是苹果自带的 app'),
]

# 画板在截图里的位置：窗口 560 宽、画板 480 居中 → 左右各留 40 CSS，
# 截图按 1.5 倍出图，所以左右各 60px、上下各 61px（窗口内容 702 高）。
CROP = (60, 61, 60 + 720, 61 + 930)

BG = (16, 17, 20)
FG = (240, 242, 245)
DIM = (150, 155, 165)
ACC = (255, 90, 60)


def font(path, size):
    return ImageFont.truetype(path, size)


def main():
    panels = []
    for name, title, line in PANELS:
        im = Image.open(os.path.join(SHOTS, name)).convert('RGB')
        panels.append((im.crop(CROP), title, line))

    w, h = panels[0][0].size  # 720 x 930
    gap = 36
    pad = 44
    cap_h = 150
    head_h = 120
    W = pad * 2 + len(panels) * w + (len(panels) - 1) * gap
    H = head_h + h + cap_h + pad

    canvas = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(canvas)

    d.text((pad, 34), '番茄钟 · 三个完全不同的视觉语言', font=font(FONT_BOLD, 40), fill=FG)
    d.text(
        (pad, 86),
        '同一套信息结构（时间 / 阶段 / 任务 / 模板 / 主题 / 按钮），三套不同的字体、圆角、按钮形态、明暗关系',
        font=font(FONT_REG, 24),
        fill=DIM,
    )

    for i, (im, title, line) in enumerate(panels):
        x = pad + i * (w + gap)
        y = head_h
        d.rectangle([x - 2, y - 2, x + w + 1, y + h + 1], outline=(58, 62, 70))
        canvas.paste(im, (x, y))
        d.text((x, y + h + 26), title, font=font(FONT_BOLD, 32), fill=FG)
        d.text((x, y + h + 76), line, font=font(FONT_REG, 28), fill=ACC)

    canvas.save(OUT)
    print(f'[make-compare] saved {OUT} ({W}x{H})')


if __name__ == '__main__':
    main()
