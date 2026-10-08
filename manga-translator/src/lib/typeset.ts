// Вставка текста: подбор размера шрифта, перенос строк, отрисовка
import type { Block, Box, TextStyle } from './types';
import { DEFAULT_STYLE } from './types';

export function resolveStyle(base: TextStyle, block: Block): TextStyle {
  return { ...DEFAULT_STYLE, ...base, ...block.style };
}

function fontString(st: TextStyle, size: number) {
  return `${st.italic ? 'italic ' : ''}${st.bold ? '700 ' : '400 '}${size}px "${st.font}", "PT Sans Narrow", sans-serif`;
}

const VOWELS = 'аеёиоуыэюяaeiouy';
const NO_BREAK_BEFORE = 'ьъй';

/** Допустимые места переноса русского слова (упрощённые правила: после гласной или между согласными) */
function breakPoints(word: string): number[] {
  const w = word.toLowerCase();
  const letters = w.replace(/[^a-zа-яё]/g, '');
  if (letters.length < 6) return [];
  const pts: number[] = [];
  for (let i = 2; i <= word.length - 3; i++) {
    const a = w[i - 1], b = w[i];
    if (!/[a-zа-яё]/.test(a) || !/[a-zа-яё]/.test(b)) continue;
    if (NO_BREAK_BEFORE.includes(b)) continue;
    // в оставшейся части должна быть гласная, и в отрываемой тоже
    if (![...w.slice(0, i)].some((c) => VOWELS.includes(c)) || ![...w.slice(i)].some((c) => VOWELS.includes(c))) continue;
    if (VOWELS.includes(a) || (!VOWELS.includes(a) && !VOWELS.includes(b))) pts.push(i);
  }
  return pts;
}

/** Перенос по словам; если слово не влезает — делим его с дефисом по слогам (если allowHyphen) */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number, allowHyphen: boolean, force = false): string[] | null {
  const lines: string[] = [];
  for (const para of text.split(/\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = '';
    for (let word of words) {
      const cand = line ? line + ' ' + word : word;
      if (ctx.measureText(cand).width <= maxW) { line = cand; continue; }
      if (line) { lines.push(line); line = ''; }
      while (ctx.measureText(word).width > maxW) {
        if (!allowHyphen) return null;
        let pts = breakPoints(word).filter((k) => ctx.measureText(word.slice(0, k) + '-').width <= maxW);
        if (!pts.length && force) {
          // крайний случай: рамка уже одной буквы — режем где придётся
          let k = word.length - 1;
          while (k > 1 && ctx.measureText(word.slice(0, k) + '-').width > maxW) k--;
          pts = [Math.max(1, k)];
        }
        if (!pts.length) return null;
        const k = pts[pts.length - 1];
        lines.push(word.slice(0, k) + '-');
        word = word.slice(k);
      }
      line = word;
    }
    lines.push(line);
  }
  return lines;
}

export interface Layout { size: number; lines: string[]; lineH: number; width: number }

function tryLayout(ctx: CanvasRenderingContext2D, text: string, st: TextStyle, box: Box, size: number, hyphen: boolean, force = false): Layout | null {
  ctx.font = fontString(st, size);
  const strokePad = st.strokeWidth * size;
  const maxW = Math.max(4, box.w - strokePad * 2);
  const lines = wrap(ctx, text, maxW, hyphen, force);
  if (!lines) return null;
  const lineH = size * st.lineHeight;
  if (lines.length * lineH > box.h - strokePad * 2 + size * 0.08) return null;
  return { size, lines, lineH, width: maxW };
}

/** Подбор максимального размера шрифта, при котором текст влезает в рамку */
export function layoutText(ctx: CanvasRenderingContext2D, rawText: string, st: TextStyle, box: Box, pageW: number): Layout {
  const text = st.uppercase ? rawText.toUpperCase() : rawText;
  const maxSize = Math.max(8, Math.min(box.h, Math.max(16, pageW * 0.042), 90));
  const minSize = 6;
  if (st.size) {
    const l = tryLayout(ctx, text, st, { ...box, h: 1e6 }, st.size, true, true)!;
    return balance(ctx, text, st, l);
  }
  const search = (hyphen: boolean) => {
    let lo = minSize, hi = maxSize, best: Layout | null = null;
    while (hi - lo > 0.5) {
      const mid = (lo + hi) / 2;
      const l = tryLayout(ctx, text, st, box, mid, hyphen);
      if (l) { best = l; lo = mid; } else hi = mid;
    }
    return best;
  };
  const noHyph = search(false);
  // короткие реплики (1–2 слова) не переносим — это выглядит странно
  const hyph = text.trim().split(/\s+/).length > 2 ? search(true) : null;
  let best = noHyph;
  // перенос с дефисом используем только если он заметно увеличивает шрифт
  if (hyph && (!noHyph || hyph.size > noHyph.size * 1.4)) best = hyph;
  if (!best) best = tryLayout(ctx, text, st, { ...box, h: 1e6 }, minSize, true, true)!;
  best.size = Math.floor(best.size * 10) / 10;
  return balance(ctx, text, st, best);
}

/** Выравнивание длины строк: сужаем ширину, пока число строк не меняется */
function balance(ctx: CanvasRenderingContext2D, text: string, st: TextStyle, l: Layout): Layout {
  ctx.font = fontString(st, l.size);
  const n = l.lines.length;
  if (n < 2) return l;
  let lo = l.width * 0.4, hi = l.width, bestLines = l.lines;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    const lines = wrap(ctx, text, mid, l.lines.some((s) => s.endsWith('-')));
    if (lines && lines.length <= n) { hi = mid; bestLines = lines; } else lo = mid;
  }
  return { ...l, lines: bestLines };
}

