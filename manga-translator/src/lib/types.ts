// Общие типы данных приложения

export interface Box { x: number; y: number; w: number; h: number }

export type BlockKind = 'speech' | 'thought' | 'narration' | 'sfx' | 'sign' | 'other';

export const KIND_LABELS: Record<BlockKind, string> = {
  speech: 'Реплика',
  thought: 'Мысли',
  narration: 'Закадровый',
  sfx: 'Звук (SFX)',
  sign: 'Надпись',
  other: 'Другое',
};

export type CleanMode = 'auto' | 'fill' | 'blur' | 'none';

export const CLEAN_LABELS: Record<CleanMode, string> = {
  auto: 'Авто',
  fill: 'Залить рамку цветом',
  blur: 'Размыть (сложный фон)',
  none: 'Не чистить',
};

export interface TextStyle {
  font: string;
  size: number | null; // null = автоподбор
  color: string;
  strokeColor: string;
  strokeWidth: number; // в долях от размера шрифта (0..0.3)
  bold: boolean;
  italic: boolean;
  align: 'center' | 'left' | 'right';
  lineHeight: number;
  uppercase: boolean;
  angle: number; // градусы
}

export interface Block {
  id: string;
  box: Box; // где найден оригинальный текст (используется для очистки)
  textBox: Box; // куда вписывается перевод
  kind: BlockKind;
  original: string;
  translation: string;
  clean: CleanMode;
  fillColor?: string; // для режима «залить» или вычисленный цвет фона
  bgType?: 'flat' | 'complex';
  style: Partial<TextStyle>; // переопределения поверх стиля проекта
  skip: boolean; // не переводить, не чистить и не вставлять
  textCands?: Box[]; // варианты области текста внутри найденного пузыря
  manualTextBox?: boolean; // область текста двигали вручную — не пересчитывать при очистке
  warnings?: string[];
}

export type PageStatus = 'new' | 'ocr' | 'translated' | 'done' | 'error';

export const STATUS_LABELS: Record<PageStatus, string> = {
  new: 'Загружена',
  ocr: 'Текст найден',
  translated: 'Переведена',
  done: 'Готова',
  error: 'Ошибка',
};

export interface Page {
  id: string;
  projectId: string;
  index: number;
  name: string;
  width: number;
  height: number;
  blocks: Block[];
  status: PageStatus;
  error?: string;
  hasClean: boolean;
  thumb?: string; // миниатюра (dataURL)
}

export type SourceLang = 'ja' | 'zh' | 'ko' | 'en' | 'auto';

export const LANG_LABELS: Record<SourceLang, string> = {
  ja: 'Японский',
  zh: 'Китайский',
  ko: 'Корейский',
  en: 'Английский',
  auto: 'Определить автоматически',
};

export interface GlossaryEntry {
  id: string;
  src: string;
  dst: string;
  note: string;
}

export interface Glossary {
  id: string;
  name: string;
  entries: GlossaryEntry[];
  updatedAt: number;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  sourceLang: SourceLang;
  direction: 'auto' | 'rtl' | 'ltr';
  format: 'auto' | 'manga' | 'webtoon';
  notes: string; // контекст: персонажи, пол, сеттинг
  honorifics: 'keep' | 'adapt';
  sfx: 'translate' | 'keep';
  glossary: GlossaryEntry[]; // глоссарий проекта
  sharedGlossaryIds: string[]; // подключённые общие глоссарии
  style: TextStyle; // стиль текста по умолчанию
  pageCount: number;
  cover?: string; // dataURL миниатюры
}

export const DEFAULT_STYLE: TextStyle = {
  font: 'Pangolin',
  size: null,
  color: '#000000',
  strokeColor: '#ffffff',
  strokeWidth: 0,
  bold: false,
  italic: false,
  align: 'center',
  lineHeight: 1.12,
  uppercase: false,
  angle: 0,
};

export const SFX_STYLE: Partial<TextStyle> = {
  font: 'Russo One',
  strokeWidth: 0.18,
  color: '#000000',
  strokeColor: '#ffffff',
};
