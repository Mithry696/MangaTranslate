import { useEffect, useState } from 'react';
import type { Project } from './lib/types';
import { getProject } from './lib/db';
import { clearCache } from './lib/image';
import { isConfigured, loadSettings, type Settings } from './lib/settings';
import { registerCustomFonts } from './lib/fonts';
import { Home } from './components/Home';
import { ProjectView } from './components/ProjectView';
import { Guide } from './components/Guide';
import { SettingsModal } from './components/SettingsModal';
import { Toasts } from './components/ui';

type Route = { name: 'home' } | { name: 'guide' } | { name: 'project'; project: Project };

export function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [route, setRoute] = useState<Route>({ name: 'home' });
  const [showSettings, setShowSettings] = useState(false);
  const [, setFontsVer] = useState(0);

  useEffect(() => { registerCustomFonts().then(() => setFontsVer((v) => v + 1)); }, []);

  // простая навигация через #hash, чтобы работали кнопки «назад» и обновление страницы
  useEffect(() => {
    const apply = async () => {
      const h = location.hash.slice(1);
      if (h === 'guide') setRoute({ name: 'guide' });
      else if (h.startsWith('project/')) {
        const p = await getProject(h.slice(8));
        setRoute(p ? { name: 'project', project: p } : { name: 'home' });
      } else setRoute({ name: 'home' });
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);

  const go = (hash: string) => { if (location.hash !== '#' + hash) location.hash = hash; };
  const openProject = (p: Project) => { clearCache(); setRoute({ name: 'project', project: p }); go('project/' + p.id); };

  return (
    <div className="app">
      <header className="topbar">
        <div className="logo" onClick={() => go('')}><span className="logo-mark">Я</span>МангаПеревод</div>
        <nav>
          <button className={'btn ghost' + (route.name === 'home' ? ' active' : '')} onClick={() => go('')}>Проекты</button>
          <button className={'btn ghost' + (route.name === 'guide' ? ' active' : '')} onClick={() => go('guide')}>Руководство</button>
        </nav>
        {route.name === 'project' && <span className="muted small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>/ {route.project.name}</span>}
        <span className="spacer" />
        <button className={'btn' + (isConfigured(settings) ? '' : ' primary')} onClick={() => setShowSettings(true)}>
          {isConfigured(settings) ? '⚙ Настройки API' : '🔑 Указать API-ключ'}
        </button>
      </header>
      <main className="main" style={route.name === 'project' ? { overflow: 'hidden' } : undefined}>
        {route.name === 'home' && <Home open={openProject} settings={settings} openSettings={() => setShowSettings(true)} openGuide={() => go('guide')} />}
        {route.name === 'guide' && <Guide openSettings={() => setShowSettings(true)} />}
        {route.name === 'project' && <ProjectView key={route.project.id} projectId={route.project.id} initialProject={route.project} settings={settings} openSettings={() => setShowSettings(true)} />}
      </main>
      {showSettings && <SettingsModal settings={settings} onChange={setSettings} onClose={() => setShowSettings(false)} />}
      <Toasts />
    </div>
  );
}
