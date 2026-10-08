import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Block, BlockKind, Box, CleanMode, Page, TextStyle } from '../lib/types';
import { CLEAN_LABELS, KIND_LABELS, SFX_STYLE } from '../lib/types';
import type { Store } from './ProjectView';
import { cloneCanvas, ctx2d, getCleanOrOrig, getPageCanvas, rgbToHex, setPageCanvas, type Canvas } from '../lib/image';
import { renderPage } from '../lib/render';
import { cleanPage, fitTextBoxes, recleanBlock } from '../lib/pipeline';
import { newBlock, ocrPage } from '../lib/ocr';
import { retranslateOne } from '../lib/translate';
import { resolveStyle } from '../lib/typeset';
import { allFontNames } from '../lib/fonts';
import { isConfigured } from '../lib/settings';
import { Field, Tip, toast } from './ui';

type View = 'orig' | 'clean' | 'final';
type Tool = 'select' | 'add' | 'brush' | 'restore' | 'pick';

interface Undo { pageId: string; blocks: string; clean: Canvas | null }

export function Editor({ store, pageIndex, setPageIndex }: { store: Store; pageIndex: number; setPageIndex: (i: number) => void }) {
  const { pages, project } = store;
  const page = pages[pageIndex];
  const [view, setView] = useState<View>(page.hasClean ? 'final' : 'orig');
  const [tool, setTool] = useState<Tool>('select');
  const [sel, setSel] = useState<string | null>(null);
  const [zoom, setZoom] = useState<'fit' | number>('fit');
  const [brush, setBrush] = useState(24);
  const [brushColor, setBrushColor] = useState('#ffffff');
  const [cleanVer, setCleanVer] = useState(0);
  const [vpW, setVpW] = useState(800);
  const [drawRect, setDrawRect] = useState<Box | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const vpRef = useRef<HTMLDivElement>(null);
  const undo = useRef<Undo[]>([]);

  const block = page.blocks.find((b) => b.id === sel) || null;
  useEffect(() => { setSel(null); setView(page.hasClean ? 'final' : 'orig'); undo.current = []; }, [page.id]);

  // ширина области просмотра для режима «по ширине»
  useEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setVpW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = zoom === 'fit' ? Math.min(1.5, (vpW - 40) / page.width) : zoom;

  // отрисовка холста
  const sig = useMemo(() => view + '|' + cleanVer + '|' + JSON.stringify(page.blocks) + JSON.stringify(project.style), [view, cleanVer, page.blocks, project.style, store]); // eslint-disable-line
  const rendering = useRef(0);
  const draw = useCallback(async () => {
    const id = ++rendering.current;
    const c = canvasRef.current;
    if (!c) return;
    let src: Canvas | null;
    if (view === 'orig') src = await getPageCanvas(page.id, 'orig');
    else if (view === 'clean') src = await getCleanOrOrig(page.id);
    else src = await renderPage(page, project);
    if (!src || id !== rendering.current) return;
    if (c.width !== src.width || c.height !== src.height) { c.width = src.width; c.height = src.height; }
    ctx2d(c).drawImage(src, 0, 0);
  }, [page, project, view]);
  useEffect(() => { draw(); }, [sig, draw]);

  const pushUndo = (withClean = false) => {
    getPageCanvas(page.id, 'clean').then((cl) => {
      undo.current.push({ pageId: page.id, blocks: JSON.stringify(page.blocks), clean: withClean && cl ? cloneCanvas(cl) : null });
      if (undo.current.length > 30) undo.current.shift();
    });
  };
  const doUndo = async () => {
    const u = undo.current.pop();
    if (!u || u.pageId !== page.id) return;
    page.blocks = JSON.parse(u.blocks);
    if (u.clean) { await setPageCanvas(page.id, 'clean', u.clean); setCleanVer((v) => v + 1); }
    store.touchPage(page);
  };

  const commit = (immediate = false) => store.touchPage(page, immediate);

  const updateBlock = (b: Block, patch: Partial<Block>) => { Object.assign(b, patch); commit(); };
  const updateStyle = (b: Block, patch: Partial<TextStyle>) => { b.style = { ...b.style, ...patch }; commit(); };

  const reclean = async (b: Block, prevBox?: Box) => {
    if (!page.hasClean) return;
    await recleanBlock(page, project, b, prevBox);
    setCleanVer((v) => v + 1);
    commit(true);
  };

  const deleteBlock = async (b: Block) => {
    pushUndo(true);
    page.blocks = page.blocks.filter((x) => x !== b);
    setSel(null);
    if (page.hasClean) {
      // возвращаем оригинал на месте удалённого блока
      const orig = await getPageCanvas(page.id, 'orig');
      const clean = await getPageCanvas(page.id, 'clean');
      if (orig && clean) {
        const r = b.box, p = 6;
        ctx2d(clean).drawImage(orig, r.x - p, r.y - p, r.w + 2 * p, r.h + 2 * p, r.x - p, r.y - p, r.w + 2 * p, r.h + 2 * p);
        await setPageCanvas(page.id, 'clean', clean);
        setCleanVer((v) => v + 1);
      }
    }
    commit(true);
  };

  // горячие клавиши
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); doUndo(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && block) { e.preventDefault(); deleteBlock(block); }
      else if (e.key === 'ArrowRight' || e.key === 'PageDown') { if (pageIndex < pages.length - 1) setPageIndex(pageIndex + 1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { if (pageIndex > 0) setPageIndex(pageIndex - 1); }
      else if (e.key === '1') setView('orig');
      else if (e.key === '2') setView('clean');
      else if (e.key === '3') setView('final');
      else if (e.key === 'v') setTool('select');
      else if (e.key === 'n') setTool('add');
      else if (e.key === 'b') { setTool('brush'); if (view === 'orig') setView('clean'); }
      else if (e.key === 'Escape') { setSel(null); setTool('select'); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  // ---- координаты
  const toImg = (e: { clientX: number; clientY: number }) => {
    const r = (e.target as HTMLElement).closest('.overlay')!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };

  // ---- перетаскивание и изменение размеров рамок
  const editingTextBox = view !== 'orig';
  const startDrag = (e: React.PointerEvent, b: Block, mode: 'move' | 'nw' | 'ne' | 'sw' | 'se') => {
    if (tool !== 'select') return;
    e.stopPropagation(); e.preventDefault();
    setSel(b.id);
    pushUndo(!editingTextBox);
    const key = editingTextBox ? 'textBox' : 'box';
    const start = { ...b[key] };
    const p0 = { x: e.clientX, y: e.clientY };
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - p0.x) / scale, dy = (ev.clientY - p0.y) / scale;
      if (Math.abs(dx) + Math.abs(dy) > 1) moved = true;
      const nb = { ...start };
      if (mode === 'move') { nb.x = start.x + dx; nb.y = start.y + dy; }
      if (mode.includes('w')) { nb.x = Math.min(start.x + dx, start.x + start.w - 8); nb.w = start.w - (nb.x - start.x); }
      if (mode.includes('e')) nb.w = Math.max(8, start.w + dx);
      if (mode.includes('n')) { nb.y = Math.min(start.y + dy, start.y + start.h - 8); nb.h = start.h - (nb.y - start.y); }
      if (mode.includes('s')) nb.h = Math.max(8, start.h + dy);
      b[key] = { x: Math.round(nb.x), y: Math.round(nb.y), w: Math.round(nb.w), h: Math.round(nb.h) };
      if (editingTextBox) b.manualTextBox = true;
      store.refresh();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) { undo.current.pop(); return; }
      if (!editingTextBox) reclean(b, start); else commit(true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ---- кисть
  const paintAt = async (clean: Canvas, orig: Canvas, from: { x: number; y: number }, to: { x: number; y: number }, restore: boolean) => {
    const g = ctx2d(clean);
    g.save();
    g.lineCap = 'round'; g.lineJoin = 'round'; g.lineWidth = brush;
    if (restore) {
      g.beginPath(); g.moveTo(from.x, from.y); g.lineTo(to.x, to.y);
      // обводим путь и используем его как маску для копирования из оригинала
      const path = new Path2D();
      const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / (brush / 4)));
      for (let i = 0; i <= steps; i++) {
        const x = from.x + ((to.x - from.x) * i) / steps, y = from.y + ((to.y - from.y) * i) / steps;
        path.moveTo(x + brush / 2, y); path.arc(x, y, brush / 2, 0, Math.PI * 2);
      }
      g.clip(path);
      g.drawImage(orig, 0, 0);
    } else {
      g.strokeStyle = brushColor;
      g.beginPath(); g.moveTo(from.x, from.y); g.lineTo(to.x, to.y); g.stroke();
    }
    g.restore();
  };

  const onOverlayDown = async (e: React.PointerEvent) => {
    const p = toImg(e);
    if (tool === 'select') { setSel(null); return; }
    if (tool === 'pick') {
      const c = canvasRef.current!;
      const d = ctx2d(c).getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data;
      const hex = rgbToHex([d[0], d[1], d[2]]);
      setBrushColor(hex);
      toast(`Цвет кисти: ${hex}`);
      setTool('brush');
      return;
    }
    if (tool === 'add') {
      const start = p;
      setDrawRect({ x: p.x, y: p.y, w: 0, h: 0 });
      const target = e.currentTarget as HTMLElement;
      const move = (ev: PointerEvent) => {
        const r = target.getBoundingClientRect();
        const q = { x: (ev.clientX - r.left) / scale, y: (ev.clientY - r.top) / scale };
        setDrawRect({ x: Math.min(start.x, q.x), y: Math.min(start.y, q.y), w: Math.abs(q.x - start.x), h: Math.abs(q.y - start.y) });
      };
      const up = async (ev: PointerEvent) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        setDrawRect(null);
        const r = target.getBoundingClientRect();
        const q = { x: (ev.clientX - r.left) / scale, y: (ev.clientY - r.top) / scale };
        const box = { x: Math.min(start.x, q.x), y: Math.min(start.y, q.y), w: Math.abs(q.x - start.x), h: Math.abs(q.y - start.y) };
        if (box.w < 8 || box.h < 8) return;
        pushUndo(true);
        const nb = newBlock(box, '', 'speech');
        page.blocks.push(nb);
        setSel(nb.id);
        setTool('select');
        if (page.hasClean) await reclean(nb); else commit(true);
        toast('Блок добавлен. Впишите оригинал и перевод справа.');
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      return;
    }
    if (tool === 'brush' || tool === 'restore') {
      const orig = await getPageCanvas(page.id, 'orig');
      if (!orig) return;
      let clean = await getPageCanvas(page.id, 'clean');
      pushUndo(true);
      if (!clean) { clean = cloneCanvas(orig); await setPageCanvas(page.id, 'clean', clean, false); }
      const cl = clean;
      const target = e.currentTarget as HTMLElement;
      let last = p;
      await paintAt(cl, orig, last, last, tool === 'restore');
      setCleanVer((v) => v + 1);
      let raf = 0;
      const move = (ev: PointerEvent) => {
        const r = target.getBoundingClientRect();
        const q = { x: (ev.clientX - r.left) / scale, y: (ev.clientY - r.top) / scale };
        paintAt(cl, orig, last, q, tool === 'restore');
        last = q;
        if (!raf) raf = requestAnimationFrame(() => { raf = 0; setCleanVer((v) => v + 1); });
      };
      const up = async () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        await setPageCanvas(page.id, 'clean', cl);
        page.hasClean = true;
        setCleanVer((v) => v + 1);
        commit(true);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    }
  };

  // ---- действия со страницей
  const ocrThis = async () => {
    if (!isConfigured(store.settings)) { store.openSettings(); return; }
    if (page.blocks.length && !confirm('Распознать страницу заново? Текущие блоки будут заменены.')) return;
    setBusy('Распознаю…');
    try {
      const img = await getPageCanvas(page.id, 'orig');
      pushUndo();
      page.blocks = await ocrPage(img!, project, store.settings);
      page.status = 'ocr';
      commit(true);
      toast(`Найдено блоков: ${page.blocks.length}`);
    } catch (e) { toast((e as Error).message, true); }
    setBusy('');
  };
  const cleanThis = async () => {
    setBusy('Очищаю…');
    pushUndo(true);
    try { await cleanPage(page, project, true); setCleanVer((v) => v + 1); setView('final'); commit(true); }
    catch (e) { toast((e as Error).message, true); }
    setBusy('');
  };

  const overlayBoxes = view === 'orig' ? 'box' : 'textBox';
  const W = page.width * scale, H = page.height * scale;

  return (
    <div className="editor">
      <div className="pages-col">
        {pages.map((p, i) => (
          <div key={p.id} className={'pthumb' + (i === pageIndex ? ' active' : '')} onClick={() => setPageIndex(i)}>
            {p.thumb && <img src={p.thumb} alt="" />}
            <span>{i + 1}</span>
          </div>
        ))}
      </div>

      <div className="center">
        <div className="toolbar">
          <div className="seg" role="group" aria-label="Вид">
            <button className={view === 'orig' ? 'active' : ''} onClick={() => setView('orig')} title="Оригинал и рамки найденного текста (1)">Оригинал</button>
            <button className={view === 'clean' ? 'active' : ''} onClick={() => setView('clean')} title="Очищенная страница (2)">Очищено</button>
            <button className={view === 'final' ? 'active' : ''} onClick={() => setView('final')} title="Результат с переводом (3)">Перевод</button>
          </div>
          <span className="sep" />
          <div className="seg" role="group" aria-label="Инструмент">
            <button className={tool === 'select' ? 'active' : ''} onClick={() => setTool('select')} title="Выбор и перемещение (V)">↖ Выбор</button>
            <button className={tool === 'add' ? 'active' : ''} onClick={() => setTool('add')} title="Нарисовать новый блок (N)">＋ Блок</button>
            <button className={tool === 'brush' ? 'active' : ''} onClick={() => { setTool('brush'); if (view === 'orig') setView('clean'); }} title="Кисть-заливка цветом (B)">🖌 Кисть</button>
            <button className={tool === 'restore' ? 'active' : ''} onClick={() => { setTool('restore'); if (view === 'orig') setView('clean'); }} title="Вернуть оригинал кистью">↺ Вернуть</button>
            <button className={tool === 'pick' ? 'active' : ''} onClick={() => setTool('pick')} title="Пипетка — взять цвет со страницы">💧</button>
          </div>
          {(tool === 'brush' || tool === 'restore' || tool === 'pick') && <>
            <input type="color" value={brushColor} onChange={(e) => setBrushColor(e.target.value)} title="Цвет кисти" />
            <label className="small row" style={{ gap: 4 }}>Размер<input type="range" min={4} max={120} value={brush} onChange={(e) => setBrush(+e.target.value)} style={{ width: 90 }} /></label>
          </>}
          <span className="sep" />
          <button className="btn small ghost" onClick={() => setZoom('fit')} title="По ширине">⤢</button>
          <button className="btn small ghost" onClick={() => setZoom(Math.max(0.1, +(scale / 1.25).toFixed(2)))}>−</button>
          <span className="small" style={{ minWidth: 40, textAlign: 'center' }}>{Math.round(scale * 100)}%</span>
          <button className="btn small ghost" onClick={() => setZoom(Math.min(4, +(scale * 1.25).toFixed(2)))}>＋</button>
          <button className="btn small ghost" onClick={doUndo} title="Отменить (Ctrl+Z)">↶</button>
          <span className="spacer" />
          {busy && <span className="small muted">{busy}</span>}
          <span className="small muted">Стр. {pageIndex + 1} / {pages.length}</span>
          <button className="btn small" disabled={pageIndex === 0} onClick={() => setPageIndex(pageIndex - 1)}>←</button>
          <button className="btn small" disabled={pageIndex >= pages.length - 1} onClick={() => setPageIndex(pageIndex + 1)}>→</button>
        </div>
        <div className="viewport" ref={vpRef}>
          <div className="stage" style={{ width: W, height: H }}>
            <canvas ref={canvasRef} style={{ width: W, height: H }} />
            <div className={'overlay' + (tool === 'brush' || tool === 'restore' || tool === 'pick' ? ' brush' : tool === 'add' ? ' draw' : '')}
              onPointerDown={onOverlayDown}
              onPointerMove={(e) => { if (tool === 'brush' || tool === 'restore') setCursor(toImg(e)); }}
              onPointerLeave={() => setCursor(null)}>
              {tool !== 'brush' && tool !== 'restore' && page.blocks.map((b, i) => {
                const r = b[overlayBoxes];
                const isSel = b.id === sel;
                return (
                  <div key={b.id}
                    className={'bx' + (overlayBoxes === 'textBox' ? ' textbox' : '') + (isSel ? ' sel' : '') + (b.skip ? ' skip' : '') + (b.warnings?.length ? ' warn' : '')}
                    style={{ left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale, pointerEvents: tool === 'select' ? 'auto' : 'none', opacity: view === 'final' && !isSel ? 0.35 : 1 }}
                    onPointerDown={(e) => startDrag(e, b, 'move')}
                    title={b.original}>
                    <span className="lbl">{i + 1}{b.kind !== 'speech' ? ' · ' + KIND_LABELS[b.kind] : ''}</span>
                    {isSel && (['nw', 'ne', 'sw', 'se'] as const).map((h) => (
                      <div key={h} className={'handle ' + h} onPointerDown={(e) => startDrag(e, b, h)} />
                    ))}
                  </div>
                );
              })}
              {drawRect && <div className="drawrect" style={{ left: drawRect.x * scale, top: drawRect.y * scale, width: drawRect.w * scale, height: drawRect.h * scale }} />}
              {cursor && (tool === 'brush' || tool === 'restore') && <div className="brush-cursor" style={{ left: cursor.x * scale, top: cursor.y * scale, width: brush * scale, height: brush * scale }} />}
            </div>
          </div>
        </div>
      </div>

      <div className="side">
        {block ? <BlockPanel key={block.id} store={store} page={page} block={block} index={page.blocks.indexOf(block)}
          update={(p) => updateBlock(block, p)} updateStyle={(p) => updateStyle(block, p)}
          reclean={() => reclean(block)} remove={() => deleteBlock(block)} close={() => setSel(null)} pushUndo={pushUndo} />
          : <PagePanel store={store} page={page} select={setSel} ocrThis={ocrThis} cleanThis={cleanThis} view={view} />}
      </div>
    </div>
  );
}

