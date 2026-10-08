// Контекстный перевод всей главы сразу с учётом глоссария
import type { Block, GlossaryEntry, Page, Project } from './types';
import { LANG_LABELS } from './types';
import { chat, parseJsonLoose } from './llm';
import { textProvider, type Settings } from './settings';
import { isCJK, normRu } from './util';

export interface Line { key: string; pageNo: number; block: Block }

export function collectLines(pages: Page[], onlyEmpty = false): Line[] {
  const lines: Line[] = [];
  pages.forEach((p, pi) => {
    p.blocks.forEach((b, bi) => {
      if (b.skip || !b.original.trim()) return;
      if (onlyEmpty && b.translation.trim()) return;
      lines.push({ key: `${pi + 1}.${bi + 1}`, pageNo: pi + 1, block: b });
    });
  });
  return lines;
}

/** Термины глоссария, встречающиеся в тексте */
export function relevantTerms(glossary: GlossaryEntry[], text: string): GlossaryEntry[] {
  const t = text.toLowerCase();
  return glossary.filter((g) => g.src.trim() && t.includes(g.src.trim().toLowerCase()));
}

function systemPrompt(p: Project) {
  const hon = p.honorifics === 'keep'
    ? 'Именные суффиксы (-сан, -кун, -тян, -сэмпай, -ним, -ши и т.п.) СОХРАНЯЙ в русской транскрипции через дефис.'
    : 'Именные суффиксы адаптируй по смыслу (уважительное обращение, «братик», «сестрёнка», по имени и т.п.), не оставляй их транслитом.';
  const sfx = p.sfx === 'translate'
    ? 'Звуковые эффекты (kind = sfx) переводи короткими русскими звукоподражаниями (БАХ, ШУРХ, ТУК-ТУК).'
    : 'Звуковые эффекты (kind = sfx) не переводи — верни пустую строку.';
  return `Ты — опытный переводчик комиксов (манга, манхва, маньхуа) на русский язык.
Переводишь с языка: ${LANG_LABELS[p.sourceLang]}.

Правила:
- Пиши живым, естественным разговорным русским языком, как в хорошем литературном переводе. Сохраняй характер речи персонажей, тон, юмор, грубость.
- Учитывай контекст всей главы: кто говорит, к кому обращается, пол персонажей (глаголы прошедшего времени!), ты/вы.
- Реплики должны помещаться в пузыри: переводи ёмко, без лишних слов и пояснений.
- ${hon}
- ${sfx}
- Термины из глоссария переводи СТРОГО указанным вариантом (склонять по падежам можно, заменять синонимами — нельзя).
- Имена, не указанные в глоссарии, транскрибируй по общепринятым системам (японский — Поливанов, корейский — Концевич, китайский — Палладий).
- Не добавляй примечаний, кавычек вокруг реплики и пояснений переводчика.
- Если строка — обрывок фразы, продолженной в следующем пузыре, переводи так, чтобы при чтении подряд получалась цельная фраза.

Ответ — ТОЛЬКО JSON: {"translations":[{"id":"...","text":"..."}]} — ровно по одному элементу на каждый id из входных данных.`;
}

function glossaryText(terms: GlossaryEntry[]) {
  if (!terms.length) return '';
  return 'ГЛОССАРИЙ (обязателен):\n' + terms.map((g) => `- ${g.src} → ${g.dst}${g.note ? ` (${g.note})` : ''}`).join('\n') + '\n\n';
}

