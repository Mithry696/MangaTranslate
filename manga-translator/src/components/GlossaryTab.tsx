import { useState } from 'react';
import type { Store } from './ProjectView';
import type { Glossary, GlossaryEntry } from '../lib/types';
import { deleteGlossary, putGlossary } from '../lib/db';
import { suggestTerms, type TermSuggestion } from '../lib/translate';
import { isConfigured } from '../lib/settings';
import { download, uid } from '../lib/util';
import { Modal, Tip, toast } from './ui';

function parseGlossaryFile(text: string, name: string): GlossaryEntry[] {
  if (/\.json$/i.test(name) || text.trim().startsWith('[') || text.trim().startsWith('{')) {
    const j = JSON.parse(text);
    const arr = Array.isArray(j) ? j : j.entries || [];
    return arr.map((e: Partial<GlossaryEntry>) => ({ id: uid('g'), src: String(e.src || ''), dst: String(e.dst || ''), note: String(e.note || '') })).filter((e: GlossaryEntry) => e.src);
  }
  // CSV/TSV: оригинал;перевод;пометка
  return text.split(/\r?\n/).map((line) => line.split(/\t|;|,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((s) => s.trim().replace(/^"|"$/g, '')))
    .filter((c) => c[0] && c[1] && !/^(src|оригинал)$/i.test(c[0]))
    .map((c) => ({ id: uid('g'), src: c[0], dst: c[1], note: c[2] || '' }));
}

function toCsv(entries: GlossaryEntry[]) {
  const esc = (s: string) => (/[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return 'оригинал;перевод;пометка\n' + entries.map((e) => [e.src, e.dst, e.note].map(esc).join(';')).join('\n');
}

function EntriesTable({ entries, onChange }: { entries: GlossaryEntry[]; onChange: (e: GlossaryEntry[]) => void }) {
  const set = (i: number, patch: Partial<GlossaryEntry>) => onChange(entries.map((e, k) => (k === i ? { ...e, ...patch } : e)));
  return (
    <table className="tt">
      <thead><tr><th>Оригинал</th><th>Перевод (всегда так)</th><th>Пометка</th><th style={{ width: 40 }} /></tr></thead>
      <tbody>
        {entries.map((e, i) => (
          <tr key={e.id}>
            <td><input className="input" value={e.src} onChange={(ev) => set(i, { src: ev.target.value })} placeholder="ナルミ / 나루미 / Narumi" /></td>
            <td><input className="input" value={e.dst} onChange={(ev) => set(i, { dst: ev.target.value })} placeholder="Наруми" /></td>
            <td><input className="input" value={e.note} onChange={(ev) => set(i, { note: ev.target.value })} placeholder="имя, ж.р." /></td>
            <td><button className="btn small ghost danger" onClick={() => onChange(entries.filter((_, k) => k !== i))}>✕</button></td>
          </tr>
        ))}
        {!entries.length && <tr><td colSpan={4} className="muted small">Пока пусто.</td></tr>}
      </tbody>
    </table>
  );
}

export function GlossaryTab({ store }: { store: Store }) {
  const { project, shared, updateProject } = store;
  const [suggest, setSuggest] = useState<(TermSuggestion & { on: boolean })[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [editShared, setEditShared] = useState<Glossary | null>(null);

  const setEntries = (glossary: GlossaryEntry[]) => updateProject({ glossary });
  const add = () => setEntries([...project.glossary, { id: uid('g'), src: '', dst: '', note: '' }]);

  const importFile = async (f: File | undefined, target: 'project' | Glossary) => {
    if (!f) return;
    try {
      const entries = parseGlossaryFile(await f.text(), f.name);
      if (target === 'project') setEntries([...project.glossary, ...entries]);
      else setEditShared({ ...target, entries: [...target.entries, ...entries] });
      toast(`Импортировано терминов: ${entries.length}`);
    } catch (e) { toast('Не удалось прочитать файл: ' + (e as Error).message, true); }
  };

  const runSuggest = async () => {
    if (!isConfigured(store.settings)) { store.openSettings(); return; }
    setLoading(true);
    try {
      const t = await suggestTerms(store.pages, project, store.glossary, store.settings);
      setSuggest(t.map((x) => ({ ...x, on: true })));
      if (!t.length) toast('Новых терминов не найдено');
    } catch (e) { toast((e as Error).message, true); }
    setLoading(false);
  };

  const saveShared = async (g: Glossary) => {
    const ng = { ...g, entries: g.entries.filter((e) => e.src.trim()), updatedAt: Date.now() };
    await putGlossary(ng);
    store.setShared([...shared.filter((x) => x.id !== g.id), ng].sort((a, b) => a.name.localeCompare(b.name)));
    setEditShared(null);
  };

  return (
    <div className="container">
      <Tip title="Как работает глоссарий">
        Термины, найденные в тексте главы, передаются модели вместе с каждым запросом перевода с требованием переводить их строго указанным вариантом.
        После перевода сайт проверяет, что термин действительно использован (с учётом падежных окончаний), и при нарушении просит модель исправить строку.
        Оставшиеся нарушения подсвечиваются красным во вкладке «Текст».
      </Tip>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Глоссарий проекта</h2>
          <div className="btn-row">
            <button className="btn small primary" onClick={add}>＋ Термин</button>
            <button className="btn small" onClick={runSuggest} disabled={loading || !store.pages.some((p) => p.blocks.length)} title="Модель найдёт имена и термины в распознанном тексте">{loading ? 'Ищу…' : '✨ Предложить из текста'}</button>
            <label className="btn small">Импорт CSV/JSON<input type="file" accept=".csv,.tsv,.txt,.json" hidden onChange={(e) => { importFile(e.target.files?.[0], 'project'); e.target.value = ''; }} /></label>
            <button className="btn small" onClick={() => download(new Blob([toCsv(project.glossary)], { type: 'text/csv;charset=utf-8' }), `глоссарий_${project.name}.csv`)}>Экспорт CSV</button>
            <button className="btn small" disabled={!project.glossary.length} title="Сохранить как общий глоссарий, чтобы подключать в другие проекты (например, к следующим главам)" onClick={async () => {
              const name = prompt('Название общего глоссария', project.name);
              if (!name) return;
              await saveShared({ id: uid('gl'), name, entries: project.glossary.map((e) => ({ ...e, id: uid('g') })), updatedAt: Date.now() });
              toast('Сохранено в общие глоссарии');
            }}>Сохранить как общий</button>
          </div>
        </div>
        <EntriesTable entries={project.glossary} onChange={setEntries} />
        <p className="small muted" style={{ marginTop: 8 }}>Формат CSV: <code>оригинал;перевод;пометка</code>. Пометка помогает модели: «имя, ж.р.», «не склоняется», «техника меча».</p>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Общие глоссарии</h2>
          <button className="btn small" onClick={() => setEditShared({ id: uid('gl'), name: 'Новый глоссарий', entries: [], updatedAt: Date.now() })}>＋ Создать</button>
        </div>
        <p className="small muted">Общие глоссарии хранятся отдельно от проектов: один глоссарий тайтла можно подключать к каждой новой главе.</p>
        {!shared.length && <p className="muted small">Пока нет общих глоссариев.</p>}
        {shared.map((g) => (
          <div key={g.id} className="row" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
            <label className="check" style={{ flex: 1 }}>
              <input type="checkbox" checked={project.sharedGlossaryIds.includes(g.id)} onChange={(e) => updateProject({
                sharedGlossaryIds: e.target.checked ? [...project.sharedGlossaryIds, g.id] : project.sharedGlossaryIds.filter((x) => x !== g.id),
              })} />
              <b>{g.name}</b> <span className="muted small">{g.entries.length} терм.</span>
            </label>
            <button className="btn small" onClick={() => setEditShared(g)}>Изменить</button>
            <button className="btn small ghost danger" onClick={async () => {
              if (!confirm(`Удалить глоссарий «${g.name}»?`)) return;
              await deleteGlossary(g.id);
              store.setShared(shared.filter((x) => x.id !== g.id));
              updateProject({ sharedGlossaryIds: project.sharedGlossaryIds.filter((x) => x !== g.id) });
            }}>✕</button>
          </div>
        ))}
      </div>

      {suggest && (
        <Modal title="Предложенные термины" onClose={() => setSuggest(null)}>
          <p className="small muted">Отметьте нужные и при необходимости поправьте перевод.</p>
          <table className="tt">
            <thead><tr><th /><th>Оригинал</th><th>Перевод</th><th>Пометка</th></tr></thead>
            <tbody>
              {suggest.map((t, i) => (
                <tr key={i}>
                  <td><input type="checkbox" checked={t.on} onChange={(e) => setSuggest(suggest.map((x, k) => (k === i ? { ...x, on: e.target.checked } : x)))} /></td>
                  <td>{t.src}</td>
                  <td><input className="input" value={t.dst} onChange={(e) => setSuggest(suggest.map((x, k) => (k === i ? { ...x, dst: e.target.value } : x)))} /></td>
                  <td className="small muted">{t.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn" onClick={() => setSuggest(null)}>Отмена</button>
            <button className="btn primary" onClick={() => {
              const add = suggest.filter((t) => t.on).map((t) => ({ id: uid('g'), src: t.src, dst: t.dst, note: t.note }));
              setEntries([...project.glossary, ...add]);
              setSuggest(null);
              toast(`Добавлено терминов: ${add.length}`);
            }}>Добавить отмеченные</button>
          </div>
        </Modal>
      )}

      {editShared && (
        <Modal title="Общий глоссарий" onClose={() => setEditShared(null)} wide>
          <label className="field"><span>Название</span><input className="input" value={editShared.name} onChange={(e) => setEditShared({ ...editShared, name: e.target.value })} /></label>
          <div className="btn-row" style={{ marginBottom: 10 }}>
            <button className="btn small" onClick={() => setEditShared({ ...editShared, entries: [...editShared.entries, { id: uid('g'), src: '', dst: '', note: '' }] })}>＋ Термин</button>
            <label className="btn small">Импорт CSV/JSON<input type="file" accept=".csv,.tsv,.txt,.json" hidden onChange={(e) => { importFile(e.target.files?.[0], editShared); e.target.value = ''; }} /></label>
            <button className="btn small" onClick={() => download(new Blob([toCsv(editShared.entries)], { type: 'text/csv;charset=utf-8' }), `${editShared.name}.csv`)}>Экспорт CSV</button>
          </div>
          <EntriesTable entries={editShared.entries} onChange={(entries) => setEditShared({ ...editShared, entries })} />
          <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn" onClick={() => setEditShared(null)}>Отмена</button>
            <button className="btn primary" onClick={() => saveShared(editShared)}>Сохранить</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
