import type { Box } from './types';

export const uid = (prefix = '') =>
  prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function naturalCompare(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export function boxArea(b: Box) { return Math.max(0, b.w) * Math.max(0, b.h); }

export function intersect(a: Box, b: Box): Box {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
}

export function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function expandBox(b: Box, px: number, W: number, H: number): Box {
  const x = clamp(Math.round(b.x - px), 0, W), y = clamp(Math.round(b.y - px), 0, H);
  const x2 = clamp(Math.round(b.x + b.w + px), 0, W), y2 = clamp(Math.round(b.y + b.h + px), 0, H);
  return { x, y, w: x2 - x, h: y2 - y };
}

export function roundBox(b: Box): Box {
  return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) };
}

/** Простой пул задач с ограничением параллельности */
export async function runPool<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>, signal?: AbortSignal) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      if (signal?.aborted) throw new DOMException('Отменено', 'AbortError');
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function safeFileName(s: string) {
  return s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'project';
}

export function pad(n: number, len = 3) { return String(n).padStart(len, '0'); }

/** Нормализация для сравнения терминов глоссария */
export function normRu(s: string) { return s.toLowerCase().replace(/ё/g, 'е'); }

export function isCJK(s: string) { return /[぀-ヿ㐀-鿿가-힯豈-﫿]/.test(s); }
