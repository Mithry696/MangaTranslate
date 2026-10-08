// Очистка оригинального текста и поиск области пузыря для вставки перевода.
// Идея: внутри пузыря фон однотонный, а буквы — «острова» другого цвета, не касающиеся
// контура. Такие острова закрашиваются цветом фона. Если фон сложный (рисунок),
// область заполняется диффузией от краёв (аналог простого инпейнтинга).
import type { Block, Box, CleanMode } from './types';
import { ctx2d, hexToRgb, rgbToHex, type Canvas } from './image';
import { clamp, expandBox } from './util';

export interface CleanResult {
  bgType: 'flat' | 'complex';
  fillColor: string;
  textBox: Box;
  cands: Box[]; // варианты области текста внутри пузыря
}

const BG_TOL = 60; // расстояние по цвету, в пределах которого пиксель считается фоном

function dist2(d: Uint8ClampedArray, i: number, c: number[]) {
  const r = d[i] - c[0], g = d[i + 1] - c[1], b = d[i + 2] - c[2];
  return r * r + g * g + b * b;
}

/** Доминирующий цвет в кольце вокруг рамки и доля пикселей этого цвета */
function ringStats(data: ImageData, inner: Box): { color: number[]; share: number } {
  const { width: w, height: h, data: d } = data;
  const hist = new Map<number, { n: number; r: number; g: number; b: number }>();
  let total = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= inner.x && x < inner.x + inner.w && y >= inner.y && y < inner.y + inner.h) continue;
      const i = (y * w + x) * 4;
      const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
      const e = hist.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += d[i]; e.g += d[i + 1]; e.b += d[i + 2];
      hist.set(key, e);
      total++;
    }
  }
  let best = { n: 0, r: 255, g: 255, b: 255 };
  for (const e of hist.values()) if (e.n > best.n) best = e;
  const color = best.n ? [best.r / best.n, best.g / best.n, best.b / best.n] : [255, 255, 255];
  let near = 0;
  const t2 = 36 * 36;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= inner.x && x < inner.x + inner.w && y >= inner.y && y < inner.y + inner.h) continue;
      if (dist2(d, (y * w + x) * 4, color) < t2) near++;
    }
  }
  return { color, share: total ? near / total : 0 };
}

/**
 * Главная функция: очищает блок на холсте `clean`, анализируя оригинал `orig`.
 * Возвращает тип фона, цвет заливки и варианты области для текста.
 */
