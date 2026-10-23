// arXiv 论文下载与解析 v2：LaTeXML alttext 公式 + 图表 SVG + 结构化去噪
import { fetchWithRetry } from './net';

export interface ParsedBlock {
  seq: number;
  type: 'heading' | 'para' | 'fig';
  level: number;
  en: string;          // 文本（含 $...$ / $$...$$ LaTeX 占位）
  figPath?: string;    // figure 本地文件路径（下载后）
  figKind?: 'figure' | 'table';
}

export interface ParsedPaper {
  arxivId: string;
  title: string;
  authors: string;
  blocks: ParsedBlock[];
  importType: 'html' | 'text';
}

export function normalizeArxivId(input: string): string | null {
  const s = input.trim();
  const m = s.match(/(\d{4}\.\d{4,5})(v\d+)?/);
  if (!m) return null;
  return m[1];
}

// LaTeXML 公式形态（实测 2609.34683）：
//   <math id="S3.Ex1.m1" class="ltx_Math" alttext="\mathrm{E2EL}=..." display="block" intent=":literal">
//   行内 display="inline"，块级 display="block"，alttext 恒有
// figure：<figure id="S4.F1" class="ltx_figure|ltx_table"> 内嵌 <svg>（LaTeXML 把矢量图转成 inline svg）
//   少数老论文用 <graphics> 或 <img src="x1.png">

export async function fetchAndParse(arxivId: string): Promise<ParsedPaper> {
  const htmlUrl = `https://arxiv.org/html/${arxivId}`;
  let html: string | null = null;
  try {
    html = await fetchWithRetry(htmlUrl, { timeout: 60000, retries: 2 });
  } catch { /* fallthrough */ }

  if (html && html.length > 5000 && /<html/i.test(html)) {
    const parsed = parseArxivHtml(html, arxivId);
    if (parsed.blocks.length > 20) return parsed;
  }
  const err = new Error('NO_HTML_VERSION') as any;
  err.code = 'NO_HTML_VERSION';
  err.hint = `arXiv ${arxivId} 没有 HTML 版（常见于老论文）。两条替代路径：\n1) 在知识库精读后从 .fulltext 缓存导入（设置 → 仓库连接）\n2) 手动粘贴论文文本导入`;
  throw err;
}

// ---------- HTML 解析 ----------
export function parseArxivHtml(html: string, arxivId: string): ParsedPaper {
  const title = extractTitle(html);
  const authors = extractAuthors(html);
  const blocks: ParsedBlock[] = [];
  let seq = 0;

  const art = html.match(/<article[^>]*>([\s\S]*)<\/article>/i) || html.match(/<article[^>]*>([\s\S]*)/i);
  const cleaned0 = art ? art[1] : html;

  const cleaned = cleaned0
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<button[\s\S]*?<\/button>/gi, '')
    .replace(/<annotation[\s\S]*?<\/annotation>/gi, '');

  const NOISE = /^(report (github )?issue|back to abstract|download pdf|have a free development|our team has already|content selection saved|click on the)/i;
  const TOC_LINE = /^(\d+(\.\d+)*\s+[A-Za-z][^0-9]+){4,}/;

  // 数学公式 → $ / $$ 占位。块级用 $$..$$，行内 $..$；alttext 缺失时退化为 [公式]
  const mathRe = /<math([^>]*)>([\s\S]*?)<\/math>/gi;

  function replaceMath(source: string): string {
    return source.replace(mathRe, (_m, attrs: string) => {
      const alt = (attrs.match(/alttext="([^"]*)"/) || [])[1];
      if (!alt) return ' [公式] ';
      const isBlock = /display="block"/.test(attrs);
      const tex = decodeEntities(alt);
      return isBlock ? ` $$${tex}$$ ` : ` $${tex}$ `;
    });
  }

  // 逐块抽取。顺序扫描，保持文档流。
  // 块级公式独立容器：<table class="ltx_equation..."> 或 <div class="ltx_equation...">
  // 行内公式在 <p> 内，由 replaceMath 处理
  const re = /<(h[1-6])[^>]*>([\s\S]*?)<\/\1>|<p[^>]*>([\s\S]*?)<\/p>|<(table|div)[^>]*class="[^"]*ltx_equation[^"]*"[^>]*>([\s\S]*?)<\/\4>|<figure[^>]*>([\s\S]*?)<\/figure>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    if (m[1]) {
      const level = Number(m[1][1]);
      const text = stripTags(replaceMath(m[2])).trim();
      if (!text || NOISE.test(text)) continue;
      blocks.push({ seq: seq++, type: 'heading', level, en: text });
    } else if (m[3] !== undefined) {
      const text = stripTags(replaceMath(m[3])).trim();
      if (!text || NOISE.test(text)) continue;
      if (TOC_LINE.test(text) && text.length > 200) continue;
      if (text.length < 2) continue;
      blocks.push({ seq: seq++, type: 'para', level: 0, en: text });
    } else if (m[5] !== undefined) {
      // 独立块级公式（equation 容器）
      const text = stripTags(replaceMath(m[5])).trim();
      if (text && /\$\$/.test(text)) {
        blocks.push({ seq: seq++, type: 'para', level: 0, en: text });
      }
    } else if (m[6] !== undefined) {
      const figHtml = m[6];
      const figClass = (m[0].match(/class="([^"]*)"/) || [])[1] ?? '';
      const kind: 'figure' | 'table' = /ltx_table/.test(figClass) ? 'table' : 'figure';
      const capMatch = figHtml.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i);
      const cap = capMatch ? stripTags(replaceMath(capMatch[1])).trim() : '';
      // 图片：优先 graphics/img 的 href|src；inline svg 无 src 则占位（下载阶段处理）
      const imgMatch = figHtml.match(/<(?:img|graphics)[^>]*(?:xlink:href|src)="([^"]+)"[^>]*>/i);
      let img = imgMatch ? imgMatch[1] : '';
      if (img && !/^data:/.test(img)) img = absolutizeImg(img, arxivId);
      const hasSvg = /<svg/i.test(figHtml);
      if ((cap && !NOISE.test(cap)) || img || hasSvg) {
        blocks.push({
          seq: seq++, type: 'fig', level: 0,
          en: cap || (kind === 'table' ? '表格' : '图'),
          figPath: img || undefined,
          figKind: kind,
        });
      }
    }
  }
  return { arxivId, title, authors, blocks, importType: 'html' };
}

