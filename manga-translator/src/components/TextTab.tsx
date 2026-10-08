import { useState } from 'react';
import type { Store } from './ProjectView';
import { KIND_LABELS } from '../lib/types';
import { retranslateOne, checkGlossary } from '../lib/translate';
import { isConfigured } from '../lib/settings';
import { scriptText } from '../lib/export';
import { download } from '../lib/util';
import { fitTextBoxes } from '../lib/pipeline';
import { Tip, toast } from './ui';

export function TextTab({ store }: { store: Store }) {
  const { pages, project } = store;
  const [filter, setFilter] = useState<'all' | 'empty' | 'warn'>('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const total = pages.reduce((s, p) => s + p.blocks.length, 0);

  const retr = async (pageIdx: number, blockId: string) => {
    if (!isConfigured(store.settings)) { store.openSettings(); return; }
    const page = pages[pageIdx];
    const b = page.blocks.find((x) => x.id === blockId)!;
    setLoading(blockId);
    try { await retranslateOne(pages, b, project, store.glossary, store.settings); fitTextBoxes(page, project, b); store.touchPage(page, true); }
    catch (e) { toast((e as Error).message, true); }
    setLoading(null);
  };

  const move = (pageIdx: number, i: number, d: number) => {
    const page = pages[pageIdx];
    const j = i + d;
    if (j < 0 || j >= page.blocks.length) return;
    [page.blocks[i], page.blocks[j]] = [page.blocks[j], page.blocks[i]];
    store.touchPage(page);
  };

  const copyAll = async () => {
    try { await navigator.clipboard.writeText(scriptText(pages, project, true)); toast('Скопировано'); }
    catch { toast('Не удалось скопировать — используйте «Скачать TXT»', true); }
  };

  if (!total) {
    return <div className="container"><div className="card"><h2>Текст главы</h2><p className="muted">Здесь появится весь распознанный текст и перевод после шага «Распознать».</p></div></div>;
  }

  return (
    <div className="container" style={{ maxWidth: 1300 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Текст главы: оригинал и перевод</h2>
        <div className="btn-row">
          <input className="input" style={{ width: 200 }} placeholder="Поиск…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select className="input" style={{ width: 'auto' }} value={filter} onChange={(e) => setFilter(e.target.value as 'all')}>
            <option value="all">Все реплики</option>
            <option value="empty">Без перевода</option>
            <option value="warn">С предупреждениями</option>
          </select>
          <button className="btn small" onClick={copyAll}>Копировать всё</button>
          <button className="btn small" onClick={() => download(new Blob([scriptText(pages, project, true)], { type: 'text/plain;charset=utf-8' }), `${project.name}.txt`)}>Скачать TXT</button>
        </div>
      </div>
      <Tip>Исправляйте ошибки распознавания в колонке «Оригинал» <b>до</b> перевода — так перевод будет точнее. Порядок реплик меняется стрелками ↑↓: он важен для контекста. Изменения сразу видны в редакторе.</Tip>
      <div className="card" style={{ padding: 0, overflow: 'auto', maxHeight: 'calc(100vh - 260px)' }}>
        <table className="tt">
          <thead><tr><th style={{ width: 50 }}>№</th><th style={{ width: 100 }}>Тип</th><th>Оригинал</th><th>Перевод</th><th style={{ width: 110 }} /></tr></thead>
          <tbody>
            {pages.map((p, pi) => {
              const rows = p.blocks.map((b, bi) => ({ b, bi })).filter(({ b }) => {
                if (filter === 'empty' && (b.translation.trim() || b.skip)) return false;
                if (filter === 'warn' && !b.warnings?.length) return false;
                if (q && !b.original.toLowerCase().includes(q) && !b.translation.toLowerCase().includes(q)) return false;
                return true;
              });
              if (!rows.length) return null;
              return [
                <tr key={p.id} className="pagehead"><td colSpan={5}>Страница {pi + 1} · {p.name} <button className="btn small ghost" onClick={() => store.goTab('editor', pi)}>открыть в редакторе →</button></td></tr>,
                ...rows.map(({ b, bi }) => (
                  <tr key={b.id} style={b.skip ? { opacity: 0.5 } : undefined}>
                    <td>{pi + 1}.{bi + 1}</td>
                    <td className="small">
                      <select className="input" style={{ padding: '2px 4px', fontSize: 12 }} value={b.kind} onChange={(e) => { b.kind = e.target.value as typeof b.kind; store.touchPage(p); }}>
                        {Object.entries(KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                      <label className="check small" style={{ marginTop: 4 }}><input type="checkbox" checked={b.skip} onChange={(e) => { b.skip = e.target.checked; store.touchPage(p); }} />пропуск</label>
                    </td>
                    <td className="orig"><textarea value={b.original} onChange={(e) => { b.original = e.target.value; store.touchPage(p); }} /></td>
                    <td>
                      <textarea value={b.translation} onChange={(e) => {
                        b.translation = e.target.value;
                        const w = checkGlossary(b.original, b.translation, store.glossary);
                        b.warnings = w.length ? w : undefined;
                        store.touchPage(p);
                      }} onBlur={() => { fitTextBoxes(p, project, b); store.touchPage(p); }} />
                      {b.warnings?.map((w) => <div key={w} className="warnline">⚠ {w}</div>)}
                    </td>
                    <td>
                      <div className="btn-row" style={{ gap: 2 }}>
                        <button className="btn small icon" title="Выше" onClick={() => move(pi, bi, -1)}>↑</button>
                        <button className="btn small icon" title="Ниже" onClick={() => move(pi, bi, 1)}>↓</button>
                        <button className="btn small icon" title="Перевести заново с учётом контекста" disabled={loading === b.id} onClick={() => retr(pi, b.id)}>{loading === b.id ? '…' : '↻'}</button>
                      </div>
                    </td>
                  </tr>
                )),
              ];
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
