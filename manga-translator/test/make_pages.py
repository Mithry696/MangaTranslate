# Генерация синтетических тестовых страниц с известными координатами текста
import json, sys
from PIL import Image, ImageDraw, ImageFont
out = sys.argv[1]
JP = '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc'
def font(size, idx=0): return ImageFont.truetype(JP, size, index=idx)

def vtext(d, cx, cy, text, size):
    per = 6
    cols = [text[i:i+per] for i in range(0, len(text), per)]
    cw = int(size * 1.25); tw = len(cols) * cw; th = per * int(size * 1.05) if len(cols) > 1 else len(text) * int(size * 1.05)
    x0 = cx + tw // 2 - cw
    y0 = cy - th // 2
    f = font(size)
    for ci, col in enumerate(cols):
        for k, ch in enumerate(col):
            d.text((x0 - ci * cw + (cw - size) // 2, y0 + k * int(size * 1.05)), ch, font=f, fill=(15, 15, 15))
    return [cx - tw // 2, y0, tw, th]

def htext(d, cx, cy, lines, size, fill=(15,15,15), idx=1):
    f = font(size, idx); lh = int(size * 1.3)
    ws = [d.textlength(l, font=f) for l in lines]
    th = lh * len(lines); w = max(ws)
    for i, l in enumerate(lines):
        d.text((cx - ws[i] / 2, cy - th / 2 + i * lh), l, font=f, fill=fill)
    return [int(cx - w / 2), int(cy - th / 2), int(w), int(th)]

def bubble(d, cx, cy, rx, ry, tail=None):
    d.ellipse([cx-rx, cy-ry, cx+rx, cy+ry], fill='white', outline=(10,10,10), width=4)
    if tail:
        d.polygon([(cx-16, cy+ry-6), tail, (cx+16, cy+ry-6)], fill='white', outline=(10,10,10))
        d.ellipse([cx-rx+4, cy-ry+4, cx+rx-4, cy+ry-4], fill='white')

# ---- страница манги 1000x1450
W, H = 1000, 1450
im = Image.new('RGB', (W, H), 'white'); d = ImageDraw.Draw(im)
truth = []
# панели со штриховкой
d.rectangle([30, 30, 970, 640], outline='black', width=5)
for x in range(30, 970, 14): d.line([(x, 420), (x + 60, 640)], fill=(120,120,120), width=2)
d.rectangle([30, 670, 480, 1420], outline='black', width=5)
for y in range(670, 1420, 4):
    g = int(90 + 120 * (y - 670) / 750); d.line([(33, y), (477, y)], fill=(g, g - 20, g + 30))
d.rectangle([510, 670, 970, 1420], outline='black', width=5)
d.polygon([(520, 1400), (700, 1100), (960, 1400)], fill=(200, 200, 200), outline='black')

bubble(d, 780, 230, 140, 165, (720, 470)); truth.append(('speech', vtext(d, 780, 230, 'ここは一体どこなんだ？', 34), 'ここは一体どこなんだ？'))
bubble(d, 300, 220, 120, 150, (330, 450)); truth.append(('speech', vtext(d, 300, 220, '落ち着いて。', 34), '落ち着いて。'))
bubble(d, 740, 860, 150, 120); truth.append(('speech', vtext(d, 740, 860, '明日また来るよ', 30), '明日また来るよ'))
# SFX на градиенте
f = font(80); d.text((120, 850), 'ドン', font=f, fill='black', stroke_width=6, stroke_fill='white')
truth.append(('sfx', [115, 870, 180, 110], 'ドン'))
# подпись в рамке
d.rectangle([60, 1200, 450, 1380], fill='white', outline='black', width=3)
truth.append(('narration', htext(d, 255, 1290, ['三日後、', '彼らは町を出た。'], 28, idx=0), '三日後、彼らは町を出た。'))
im.save(f'{out}/page01.png')
meta = {'page01.png': {'w': W, 'h': H, 'blocks': truth}}

# ---- вебтун 800x5200
W, H = 800, 5200
im = Image.new('RGB', (W, H), (250, 248, 244)); d = ImageDraw.Draw(im); truth = []
for i, (y0, col) in enumerate([(600, (150, 180, 210)), (2300, (190, 160, 140)), (3900, (120, 140, 120))]):
    d.rectangle([40, y0, 760, y0 + 800], fill=col, outline='black', width=4)
    for k in range(0, 720, 30): d.line([(40 + k, y0 + 800), (40 + k + 100, y0 + 500)], fill=(60, 60, 60), width=2)
specs = [(400, 300, 260, 110, ['어디로 가는 거야?', '같이 가!']), (330, 1700, 240, 100, ['조금만 기다려.']),
         (450, 2100, 250, 105, ['정말 괜찮아?']), (380, 3450, 270, 120, ['이건 시작일 뿐이야.', '알겠지?']), (420, 4950, 230, 95, ['끝!'])]
for cx, cy, rx, ry, lines in specs:
    bubble(d, cx, cy, rx, ry)
    truth.append(('speech', htext(d, cx, cy, lines, 34), ' '.join(lines)))
im.save(f'{out}/page02_webtoon.png')
meta['page02_webtoon.png'] = {'w': W, 'h': H, 'blocks': truth}
json.dump(meta, open(f'{out}/truth.json', 'w'), ensure_ascii=False, indent=1)
print('ok')
