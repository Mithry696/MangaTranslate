import { useEffect, useState } from 'react';
import type { Project, SourceLang } from '../lib/types';
import { DEFAULT_STYLE, LANG_LABELS } from '../lib/types';
import { deleteProject, listProjects, putBlob, putPage, putProject, storageEstimate } from '../lib/db';
import { importProjectBackup } from '../lib/export';
import { buildDemo } from '../lib/demo';
import { blobToCanvas, thumbnail, setPageCanvas } from '../lib/image';
import { cleanPage } from '../lib/pipeline';
import { isConfigured, type Settings } from '../lib/settings';
import { uid } from '../lib/util';
import { Field, Modal, Tip, toast } from './ui';

export function Home({ open, settings, openSettings, openGuide }: { open: (p: Project) => void; settings: Settings; openSettings: () => void; openGuide: () => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [usage, setUsage] = useState('');
  const [loading, setLoading] = useState('');

  const reload = () => listProjects().then(setProjects);
  useEffect(() => {
    reload();
    storageEstimate().then((e) => { if (e?.usage) setUsage(`Занято в браузере: ${(e.usage / 1048576).toFixed(1)} МБ`); });
  }, []);

  const openDemo = async () => {
    setLoading('Создаю демо…');
    try {
      const { project, pages } = await buildDemo();
      for (let i = 0; i < pages.length; i++) {
        const d = pages[i];
        const canvas = await blobToCanvas(d.blob);
        const page = {
          id: uid('p'), projectId: project.id, index: i, name: d.name, width: canvas.width, height: canvas.height,
          blocks: d.blocks, status: 'translated' as const, hasClean: false, thumb: thumbnail(canvas),
        };
        await putBlob(page.id + ':orig', d.blob);
        await setPageCanvas(page.id, 'orig', canvas, false);
        await cleanPage(page, project);
        page.thumb = page.thumb || '';
        await putPage(page);
        if (i === 0) project.cover = page.thumb;
      }
      await putProject(project);
      open(project);
    } catch (e) { toast((e as Error).message, true); }
    setLoading('');
  };

  const importBackup = async (f?: File) => {
    if (!f) return;
    setLoading('Импортирую…');
    try { const p = await importProjectBackup(f); toast('Проект импортирован'); open(p); }
    catch (e) { toast((e as Error).message, true); }
    setLoading('');
  };

  return (
    <div className="container">
      <div className="card" style={{ background: 'linear-gradient(135deg, var(--accent-2), var(--panel))', marginBottom: 18 }}>
        <h1>Перевод манги, манхвы и комиксов на русский</h1>
        <p style={{ maxWidth: 760 }}>Загрузите главу — сайт найдёт текст, переведёт всю главу с учётом контекста и вашего глоссария, сотрёт оригинал и впишет перевод.
          Всё работает в браузере, нужен только ваш API-ключ недорогой нейросети.</p>
        <div className="btn-row">
          <button className="btn primary" onClick={() => setCreating(true)}>＋ Новый проект</button>
          <button className="btn" onClick={openDemo} disabled={!!loading}>Открыть демо (без ключа)</button>
          {!isConfigured(settings) && <button className="btn" onClick={openSettings}>🔑 Настроить API</button>}
          <button className="btn ghost" onClick={openGuide}>📖 Руководство</button>
          <label className="btn ghost">Импорт проекта…<input type="file" accept=".zip" hidden onChange={(e) => { importBackup(e.target.files?.[0]); e.target.value = ''; }} /></label>
          {loading && <span className="muted small">{loading}</span>}
        </div>
      </div>

      <h2>Мои проекты</h2>
      {projects && !projects.length && (
        <Tip title="С чего начать">Создайте проект для одной главы, загрузите все её страницы и следуйте шагам на странице проекта. Если ключа пока нет — откройте демо, чтобы посмотреть, как работает очистка, вставка текста и редактор.</Tip>
      )}
      <div className="projects">
        {projects?.map((p) => (
          <div key={p.id} className="card project-card" onClick={() => open(p)}>
            <div className="cover" style={{ backgroundImage: p.cover ? `url(${p.cover})` : undefined }} />
            <div className="body">
              <b>{p.name}</b>
              <div className="muted small">{LANG_LABELS[p.sourceLang]} · {p.pageCount} стр.</div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="muted small">{new Date(p.updatedAt).toLocaleDateString('ru-RU')}</span>
                <button className="btn small ghost danger" onClick={async (e) => {
                  e.stopPropagation();
                  if (!confirm(`Удалить проект «${p.name}» со всеми страницами?`)) return;
                  await deleteProject(p.id); reload();
                }}>Удалить</button>
              </div>
            </div>
          </div>
        ))}
      </div>
      {usage && <p className="muted small" style={{ marginTop: 16 }}>{usage}</p>}
      {creating && <NewProject onClose={() => setCreating(false)} onCreate={async (p) => { await putProject(p); setCreating(false); open(p); }} />}
    </div>
  );
}

function NewProject({ onClose, onCreate }: { onClose: () => void; onCreate: (p: Project) => void }) {
  const [name, setName] = useState('');
  const [lang, setLang] = useState<SourceLang>('ja');
  const [format, setFormat] = useState<'auto' | 'manga' | 'webtoon'>('auto');
  const create = () => onCreate({
    id: uid('pr'), name: name.trim() || 'Без названия', createdAt: Date.now(), updatedAt: Date.now(),
    sourceLang: lang, direction: 'auto', format, notes: '', honorifics: 'keep', sfx: 'translate',
    glossary: [], sharedGlossaryIds: [], style: { ...DEFAULT_STYLE }, pageCount: 0,
  });
  return (
    <Modal title="Новый проект" onClose={onClose}>
      <Field label="Название (например, «Тайтл — глава 12»)">
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
      </Field>
      <div className="mini-grid">
        <Field label="Язык оригинала">
          <select className="input" value={lang} onChange={(e) => setLang(e.target.value as SourceLang)}>
            {Object.entries(LANG_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Формат">
          <select className="input" value={format} onChange={(e) => setFormat(e.target.value as 'auto')}>
            <option value="auto">Авто</option>
            <option value="manga">Манга / комикс</option>
            <option value="webtoon">Вебтун / манхва</option>
          </select>
        </Field>
      </div>
      <Tip>Один проект = одна глава. Так перевод получит весь контекст главы, а общий глоссарий тайтла можно подключать к каждому проекту.</Tip>
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Отмена</button>
        <button className="btn primary" onClick={create}>Создать</button>
      </div>
    </Modal>
  );
}
