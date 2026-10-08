import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Glossary, GlossaryEntry, Page, Project } from '../lib/types';
import { LANG_LABELS, STATUS_LABELS } from '../lib/types';
import { deletePage, listGlossaries, listPages, putPage, putProject } from '../lib/db';
import { dropFromCache } from '../lib/image';
import { expandFiles, fitTextBoxes, importImages, runClean, runOcr, type Progress } from '../lib/pipeline';
import { translateAll } from '../lib/translate';
import { isConfigured, type Settings } from '../lib/settings';
import { usageTotals } from '../lib/llm';
import { ProgressBar, Tip, toast } from './ui';
import { Editor } from './Editor';
import { TextTab } from './TextTab';
import { GlossaryTab } from './GlossaryTab';
import { ExportTab } from './ExportTab';
import { ProjectSettings } from './ProjectSettings';

export type Tab = 'pages' | 'editor' | 'text' | 'glossary' | 'export';

export interface Store {
  project: Project;
  pages: Page[];
  glossary: GlossaryEntry[]; // проект + подключённые общие
  shared: Glossary[];
  settings: Settings;
  updateProject: (patch: Partial<Project>) => void;
  touchPage: (p: Page, immediate?: boolean) => void;
  refresh: () => void;
  setShared: (g: Glossary[]) => void;
  busy: boolean;
  run: (label: string, fn: (ctl: JobCtl) => Promise<void>) => Promise<void>;
  openSettings: () => void;
  goTab: (t: Tab, pageIndex?: number) => void;
}

export interface JobCtl {
  signal: AbortSignal;
  progress: (p: Partial<Progress> & { logLine?: string }) => void;
}

interface Job extends Progress { abort: AbortController; error?: string; finished?: boolean }

