// Поиск и распознавание текста vision-моделью.
// Длинные полосы вебтуна режутся на куски по «пустым» строкам, чтобы не разрезать пузыри.
import type { Block, BlockKind, Box, Project, SourceLang } from './types';
import { chat, parseJsonLoose, type ContentPart } from './llm';
import type { Settings } from './settings';
import { ctx2d, cropScaled, type Canvas } from './image';
import { boxArea, intersect, uid } from './util';

interface Tile { y: number; h: number }

const LANG_NAMES: Record<SourceLang, string> = {
  ja: 'Japanese', zh: 'Chinese', ko: 'Korean', en: 'English', auto: 'any (detect it)',
};

export function readingDirection(p: Project): 'rtl' | 'ltr' {
  if (p.direction !== 'auto') return p.direction;
  return p.sourceLang === 'ja' && p.format !== 'webtoon' ? 'rtl' : 'ltr';
}

/** Насколько строка изображения «однотонна» — чем меньше, тем лучше место для разреза */
function rowNoise(data: Uint8ClampedArray, w: number, y: number) {
  let s = 0, s2 = 0, n = 0;
  const step = Math.max(1, Math.floor(w / 200));
  for (let x = 0; x < w; x += step) {
    const i = (y * w + x) * 4;
    const l = 0.3 * data[i] + 0.59 * data[i + 1] + 0.11 * data[i + 2];
    s += l; s2 += l * l; n++;
  }
  const m = s / n;
  return Math.sqrt(Math.max(0, s2 / n - m * m));
}

export function planTiles(img: Canvas, ratio: number): { tiles: Tile[]; overlap: boolean[] } {
  const W = img.width, H = img.height;
  if (H / W <= ratio) return { tiles: [{ y: 0, h: H }], overlap: [false] };
  const target = Math.round(Math.max(700, W * 1.5));
  const tiles: Tile[] = [];
  const overlap: boolean[] = [];
  const g = ctx2d(img);
  let y = 0;
  while (y < H) {
    if (H - y <= target * 1.25) { tiles.push({ y, h: H - y }); overlap.push(false); break; }
    // ищем самую «пустую» строку в окне [0.65 .. 1.0] от целевой высоты
    const from = y + Math.round(target * 0.65), to = Math.min(H - 1, y + target);
    const band = g.getImageData(0, from, W, to - from).data;
    let bestY = to, bestN = Infinity;
    for (let yy = 0; yy < to - from; yy += 2) {
      const nz = rowNoise(band, W, yy);
      if (nz < bestN) { bestN = nz; bestY = from + yy; }
    }
    if (bestN < 4) {
      tiles.push({ y, h: bestY - y }); overlap.push(false);
      y = bestY;
    } else {
      // чистого места нет — режем с перехлёстом, дубли потом уберём
      const ov = Math.round(target * 0.18);
      tiles.push({ y, h: target }); overlap.push(true);
      y = y + target - ov;
    }
  }
  return { tiles, overlap };
}

function buildPrompt(p: Project) {
  const dir = readingDirection(p) === 'rtl'
    ? 'manga order: panels and bubbles from RIGHT to LEFT, then top to bottom'
    : 'left to right, top to bottom';
  return `You are a precise OCR engine for comics, manga, manhwa and manhua.
Find ALL text on this image: speech bubbles, thought bubbles, narration boxes, signs/labels and sound effects (SFX).
Source language: ${LANG_NAMES[p.sourceLang]}.

Return ONLY JSON of the form:
{"blocks":[{"box_2d":[ymin,xmin,ymax,xmax],"text":"...","kind":"speech|thought|narration|sfx|sign|other"}]}

Rules:
- One block = one bubble / caption / sign / SFX. Never merge two different bubbles into one block.
- box_2d tightly encloses the text glyphs of that block (not the whole bubble). Coordinates are integers normalized to 0-1000 (y relative to image height, x relative to image width).
- Transcribe the text exactly as written, in the original language. Do NOT translate. Join the lines of one block: with nothing for Chinese/Japanese, with a space for Korean/English.
- Vertical Japanese/Chinese text: read columns right to left.
- Order the blocks in natural reading order (${dir}).
- Skip page numbers, watermarks, website URLs and scanlation credits.
- If there is no text, return {"blocks":[]}.`;
}

