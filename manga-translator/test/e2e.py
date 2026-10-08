# Сквозной тест с подменой API (сеть к ИИ не нужна)
import base64, io, json, re, sys, os, zipfile, random
import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright

T = sys.argv[1]           # папка с тестовыми страницами
URL = sys.argv[2]         # адрес сайта
SHOTS = sys.argv[3]
truth = json.load(open(f'{T}/truth.json'))
full_web = np.asarray(Image.open(f'{T}/page02_webtoon.png').convert('L'), dtype=np.float32)
TR = {
 'ここは一体どこなんだ？': 'Где это я вообще оказался?', '落ち着いて。': 'Успокойся.', '明日また来るよ': 'Я завтра ещё приду.',
 'ドン': 'БАМ', '三日後、彼らは町を出た。': 'Через три дня они покинули город.',
 '어디로 가는 거야? 같이 가!': 'Куда ты идёшь? Подожди, я с тобой!', '조금만 기다려.': 'Подожди немного.',
 '정말 괜찮아?': 'Ты точно в порядке?', '이건 시작일 뿐이야. 알겠지?': 'Это только начало. Понял?', '끝!': 'Конец!',
}
random.seed(1)
calls = {'vision': 0, 'text': 0}

def vision_reply(img):
    w, h = img.size
    if abs(h / w - 1.45) < 0.01:
        name, y0, th, W = 'page01.png', 0, 1450, 1000
    else:
        name, W = 'page02_webtoon.png', 800
        tile = np.asarray(img.convert('L').resize((800, round(h * 800 / w))), dtype=np.float32)
        th = tile.shape[0]
        prof_t = tile.mean(axis=1); prof_f = full_web.mean(axis=1)
        best, y0 = 1e18, 0
        for y in range(0, full_web.shape[0] - th + 1):
            e = np.abs(prof_f[y:y+th] - prof_t).sum()
            if e < best: best, y0 = e, y
    blocks = []
    for kind, (x, y, bw, bh), text in truth[name]['blocks']:
        cy = y + bh / 2
        if not (y0 <= cy < y0 + th): continue
        j = lambda v: v + random.uniform(-0.06, 0.06) * max(bw, bh)   # неточность рамок
        ymin, xmin, ymax, xmax = j(y) - y0, j(x), j(y + bh) - y0, j(x + bw)
        blocks.append({'box_2d': [round(ymin / th * 1000), round(xmin / W * 1000), round(ymax / th * 1000), round(xmax / W * 1000)], 'text': text, 'kind': kind})
    return {'blocks': blocks}

def handle(route):
    req = route.request
    if req.method == 'OPTIONS':
        return route.fulfill(status=204, headers={'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*'})
    body = json.loads(req.post_data or '{}')
    msgs = body.get('messages', [])
    content = msgs[-1]['content']
    if isinstance(content, list) and any(p.get('type') == 'image_url' for p in content):
        calls['vision'] += 1
        url = next(p['image_url']['url'] for p in content if p.get('type') == 'image_url')
        img = Image.open(io.BytesIO(base64.b64decode(url.split(',', 1)[1])))
        if 'HELLO' in json.dumps(content[0]): out = {'word': 'HELLO'}
        else: out = vision_reply(img)
    else:
        calls['text'] += 1
        txt = content if isinstance(content, str) else content[0]['text']
        if '"terms"' in txt:
            out = {'terms': [{'src': '町', 'dst': 'город', 'note': 'место'}]}
        else:
            arr = json.loads(txt[txt.index('ПЕРЕВЕДИ'):].split('\n', 1)[1])
            out = {'translations': [{'id': a['id'], 'text': TR.get(a['text'], 'Перевод: ' + a['text'])} for a in arr]}
    resp = {'choices': [{'message': {'content': json.dumps(out, ensure_ascii=False)}}], 'usage': {'prompt_tokens': 1000, 'completion_tokens': 100, 'cost': 0.0003}}
    route.fulfill(status=200, headers={'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json'}, body=json.dumps(resp))

