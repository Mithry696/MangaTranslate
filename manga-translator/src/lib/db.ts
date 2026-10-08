// Хранилище в IndexedDB: проекты, страницы, изображения и глоссарии остаются на устройстве пользователя
import type { Glossary, Page, Project } from './types';

const DB_NAME = 'mangaperevod';
const DB_VERSION = 1;
let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('pages')) {
        const s = db.createObjectStore('pages', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId');
      }
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      if (!db.objectStoreNames.contains('glossaries')) db.createObjectStore('glossaries', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('fonts')) db.createObjectStore('fonts');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqP<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

async function store(name: string, mode: IDBTransactionMode = 'readonly') {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

// ---- проекты
export async function listProjects(): Promise<Project[]> {
  const all = await reqP((await store('projects')).getAll()) as Project[];
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function getProject(id: string) { return reqP((await store('projects')).get(id)) as Promise<Project | undefined>; }
export async function putProject(p: Project) { await reqP((await store('projects', 'readwrite')).put(p)); }
export async function deleteProject(id: string) {
  const pages = await listPages(id);
  for (const pg of pages) await deletePage(pg.id);
  await reqP((await store('projects', 'readwrite')).delete(id));
}

// ---- страницы
export async function listPages(projectId: string): Promise<Page[]> {
  const s = await store('pages');
  const all = await reqP(s.index('projectId').getAll(projectId)) as Page[];
  return all.sort((a, b) => a.index - b.index);
}
export async function putPage(p: Page) { await reqP((await store('pages', 'readwrite')).put(p)); }
export async function deletePage(id: string) {
  await reqP((await store('pages', 'readwrite')).delete(id));
  await deleteBlob(id + ':orig');
  await deleteBlob(id + ':clean');
}

// ---- изображения
export async function putBlob(key: string, b: Blob) { await reqP((await store('blobs', 'readwrite')).put(b, key)); }
export async function getBlob(key: string) { return reqP((await store('blobs')).get(key)) as Promise<Blob | undefined>; }
export async function deleteBlob(key: string) { await reqP((await store('blobs', 'readwrite')).delete(key)); }

// ---- общие глоссарии
export async function listGlossaries(): Promise<Glossary[]> {
  const all = await reqP((await store('glossaries')).getAll()) as Glossary[];
  return all.sort((a, b) => a.name.localeCompare(b.name));
}
export async function putGlossary(g: Glossary) { await reqP((await store('glossaries', 'readwrite')).put(g)); }
export async function deleteGlossary(id: string) { await reqP((await store('glossaries', 'readwrite')).delete(id)); }

// ---- пользовательские шрифты
export async function listFonts(): Promise<{ name: string; data: ArrayBuffer }[]> {
  const s = await store('fonts');
  const keys = await reqP(s.getAllKeys()) as string[];
  const vals = await reqP((await store('fonts')).getAll()) as ArrayBuffer[];
  return keys.map((k, i) => ({ name: k, data: vals[i] }));
}
export async function putFont(name: string, data: ArrayBuffer) { await reqP((await store('fonts', 'readwrite')).put(data, name)); }
export async function deleteFont(name: string) { await reqP((await store('fonts', 'readwrite')).delete(name)); }

export async function storageEstimate() {
  try { return await navigator.storage?.estimate?.(); } catch { return undefined; }
}
