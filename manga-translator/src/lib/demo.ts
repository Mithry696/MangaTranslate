// Демо-проект: страницы рисуются прямо в браузере (оригинальный учебный пример),
// текст и перевод заданы заранее — можно попробовать очистку, вставку и редактор без API-ключа.
import type { Block, BlockKind, Box, Project } from './types';
import { DEFAULT_STYLE } from './types';
import { canvasToBlob, ctx2d, makeCanvas } from './image';
import { newBlock } from './ocr';
import { uid } from './util';

interface DemoBubble { cx: number; cy: number; rx: number; ry: number; text: string; tr: string; vertical: boolean; kind?: BlockKind; size?: number }

const CJK_FONT = '"Noto Sans CJK JP", "Noto Sans JP", "Hiragino Sans", "Yu Gothic", "Meiryo", "Malgun Gothic", "Noto Sans CJK KR", sans-serif';

function drawBubble(g: CanvasRenderingContext2D, b: DemoBubble, tail: [number, number] | null) {
  g.save();
  g.fillStyle = '#fff'; g.strokeStyle = '#111'; g.lineWidth = 3;
  g.beginPath();
  g.ellipse(b.cx, b.cy, b.rx, b.ry, 0, 0, Math.PI * 2);
  if (tail) {
    g.moveTo(b.cx - 14, b.cy + b.ry * 0.9);
    g.lineTo(tail[0], tail[1]);
    g.lineTo(b.cx + 14, b.cy + b.ry * 0.92);
  }
  g.fill(); g.stroke();
  // убираем линию эллипса внутри хвостика
  if (tail) {
    g.beginPath(); g.ellipse(b.cx, b.cy, b.rx - 2, b.ry - 2, 0, 0, Math.PI * 2); g.fill();
  }
  g.restore();
}

/** Рисует текст и возвращает его точные границы */
function drawText(g: CanvasRenderingContext2D, b: DemoBubble): Box {
  const size = b.size ?? 26;
  g.save();
  g.fillStyle = '#111';
  g.font = `700 ${size}px ${CJK_FONT}`;
  g.textBaseline = 'middle'; g.textAlign = 'center';
  let box: Box;
  if (b.vertical) {
    // вертикальный текст: колонки справа налево, по 6 символов
    const chars = [...b.text];
    const perCol = Math.max(3, Math.ceil(chars.length / Math.ceil(chars.length / 6)));
    const cols: string[][] = [];
    for (let i = 0; i < chars.length; i += perCol) cols.push(chars.slice(i, i + perCol));
    const colW = size * 1.25;
    const totalW = cols.length * colW;
    const totalH = perCol * size * 1.05;
    const x0 = b.cx + totalW / 2 - colW / 2;
    const y0 = b.cy - totalH / 2 + size / 2;
    cols.forEach((col, ci) => col.forEach((ch, k) => g.fillText(ch, x0 - ci * colW, y0 + k * size * 1.05)));
    box = { x: b.cx - totalW / 2 + 2, y: b.cy - totalH / 2, w: totalW - 4, h: totalH };
  } else {
    const lines = b.text.split('\n');
    const lh = size * 1.25;
    const widths = lines.map((l) => g.measureText(l).width);
    const totalH = lines.length * lh;
    lines.forEach((l, i) => g.fillText(l, b.cx, b.cy - totalH / 2 + lh / 2 + i * lh));
    const w = Math.max(...widths);
    box = { x: b.cx - w / 2, y: b.cy - totalH / 2, w, h: totalH };
  }
  g.restore();
  return box;
}

function panel(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, paint: (g: CanvasRenderingContext2D) => void) {
  g.save();
  g.beginPath(); g.rect(x, y, w, h); g.clip();
  g.fillStyle = '#fff'; g.fillRect(x, y, w, h);
  paint(g);
  g.restore();
  g.strokeStyle = '#111'; g.lineWidth = 4; g.strokeRect(x, y, w, h);
}

