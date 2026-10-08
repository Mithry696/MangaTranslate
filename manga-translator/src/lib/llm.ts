// Вызовы OpenAI-совместимого API (/chat/completions) напрямую из браузера
import type { ProviderCfg } from './settings';
import { sleep } from './util';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] }

export interface ChatOptions {
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export class ApiError extends Error {
  constructor(message: string, public status = 0, public retryable = false) { super(message); }
}

export interface Usage { prompt: number; completion: number; cost: number }
export const usageTotals: Usage = { prompt: 0, completion: 0, cost: 0 };

function explainNetworkError(cfg: ProviderCfg) {
  return new ApiError(
    `Не удалось связаться с ${cfg.baseUrl}. Возможные причины: нет интернета, сервис недоступен из вашей сети ` +
    `или он не разрешает запросы напрямую из браузера (CORS). Попробуйте OpenRouter или прокси (см. «Руководство» → «Проблемы»).`,
    0, true);
}

export async function chat(cfg: ProviderCfg, messages: ChatMessage[], opt: ChatOptions = {}): Promise<string> {
  if (!cfg.apiKey) throw new ApiError('Не указан API-ключ. Откройте «Настройки API».');
  if (!cfg.model) throw new ApiError('Не указана модель. Откройте «Настройки API».');
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  let useJson = !!(opt.json && cfg.jsonMode);
  let lastErr: unknown;

  for (let attempt = 0; attempt < 5; attempt++) {
    if (opt.signal?.aborted) throw new DOMException('Отменено', 'AbortError');
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages,
      temperature: opt.temperature ?? 0.2,
    };
    if (opt.maxTokens) body.max_tokens = opt.maxTokens;
    if (useJson) body.response_format = { type: 'json_object' };
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    };
    if (cfg.baseUrl.includes('openrouter.ai')) {
      headers['HTTP-Referer'] = location.origin;
      headers['X-Title'] = 'MangaPerevod';
    }
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: opt.signal });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      lastErr = explainNetworkError(cfg);
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (res.ok) {
      const data = await res.json();
      if (data.error) throw new ApiError(`Ошибка API: ${data.error.message || JSON.stringify(data.error)}`, res.status);
      const u = data.usage;
      if (u) {
        usageTotals.prompt += u.prompt_tokens || 0;
        usageTotals.completion += u.completion_tokens || 0;
        usageTotals.cost += u.cost || 0;
      }
      const content = data.choices?.[0]?.message?.content;
      const text = Array.isArray(content) ? content.map((c: { text?: string }) => c.text || '').join('') : content;
      if (typeof text !== 'string' || !text.trim()) {
        lastErr = new ApiError('Модель вернула пустой ответ', res.status, true);
        await sleep(1000);
        continue;
      }
      return text;
    }
    const errText = await res.text().catch(() => '');
    let msg = errText;
    try { const j = JSON.parse(errText); msg = j.error?.message || j.message || errText; } catch { /* текст как есть */ }
    if (res.status === 400 && useJson && /response_format|json/i.test(msg)) {
      useJson = false; // модель не поддерживает JSON-режим — просим JSON текстом
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new ApiError(`Ключ не принят (${res.status}): ${msg}`, res.status);
    if (res.status === 402) throw new ApiError(`Недостаточно средств на балансе (402): ${msg}`, res.status);
    if (res.status === 404) throw new ApiError(`Модель или адрес не найдены (404): ${msg}`, res.status);
    if (res.status === 429 || res.status >= 500) {
      lastErr = new ApiError(`Сервис перегружен или превышен лимит (${res.status}): ${msg}`, res.status, true);
      const ra = Number(res.headers.get('retry-after'));
      await sleep(ra > 0 ? Math.min(ra, 30) * 1000 : 2000 * 2 ** attempt);
      continue;
    }
    throw new ApiError(`Ошибка ${res.status}: ${msg}`, res.status);
  }
  throw lastErr instanceof Error ? lastErr : new ApiError('Не удалось получить ответ');
}

/** Достаёт JSON из ответа модели (убирает ```json, лишний текст и т.п.) */
export function parseJsonLoose<T = unknown>(text: string): T {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { /* ищем первый объект/массив */ }
  const start = t.search(/[{[]/);
  if (start >= 0) {
    const open = t[start], close = open === '{' ? '}' : ']';
    const end = t.lastIndexOf(close);
    if (end > start) {
      const slice = t.slice(start, end + 1);
      try { return JSON.parse(slice); } catch {
        // частая ошибка — висячие запятые
        return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'));
      }
    }
  }
  throw new ApiError('Модель вернула ответ не в формате JSON');
}

/** Список моделей провайдера (GET /models) */
export async function listModels(cfg: ProviderCfg, onlyVision = false): Promise<string[]> {
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/models';
  let res: Response;
  try {
    res = await fetch(url, { headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {} });
  } catch { throw explainNetworkError(cfg); }
  if (!res.ok) throw new ApiError(`Не удалось получить список моделей (${res.status})`, res.status);
  const data = await res.json();
  const arr: { id: string; architecture?: { input_modalities?: string[] } }[] = data.data || data.models || [];
  return arr
    .filter((m) => !onlyVision || !m.architecture?.input_modalities || m.architecture.input_modalities.includes('image'))
    .map((m) => m.id)
    .sort();
}

/** Короткая проверка, что ключ и модель работают */
export async function testProvider(cfg: ProviderCfg, withImage: boolean): Promise<string> {
  const content: ContentPart[] = [{ type: 'text', text: withImage ? 'What single word is written on this image? Answer with JSON {"word": "..."}' : 'Reply with JSON {"ok": true}' }];
  if (withImage) {
    const c = document.createElement('canvas');
    c.width = 220; c.height = 80;
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff'; g.fillRect(0, 0, 220, 80);
    g.fillStyle = '#000'; g.font = 'bold 40px sans-serif'; g.textBaseline = 'middle';
    g.fillText('HELLO', 40, 42);
    content.push({ type: 'image_url', image_url: { url: c.toDataURL('image/png') } });
  }
  const t0 = performance.now();
  const r = await chat(cfg, [{ role: 'user', content }], { json: true, maxTokens: 50 });
  const ms = Math.round(performance.now() - t0);
  return `Ответ за ${ms} мс: ${r.slice(0, 80)}`;
}
