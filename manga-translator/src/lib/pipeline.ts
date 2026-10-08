// Этапы обработки: импорт → распознавание → перевод → очистка и вставка
import JSZip from 'jszip';
import type { Block, Page, Project } from './types';
import { SFX_STYLE } from './types';
import { putPage, putBlob } from './db';
import { blobToCanvas, cloneCanvas, getPageCanvas, IMAGE_RE, setPageCanvas, thumbnail } from './image';
import { cleanBlock, restoreRegion } from './clean';
import { ocrPage } from './ocr';
import type { Settings } from './settings';
import { naturalCompare, runPool, uid, union } from './util';
import { chooseTextBox, resolveStyle } from './typeset';

/** Подбираем лучшую область внутри пузыря под текущий перевод */
export function fitTextBoxes(page: Page, project: Project, only?: Block) {
  for (const b of page.blocks) {
    if (only && b !== only) continue;
    if (b.manualTextBox || !b.textCands?.length || !b.translation.trim()) continue;
    const tb = chooseTextBox(b.textCands, b.translation, resolveStyle(project.style, b), page.width);
    if (tb) b.textBox = tb;
  }
}

export interface Progress { label: string; done: number; total: number; log: string[] }
export type ProgressFn = (p: Partial<Progress> & { logLine?: string }) => void;

/** Разбираем выбранные файлы и ZIP-архивы в упорядоченный список изображений */
export async function expandFiles(files: File[]): Promise<{ name: string; blob: Blob }[]> {
  const out: { name: string; blob: Blob }[] = [];
  for (const f of files) {
    if (/\.(zip|cbz)$/i.test(f.name)) {
      const zip = await JSZip.loadAsync(f);
      const entries = Object.values(zip.files).filter((e) => !e.dir && IMAGE_RE.test(e.name) && !e.name.includes('__MACOSX'));
      for (const e of entries) {
        const ext = e.name.split('.').pop()!.toLowerCase();
        const type = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
        out.push({ name: e.name, blob: new Blob([await e.async('arraybuffer')], { type }) });
      }
    } else if (f.type.startsWith('image/') || IMAGE_RE.test(f.name)) {
      out.push({ name: f.name, blob: f });
    }
  }
  return out.sort((a, b) => naturalCompare(a.name, b.name));
}

export async function importImages(project: Project, existing: Page[], items: { name: string; blob: Blob }[], onProgress?: ProgressFn): Promise<Page[]> {
  const pages: Page[] = [];
  let index = existing.length ? Math.max(...existing.map((p) => p.index)) + 1 : 0;
  for (let i = 0; i < items.length; i++) {
    onProgress?.({ label: 'Загрузка страниц', done: i, total: items.length });
    const { name, blob } = items[i];
    let canvas;
    try { canvas = await blobToCanvas(blob); } catch {
      onProgress?.({ logLine: `Не удалось открыть ${name} — пропущено` });
      continue;
    }
    const page: Page = {
      id: uid('p'), projectId: project.id, index: index++, name: name.split('/').pop() || name,
      width: canvas.width, height: canvas.height, blocks: [], status: 'new', hasClean: false,
      thumb: thumbnail(canvas),
    };
    await putBlob(page.id + ':orig', blob);
    await setPageCanvas(page.id, 'orig', canvas, false);
    await putPage(page);
    pages.push(page);
  }
  return pages;
}

function applyKindDefaults(project: Project, b: Block) {
  if (b.kind === 'sfx') {
    b.style = { ...SFX_STYLE, ...b.style };
    if (project.sfx === 'keep') b.skip = true;
  }
  if (b.kind === 'thought') b.style = { italic: true, ...b.style };
}

