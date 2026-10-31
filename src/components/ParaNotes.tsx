import { useState } from 'react';
import { useStore, NoteRow } from '../store';

// 段落下方的小笔记条（阅读器内就近展示，可编辑/删除）
// 无笔记时返回 null——对无笔记段落零 DOM 开销，不影响滚动锚点与行高
export default function ParaNotes({ notes, paperId }: { notes: NoteRow[]; paperId: number }) {
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  if (!notes.length) return null;

  async function save() {
    if (!editing) return;
    await window.api.updateNote({ id: editing.id, text: editing.text });
    setEditing(null);
    await useStore.getState().refreshNotes(paperId);
  }

  async function remove(id: number) {
    if (!confirm('删除这条笔记？')) return;
    await window.api.deleteNote(id);
    await useStore.getState().refreshNotes(paperId);
  }

  return (
    <div className="para-notes">
      {notes.map(n => editing?.id === n.id ? (
        <div key={n.id} className="pn-edit" onClick={e => e.stopPropagation()}>
          <textarea
            autoFocus
            value={editing.text}
            onChange={e => setEditing(v => v! && { ...v, text: e.target.value })}
            onKeyDown={e => {
              if (e.key === 'Escape') setEditing(null);
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
            }}
          />
          <div className="pn-actions">
            <button className="primary" onClick={save}>保存</button>
            <button className="ghost-btn" onClick={() => setEditing(null)}>取消</button>
          </div>
        </div>
      ) : (
        <div key={n.id} className="pn-item" onClick={e => e.stopPropagation()}>
          <span className="pn-mark">📝</span>
          <span className="pn-text">{n.text}</span>
          <span className="pn-btns">
            <button className="pn-btn" onClick={() => setEditing({ id: n.id, text: n.text })} title="编辑">编辑</button>
            <button className="pn-btn" onClick={() => remove(n.id)} title="删除">删</button>
          </span>
        </div>
      ))}
    </div>
  );
}