export function drawBlockText(ctx: CanvasRenderingContext2D, block: Block, st: TextStyle, pageW: number) {
  const text = block.translation.trim();
  if (!text || block.skip) return;
  const box = block.textBox;
  ctx.save();
  const l = layoutText(ctx, text, st, box, pageW);
  ctx.font = fontString(st, l.size);
  ctx.textBaseline = 'middle';
  ctx.textAlign = st.align;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  if (st.angle) {
    ctx.translate(cx, cy);
    ctx.rotate((st.angle * Math.PI) / 180);
    ctx.translate(-cx, -cy);
  }
  const total = l.lines.length * l.lineH;
  const x = st.align === 'center' ? cx : st.align === 'left' ? box.x + st.strokeWidth * l.size : box.x + box.w - st.strokeWidth * l.size;
  let y = cy - total / 2 + l.lineH / 2;
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  for (const line of l.lines) {
    if (st.strokeWidth > 0) {
      ctx.strokeStyle = st.strokeColor;
      ctx.lineWidth = st.strokeWidth * l.size * 2;
      ctx.strokeText(line, x, y);
    }
    ctx.fillStyle = st.color;
    ctx.fillText(line, x, y);
    y += l.lineH;
  }
  ctx.restore();
}

const loadedFonts = new Set<string>();

/** Дожидаемся загрузки шрифтов, иначе canvas нарисует текст запасным шрифтом */
export async function ensureFonts(fonts: string[]) {
  const todo = [...new Set(fonts)].filter((f) => !loadedFonts.has(f));
  await Promise.all(todo.map(async (f) => {
    try {
      await Promise.race([
        Promise.all([document.fonts.load(`400 32px "${f}"`, 'Привет AБВ'), document.fonts.load(`700 32px "${f}"`, 'Привет')]),
        new Promise((r) => setTimeout(r, 4000)),
      ]);
    } catch { /* шрифт недоступен — будет запасной */ }
    loadedFonts.add(f);
  }));
}

export const BUILTIN_FONTS = [
  { name: 'Pangolin', note: 'комиксный, по умолчанию' },
  { name: 'Neucha', note: 'рукописный' },
  { name: 'Comfortaa', note: 'округлый' },
  { name: 'PT Sans Narrow', note: 'узкий, для длинных фраз' },
  { name: 'Rubik', note: 'чёткий гротеск' },
  { name: 'Caveat', note: 'рукописный, мысли' },
  { name: 'Marck Script', note: 'каллиграфия' },
  { name: 'Russo One', note: 'жирный, для SFX' },
  { name: 'Lobster', note: 'декоративный, вывески' },
];

let measureCtx: CanvasRenderingContext2D | null = null;

/** Из вариантов области внутри пузыря выбираем тот, где перевод получится крупнее всего */
export function chooseTextBox(cands: Box[], text: string, st: TextStyle, pageW: number): Box | null {
  if (!cands.length || !text.trim()) return null;
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')!;
  let best: Box | null = null, bestScore = -1;
  for (const c of cands) {
    const l = layoutText(measureCtx, text, { ...st, size: null }, c, pageW);
    const hyph = l.lines.some((s) => s.endsWith('-')) ? 0.7 : 1;
    const score = l.size * hyph + (c.w * c.h) / 1e7;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}