errors = []
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1440, 'height': 950}, accept_downloads=True)
    pg.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.route('**/fonts.googleapis.com/**', lambda r: r.abort())
    pg.route('https://openrouter.ai/**', handle)
    pg.goto(URL)
    pg.evaluate("""localStorage.setItem('mangaperevod.settings', JSON.stringify({vision:{preset:'openrouter',baseUrl:'https://openrouter.ai/api/v1',apiKey:'test',model:'google/gemini-3.8-flash',jsonMode:true},
      text:{preset:'openrouter',baseUrl:'https://openrouter.ai/api/v1',apiKey:'',model:'deepseek/deepseek-v4.1-flash',jsonMode:true}}))""")
    pg.reload()
    pg.screenshot(path=f'{SHOTS}/01_home.png')
    # проект
    pg.get_by_role('button', name='＋ Новый проект').click()
    pg.locator('.modal input.input').first.fill('Тест — глава 1')
    pg.locator('.modal select').first.select_option('auto')
    pg.get_by_role('button', name='Создать').click()
    pg.locator('.dropzone input[type=file]').set_input_files([f'{T}/page01.png', f'{T}/page02_webtoon.png'])
    pg.wait_for_selector('.thumb >> nth=1')
    pg.get_by_role('button', name='Распознать', exact=True).click()
    pg.wait_for_selector('text=Распознавание текста: готово', timeout=60000)
    pg.get_by_role('button', name='Перевести', exact=True).click()
    pg.wait_for_selector('text=готово', timeout=60000)
    pg.wait_for_timeout(300)
    pg.get_by_role('button', name='Очистить и вставить', exact=True).click()
    pg.wait_for_selector('text=Очистка и вставка текста: готово', timeout=60000)
    print('LOG:', pg.locator('.log').text_content() if pg.locator('.log').count() else '-')
    pg.screenshot(path=f'{SHOTS}/02_project.png', full_page=True)
    # редактор
    pg.locator('.tab', has_text='Редактор').click()
    pg.wait_for_timeout(1200)
    pg.screenshot(path=f'{SHOTS}/03_editor_p1_final.png')
    pg.keyboard.press('1'); pg.wait_for_timeout(500)
    pg.screenshot(path=f'{SHOTS}/04_editor_p1_orig.png')
    pg.keyboard.press('3'); pg.wait_for_timeout(300)
    pg.locator('.bx').first.click(); pg.wait_for_timeout(400)
    pg.screenshot(path=f'{SHOTS}/05_editor_block.png')
    pg.keyboard.press('Escape')
    pg.keyboard.press('ArrowRight'); pg.wait_for_timeout(1500)
    pg.screenshot(path=f'{SHOTS}/06_editor_p2.png')
    # текст и глоссарий
    pg.locator('.tab', has_text='Текст').click(); pg.wait_for_timeout(400)
    pg.screenshot(path=f'{SHOTS}/07_text.png')
    pg.locator('.tab', has_text='Глоссарий').click()
    pg.get_by_role('button', name='✨ Предложить из текста').click()
    pg.wait_for_selector('text=Предложенные термины')
    pg.screenshot(path=f'{SHOTS}/08_glossary_suggest.png')
    pg.get_by_role('button', name='Добавить отмеченные').click()
    # экспорт
    pg.locator('.tab', has_text='Экспорт').click()
    with pg.expect_download() as dl:
        pg.get_by_role('button', name='⬇ Скачать ZIP').click()
    path = dl.value.path()
    z = zipfile.ZipFile(path)
    names = z.namelist(); print('ZIP:', names)
    for n in names:
        if n.startswith('перевод/'):
            open(f'{SHOTS}/zip_{os.path.basename(n)}', 'wb').write(z.read(n))
    print(z.read('текст/перевод_и_оригинал.txt').decode()[:500])
    # демо
    pg.goto(URL + '#'); pg.wait_for_timeout(300)
    pg.get_by_role('button', name='Открыть демо (без ключа)').click()
    pg.wait_for_selector('.tab >> text=Редактор', timeout=30000)
    pg.locator('.tab', has_text='Редактор').click(); pg.wait_for_timeout(1500)
    pg.screenshot(path=f'{SHOTS}/09_demo_p1.png')
    pg.keyboard.press('ArrowRight'); pg.wait_for_timeout(1500)
    pg.screenshot(path=f'{SHOTS}/10_demo_p2.png', full_page=False)
    pg.goto(URL + '#guide'); pg.wait_for_timeout(500)
    pg.screenshot(path=f'{SHOTS}/11_guide.png')
    b.close()
print('calls', calls)
print('ERRORS:', errors)
