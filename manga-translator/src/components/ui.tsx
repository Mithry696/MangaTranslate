import { useEffect, useState, type ReactNode } from 'react';

type Toast = { id: number; text: string; err?: boolean };
let pushToast: (t: Omit<Toast, 'id'>) => void = () => {};

export function toast(text: string, err = false) { pushToast({ text, err }); }

export function Toasts() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => {
    let n = 0;
    pushToast = (t) => {
      const id = ++n;
      setList((l) => [...l, { ...t, id }]);
      setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), t.err ? 9000 : 3500);
    };
  }, []);
  return (
    <div className="toast-wrap">
      {list.map((t) => (
        <div key={t.id} className={'toast' + (t.err ? ' err' : '')} onClick={() => setList((l) => l.filter((x) => x.id !== t.id))}>{t.text}</div>
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={wide ? { width: 'min(980px, 100%)' } : undefined} role="dialog" aria-label={title}>
        <div className="modal-head"><h2 style={{ margin: 0 }}>{title}</h2><button className="btn ghost" onClick={onClose} aria-label="Закрыть">✕</button></div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** Подсказка-совет с иконкой */
export function Tip({ children, title = 'Совет' }: { children: ReactNode; title?: string }) {
  return <div className="tip"><span aria-hidden>💡</span><div><b>{title}.</b> {children}</div></div>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small className="muted small">{hint}</small>}
    </label>
  );
}

export function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return <div className="progress" aria-valuenow={pct} role="progressbar"><div style={{ width: pct + '%' }} /></div>;
}
