import type { Store } from './ProjectView';
import { LANG_LABELS, type SourceLang } from '../lib/types';
import { Field } from './ui';

export function ProjectSettings({ store }: { store: Store }) {
  const { project, updateProject } = store;
  return (
    <details className="card" open={!project.pageCount}>
      <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 16 }}>Параметры проекта и контекст для перевода</summary>
      <div className="grid cols-2" style={{ marginTop: 12 }}>
        <div>
          <Field label="Название">
            <input className="input" value={project.name} onChange={(e) => updateProject({ name: e.target.value })} />
          </Field>
          <div className="mini-grid">
            <Field label="Язык оригинала">
              <select className="input" value={project.sourceLang} onChange={(e) => updateProject({ sourceLang: e.target.value as SourceLang })}>
                {Object.entries(LANG_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            <Field label="Формат">
              <select className="input" value={project.format} onChange={(e) => updateProject({ format: e.target.value as 'auto' })}>
                <option value="auto">Авто</option>
                <option value="manga">Манга / комикс (страницы)</option>
                <option value="webtoon">Вебтун / манхва (длинные полосы)</option>
              </select>
            </Field>
            <Field label="Порядок чтения">
              <select className="input" value={project.direction} onChange={(e) => updateProject({ direction: e.target.value as 'auto' })}>
                <option value="auto">Авто (японская манга — справа налево)</option>
                <option value="rtl">Справа налево</option>
                <option value="ltr">Слева направо</option>
              </select>
            </Field>
            <Field label="Именные суффиксы">
              <select className="input" value={project.honorifics} onChange={(e) => updateProject({ honorifics: e.target.value as 'keep' })}>
                <option value="keep">Сохранять (-сан, -ним)</option>
                <option value="adapt">Адаптировать</option>
              </select>
            </Field>
            <Field label="Звуки (SFX)">
              <select className="input" value={project.sfx} onChange={(e) => updateProject({ sfx: e.target.value as 'keep' })}>
                <option value="translate">Переводить</option>
                <option value="keep">Оставлять оригинал</option>
              </select>
            </Field>
          </div>
        </div>
        <Field label="Заметки для переводчика-модели" hint="Передаются в каждый запрос перевода. Опишите персонажей (пол, характер, кто к кому на «ты»), жанр, стиль речи.">
          <textarea className="input" rows={9} value={project.notes} placeholder={'Например:\nАки — девушка, 17 лет, грубоватая, ко всем на «ты».\nСэнсэй — мужчина, говорит вежливо и витиевато.\nЖанр: школьная комедия, лёгкий разговорный стиль.'}
            onChange={(e) => updateProject({ notes: e.target.value })} />
        </Field>
      </div>
    </details>
  );
}