export function cleanBlock(orig: Canvas, clean: Canvas, block: Block, mode: CleanMode = block.clean): CleanResult {
  const W = orig.width, H = orig.height;
  const box = clampBox(block.box, W, H);
  const pad = Math.round(clamp(Math.min(box.w, box.h) * 0.4, 10, 60));
  const R = expandBox(box, pad, W, H);
  const rData = ctx2d(orig).getImageData(R.x, R.y, R.w, R.h);
  const inner: Box = { x: box.x - R.x, y: box.y - R.y, w: box.w, h: box.h };
  const ring = ringStats(rData, inner);
  const flat = ring.share > 0.6;
  const bg = mode === 'fill' && block.fillColor ? hexToRgb(block.fillColor) : ring.color;
  const result: CleanResult = { bgType: flat ? 'flat' : 'complex', fillColor: rgbToHex(bg), textBox: { ...box }, cands: [] };

  if (mode === 'fill') {
    const g = ctx2d(clean);
    g.fillStyle = rgbToHex(bg);
    const fb = expandBox(box, 2, W, H);
    g.fillRect(fb.x, fb.y, fb.w, fb.h);
    result.textBox = fb;
    return result;
  }
  // звуки обычно нарисованы поверх рисунка и обведены — для них сразу «размытие»
  const treatComplex = !flat || (block.kind === 'sfx' && mode === 'auto');
  if (mode === 'blur' || (treatComplex && mode !== 'none')) {
    const m = Math.round(clamp(Math.min(box.w, box.h) * 0.12, 4, 24));
    diffuseFill(clean, expandBox(box, m, W, H));
    result.bgType = 'complex';
    result.textBox = expandBox(box, m, W, H);
    return result;
  }

  // 1) пробуем найти замкнутый пузырь: заливаем фон от центра рамки
  const bubble = floodBubble(orig, box, bg);
  if (bubble) {
    if (mode !== 'none') applyMask(clean, bubble.S, bubble.erase, bg);
    result.cands = bubble.cands;
    result.textBox = bubble.cands.length ? pickByArea(bubble.cands) : expandBox(box, Math.round(pad * 0.3), W, H);
    return result;
  }
  if (mode === 'none') { return result; }

  // 2) пузыря нет (текст на однотонном фоне страницы): стираем «острова» внутри расширенной рамки
  const { width: rw, height: rh, data: d } = rData;
  const n = rw * rh;
  const isBg = new Uint8Array(n);
  const tol2 = BG_TOL * BG_TOL;
  for (let p = 0; p < n; p++) isBg[p] = dist2(d, p * 4, bg) < tol2 ? 1 : 0;
  const label = new Uint8Array(n);
  const erase = new Uint8Array(n);
  const keep = new Uint8Array(n);
  const stack: number[] = [];
  const comp: number[] = [];
  for (let p0 = 0; p0 < n; p0++) {
    if (isBg[p0] || label[p0]) continue;
    comp.length = 0;
    stack.push(p0); label[p0] = 1;
    let touches = false;
    while (stack.length) {
      const p = stack.pop()!;
      comp.push(p);
      const x = p % rw, y = (p / rw) | 0;
      if (x === 0 || y === 0 || x === rw - 1 || y === rh - 1) touches = true;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= rh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= rw) continue;
          const q = yy * rw + xx;
          if (!isBg[q] && !label[q]) { label[q] = 1; stack.push(q); }
        }
      }
    }
    const target = !touches && comp.length < n * 0.5 ? erase : keep;
    for (const p of comp) target[p] = 1;
  }
  const dil = clamp(Math.round(Math.min(box.w, box.h) / 120) + 2, 2, 4);
  applyMask(clean, R, dilate(erase, rw, rh, dil, keep), bg);
  result.textBox = expandBox(box, Math.round(pad * 0.3), W, H);
  return result;
}

function applyMask(clean: Canvas, A: Box, mask: Uint8Array, bg: number[]) {
  const cg = ctx2d(clean);
  const img = cg.getImageData(A.x, A.y, A.w, A.h);
  const cd = img.data;
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const i = p * 4;
    cd[i] = bg[0]; cd[i + 1] = bg[1]; cd[i + 2] = bg[2]; cd[i + 3] = 255;
  }
  cg.putImageData(img, A.x, A.y);
}

function clampBox(b: Box, W: number, H: number): Box {
  const x = clamp(Math.round(b.x), 0, W - 1), y = clamp(Math.round(b.y), 0, H - 1);
  return { x, y, w: clamp(Math.round(b.w), 1, W - x), h: clamp(Math.round(b.h), 1, H - y) };
}

