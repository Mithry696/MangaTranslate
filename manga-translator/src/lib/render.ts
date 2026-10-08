// Сборка итоговой страницы: очищенное изображение + переведённый текст
import type { Page, Project } from './types';
import { ctx2d, getCleanOrOrig, makeCanvas, type Canvas } from './image';
import { drawBlockText, ensureFonts, resolveStyle } from './typeset';

export async function renderPage(page: Page, project: Project, target?: Canvas): Promise<Canvas> {
  const base = await getCleanOrOrig(page.id);
  const out = target && target.width === base.width && target.height === base.height ? target : makeCanvas(base.width, base.height);
  const g = ctx2d(out);
  g.clearRect(0, 0, out.width, out.height);
  g.drawImage(base, 0, 0);
  const styles = page.blocks.map((b) => resolveStyle(project.style, b));
  await ensureFonts(styles.map((s) => s.font));
  page.blocks.forEach((b, i) => drawBlockText(g, b, styles[i], page.width));
  return out;
}