function PagePanel({ store, page, select, ocrThis, cleanThis, view }: { store: Store; page: Page; select: (id: string) => void; ocrThis: () => void; cleanThis: () => void; view: View }) {
  return (
    <>
      <h3>Страница: {page.name}</h3>
      <div className="btn-row" style={{ marginBottom: 12 }}>
        <button className="btn small" onClick={ocrThis}>Распознать страницу</button>
        <button className="btn small primary" onClick={cleanThis} disabled={!page.blocks.length}>Очистить и вставить</button>
      </div>
      <Tip title="Как править">
        {view === 'orig'
          ? <>Оранжевые рамки — где найден текст. Двигайте их и тяните за углы, если модель промахнулась: после этого блок переочистится. Пропущенный текст обведите инструментом «＋ Блок».</>
          : <>Синие рамки — куда вписывается перевод. Перетащите или растяните, чтобы текст лёг красивее. Остатки букв закрасьте «Кистью» (цвет берётся пипеткой 💧).</>}
      </Tip>
      <h3>Блоки ({page.blocks.length})</h3>
      {!page.blocks.length && <p className="muted small">Текст ещё не распознан. Нажмите «Распознать страницу» или добавьте блоки вручную.</p>}
      <div className="blocklist">
        {page.blocks.map((b, i) => (
          <div key={b.id} className="it" onClick={() => select(b.id)}>
            <div><b>{i + 1}.</b> {b.translation || <span className="muted">— нет перевода —</span>} {b.warnings?.length ? <span className="badge err">!</span> : null}</div>
            <div className="o">{b.original}</div>
          </div>
        ))}
      </div>
      <details style={{ marginTop: 16 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Стиль текста по умолчанию (весь проект)</summary>
        <div style={{ marginTop: 10 }}>
          <StyleEditor style={store.project.style} onChange={(p) => store.updateProject({ style: { ...store.project.style, ...p } })} />
        </div>
      </details>
      <p className="small muted" style={{ marginTop: 16 }}>
        Клавиши: <kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd> — вид, <kbd>V</kbd> выбор, <kbd>N</kbd> новый блок, <kbd>B</kbd> кисть, <kbd>Del</kbd> удалить блок, <kbd>Ctrl+Z</kbd> отмена, <kbd>←</kbd>/<kbd>→</kbd> страницы.
      </p>
    </>
  );
}

function BlockPanel({ store, page, block, index, update, updateStyle, reclean, remove, close, pushUndo }: {
  store: Store; page: Page; block: Block; index: number; update: (p: Partial<Block>) => void; updateStyle: (p: Partial<TextStyle>) => void;
  reclean: () => void; remove: () => void; close: () => void; pushUndo: (c?: boolean) => void;
}) {
  const [hint, setHint] = useState('');
  const [loading, setLoading] = useState(false);
  const st = resolveStyle(store.project.style, block);
  const retranslate = async () => {
    if (!isConfigured(store.settings)) { store.openSettings(); return; }
    setLoading(true);
    pushUndo();
    try { await retranslateOne(store.pages, block, store.project, store.glossary, store.settings, hint); fitTextBoxes(page, store.project, block); store.touchPage(page, true); }
    catch (e) { toast((e as Error).message, true); }
    setLoading(false);
  };
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>Блок {index + 1}</h3>
        <button className="btn small ghost" onClick={close}>✕</button>
      </div>
      {block.warnings?.map((w) => <div key={w} className="small" style={{ color: 'var(--err)' }}>⚠ {w}</div>)}
      <Field label="Оригинал (распознанный текст)">
        <textarea className="input" rows={2} value={block.original} onChange={(e) => update({ original: e.target.value })} />
      </Field>
      <Field label="Перевод">
        <textarea className="input" rows={3} value={block.translation} onChange={(e) => update({ translation: e.target.value })} onBlur={() => { fitTextBoxes(page, store.project, block); store.touchPage(page); }} style={{ fontSize: 15 }} />
      </Field>
      <div className="row" style={{ marginBottom: 10, flexWrap: 'nowrap' }}>
        <input className="input" placeholder="Пожелание: короче, грубее…" value={hint} onChange={(e) => setHint(e.target.value)} />
        <button className="btn small" disabled={loading || !block.original.trim()} onClick={retranslate}>{loading ? '…' : '↻ Перевести'}</button>
      </div>
      <div className="mini-grid">
        <Field label="Тип">
          <select className="input" value={block.kind} onChange={(e) => {
            const kind = e.target.value as BlockKind;
            update({ kind, style: kind === 'sfx' ? { ...SFX_STYLE, ...block.style } : block.style });
          }}>
            {Object.entries(KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Очистка">
          <select className="input" value={block.clean} onChange={(e) => { update({ clean: e.target.value as CleanMode }); setTimeout(reclean, 0); }}>
            {Object.entries(CLEAN_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
      </div>
      {block.clean === 'fill' && (
        <div className="row" style={{ marginBottom: 10 }}>
          <span className="small muted">Цвет заливки</span>
          <input type="color" value={block.fillColor || '#ffffff'} onChange={(e) => update({ fillColor: e.target.value })} onBlur={reclean} />
        </div>
      )}
      {block.bgType === 'complex' && block.clean === 'auto' && <p className="small" style={{ color: 'var(--warn)' }}>Сложный фон: область размыта. Если выглядит плохо — подправьте кистью или выберите «Залить рамку цветом».</p>}
      <div className="btn-row" style={{ marginBottom: 12 }}>
        <label className="check small"><input type="checkbox" checked={block.skip} onChange={(e) => { update({ skip: e.target.checked }); setTimeout(reclean, 0); }} /> Пропустить блок</label>
        <button className="btn small" onClick={reclean} disabled={!page.hasClean}>Переочистить</button>
        {block.manualTextBox && <button className="btn small" onClick={() => { update({ manualTextBox: false }); setTimeout(reclean, 0); }}>Авто-область</button>}
      </div>
      <h3>Оформление</h3>
      <StyleEditor style={st} onChange={updateStyle} />
      <div className="btn-row" style={{ marginTop: 8 }}>
        <button className="btn small" onClick={() => update({ style: {} })}>Сбросить стиль</button>
        <button className="btn small" title="Применить это оформление ко всем блокам такого же типа в проекте" onClick={() => {
          const s = { ...block.style };
          store.pages.forEach((p) => { p.blocks.forEach((b) => { if (b.kind === block.kind && b !== block) b.style = { ...s, angle: b.style.angle }; }); store.touchPage(p); });
          toast(`Стиль применён ко всем блокам типа «${KIND_LABELS[block.kind]}»`);
        }}>Ко всем «{KIND_LABELS[block.kind]}»</button>
        <button className="btn small danger" onClick={remove}>Удалить блок</button>
      </div>
    </>
  );
}

function StyleEditor({ style, onChange }: { style: TextStyle; onChange: (p: Partial<TextStyle>) => void }) {
  const fonts = allFontNames();
  return (
    <>
      <Field label="Шрифт">
        <select className="input" value={style.font} onChange={(e) => onChange({ font: e.target.value })} style={{ fontFamily: style.font }}>
          {fonts.map((f) => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
        </select>
      </Field>
      <div className="mini-grid">
        <Field label={`Размер: ${style.size ? style.size + 'px' : 'авто'}`}>
          <div className="row" style={{ flexWrap: 'nowrap', gap: 4 }}>
            <input type="range" min={8} max={120} value={style.size || 24} onChange={(e) => onChange({ size: +e.target.value })} style={{ width: '100%' }} />
            <button className={'btn small' + (!style.size ? ' primary' : '')} onClick={() => onChange({ size: null })} title="Автоподбор размера">A</button>
          </div>
        </Field>
        <Field label={`Межстрочный: ${style.lineHeight.toFixed(2)}`}>
          <input type="range" min={0.8} max={1.8} step={0.02} value={style.lineHeight} onChange={(e) => onChange({ lineHeight: +e.target.value })} />
        </Field>
        <Field label="Цвет текста"><input type="color" value={style.color} onChange={(e) => onChange({ color: e.target.value })} /></Field>
        <Field label={`Обводка: ${Math.round(style.strokeWidth * 100)}%`}>
          <div className="row" style={{ flexWrap: 'nowrap', gap: 4 }}>
            <input type="color" value={style.strokeColor} onChange={(e) => onChange({ strokeColor: e.target.value })} />
            <input type="range" min={0} max={0.3} step={0.01} value={style.strokeWidth} onChange={(e) => onChange({ strokeWidth: +e.target.value })} style={{ width: '100%' }} />
          </div>
        </Field>
        <Field label={`Поворот: ${style.angle}°`}>
          <input type="range" min={-45} max={45} value={style.angle} onChange={(e) => onChange({ angle: +e.target.value })} />
        </Field>
        <Field label="Выравнивание">
          <select className="input" value={style.align} onChange={(e) => onChange({ align: e.target.value as 'center' })}>
            <option value="center">По центру</option><option value="left">Влево</option><option value="right">Вправо</option>
          </select>
        </Field>
      </div>
      <div className="btn-row">
        <label className="check small"><input type="checkbox" checked={style.bold} onChange={(e) => onChange({ bold: e.target.checked })} /> Жирный</label>
        <label className="check small"><input type="checkbox" checked={style.italic} onChange={(e) => onChange({ italic: e.target.checked })} /> Курсив</label>
        <label className="check small"><input type="checkbox" checked={style.uppercase} onChange={(e) => onChange({ uppercase: e.target.checked })} /> ПРОПИСНЫЕ</label>
      </div>
    </>
  );
}
