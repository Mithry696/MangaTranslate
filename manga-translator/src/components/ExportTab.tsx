import { useState } from 'react';
import type { Store } from './ProjectView';
import { exportProjectBackup, exportZip, type ExportOptions } from '../lib/export';
import { download, safeFileName } from '../lib/util';
import { ProgressBar, Tip, toast } from './ui';

export function ExportTab({ store }: { store: Store }) {
  const { pages, project } = store;
  const [opt, setOpt] = useState<ExportOptions>({ translated: true, clean: true, original: false, text: true, format: 'png', quality: 0.92 });
  const [prog, setProg] = useState<{ done: number; total: number } | null>(null);
  const notClean = pages.filter((p) => p.blocks.length && !p.hasClean).length;

  const go = async () => {
    setProg({ done: 0, total: pages.length });
    try {
      const blob = await exportZip(pages, project, opt, (done, total) => setProg({ done, total }));
      download(blob, `${safeFileName(project.name)}.zip`);
    } catch (e) { toast((e as Error).message, true); }
    setProg(null);
  };
  const backup = async () => {
    setProg({ done: 0, total: 1 });
    try { download(await exportProjectBackup(project, pages), `${safeFileName(project.name)}.mangaperevod.zip`); }
    catch (e) { toast((e as Error).message, true); }
    setProg(null);
  };
  const check = (k: keyof ExportOptions, label: string, hint: string) => (
    <label className="check" style={{ alignItems: 'flex-start', marginBottom: 8 }}>
      <input type="checkbox" checked={!!opt[k]} onChange={(e) => setOpt({ ...opt, [k]: e.target.checked })} style={{ marginTop: 4 }} />
      <span><b>{label}</b><br /><span className="small muted">{hint}</span></span>
    </label>
  );

  return (
    <div className="container" style={{ maxWidth: 820 }}>
      <div className="card">
        <h2>Скачать результат (ZIP)</h2>
        {notClean > 0 && <div className="notice">На {notClean} стр. ещё не выполнена очистка — на переведённых страницах останется оригинальный текст. Запустите «Очистить и вставить» на вкладке «Страницы».</div>}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {check('translated', 'Переведённые страницы', 'Очищенные страницы со вставленным переводом — папка «перевод».')}
          {check('clean', 'Чистые страницы (без текста)', 'Для ручного тайпа в Photoshop/Krita/GIMP — папка «очищено».')}
          {check('text', 'Текст отдельно', 'TXT «оригинал → перевод» по страницам, TXT только с переводом и JSON-скрипт с координатами.')}
          {check('original', 'Оригиналы', 'Исходные файлы страниц.')}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <label className="field" style={{ width: 160 }}><span>Формат изображений</span>
            <select className="input" value={opt.format} onChange={(e) => setOpt({ ...opt, format: e.target.value as 'png' })}>
              <option value="png">PNG (без потерь)</option><option value="jpeg">JPG</option><option value="webp">WEBP</option>
            </select>
          </label>
          {opt.format !== 'png' && <label className="field" style={{ width: 200 }}><span>Качество: {Math.round(opt.quality * 100)}%</span>
            <input type="range" min={0.6} max={1} step={0.01} value={opt.quality} onChange={(e) => setOpt({ ...opt, quality: +e.target.value })} />
          </label>}
        </div>
        {prog ? <ProgressBar done={prog.done} total={prog.total} /> :
          <button className="btn primary" disabled={!pages.length} onClick={go}>⬇ Скачать ZIP</button>}
      </div>

      <div className="card">
        <h2>Резервная копия проекта</h2>
        <p className="muted">Все страницы, распознанный текст, перевод, рамки и очистка в одном файле. Его можно открыть на другом компьютере
          или передать коллеге (например, переводчик → тайпер) через «Импорт проекта» на главной.</p>
        <button className="btn" disabled={!pages.length || !!prog} onClick={backup}>Сохранить копию проекта</button>
      </div>
      <Tip>Проекты хранятся только в этом браузере. Если очистить данные сайта, они пропадут — делайте резервные копии важных глав.</Tip>
    </div>
  );
}
