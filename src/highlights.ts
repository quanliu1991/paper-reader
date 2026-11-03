import katex from 'katex';
import { splitMath } from './components/RichText';

export interface HighlightMark { text: string; color: string }

const HL_BG: Record<string, string> = { // ux-lint-allow: 高亮功能色板（业务数据非主题色）
  yellow: '#fff3b0', green: '#c8e6c9', blue: '#bbdefb', pink: '#f8bbd0',
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function bgOf(color: string): string {
  return HL_BG[color] ?? '#fff3b0';
}

interface Span { start: number; end: number; color: string }

// 同一段里多次划到重叠片段时合成一段，避免标记互相切碎。
function mergedSpans(text: string, items: HighlightMark[]): Span[] {
  const spans: Span[] = [];
  for (const it of items) {
    const needle = it.text.trim();
    if (needle.length < 2) continue;
    let from = 0;
    while (from < text.length) {
      const i = text.indexOf(needle, from);
      if (i < 0) break;
      spans.push({ start: i, end: i + needle.length, color: it.color });
      from = i + needle.length;
    }
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      if (span.end > last.end) last.end = span.end;
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

function paint(text: string, spans: Span[]): string {
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += escapeHtml(text.slice(cursor, span.start));
    // ux-lint-allow: 高亮色板应用（业务数据）
    out += `<mark class="hl" style="background:${bgOf(span.color)}">${escapeHtml(text.slice(span.start, span.end))}</mark>`;
    cursor = span.end;
  }
  return out + escapeHtml(text.slice(cursor));
}

function renderMath(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: false,
      trust: false,
      output: 'html',
    });
  } catch {
    return `<code>${escapeHtml(tex)}</code>`;
  }
}

// 划线落在哪一侧就标哪一侧。对不上的一侧返回 null，继续用富文本，避免公式被纯文本替换掉。
export function highlightHtml(text: string, items: HighlightMark[]): string | null {
  if (!text || !items.length) return null;
  let hit = false;
  const html = splitMath(text).map(part => {
    if (part.math) return renderMath(part.text, part.display);
    const spans = mergedSpans(part.text, items);
    if (!spans.length) return escapeHtml(part.text);
    hit = true;
    return paint(part.text, spans);
  }).join('');
  return hit ? html : null;
}