// простые декоративные «декорации» без персонажей: холмы, дома, облака
function scenery(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, seed: number) {
  g.strokeStyle = '#333'; g.lineWidth = 2;
  g.fillStyle = '#d9d9d9';
  g.beginPath(); g.moveTo(x, y + h);
  for (let i = 0; i <= 8; i++) g.lineTo(x + (w * i) / 8, y + h * (0.72 + 0.12 * Math.sin(i * 1.3 + seed)));
  g.lineTo(x + w, y + h); g.closePath(); g.fill(); g.stroke();
  for (let i = 0; i < 3; i++) {
    const hx = x + w * (0.15 + 0.3 * i), hw = w * 0.14, hh = h * (0.18 + 0.05 * ((i + seed) % 3));
    g.fillStyle = '#eee';
    g.fillRect(hx, y + h * 0.78 - hh, hw, hh); g.strokeRect(hx, y + h * 0.78 - hh, hw, hh);
    g.beginPath(); g.moveTo(hx - 6, y + h * 0.78 - hh); g.lineTo(hx + hw / 2, y + h * 0.78 - hh - hw * 0.5); g.lineTo(hx + hw + 6, y + h * 0.78 - hh); g.closePath();
    g.fillStyle = '#888'; g.fill(); g.stroke();
  }
  // штриховка
  g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 1;
  for (let k = 0; k < w; k += 9) { g.beginPath(); g.moveTo(x + k, y + h * 0.95); g.lineTo(x + k + 20, y + h); g.stroke(); }
}

