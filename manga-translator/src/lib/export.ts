// Экспорт результатов в ZIP и резервные копии проекта
import JSZip from 'jszip';
import type { Page, Project } from './types';
import { KIND_LABELS } from './types';
import { getBlob, putBlob, putPage, putProject } from './db';
import { canvasToBlob, getPageCanvas } from './image';
import { renderPage } from './render';
import { pad, uid } from './util';

export interface ExportOptions {
  translated: boolean;
  clean: boolean;
  original: boolean;
  text: boolean;
  format: 'png' | 'jpeg' | 'webp';
  quality: number;
}

export function scriptText(pages: Page[], project: Project, withOriginal = true) {
  const out: string[] = [`${project.name}`, ''];
  pages.forEach((p, pi) => {
    out.push(`=== Страница ${pi + 1} (${p.name}) ===`);
    p.blocks.forEach((b, bi) => {
      if (b.skip && !b.original) return;
      const tag = b.kind !== 'speech' ? ` [${KIND_LABELS[b.kind]}]` : '';
      if (withOriginal) {
        out.push(`${bi + 1}.${tag} ${b.original}`);
        out.push(`   → ${b.translation || '(нет перевода)'}`);
      } else if (b.translation) {
        out.push(`${bi + 1}.${tag} ${b.translation}`);
      }
    });
    out.push('');
  });
  return out.join('\n');
}

export async function exportZip(pages: Page[], project: Project, opt: ExportOptions, onProgress?: (done: number, total: number) => void): Promise<Blob> {
  const zip = new JSZip();
  const mime = `image/${opt.format}`;
  const ext = opt.format === 'jpeg' ? 'jpg' : opt.format;
  let done = 0;
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const base = pad(i + 1);
    if (opt.translated) {
      const c = await renderPage(p, project);
      zip.file(`перевод/${base}.${ext}`, await canvasToBlob(c, mime, opt.quality));
    }
    if (opt.clean) {
      const c = (await getPageCanvas(p.id, 'clean')) || (await getPageCanvas(p.id, 'orig'));
      if (c) zip.file(`очищено/${base}.${ext}`, await canvasToBlob(c, mime, opt.quality));
    }
    if (opt.original) {
      const b = await getBlob(p.id + ':orig');
      if (b) zip.file(`оригинал/${base}_${p.name}`, b);
    }
    onProgress?.(++done, pages.length);
  }
  if (opt.text) {
    zip.file('текст/перевод_и_оригинал.txt', scriptText(pages, project, true));
    zip.file('текст/только_перевод.txt', scriptText(pages, project, false));
    zip.file('текст/скрипт.json', JSON.stringify(pages.map((p, i) => ({
      page: i + 1, file: p.name,
      blocks: p.blocks.map((b, j) => ({ n: j + 1, kind: b.kind, original: b.original, translation: b.translation, box: b.box })),
    })), null, 2));
  }
  return zip.generateAsync({ type: 'blob', compression: 'STORE' });
}

/** Полная резервная копия проекта (изображения + разметка) — чтобы перенести на другой компьютер или передать коллеге */
export async function exportProjectBackup(project: Project, pages: Page[]): Promise<Blob> {
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify({ format: 'mangaperevod-project', version: 1, project, pages }, null, 1));
  for (const p of pages) {
    const o = await getBlob(p.id + ':orig');
    if (o) zip.file(`images/${p.id}.orig`, o);
    const c = await getBlob(p.id + ':clean');
    if (c) zip.file(`images/${p.id}.clean`, c);
  }
  return zip.generateAsync({ type: 'blob' });
}

export async function importProjectBackup(file: File): Promise<Project> {
  const zip = await JSZip.loadAsync(file);
  const meta = zip.file('project.json');
  if (!meta) throw new Error('Это не резервная копия проекта (нет project.json)');
  const data = JSON.parse(await meta.async('string'));
  if (data.format !== 'mangaperevod-project') throw new Error('Неизвестный формат файла');
  const project: Project = { ...data.project, id: uid('pr'), name: data.project.name + ' (импорт)', updatedAt: Date.now() };
  for (const old of data.pages as Page[]) {
    const page: Page = { ...old, id: uid('p'), projectId: project.id };
    const o = zip.file(`images/${old.id}.orig`);
    if (o) await putBlob(page.id + ':orig', new Blob([await o.async('arraybuffer')]));
    const c = zip.file(`images/${old.id}.clean`);
    if (c) await putBlob(page.id + ':clean', new Blob([await c.async('arraybuffer')], { type: 'image/png' }));
    await putPage(page);
  }
  await putProject(project);
  return project;
}
