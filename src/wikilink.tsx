import React from 'react';
import { useStore } from './store';

// v3 B4：[[论文标题]] 双链——渲染与补全工具
// 语法：笔记/高亮备注里写 [[论文标题]]，渲染为可点击链接 → 打开该论文标签。
// 匹配已导入论文用「标题包含匹配」（容错，标题可能被截断）。

export const WIKILINK_RE = /\[\[([^\[\]]{2,120})\]\]/g;

// 从文本提取所有链接目标
export function extractWikilinks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(WIKILINK_RE)) out.push(m[1].trim());
  return out;
}

// 标题 → 论文 id（取第一个标题包含匹配的论文；找不到返回 null）
export function resolvePaperByTitle(title: string): number | null {
  const papers = useStore.getState().papers;
  const exact = papers.find(p => p.title === title);
  if (exact) return exact.id;
  const loose = papers.find(p => p.title.includes(title) || title.includes(p.title.slice(0, 40)));
  return loose?.id ?? null;
}

// 渲染文本中的 [[双链]] 为可点击 span；其余为纯文本
export function renderWithWikilinks(text: string, onNav?: (paperId: number) => void): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let last = 0, key = 0;
  for (const m of text.matchAll(WIKILINK_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) parts.push(<React.Fragment key={key++}>{text.slice(last, idx)}</React.Fragment>);
    const title = m[1].trim();
    parts.push(
      <span
        key={key++}
        className="wikilink"
        role="link"
        tabIndex={0}
        onClick={e => {
          e.stopPropagation();
          const pid = resolvePaperByTitle(title);
          if (pid != null) (onNav ?? ((id: number) => useStore.getState().openPaper(id)))(pid);
          else useStore.getState().toast({ type: 'info', msg: `未找到论文「${title.slice(0, 30)}」` });
        }}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLElement).click(); }}
      >[[{title}]]</span>
    );
    last = idx + m[0].length;
  }
  if (last < text.length) parts.push(<React.Fragment key={key++}>{text.slice(last)}</React.Fragment>);
  return parts;
}

// 输入补全：光标前是 [[xxx 形式时返回建议列表
export function wikilinkSuggest(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const m = before.match(/\[\[([^\[\]]*)$/);
  if (!m) return null;
  return { query: m[1], start: caret - m[1].length };
}

export function suggestPapers(query: string, limit = 6) {
  const q = query.trim().toLowerCase();
  const papers = useStore.getState().papers;
  if (!q) return papers.slice(0, limit);
  return papers.filter(p => p.title.toLowerCase().includes(q)).slice(0, limit);
}