export function ProjectView({ projectId, settings, openSettings, initialProject }: { projectId: string; settings: Settings; openSettings: () => void; initialProject: Project }) {
  const [project, setProject] = useState<Project>(initialProject);
  const [pages, setPages] = useState<Page[]>([]);
  const [, setVer] = useState(0);
  const [tab, setTab] = useState<Tab>('pages');
  const [editorPage, setEditorPage] = useState(0);
  const [shared, setShared] = useState<Glossary[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const timers = useRef(new Map<string, number>());
  const refresh = useCallback(() => setVer((v) => v + 1), []);

  useEffect(() => {
    listPages(projectId).then(setPages);
    listGlossaries().then(setShared);
  }, [projectId]);

  const updateProject = useCallback((patch: Partial<Project>) => {
    setProject((p) => {
      const np = { ...p, ...patch, updatedAt: Date.now() };
      putProject(np);
      return np;
    });
  }, []);

  const touchPage = useCallback((p: Page, immediate = false) => {
    refresh();
    const t = timers.current.get(p.id);
    if (t) clearTimeout(t);
    if (immediate) { putPage(p); return; }
    timers.current.set(p.id, window.setTimeout(() => { putPage(p); timers.current.delete(p.id); }, 600));
  }, [refresh]);

  // сохраняем несохранённое при уходе со страницы
  useEffect(() => () => { timers.current.forEach((t) => clearTimeout(t)); pages.forEach((p) => putPage(p)); }, [pages]);

  const glossary = useMemo(() => {
    const extra = shared.filter((g) => project.sharedGlossaryIds.includes(g.id)).flatMap((g) => g.entries);
    return [...project.glossary, ...extra];
  }, [project.glossary, project.sharedGlossaryIds, shared]);

  const run = useCallback(async (label: string, fn: (ctl: JobCtl) => Promise<void>) => {
    const abort = new AbortController();
    const state: Job = { label, done: 0, total: 0, log: [], abort };
    setJob({ ...state });
    const progress = (p: Partial<Progress> & { logLine?: string }) => {
      if (p.label) state.label = p.label;
      if (p.done !== undefined) state.done = p.done;
      if (p.total !== undefined) state.total = p.total;
      if (p.logLine) state.log = [...state.log.slice(-200), p.logLine];
      setJob({ ...state });
    };
    try {
      await fn({ signal: abort.signal, progress });
      state.finished = true;
      setJob({ ...state });
      setTimeout(() => setJob((j) => (j && j.finished && !j.error ? null : j)), 2500);
    } catch (e) {
      const msg = (e as Error).name === 'AbortError' ? 'Остановлено пользователем' : (e as Error).message;
      state.error = msg; state.finished = true;
      setJob({ ...state });
      if ((e as Error).name !== 'AbortError') toast(msg, true);
    }
    refresh();
    updateProject({ pageCount: pages.length });
  }, [refresh, updateProject, pages.length]);

  const busy = !!job && !job.finished;
  const goTab = (t: Tab, pi?: number) => { if (pi !== undefined) setEditorPage(pi); setTab(t); };

  const store: Store = { project, pages, glossary, shared, settings, updateProject, touchPage, refresh, setShared, busy, run, openSettings, goTab };

  const blocksTotal = pages.reduce((s, p) => s + p.blocks.length, 0);
  const warnCount = pages.reduce((s, p) => s + p.blocks.filter((b) => b.warnings?.length).length, 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="tabs" role="tablist">
        <button className={'tab' + (tab === 'pages' ? ' active' : '')} onClick={() => setTab('pages')}>Страницы<span className="badge">{pages.length}</span></button>
        <button className={'tab' + (tab === 'editor' ? ' active' : '')} onClick={() => setTab('editor')} disabled={!pages.length}>Редактор</button>
        <button className={'tab' + (tab === 'text' ? ' active' : '')} onClick={() => setTab('text')}>Текст<span className="badge">{blocksTotal}</span>{warnCount > 0 && <span className="badge err">{warnCount}</span>}</button>
        <button className={'tab' + (tab === 'glossary' ? ' active' : '')} onClick={() => setTab('glossary')}>Глоссарий<span className="badge">{glossary.length}</span></button>
        <button className={'tab' + (tab === 'export' ? ' active' : '')} onClick={() => setTab('export')}>Экспорт</button>
      </div>
      {job && <JobPanel job={job} onClose={() => setJob(null)} />}
      <div className="main" style={tab === 'editor' ? { overflow: 'hidden' } : undefined}>
        {tab === 'pages' && <PagesTab store={store} setPages={setPages} />}
        {tab === 'editor' && pages.length > 0 && <Editor store={store} pageIndex={Math.min(editorPage, pages.length - 1)} setPageIndex={setEditorPage} />}
        {tab === 'text' && <TextTab store={store} />}
        {tab === 'glossary' && <GlossaryTab store={store} />}
        {tab === 'export' && <ExportTab store={store} />}
      </div>
    </div>
  );
}

function JobPanel({ job, onClose }: { job: Job; onClose: () => void }) {
  return (
    <div style={{ padding: '10px 16px', background: 'var(--panel)', borderBottom: '1px solid var(--border)' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>{job.error ? `⚠️ ${job.label}: ${job.error}` : job.finished ? `✅ ${job.label}: готово` : `${job.label}… ${job.total ? `${job.done} / ${job.total}` : ''}`}</b>
        {!job.finished ? <button className="btn small" onClick={() => job.abort.abort()}>Остановить</button> : <button className="btn small ghost" onClick={onClose}>Скрыть</button>}
      </div>
      {!job.finished && <div style={{ marginTop: 6 }}><ProgressBar done={job.done} total={job.total || 1} /></div>}
      {job.log.length > 0 && <details open={!!job.error}><summary className="small muted" style={{ cursor: 'pointer', marginTop: 4 }}>Журнал ({job.log.length})</summary><div className="log">{job.log.join('\n')}</div></details>}
    </div>
  );
}

function PagesTab({ store, setPages }: { store: Store; setPages: (p: Page[]) => void }) {
  const { project, pages, settings, busy, run } = store;
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const configured = isConfigured(settings);

  const addFiles = (files: File[]) => run('Загрузка страниц', async (ctl) => {
    const items = await expandFiles(files);
    if (!items.length) throw new Error('Не найдено изображений (поддерживаются PNG, JPG, WEBP, а также ZIP/CBZ-архивы)');
    const added = await importImages(project, pages, items, ctl.progress);
    const all = [...pages, ...added];
    setPages(all);
    store.updateProject({ pageCount: all.length, cover: project.cover || added[0]?.thumb });
    ctl.progress({ done: items.length, logLine: `Добавлено страниц: ${added.length}` });
  });

  const reorder = async (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= pages.length) return;
    const arr = [...pages];
    [arr[i], arr[j]] = [arr[j], arr[i]];
    arr.forEach((p, k) => { p.index = k; putPage(p); });
    setPages(arr);
  };
  const remove = async (p: Page) => {
    if (!confirm(`Удалить страницу «${p.name}»?`)) return;
    await deletePage(p.id); dropFromCache(p.id);
    const arr = pages.filter((x) => x !== p);
    arr.forEach((x, k) => { x.index = k; putPage(x); });
    setPages(arr);
    store.updateProject({ pageCount: arr.length });
  };
  const sortByName = () => {
    const arr = [...pages].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    arr.forEach((p, k) => { p.index = k; putPage(p); });
    setPages(arr);
  };

  const ocrDone = pages.length > 0 && pages.every((p) => p.status !== 'new' && p.status !== 'error');
  const anyBlocks = pages.some((p) => p.blocks.length);
  const trDone = anyBlocks && pages.every((p) => p.blocks.every((b) => b.skip || !b.original || b.translation));
  const cleanDone = anyBlocks && pages.every((p) => !p.blocks.length || p.hasClean);

  const needKey = () => { if (!configured) { toast('Сначала укажите API-ключи в «Настройках API»', true); store.openSettings(); return true; } return false; };

  const doOcr = (force: boolean) => { if (needKey()) return; return run('Распознавание текста', (ctl) => runOcr(pages, project, settings, { force, signal: ctl.signal, onProgress: ctl.progress, onPage: () => store.refresh() })); };
  const doTranslate = (onlyEmpty: boolean) => {
    if (needKey()) return;
    return run('Перевод', async (ctl) => {
      const n = await translateAll(pages, project, store.glossary, settings, {
        onlyEmpty, signal: ctl.signal,
        onProgress: (p) => ctl.progress({ label: p.stage, done: p.done, total: p.total }),
      });
      for (const p of pages) { if (p.blocks.some((b) => b.translation) && p.status === 'ocr') p.status = 'translated'; fitTextBoxes(p, project); await putPage(p); }
      ctl.progress({ logLine: `Переведено реплик: ${n}` });
    });
  };
  const doClean = () => run('Очистка и вставка текста', (ctl) => runClean(pages, project, { signal: ctl.signal, onProgress: ctl.progress, onPage: () => store.refresh() }));
  const doAll = () => {
    if (needKey()) return;
    return run('Полный цикл', async (ctl) => {
      await runOcr(pages, project, settings, { force: false, signal: ctl.signal, onProgress: ctl.progress, onPage: () => store.refresh() });
      const n = await translateAll(pages, project, store.glossary, settings, {
        onlyEmpty: true, signal: ctl.signal, onProgress: (p) => ctl.progress({ label: p.stage, done: p.done, total: p.total }),
      });
      ctl.progress({ logLine: `Переведено реплик: ${n}` });
      await runClean(pages, project, { signal: ctl.signal, onProgress: ctl.progress, onPage: () => store.refresh() });
      ctl.progress({ label: 'Полный цикл' });
    });
  };

  const steps = [
    { t: 'Загрузите главу', d: 'Все страницы одной главы разом — так перевод учтёт контекст.', done: pages.length > 0, action: null },
    { t: 'Распознайте текст', d: 'Модель найдёт пузыри и прочитает оригинал.', done: ocrDone, action: <button className="btn small primary" disabled={busy || !pages.length} onClick={() => doOcr(false)}>Распознать</button> },
    { t: 'Проверьте и поправьте', d: 'В «Редакторе» поправьте рамки, в «Тексте» — опечатки распознавания и порядок.', done: false, action: <button className="btn small" disabled={!anyBlocks} onClick={() => store.goTab('editor')}>Открыть редактор</button> },
    { t: 'Переведите', d: 'Вся глава одним контекстом + глоссарий.', done: trDone, action: <button className="btn small primary" disabled={busy || !anyBlocks} onClick={() => doTranslate(true)}>Перевести</button> },
    { t: 'Очистите и вставьте', d: 'Сотрём оригинал и впишем перевод. Работает без API.', done: cleanDone, action: <button className="btn small primary" disabled={busy || !anyBlocks} onClick={doClean}>Очистить и вставить</button> },
    { t: 'Доведите и скачайте', d: 'Финальная правка в редакторе и экспорт ZIP.', done: false, action: <button className="btn small" disabled={!cleanDone} onClick={() => store.goTab('export')}>К экспорту</button> },
  ];
  const current = steps.findIndex((s) => !s.done);

  return (
    <div className="container">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <div>
          <h1 style={{ marginBottom: 2 }}>{project.name}</h1>
          <div className="muted small">{LANG_LABELS[project.sourceLang]} → русский · {pages.length} стр. {usageTotals.cost > 0 && `· потрачено в этой сессии ≈ $${usageTotals.cost.toFixed(4)}`}</div>
        </div>
        <div className="btn-row">
          <button className="btn" disabled={busy || !pages.length} onClick={doAll} title="Распознать, перевести, очистить и вставить — всё подряд">⚡ Всё сразу</button>
        </div>
      </div>

      {!configured && (
        <div className="notice">Чтобы распознавать и переводить, нужен API-ключ. <button className="btn small primary" onClick={store.openSettings}>Настроить API</button> <span className="small muted">Очистку и редактор можно пробовать и без ключа.</span></div>
      )}

      <div className="steps">
        {steps.map((s, i) => (
          <div key={i} className={'step' + (s.done ? ' done' : '') + (i === current ? ' current' : '')}>
            <div className="row"><span className="num">{s.done ? '✓' : i + 1}</span><span className="title">{s.t}</span></div>
            <div className="desc">{s.d}</div>
            {s.action}
          </div>
        ))}
      </div>

      <ProjectSettings store={store} />

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Страницы</h2>
          <div className="btn-row">
            {pages.length > 1 && <button className="btn small" onClick={sortByName}>Сортировать по имени</button>}
            <button className="btn small" disabled={busy || !pages.length} onClick={() => doOcr(true)} title="Заново распознать все страницы (текущие блоки будут заменены)">Распознать заново всё</button>
            <button className="btn small" disabled={busy || !anyBlocks} onClick={() => { if (confirm('Перевести заново все реплики? Текущий перевод будет заменён.')) doTranslate(false); }}>Перевести заново всё</button>
          </div>
        </div>
        <div
          className={'dropzone' + (over ? ' over' : '')}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); addFiles(Array.from(e.dataTransfer.files)); }}
        >
          <div style={{ fontSize: 28 }}>📥</div>
          <b>Перетащите сюда страницы или нажмите, чтобы выбрать</b>
          <div className="muted small">PNG, JPG, WEBP или ZIP/CBZ-архив главы. Порядок — по именам файлов (001, 002, …).</div>
          <input ref={fileRef} type="file" multiple accept="image/*,.zip,.cbz" hidden onChange={(e) => { addFiles(Array.from(e.target.files || [])); e.target.value = ''; }} />
        </div>
        {pages.length > 0 && <div style={{ marginTop: 14 }} className="thumbs">
          {pages.map((p, i) => (
            <div key={p.id} className="thumb" onClick={() => store.goTab('editor', i)} title="Открыть в редакторе">
              {p.thumb ? <img src={p.thumb} alt={p.name} /> : <div style={{ height: 170 }} />}
              <span className="no">{i + 1}</span>
              <div className="tools" onClick={(e) => e.stopPropagation()}>
                <button title="Раньше" onClick={() => reorder(i, -1)}>↑</button>
                <button title="Позже" onClick={() => reorder(i, 1)}>↓</button>
                <button title="Удалить" onClick={() => remove(p)}>✕</button>
              </div>
              <div className="meta">
                <span className="name">{p.name}</span>
                <span className={'badge ' + (p.status === 'done' ? 'ok' : p.status === 'error' ? 'err' : p.status === 'new' ? '' : 'info')} title={p.error}>{STATUS_LABELS[p.status]}{p.blocks.length ? ` · ${p.blocks.length}` : ''}</span>
              </div>
            </div>
          ))}
        </div>}
        {pages.some((p) => p.status === 'error') && <p className="small" style={{ color: 'var(--err)', marginTop: 10 }}>Есть страницы с ошибкой — наведите на метку «Ошибка», чтобы увидеть причину, и нажмите «Распознать» ещё раз.</p>}
      </div>
      <Tip>Загружайте всю главу целиком и запускайте перевод после распознавания всех страниц: модель увидит весь диалог и правильно подберёт род, обращения и терминологию. Для вебтуна можно загружать длинные полосы как есть — они будут нарезаны автоматически.</Tip>
    </div>
  );
}
