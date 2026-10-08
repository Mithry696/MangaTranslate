// Пользовательские шрифты из IndexedDB регистрируются через FontFace API
import { listFonts } from './db';
import { BUILTIN_FONTS } from './typeset';

const registered = new Set<string>();
export let customFontNames: string[] = [];

export async function registerCustomFonts() {
  try {
    const fonts = await listFonts();
    for (const f of fonts) {
      if (registered.has(f.name)) continue;
      const face = new FontFace(f.name, f.data);
      await face.load();
      document.fonts.add(face);
      registered.add(f.name);
    }
    customFontNames = fonts.map((f) => f.name);
  } catch (e) {
    console.warn('Не удалось загрузить пользовательские шрифты', e);
  }
  return customFontNames;
}

export function allFontNames() {
  return [...BUILTIN_FONTS.map((f) => f.name), ...customFontNames];
}