/** Этап 1: распознавание текста на страницах */
export async function runOcr(pages: Page[], project: Project, settings: Settings, opts: { force: boolean; signal?: AbortSignal; onProgress?: ProgressFn; onPage?: (p: Page) => void }) {
  const todo = pages.filter((p) => opts.force || p.status === 'new' || p.status === 'error' || !p.blocks.length);
  let done = 0;
  opts.onProgress?.({ label: 'Распознавание текста', done: 0, total: todo.length });
  await runPool(todo, settings.concurrency, async (page) => {
    try {
      const img = await getPageCanvas(page.id, 'orig');
      if (!img) throw new Error('нет изображения');
      const blocks = await ocrPage(img, project, settings, opts.signal, (t, n) => {
        if (n > 1) opts.onProgress?.({ logLine: `${page.name}: кусок ${t + 1} из ${n}` });
      });
      blocks.forEach((b) => applyKindDefaults(project, b));
      page.blocks = blocks;
      page.status = 'ocr';
      page.error = undefined;
      opts.onProgress?.({ logLine: `${page.name}: найдено блоков — ${blocks.length}` });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      page.status = 'error';
      page.error = (e as Error).message;
      opts.onProgress?.({ logLine: `${page.name}: ошибка — ${(e as Error).message}` });
    }
    await putPage(page);
    opts.onPage?.(page);
    opts.onProgress?.({ done: ++done });
  }, opts.signal);
}

/** Этап 3: очистка оригинального текста и подбор областей для перевода */
export async function cleanPage(page: Page, project: Project, keepManual = true) {
  const orig = await getPageCanvas(page.id, 'orig');
  if (!orig) throw new Error('нет изображения');
  const clean = cloneCanvas(orig);
  for (const b of page.blocks) {
    if (b.skip) continue;
    const r = cleanBlock(orig, clean, b);
    b.bgType = r.bgType;
    if (b.clean !== 'fill') b.fillColor = r.fillColor;
    b.textCands = r.cands.length ? r.cands : undefined;
    if (!(keepManual && b.manualTextBox)) b.textBox = r.textBox;
  }
  fitTextBoxes(page, project);
  await setPageCanvas(page.id, 'clean', clean);
  page.hasClean = true;
  if (page.blocks.some((b) => b.translation.trim())) page.status = 'done';
  await putPage(page);
}

/** Повторная очистка одного блока (после правки рамки или режима) */
export async function recleanBlock(page: Page, project: Project, block: Block, prevBox?: Block['box']) {
  const orig = await getPageCanvas(page.id, 'orig');
  if (!orig) return;
  let clean = await getPageCanvas(page.id, 'clean');
  if (!clean) { clean = cloneCanvas(orig); }
  restoreRegion(orig, clean, prevBox ? union(prevBox, block.box) : block.box, 6);
  if (!block.skip) {
    const r = cleanBlock(orig, clean, block);
    block.bgType = r.bgType;
    if (block.clean !== 'fill') block.fillColor = r.fillColor;
    block.textCands = r.cands.length ? r.cands : undefined;
    if (!block.manualTextBox) block.textBox = r.textBox;
    fitTextBoxes(page, project, block);
  }
  await setPageCanvas(page.id, 'clean', clean);
  page.hasClean = true;
  await putPage(page);
}

export async function runClean(pages: Page[], project: Project, opts: { signal?: AbortSignal; onProgress?: ProgressFn; onPage?: (p: Page) => void }) {
  const todo = pages.filter((p) => p.blocks.length);
  let done = 0;
  opts.onProgress?.({ label: 'Очистка и вставка текста', done: 0, total: todo.length });
  for (const page of todo) {
    if (opts.signal?.aborted) throw new DOMException('Отменено', 'AbortError');
    try {
      await cleanPage(page, project);
    } catch (e) {
      opts.onProgress?.({ logLine: `${page.name}: ошибка очистки — ${(e as Error).message}` });
    }
    opts.onPage?.(page);
    opts.onProgress?.({ done: ++done });
    await new Promise((r) => setTimeout(r, 0)); // даём интерфейсу обновиться
  }
}
