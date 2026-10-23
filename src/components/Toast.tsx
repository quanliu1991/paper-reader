import { useEffect, useState } from 'react';

interface ToastMsg { id: number; type: 'success' | 'error' | 'info'; msg: string }

let nextId = 1;

export function toast(type: ToastMsg['type'], msg: string) {
  window.dispatchEvent(new CustomEvent('pr:toast', { detail: { type, msg } }));
}

// IPC 错误统一 toast（err 可能带 hint 字段）
export function toastErr(e: any) {
  const msg = e?.message ?? String(e);
  toast('error', msg);
}

export default function ToastHost() {
  const [msgs, setMsgs] = useState<ToastMsg[]>([]);
  useEffect(() => {
    const on = (e: any) => {
      const t: ToastMsg = { id: nextId++, ...e.detail };
      setMsgs(m => [...m, t]);
      setTimeout(() => setMsgs(m => m.filter(x => x.id !== t.id)), 3600);
    };
    window.addEventListener('pr:toast', on);
    return () => window.removeEventListener('pr:toast', on);
  }, []);
  return (
    <div className="toast-host">
      {msgs.map(t => (
        <div key={t.id} className={`toast toast-${t.type}`}>{t.msg}</div>
      ))}
    </div>
  );
}