function chunkLines(lines: Line[], maxChars: number): Line[][] {
  const chunks: Line[][] = [];
  let cur: Line[] = [], size = 0;
  for (const l of lines) {
    const len = l.block.original.length + 30;
    if (cur.length && (size + len > maxChars || cur.length >= 120)) { chunks.push(cur); cur = []; size = 0; }
    cur.push(l); size += len;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

async function requestTranslations(settings: Settings, project: Project, glossary: GlossaryEntry[],
  lines: Line[], context: Line[], signal?: AbortSignal, extraInstruction = ''): Promise<Map<string, string>> {
  const allText = lines.map((l) => l.block.original).join('\n');
  const terms = relevantTerms(glossary, allText);
  let user = '';
  if (project.notes.trim()) user += `ЗАМЕТКИ О ПРОЕКТЕ (персонажи, сеттинг):\n${project.notes.trim()}\n\n`;
  user += glossaryText(terms);
  if (context.length) {
    user += 'ПРЕДЫДУЩИЕ РЕПЛИКИ (уже переведены, только для контекста):\n' +
      context.map((l) => `[стр. ${l.pageNo}] ${l.block.original} → ${l.block.translation}`).join('\n') + '\n\n';
  }
  if (extraInstruction) user += extraInstruction + '\n\n';
  user += 'ПЕРЕВЕДИ (id, номер страницы, тип, текст):\n' + JSON.stringify(
    lines.map((l) => ({ id: l.key, page: l.pageNo, kind: l.block.kind, text: l.block.original })), null, 0);

  const res = await chat(textProvider(settings), [
    { role: 'system', content: systemPrompt(project) },
    { role: 'user', content: user },
  ], { json: true, temperature: settings.temperature, signal, maxTokens: 8000 });
  const parsed = parseJsonLoose<{ translations?: { id: string; text: string }[] } | { id: string; text: string }[]>(res);
  const arr = Array.isArray(parsed) ? parsed : parsed.translations || [];
  const map = new Map<string, string>();
  for (const t of arr) if (t && t.id != null) map.set(String(t.id), String(t.text ?? '').trim());
  return map;
}

/** Проверка, что каждый нужный термин глоссария есть в переводе (с учётом окончаний) */
export function checkGlossary(original: string, translation: string, glossary: GlossaryEntry[]): string[] {
  const tr = normRu(translation);
  const problems: string[] = [];
  for (const g of relevantTerms(glossary, original)) {
    if (!g.dst.trim()) continue;
    const words = normRu(g.dst).split(/[\s-]+/).filter(Boolean);
    const ok = words.every((w) => {
      const stem = w.length > 4 ? w.slice(0, w.length - 2) : w.length > 3 ? w.slice(0, w.length - 1) : w;
      return tr.includes(stem);
    });
    if (!ok) problems.push(`Глоссарий: «${g.src}» должно быть «${g.dst}»`);
  }
  return problems;
}

export interface TranslateProgress { done: number; total: number; stage: string }

/**
 * Перевод всех строк проекта. Строки идут кусками по порядку, каждому куску передаётся
 * хвост уже переведённого текста. После перевода — проверка глоссария и одна попытка исправления.
 */
export async function translateAll(pages: Page[], project: Project, glossary: GlossaryEntry[], settings: Settings,
  opts: { onlyEmpty: boolean; signal?: AbortSignal; onProgress?: (p: TranslateProgress) => void }): Promise<number> {
  const all = collectLines(pages);
  const todo = opts.onlyEmpty ? all.filter((l) => !l.block.translation.trim()) : all;
  if (!todo.length) return 0;
  const chunks = chunkLines(todo, settings.chunkChars);
  let done = 0;
  for (const chunk of chunks) {
    opts.onProgress?.({ done, total: todo.length, stage: 'Перевод' });
    const firstIdx = all.indexOf(chunk[0]);
    const context = all.slice(Math.max(0, firstIdx - 12), firstIdx).filter((l) => l.block.translation.trim());
    let map = await requestTranslations(settings, project, glossary, chunk, context, opts.signal);
    // пропущенные строки — дозапрос
    const missing = chunk.filter((l) => !map.has(l.key));
    if (missing.length) {
      const m2 = await requestTranslations(settings, project, glossary, missing, context, opts.signal);
      map = new Map([...map, ...m2]);
    }
    for (const l of chunk) {
      const t = map.get(l.key);
      if (t !== undefined) l.block.translation = t;
    }
    done += chunk.length;
  }

  // проверка глоссария и исправление
  opts.onProgress?.({ done, total: todo.length, stage: 'Проверка глоссария' });
  const bad = todo.filter((l) => checkGlossary(l.block.original, l.block.translation, glossary).length);
  if (bad.length) {
    const instr = 'ВНИМАНИЕ: в прошлой попытке эти реплики нарушили глоссарий. Переведи их заново, обязательно используя термины из глоссария.';
    const map = await requestTranslations(settings, project, glossary, bad, [], opts.signal, instr);
    for (const l of bad) { const t = map.get(l.key); if (t) l.block.translation = t; }
  }
  for (const l of todo) {
    const w = checkGlossary(l.block.original, l.block.translation, glossary);
    l.block.warnings = w.length ? w : undefined;
  }
  return todo.length;
}

/** Перевод одной реплики заново (с соседними строками для контекста) */
export async function retranslateOne(pages: Page[], block: Block, project: Project, glossary: GlossaryEntry[], settings: Settings, hint = '') {
  const all = collectLines(pages);
  const idx = all.findIndex((l) => l.block.id === block.id);
  if (idx < 0) return;
  const context = all.slice(Math.max(0, idx - 8), idx).filter((l) => l.block.translation.trim());
  const instr = hint ? `Пожелание к переводу: ${hint}` : 'Предложи другой, более удачный вариант перевода.';
  const map = await requestTranslations(settings, project, glossary, [all[idx]], context, undefined, instr);
  const t = map.get(all[idx].key);
  if (t !== undefined) {
    block.translation = t;
    const w = checkGlossary(block.original, t, glossary);
    block.warnings = w.length ? w : undefined;
  }
}

export interface TermSuggestion { src: string; dst: string; note: string }

/** Поиск имён и терминов для глоссария по всему тексту главы */
export async function suggestTerms(pages: Page[], project: Project, glossary: GlossaryEntry[], settings: Settings, signal?: AbortSignal): Promise<TermSuggestion[]> {
  const text = collectLines(pages).map((l) => l.block.original).join('\n').slice(0, 20000);
  if (!text.trim()) return [];
  const known = new Set(glossary.map((g) => g.src.trim().toLowerCase()));
  const res = await chat(textProvider(settings), [
    { role: 'system', content: 'Ты помогаешь переводчику комиксов составить глоссарий.' },
    {
      role: 'user', content: `Язык оригинала: ${LANG_LABELS[project.sourceLang]}.
Найди в тексте имена персонажей, названия мест, организаций, техник/приёмов, титулы и повторяющиеся особые термины.
Для каждого предложи русский перевод (имена — по Поливанову для японского, Концевичу для корейского, Палладию для китайского) и короткую пометку (например «имя, ж.р.», «техника»).
Не включай обычные слова. Уже есть в глоссарии: ${[...known].join(', ') || 'ничего'}.
Ответ — ТОЛЬКО JSON: {"terms":[{"src":"...","dst":"...","note":"..."}]}

ТЕКСТ:
${text}`,
    },
  ], { json: true, temperature: 0.2, signal, maxTokens: 4000 });
  const parsed = parseJsonLoose<{ terms?: TermSuggestion[] }>(res);
  return (parsed.terms || [])
    .filter((t) => t && t.src && t.dst && !known.has(String(t.src).trim().toLowerCase()))
    .map((t) => ({ src: String(t.src).trim(), dst: String(t.dst).trim(), note: String(t.note || '').trim() }))
    // термин должен реально встречаться в тексте
    .filter((t) => (isCJK(t.src) ? text.includes(t.src) : text.toLowerCase().includes(t.src.toLowerCase())));
}
