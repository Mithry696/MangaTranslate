import { useEffect, useState } from 'react';
import { Field, Modal, Tip, toast } from './ui';
import { PRESETS, providerFromPreset, saveSettings, textProvider, type PresetId, type ProviderCfg, type Settings } from '../lib/settings';
import { listModels, testProvider } from '../lib/llm';
import { deleteFont, listFonts, putFont } from '../lib/db';
import { registerCustomFonts } from '../lib/fonts';

function ProviderEditor({ kind, cfg, onChange, fallbackKey }: { kind: 'vision' | 'text'; cfg: ProviderCfg; onChange: (c: ProviderCfg) => void; fallbackKey?: string }) {
  const preset = PRESETS[cfg.preset];
  const [models, setModels] = useState<string[]>([]);
  const [showKey, setShowKey] = useState(false);
  const [status, setStatus] = useState('');
  const listId = `models-${kind}`;
  const suggestions = models.length ? models : kind === 'vision' ? preset.visionModels : preset.textModels;

  const loadModels = async () => {
    setStatus('Загружаю список…');
    try {
      const m = await listModels({ ...cfg, apiKey: cfg.apiKey || fallbackKey || '' }, kind === 'vision');
      setModels(m); setStatus(`Найдено моделей: ${m.length}. Начните вводить название в поле «Модель».`);
    } catch (e) { setStatus((e as Error).message); }
  };
  const test = async () => {
    setStatus('Проверяю…');
    try { setStatus('✅ Работает. ' + (await testProvider({ ...cfg, apiKey: cfg.apiKey || fallbackKey || '' }, kind === 'vision'))); }
    catch (e) { setStatus('❌ ' + (e as Error).message); }
  };

  return (
    <div className="card">
      <h3>{kind === 'vision' ? '1. Чтение текста с картинки (vision-модель)' : '2. Перевод (текстовая модель)'}</h3>
      <p className="muted small">
        {kind === 'vision'
          ? 'Эта модель смотрит на страницу, находит текст и распознаёт его. Нужна модель, принимающая изображения.'
          : 'Эта модель переводит весь распознанный текст главы на русский с учётом глоссария и контекста.'}
      </p>
      <div className="grid cols-2">
        <Field label="Сервис">
          <select className="input" value={cfg.preset} onChange={(e) => {
            const id = e.target.value as PresetId;
            onChange({ ...providerFromPreset(id, kind, cfg.preset === id ? cfg.apiKey : ''), jsonMode: cfg.jsonMode });
            setModels([]); setStatus('');
          }}>
            {Object.values(PRESETS).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Адрес API (base URL)">
          <input className="input" value={cfg.baseUrl} placeholder="https://…/v1" onChange={(e) => onChange({ ...cfg, baseUrl: e.target.value.trim() })} />
        </Field>
      </div>
      <p className="small muted">{preset.note} {preset.keyUrl && <>Получить ключ: <a href={preset.keyUrl} target="_blank" rel="noreferrer">{preset.keyUrl.replace('https://', '')}</a></>}</p>
      <Field label="API-ключ" hint={fallbackKey && !cfg.apiKey ? 'Пусто — будет использован ключ из блока «Чтение текста» (тот же сервис).' : undefined}>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input className="input" type={showKey ? 'text' : 'password'} value={cfg.apiKey} autoComplete="off" placeholder="sk-…"
            onChange={(e) => onChange({ ...cfg, apiKey: e.target.value.trim() })} />
          <button className="btn small" type="button" onClick={() => setShowKey(!showKey)}>{showKey ? 'Скрыть' : 'Показать'}</button>
        </div>
      </Field>
      <Field label="Модель">
        <input className="input" list={listId} value={cfg.model} onChange={(e) => onChange({ ...cfg, model: e.target.value.trim() })} />
        <datalist id={listId}>{suggestions.map((m) => <option key={m} value={m} />)}</datalist>
      </Field>
      <div className="btn-row">
        <button className="btn small" type="button" onClick={loadModels}>Загрузить список моделей</button>
        <button className="btn small" type="button" onClick={test}>Проверить подключение</button>
        <label className="check small"><input type="checkbox" checked={cfg.jsonMode} onChange={(e) => onChange({ ...cfg, jsonMode: e.target.checked })} /> JSON-режим</label>
      </div>
      {status && <p className="small" style={{ marginTop: 8, wordBreak: 'break-word' }}>{status}</p>}
    </div>
  );
}

export function SettingsModal({ settings, onChange, onClose }: { settings: Settings; onChange: (s: Settings) => void; onClose: () => void }) {
  const [s, setS] = useState(settings);
  const [fonts, setFonts] = useState<string[]>([]);
  useEffect(() => { listFonts().then((f) => setFonts(f.map((x) => x.name))); }, []);
  const save = () => { saveSettings(s); onChange(s); toast('Настройки сохранены'); onClose(); };

  const addFont = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      const name = f.name.replace(/\.(ttf|otf|woff2?)$/i, '');
      await putFont(name, await f.arrayBuffer());
    }
    await registerCustomFonts();
    setFonts((await listFonts()).map((x) => x.name));
    toast('Шрифты добавлены');
  };

  const same = s.text.baseUrl === s.vision.baseUrl;
  return (
    <Modal title="Настройки API" onClose={onClose} wide>
      <Tip title="Ключи хранятся только у вас">
        Ключи сохраняются в этом браузере (localStorage) и отправляются только напрямую выбранному сервису. На сайте нет своего сервера.
        Самый простой вариант из России — <b>OpenRouter</b>: один ключ подходит для обоих шагов. Подробнее — в «Руководстве».
      </Tip>
      <ProviderEditor kind="vision" cfg={s.vision} onChange={(vision) => setS({ ...s, vision })} />
      <ProviderEditor kind="text" cfg={s.text} onChange={(text) => setS({ ...s, text })} fallbackKey={same ? s.vision.apiKey : undefined} />
      <div className="card">
        <h3>Дополнительно</h3>
        <div className="grid cols-2">
          <Field label={`Параллельных запросов: ${s.concurrency}`} hint="Больше — быстрее, но выше риск ошибки 429 (лимит). Для бесплатных тарифов ставьте 1.">
            <input type="range" min={1} max={6} value={s.concurrency} onChange={(e) => setS({ ...s, concurrency: +e.target.value })} />
          </Field>
          <Field label={`Размер картинки для распознавания: ${s.ocrMaxSide}px`} hint="Больше — точнее мелкий текст, но дороже.">
            <input type="range" min={1024} max={2560} step={128} value={s.ocrMaxSide} onChange={(e) => setS({ ...s, ocrMaxSide: +e.target.value })} />
          </Field>
          <Field label={`Резать длинные страницы, если высота > ширины × ${s.webtoonRatio}`} hint="Для вебтунов: длинная полоса делится на куски по пустым местам.">
            <input type="range" min={1.5} max={4} step={0.1} value={s.webtoonRatio} onChange={(e) => setS({ ...s, webtoonRatio: +e.target.value })} />
          </Field>
          <Field label={`«Творческость» перевода (temperature): ${s.temperature}`} hint="0 — максимально буквально и стабильно, 0.7 — свободнее.">
            <input type="range" min={0} max={1} step={0.05} value={s.temperature} onChange={(e) => setS({ ...s, temperature: +e.target.value })} />
          </Field>
          <Field label={`Размер пачки для перевода: ${s.chunkChars} символов`} hint="Сколько текста отправлять за один запрос. Больше — лучше контекст.">
            <input type="range" min={1000} max={12000} step={500} value={s.chunkChars} onChange={(e) => setS({ ...s, chunkChars: +e.target.value })} />
          </Field>
        </div>
      </div>
      <div className="card">
        <h3>Свои шрифты</h3>
        <p className="small muted">Загрузите файлы .ttf / .otf / .woff2 (например, ваш любимый шрифт для тайпа с кириллицей). Они сохранятся в браузере и появятся в списке шрифтов редактора.</p>
        <div className="btn-row">
          <label className="btn small">Добавить шрифт…<input type="file" accept=".ttf,.otf,.woff,.woff2" multiple hidden onChange={(e) => addFont(e.target.files)} /></label>
          {fonts.map((f) => (
            <span key={f} className="badge">{f} <button className="btn ghost small" style={{ padding: '0 4px' }} onClick={async () => { await deleteFont(f); setFonts(fonts.filter((x) => x !== f)); }}>✕</button></span>
          ))}
        </div>
      </div>
      <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
        <span className="muted small">{textProvider(s).apiKey ? '' : 'Ключ для перевода не указан. '}</span>
        <button className="btn" onClick={onClose}>Отмена</button>
        <button className="btn primary" onClick={save}>Сохранить</button>
      </div>
    </Modal>
  );
}
