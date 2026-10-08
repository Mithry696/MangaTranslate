// Настройки API и общие параметры. Хранятся только в localStorage этого браузера.

export type PresetId = 'openrouter' | 'deepseek' | 'custom';

export interface ProviderCfg {
  preset: PresetId;
  baseUrl: string;
  apiKey: string;
  model: string;
  jsonMode: boolean;
}

export interface Settings {
  vision: ProviderCfg;
  text: ProviderCfg;
  sameKey: boolean; // использовать ключ «чтения» и для перевода (если провайдер тот же)
  concurrency: number;
  ocrMaxSide: number;
  webtoonRatio: number; // при отношении высоты к ширине больше этого страница режется на куски
  temperature: number;
  chunkChars: number;
}

export interface Preset {
  id: PresetId;
  name: string;
  baseUrl: string;
  visionModel: string;
  textModel: string;
  keyUrl: string;
  visionModels: string[];
  textModels: string[];
  note: string;
}

export const PRESETS: Record<PresetId, Preset> = {
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    visionModel: 'google/gemini-3.8-flash',
    textModel: 'deepseek/deepseek-v4.1-flash',
    keyUrl: 'https://openrouter.ai/keys',
    visionModels: ['google/gemini-3.8-flash', 'qwen/qwen3.8-flash', 'z-ai/glm-5.3-flash', 'xiaomi/mimo-v2.6-flash'],
    textModels: ['deepseek/deepseek-v4.1-flash', '~deepseek/deepseek-flash-latest', 'google/gemini-3.8-flash', 'qwen/qwen3.8-flash'],
    note: 'Один ключ на сотни моделей, работает из России без VPN. Пополнение через посредников или криптовалютой.',
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    visionModel: 'deepseek-flash',
    textModel: 'deepseek-flash',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    visionModels: ['deepseek-flash'],
    textModels: ['deepseek-flash', 'deepseek-v4-pro'],
    note: 'Очень дешёвый перевод. Если браузер блокирует запросы (CORS), используйте прокси из руководства или DeepSeek через OpenRouter.',
  },
  custom: {
    id: 'custom',
    name: 'Свой (OpenAI-совместимый)',
    baseUrl: '',
    visionModel: '',
    textModel: '',
    keyUrl: '',
    visionModels: [],
    textModels: [],
    note: 'Любой сервис с API в формате OpenAI /chat/completions: свой прокси, локальный сервер (LM Studio, Ollama) и т.п.',
  },
};

export function providerFromPreset(id: PresetId, kind: 'vision' | 'text', apiKey = ''): ProviderCfg {
  const p = PRESETS[id];
  return { preset: id, baseUrl: p.baseUrl, apiKey, model: kind === 'vision' ? p.visionModel : p.textModel, jsonMode: true };
}

export const DEFAULT_SETTINGS: Settings = {
  vision: providerFromPreset('openrouter', 'vision'),
  text: providerFromPreset('openrouter', 'text'),
  sameKey: true,
  concurrency: 2,
  ocrMaxSide: 1600,
  webtoonRatio: 2.2,
  temperature: 0.3,
  chunkChars: 3000,
};

const KEY = 'mangaperevod.settings';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const s = JSON.parse(raw);
    return {
      ...DEFAULT_SETTINGS, ...s,
      vision: { ...DEFAULT_SETTINGS.vision, ...s.vision },
      text: { ...DEFAULT_SETTINGS.text, ...s.text },
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* приватный режим */ }
}

/** Итоговый конфиг для перевода с учётом галочки «тот же ключ» */
export function textProvider(s: Settings): ProviderCfg {
  if (s.sameKey && !s.text.apiKey && s.text.baseUrl === s.vision.baseUrl) return { ...s.text, apiKey: s.vision.apiKey };
  return s.text;
}

export function isConfigured(s: Settings) {
  return !!(s.vision.apiKey && s.vision.model && s.vision.baseUrl && textProvider(s).apiKey && s.text.model);
}