function dilate(src: Uint8Array, w: number, h: number, r: number, forbid: Uint8Array) {
  let cur = src;
  for (let k = 0; k < r; k++) {
    const next = new Uint8Array(cur);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (cur[p] || forbid[p]) continue;
        if ((x > 0 && cur[p - 1]) || (x < w - 1 && cur[p + 1]) || (y > 0 && cur[p - w]) || (y < h - 1 && cur[p + w])) next[p] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

/**
 * Поиск пузыря: заливка «фоновых» пикселей от центра рамки. Если заливка не утекла
 * за пределы области поиска, пузырь замкнут. Всё, что внутри пузыря и не соединено
 * с его контуром, — это буквы (их стираем). Точность рамки от модели почти не важна.
 */
function floodBubble(orig: Canvas, box: Box, bg: number[]): { S: Box; erase: Uint8Array; cands: Box[] } | null {
  const W = orig.width, H = orig.height;
  const grow = Math.round(Math.max(box.w, box.h) * 2.5 + 120);
  const S = expandBox(box, grow, W, H);
  const sw = S.w, sh = S.h, n = sw * sh;
  const d = ctx2d(orig).getImageData(S.x, S.y, sw, sh).data;
  const tol2 = BG_TOL * BG_TOL;
  const pass = new Uint8Array(n);
  for (let p = 0; p < n; p++) pass[p] = dist2(d, p * 4, bg) < tol2 ? 1 : 0;

  // семена — фоновые пиксели в центральной части рамки
  const fill = new Uint8Array(n);
  const stack: number[] = [];
  const bx0 = box.x - S.x, by0 = box.y - S.y;
  const mx = Math.round(box.w * 0.2), my = Math.round(box.h * 0.2);
  for (let y = by0 + my; y < by0 + box.h - my; y++) {
    for (let x = bx0 + mx; x < bx0 + box.w - mx; x++) {
      const p = y * sw + x;
      if (pass[p] && !fill[p]) { fill[p] = 1; stack.push(p); }
    }
  }
  if (!stack.length) return null;
  let count = 0;
  const atEdge = (x: number, y: number) =>
    (x === 0 && S.x > 0) || (y === 0 && S.y > 0) || (x === sw - 1 && S.x + sw < W) || (y === sh - 1 && S.y + sh < H);
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % sw, y = (p / sw) | 0;
    count++;
    if (atEdge(x, y)) return null; // утекло — это не пузырь
    if (x > 0 && pass[p - 1] && !fill[p - 1]) { fill[p - 1] = 1; stack.push(p - 1); }
    if (x < sw - 1 && pass[p + 1] && !fill[p + 1]) { fill[p + 1] = 1; stack.push(p + 1); }
    if (y > 0 && pass[p - sw] && !fill[p - sw]) { fill[p - sw] = 1; stack.push(p - sw); }
    if (y < sh - 1 && pass[p + sw] && !fill[p + sw]) { fill[p + sw] = 1; stack.push(p + sw); }
  }
  // «пузырь» меньше самой рамки текста — скорее обводка букв, а не пузырь
  if (count < box.w * box.h * 0.6 || count > W * H * 0.4) return null;

  // «снаружи» — все не-пузырные пиксели, связанные с краем области поиска (контур, рисунок)
  const outside = new Uint8Array(n);
  for (let x = 0; x < sw; x++) { for (const y of [0, sh - 1]) { const p = y * sw + x; if (!fill[p] && !outside[p]) { outside[p] = 1; stack.push(p); } } }
  for (let y = 0; y < sh; y++) { for (const x of [0, sw - 1]) { const p = y * sw + x; if (!fill[p] && !outside[p]) { outside[p] = 1; stack.push(p); } } }
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % sw, y = (p / sw) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= sh) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= sw) continue;
        const q = yy * sw + xx;
        if (!fill[q] && !outside[q]) { outside[q] = 1; stack.push(q); }
      }
    }
  }
  const holes = new Uint8Array(n);
  let minX = sw, minY = sh, maxX = 0, maxY = 0, sx = 0, sy = 0, cnt = 0;
  for (let p = 0; p < n; p++) {
    const inside = fill[p] || !outside[p];
    if (!fill[p] && !outside[p]) holes[p] = 1;
    if (inside) {
      const x = p % sw, y = (p / sw) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      sx += x; sy += y; cnt++;
    }
  }
  const dil = clamp(Math.round(Math.min(box.w, box.h) / 120) + 2, 2, 4);
  const erase = dilate(holes, sw, sh, dil, outside);

  // варианты прямоугольника для текста внутри пузыря
  const region = new Uint8Array(n);
  for (let p = 0; p < n; p++) region[p] = fill[p] || holes[p] ? 1 : 0;
  const cx = Math.round(sx / cnt), cy = Math.round(sy / cnt);
  const half = new Int32Array(sh);
  for (let y = minY; y <= maxY; y++) {
    if (!region[y * sw + cx]) { half[y] = 0; continue; }
    let l = 0, r = 0;
    while (cx - l - 1 >= 0 && region[y * sw + cx - l - 1]) l++;
    while (cx + r + 1 < sw && region[y * sw + cx + r + 1]) r++;
    half[y] = Math.min(l, r);
  }
  const bh = maxY - minY + 1;
  const cands: Box[] = [];
  const step = Math.max(2, Math.round(bh / 30));
  for (let hh = Math.max(8, step); hh <= bh; hh += step) {
    const y0 = cy - Math.floor(hh / 2), y1 = y0 + hh;
    if (y0 < minY || y1 > maxY) break;
    let m = Infinity;
    for (let y = y0; y <= y1; y++) if (half[y] < m) m = half[y];
    const ww = 2 * m;
    if (ww < 10) break;
    const ix = ww * 0.1, iy = hh * 0.09;
    cands.push({ x: Math.round(S.x + cx - ww / 2 + ix), y: Math.round(S.y + y0 + iy), w: Math.round(ww - 2 * ix), h: Math.round(hh - 2 * iy) });
  }
  return { S, erase, cands };
}