// figure 下载：inline svg 序列化为 .svg 文件；img/graphics 下载二进制
export async function downloadFigures(
  paperId: number, arxivId: string, html: string, figuresDir: string
): Promise<Map<number, string>> {
  const fs = await import('fs');
  const path = await import('path');
  const result = new Map<number, string>();
  fs.mkdirSync(figuresDir, { recursive: true });

  const figs = html.match(/<figure[^>]*>[\s\S]*?<\/figure>/gi) || [];
  let i = 0;
  for (const figHtml of figs) {
    i++;
    const imgMatch = figHtml.match(/<(?:img|graphics)[^>]*(?:xlink:href|src)="([^"]+)"[^>]*>/i);
    let src = imgMatch ? imgMatch[1] : '';
    if (!src || /^data:/.test(src)) { continue; }
    const url = absolutizeImg(src, arxivId);
    const ext = (url.match(/\.(svg|png|jpg|jpeg|gif)$/i) || [, 'png'])[1];
    const fname = `fig-${i}.${ext}`;
    const dest = path.join(figuresDir, fname);
    try {
      await downloadToFile(url, dest);
      result.set(i, fname);
    } catch { /* 单图失败不阻塞 */ }
  }
  return result;
}

async function downloadToFile(url: string, dest: string) {
  const fs = await import('fs');
  const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

function absolutizeImg(src: string, arxivId: string): string {
  if (/^https?:\/\//.test(src)) return src;
  const p = src.replace(/^\.\//, '').replace(/^\//, '');
  return `https://arxiv.org/html/${arxivId}/${p}`;
}

// ---------- 纯文本解析（.fulltext / 手动粘贴）----------
export function parsePlainText(text: string, arxivId: string, title: string): ParsedPaper {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ParsedBlock[] = [];
  let seq = 0;
  let buf: string[] = [];
  const flush = () => {
    const t = buf.join(' ').trim();
    if (t.length > 1) {
      const isHeading = t.length < 80 && /^(abstract|references|appendix|[0-9]+\.|chapter| acknowledg)/i.test(t);
      blocks.push({ seq: seq++, type: isHeading ? 'heading' : 'para', level: isHeading ? 2 : 0, en: t });
    }
    buf = [];
  };
  for (const line of lines) {
    if (line.trim() === '') flush();
    else buf.push(line.trim());
  }
  flush();
  return { arxivId, title: title || arxivId, authors: '', blocks, importType: 'text' };
}

// ---------- helpers ----------
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

function extractTitle(html: string): string {
  const h1 = html.match(/<h1[^>]*class="[^"]*ltx_title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return stripTags(h1[1]).trim();
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return t ? stripTags(t[1]).trim() : 'Untitled';
}

function extractAuthors(html: string): string {
  const m = html.match(/<div[^>]*class="[^"]*ltx_authors[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (!m) return '';
  return stripTags(m[1]).replace(/\s+/g, ' ').trim().slice(0, 500);
}