async function mangaPage(): Promise<{ blob: Blob; w: number; h: number; blocks: Block[] }> {
  const W = 900, H = 1300;
  const c = makeCanvas(W, H), g = ctx2d(c);
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  const blocks: Block[] = [];
  const add = (b: DemoBubble, box: Box) => {
    const bl = newBlock(box, b.text.replace(/\n/g, ''), b.kind ?? 'speech');
    bl.translation = b.tr;
    blocks.push(bl);
  };
  panel(g, 30, 30, 840, 520, (g) => scenery(g, 30, 30, 840, 520, 1));
  const b1: DemoBubble = { cx: 690, cy: 200, rx: 120, ry: 140, text: 'ねえ、今日の空は本当にきれいだね！', tr: 'Слушай, какое сегодня красивое небо!', vertical: true };
  const b2: DemoBubble = { cx: 260, cy: 190, rx: 110, ry: 125, text: 'うん、まるで絵みたい。', tr: 'Ага, прямо как на картинке.', vertical: true };
  drawBubble(g, b1, [640, 400]); add(b1, drawText(g, b1));
  drawBubble(g, b2, [300, 380]); add(b2, drawText(g, b2));

  panel(g, 30, 580, 410, 690, (g) => {
    const grd = g.createLinearGradient(30, 580, 440, 1270);
    grd.addColorStop(0, '#5b6e91'); grd.addColorStop(1, '#c9b8d8');
    g.fillStyle = grd; g.fillRect(30, 580, 410, 690);
    g.strokeStyle = 'rgba(255,255,255,0.5)';
    for (let i = 0; i < 40; i++) { g.beginPath(); g.moveTo(30 + i * 13, 580); g.lineTo(30 + i * 13 - 120, 1270); g.stroke(); }
  });
  // SFX поверх фона
  g.save();
  g.font = `900 64px ${CJK_FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 8; g.strokeStyle = '#fff'; g.fillStyle = '#111';
  g.translate(235, 800); g.rotate(-0.12);
  g.strokeText('ザアア', 0, 0); g.fillText('ザアア', 0, 0);
  g.restore();
  const sfx = newBlock({ x: 128, y: 750, w: 215, h: 100 }, 'ザアア', 'sfx');
  sfx.translation = 'ШУ-У-УХ';
  sfx.style = { font: 'Russo One', strokeWidth: 0.18, angle: -7 };
  blocks.push(sfx);
  // подпись в прямоугольной рамке
  g.fillStyle = '#fff'; g.strokeStyle = '#111'; g.lineWidth = 3;
  g.fillRect(60, 1080, 340, 150); g.strokeRect(60, 1080, 340, 150);
  const cap: DemoBubble = { cx: 230, cy: 1155, rx: 0, ry: 0, text: 'その日、\n風は少し冷たかった。', tr: 'В тот день ветер был немного холодным.', vertical: false, kind: 'narration', size: 24 };
  add(cap, drawText(g, cap));

  panel(g, 470, 580, 400, 690, (g) => scenery(g, 470, 580, 400, 690, 4));
  const b3: DemoBubble = { cx: 700, cy: 760, rx: 130, ry: 135, text: '早く行こう。電車に遅れるよ！', tr: 'Пошли быстрее. Опоздаем на электричку!', vertical: true };
  drawBubble(g, b3, [740, 980]); add(b3, drawText(g, b3));

  return { blob: await canvasToBlob(c), w: W, h: H, blocks };
}

async function webtoonPage(): Promise<{ blob: Blob; w: number; h: number; blocks: Block[] }> {
  const W = 800, H = 2600;
  const c = makeCanvas(W, H), g = ctx2d(c);
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, '#f6efe4'); grd.addColorStop(0.5, '#ffffff'); grd.addColorStop(1, '#e8eef6');
  g.fillStyle = grd; g.fillRect(0, 0, W, H);
  const blocks: Block[] = [];
  const add = (b: DemoBubble, box: Box) => {
    const bl = newBlock(box, b.text.replace(/\n/g, ' '), b.kind ?? 'speech');
    bl.translation = b.tr; blocks.push(bl);
  };
  // панель-картинка
  g.fillStyle = '#9fb7cf'; g.fillRect(60, 380, 680, 520);
  scenery(g, 60, 380, 680, 520, 2);
  g.strokeStyle = '#222'; g.lineWidth = 3; g.strokeRect(60, 380, 680, 520);

  const b1: DemoBubble = { cx: 400, cy: 200, rx: 230, ry: 95, text: '여기가 바로\n그 유명한 마을이야?', tr: 'Так это и есть та самая знаменитая деревня?', vertical: false };
  drawBubble(g, b1, [420, 370]); add(b1, drawText(g, b1));
  const b2: DemoBubble = { cx: 300, cy: 1120, rx: 210, ry: 90, text: '생각보다 조용하네.', tr: 'А тут тише, чем я думал.', vertical: false, kind: 'speech' };
  drawBubble(g, b2, null); add(b2, drawText(g, b2));
  const b3: DemoBubble = { cx: 520, cy: 1450, rx: 220, ry: 100, text: '조심해. 밤에는\n아무도 밖에 나가지 않아.', tr: 'Осторожнее. По ночам никто не выходит на улицу.', vertical: false };
  drawBubble(g, b3, null); add(b3, drawText(g, b3));

  // закадровый текст на тёмном фоне
  g.fillStyle = '#1d2433'; g.fillRect(0, 1750, W, 500);
  g.fillStyle = 'rgba(255,255,255,0.08)';
  for (let i = 0; i < 30; i++) { g.beginPath(); g.arc((i * 137) % W, 1750 + ((i * 89) % 500), 2 + (i % 4), 0, Math.PI * 2); g.fill(); }
  g.save();
  g.fillStyle = '#f2f2f2'; g.font = `500 30px ${CJK_FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('그날 밤, 마을의 불빛이', 400, 1960); g.fillText('하나둘 꺼지기 시작했다.', 400, 2005);
  g.restore();
  const nar = newBlock({ x: 240, y: 1938, w: 320, h: 90 }, '그날 밤, 마을의 불빛이 하나둘 꺼지기 시작했다.', 'narration');
  nar.translation = 'В ту ночь огни деревни начали гаснуть один за другим.';
  nar.style = { color: '#f2f2f2', font: 'PT Sans Narrow', italic: true };
  blocks.push(nar);
  return { blob: await canvasToBlob(c), w: W, h: H, blocks };
}

export async function buildDemo(): Promise<{ project: Project; pages: { name: string; blob: Blob; blocks: Block[] }[] }> {
  const project: Project = {
    id: uid('pr'), name: 'Демо: пример главы', createdAt: Date.now(), updatedAt: Date.now(),
    sourceLang: 'auto', direction: 'auto', format: 'auto',
    notes: 'Демо-проект. Две подруги приезжают в тихую деревню.',
    honorifics: 'keep', sfx: 'translate',
    glossary: [{ id: uid('g'), src: '마을', dst: 'деревня', note: 'а не «посёлок»' }],
    sharedGlossaryIds: [], style: { ...DEFAULT_STYLE }, pageCount: 2,
  };
  const p1 = await mangaPage();
  const p2 = await webtoonPage();
  return { project, pages: [{ name: '01_manga.png', blob: p1.blob, blocks: p1.blocks }, { name: '02_webtoon.png', blob: p2.blob, blocks: p2.blocks }] };
}