/** Без текста выбираем по площади с лёгким предпочтением широких прямоугольников */
export function pickByArea(cands: Box[]): Box {
  let best = cands[0], score = -1;
  for (const c of cands) {
    const s = c.w * c.h * Math.min(1, c.w / Math.max(1, c.h) / 0.7);
    if (s > score) { score = s; best = c; }
  }
  return best;
}

/** Заполнение прямоугольника плавной диффузией от его краёв (многоуровневая схема) */
export function diffuseFill(c: Canvas, area: Box) {
  const W = c.width, H = c.height;
  const R = expandBox(area, 3, W, H);
  if (R.w < 3 || R.h < 3) return;
  const g = ctx2d(c);
  const img = g.getImageData(R.x, R.y, R.w, R.h);
  const w = R.w, h = R.h, n = w * h;
  const mask = new Uint8Array(n);
  const ax = area.x - R.x, ay = area.y - R.y;
  for (let y = ay; y < ay + area.h; y++) for (let x = ax; x < ax + area.w; x++) if (x >= 0 && y >= 0 && x < w && y < h) mask[y * w + x] = 1;
  const chans = [0, 1, 2].map((k) => {
    const a = new Float32Array(n);
    for (let p = 0; p < n; p++) a[p] = img.data[p * 4 + k];
    return a;
  });
  for (const ch of chans) solveLevel(ch, mask, w, h);
  for (let p = 0; p < n; p++) {
    if (!mask[p]) continue;
    img.data[p * 4] = chans[0][p]; img.data[p * 4 + 1] = chans[1][p]; img.data[p * 4 + 2] = chans[2][p]; img.data[p * 4 + 3] = 255;
  }
  g.putImageData(img, R.x, R.y);
}

function solveLevel(v: Float32Array, mask: Uint8Array, w: number, h: number) {
  if (Math.max(w, h) > 24) {
    const w2 = Math.ceil(w / 2), h2 = Math.ceil(h / 2);
    const v2 = new Float32Array(w2 * h2), m2 = new Uint8Array(w2 * h2);
    for (let y = 0; y < h2; y++) {
      for (let x = 0; x < w2; x++) {
        let s = 0, k = 0, masked = 0, tot = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const xx = 2 * x + dx, yy = 2 * y + dy;
          if (xx >= w || yy >= h) continue;
          const p = yy * w + xx; tot++;
          if (mask[p]) masked++; else { s += v[p]; k++; }
        }
        const q = y * w2 + x;
        m2[q] = masked === tot ? 1 : 0;
        v2[q] = k ? s / k : 0;
      }
    }
    solveLevel(v2, m2, w2, h2);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (mask[p]) v[p] = v2[Math.min(h2 - 1, y >> 1) * w2 + Math.min(w2 - 1, x >> 1)];
    }
    iterate(v, mask, w, h, 30);
  } else {
    let s = 0, k = 0;
    for (let p = 0; p < w * h; p++) if (!mask[p]) { s += v[p]; k++; }
    const mean = k ? s / k : 255;
    for (let p = 0; p < w * h; p++) if (mask[p]) v[p] = mean;
    iterate(v, mask, w, h, 200);
  }
}

function iterate(v: Float32Array, mask: Uint8Array, w: number, h: number, iters: number) {
  for (let it = 0; it < iters; it++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (!mask[p]) continue;
        let s = 0, k = 0;
        if (x > 0) { s += v[p - 1]; k++; }
        if (x < w - 1) { s += v[p + 1]; k++; }
        if (y > 0) { s += v[p - w]; k++; }
        if (y < h - 1) { s += v[p + w]; k++; }
        v[p] = s / k;
      }
    }
  }
}

/** Восстановить прямоугольник из оригинала (перед повторной очисткой блока) */
export function restoreRegion(orig: Canvas, clean: Canvas, b: Box, padPx = 4) {
  const r = expandBox(b, padPx, orig.width, orig.height);
  ctx2d(clean).drawImage(orig, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
}