interface RawBlock { box_2d?: number[]; box?: number[]; bbox?: number[]; text?: string; kind?: string }

const KINDS: BlockKind[] = ['speech', 'thought', 'narration', 'sfx', 'sign', 'other'];

function toBox(raw: number[], tileW: number, tileH: number, sentW: number, sentH: number): Box | null {
  if (!Array.isArray(raw) || raw.length < 4 || raw.some((v) => typeof v !== 'number' || !isFinite(v))) return null;
  let [ymin, xmin, ymax, xmax] = raw;
  const maxV = Math.max(...raw);
  let sx: number, sy: number;
  if (maxV <= 1.0001) { sx = tileW; sy = tileH; } // доли 0..1
  else if (maxV <= 1000) { sx = tileW / 1000; sy = tileH / 1000; } // норма 0..1000
  else { sx = tileW / sentW; sy = tileH / sentH; } // пиксели отправленного изображения
  if (ymin > ymax) [ymin, ymax] = [ymax, ymin];
  if (xmin > xmax) [xmin, xmax] = [xmax, xmin];
  const b = { x: xmin * sx, y: ymin * sy, w: (xmax - xmin) * sx, h: (ymax - ymin) * sy };
  if (b.w < 3 || b.h < 3) return null;
  return b;
}

/** Распознать одну страницу. Возвращает новые блоки (textBox пока равен box). */
export async function ocrPage(img: Canvas, project: Project, settings: Settings, signal?: AbortSignal,
  onTile?: (i: number, n: number) => void): Promise<Block[]> {
  const { tiles } = planTiles(img, settings.webtoonRatio);
  const prompt = buildPrompt(project);
  const all: Block[] = [];
  for (let t = 0; t < tiles.length; t++) {
    onTile?.(t, tiles.length);
    const tile = tiles[t];
    const { canvas, scale } = cropScaled(img, 0, tile.y, img.width, tile.h, settings.ocrMaxSide);
    const content: ContentPart[] = [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: canvas.toDataURL('image/jpeg', 0.92) } },
    ];
    const text = await chat(settings.vision, [{ role: 'user', content }], { json: true, temperature: 0, signal, maxTokens: 8000 });
    const parsed = parseJsonLoose<{ blocks?: RawBlock[] } | RawBlock[]>(text);
    const list: RawBlock[] = Array.isArray(parsed) ? parsed : parsed.blocks || [];
    for (const r of list) {
      const raw = r.box_2d || r.box || r.bbox;
      const b = raw && toBox(raw, img.width, tile.h, canvas.width, canvas.height);
      void scale;
      if (!b || !r.text || !String(r.text).trim()) continue;
      b.y += tile.y;
      const kind = (KINDS.includes(r.kind as BlockKind) ? r.kind : 'speech') as BlockKind;
      all.push(newBlock(b, String(r.text).trim(), kind));
    }
  }
  return dedupe(all);
}

export function newBlock(b: Box, text: string, kind: BlockKind): Block {
  const box = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) };
  return {
    id: uid('b'), box, textBox: { ...box }, kind, original: text, translation: '',
    clean: 'auto', style: {}, skip: false,
  };
}

/** Удаляем дубли на перехлёсте кусков: оставляем больший блок */
function dedupe(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    const j = out.findIndex((o) => {
      const i = boxArea(intersect(o.box, b.box));
      return i > 0.5 * Math.min(boxArea(o.box), boxArea(b.box));
    });
    if (j < 0) out.push(b);
    else if (boxArea(b.box) > boxArea(out[j].box)) out[j] = { ...b, id: out[j].id };
  }
  return out;
}
