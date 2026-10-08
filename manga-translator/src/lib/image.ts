// Работа с изображениями: загрузка, холсты, кэш

export type Canvas = HTMLCanvasElement;

export function makeCanvas(w: number, h: number): Canvas {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function ctx2d(c: Canvas) {
  return c.getContext('2d', { willReadFrequently: true })!;
}

export async function blobToCanvas(blob: Blob): Promise<Canvas> {
  const bmp = await createImageBitmap(blob);
  const c = makeCanvas(bmp.width, bmp.height);
  ctx2d(c).drawImage(bmp, 0, 0);
  bmp.close?.();
  return c;
}

export function canvasToBlob(c: Canvas, type = 'image/png', quality = 0.92): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Не удалось сохранить изображение'))), type, quality));
}

export function cloneCanvas(src: Canvas): Canvas {
  const c = makeCanvas(src.width, src.height);
  ctx2d(c).drawImage(src, 0, 0);
  return c;
}

/** Фрагмент изображения, уменьшенный так, чтобы длинная сторона была ≤ maxSide */
export function cropScaled(src: Canvas, x: number, y: number, w: number, h: number, maxSide: number) {
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const c = makeCanvas(w * scale, h * scale);
  const g = ctx2d(c);
  g.imageSmoothingQuality = 'high';
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
  return { canvas: c, scale };
}

export function thumbnail(src: Canvas, maxW = 240, maxH = 340): string {
  const s = Math.min(maxW / src.width, maxH / src.height, 1);
  const c = makeCanvas(src.width * s, src.height * s);
  const g = ctx2d(c);
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}

export const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;

/** Кэш холстов страниц в памяти (оригинал и очищенная версия) */
import { getBlob, putBlob } from './db';

const cache = new Map<string, Canvas>();

export async function getPageCanvas(pageId: string, kind: 'orig' | 'clean'): Promise<Canvas | null> {
  const key = `${pageId}:${kind}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const blob = await getBlob(key);
  if (!blob) return null;
  const c = await blobToCanvas(blob);
  cache.set(key, c);
  return c;
}

export async function setPageCanvas(pageId: string, kind: 'orig' | 'clean', c: Canvas, persist = true) {
  cache.set(`${pageId}:${kind}`, c);
  if (persist) await putBlob(`${pageId}:${kind}`, await canvasToBlob(c, 'image/png'));
}

export function dropFromCache(pageId: string) {
  cache.delete(`${pageId}:orig`);
  cache.delete(`${pageId}:clean`);
}

export function clearCache() { cache.clear(); }

/** Очищенная версия или копия оригинала, если очистки ещё не было */
export async function getCleanOrOrig(pageId: string): Promise<Canvas> {
  const clean = await getPageCanvas(pageId, 'clean');
  if (clean) return clean;
  const orig = await getPageCanvas(pageId, 'orig');
  if (!orig) throw new Error('Изображение страницы не найдено');
  return orig;
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace('#', '');
  const v = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const n = parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: number[]) {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}
