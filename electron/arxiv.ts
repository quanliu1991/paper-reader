// arXiv 论文下载与解析 v2：LaTeXML alttext 公式 + 图表 SVG + 结构化去噪
import { fetchWithRetry } from './net';

export interface ParsedBlock {
  seq: number;
  type: 'heading' | 'para' | 'fig';
  level: number;
  en: string;          // 文本（含 $...$ / $$...$$ LaTeX 占位）
  figPath?: string;    // figure 本地文件路径（下载后）
  figKind?: 'figure' | 'table';
  figHtmlTable?: boolean; // HTML 表格实体（LaTeXML ltx_tabular span 结构）：无需下载图片，渲染层直接展示
  figTableRows?: string[][]; // 表格数据（ltx_tabular 提取：行 → 单元格纯文本），渲染层还原为真表格
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

  const NOISE = /^(report (github )?issue|back to abstract|download pdf|have a free development|our team has already|content selection saved|click on the|colour theme|toggle navigation)/i;
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
  const pushFig = (
    en: string, figPath: string | undefined, figKind: 'figure' | 'table',
    rows?: string[][], htmlTable?: boolean,
  ) => {
    blocks.push({
      seq: seq++, type: 'fig', level: 0, en,
      figPath, figKind,
      figHtmlTable: htmlTable || undefined,
      figTableRows: rows,
    });
  };

  const re = /<(h[1-6])[^>]*>([\s\S]*?)<\/\1>|<p[^>]*>([\s\S]*?)<\/p>|<(table|div)[^>]*class="[^"]*ltx_equation[^"]*"[^>]*>([\s\S]*?)<\/\4>|<figure[^>]*>([\s\S]*?)<\/figure>|<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    if (m[1]) {
      const level = Number(m[1][1]);
      const text = stripTags(replaceMath(m[2])).trim();
      if (!text || NOISE.test(text)) continue;
      blocks.push({ seq: seq++, type: 'heading', level, en: text });
    } else if (m[3] !== undefined) {
      // 段落里直接嵌的图（不在 figure 里）也要留下，否则 teaser 这类图会消失
      // 脚注在 LaTeXML 里嵌进段落（标记会重复三遍）。抽出来单独成段，正文里不再出现「7 7 7」。
      const pulled = extractNotes(m[3], replaceMath);
      for (const src of collectImgSrcs(pulled.html)) pushFig('', absolutizeImg(src, arxivId), 'figure');
      const text = stripTags(replaceMath(pulled.html)).trim();
      const drop = !text || NOISE.test(text) || (TOC_LINE.test(text) && text.length > 200)
        || text.length < 2 || /^\d{1,4}$/.test(text)
        || /hereby grants permission to reproduce/i.test(text);
      if (!drop) blocks.push({ seq: seq++, type: 'para', level: 0, en: text });
      for (const note of pulled.notes) blocks.push({ seq: seq++, type: 'para', level: 0, en: note });
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
      const capPulled = extractNotes(capMatch ? capMatch[1] : '', replaceMath);
      const cap = stripTags(replaceMath(capPulled.html)).trim();
      const capOk = !!cap && !NOISE.test(cap);
      const pushCapNotes = () => {
        for (const note of capPulled.notes) blocks.push({ seq: seq++, type: 'para', level: 0, en: note });
      };
      // 一张 figure 里常有多张子图（网格图、左右面板）。只留第一张的话，其余图在阅读页里不存在。
      const srcs = collectImgSrcs(figHtml).map(s => absolutizeImg(s, arxivId));
      if (srcs.length) {
        srcs.forEach((src, idx) => {
          // 续图用空格占位：图注只写在第一张上，空串会被后面的「无图图注」误粘过来
          const en = idx === 0 ? (capOk ? cap : (kind === 'table' ? '表格' : '图')) : ' ';
          pushFig(en, src, kind);
        });
        pushCapNotes();
        continue;
      }
      // 图片：LaTeXML 主力形态 <object type="image/svg+xml" data="...">；内联 <svg> 无 src，用 inline: 标记，下载阶段落盘
      const objMatch = figHtml.match(/<object[^>]*type="image\/svg\+xml"[^>]*data="([^"]+)"[^>]*>/i)
        || figHtml.match(/<object[^>]*data="([^"]+\.svg)"[^>]*>/i);
      const img = objMatch && !/^data:/i.test(objMatch[1]) ? absolutizeImg(objMatch[1], arxivId) : '';
      const hasSvg = /<svg/i.test(figHtml);
      // 算法环境（ltx_listingline）没有图片。抽成逐行文本，避免翻译页永远停在「图片下载中」。
      const listingRows = (!img && !hasSvg) ? extractListingLines(figHtml, replaceMath) : undefined;
      // HTML 表格实体（ltx_tabular：span 嵌套或原生 <table> 两种形态）：无图源时提取表格数据，
      // 渲染层还原为真表格——用户不再需要「见原文 PDF」跳转。
      const tableRows = (!img && !hasSvg && !listingRows && /ltx_tabular/i.test(figHtml)) ? extractTableRows(figHtml) : undefined;
      // 图里是排好的正文（生成样本、标注说明），不是图片。抽成段落，避免永远「图片下载中」。
      const proseRows = (!img && !hasSvg && !listingRows && !tableRows) ? extractFigureProse(figHtml, replaceMath) : undefined;
      const rows = listingRows || tableRows || proseRows;
      if (img || hasSvg || rows) {
        pushFig(
          capOk ? cap : (kind === 'table' ? '表格' : '图'),
          img || (hasSvg ? 'inline:' : undefined),
          kind, rows, !!tableRows,
        );
        pushCapNotes();
      } else if (capOk) {
        // 图注单独成 figure、图片在前一个裸 <img> 里（SAM teaser）。把图注补到那张图上。
        const prev = blocks[blocks.length - 1];
        if (prev && prev.type === 'fig' && prev.figPath && !prev.en.trim()) prev.en = cap;
        else pushFig(cap, undefined, kind);
        pushCapNotes();
      }
    } else if (/^<img\b/i.test(m[0])) {
      for (const src of collectImgSrcs(m[0])) pushFig('', absolutizeImg(src, arxivId), 'figure');
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

// 算法 / 伪代码：LaTeXML 用 ltx_listingline，没有 img/svg。每行一个单元格，行首缩进保留。
function extractListingLines(figHtml: string, replaceMath: (s: string) => string): string[][] | undefined {
  if (!/ltx_listingline/i.test(figHtml)) return undefined;
  const lines: string[][] = [];
  const re = /<div[^>]*class="[^"]*\bltx_listingline\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(figHtml)) !== null) {
    const mathDone = replaceMath(m[1]);
    const indented = /[\u2002\u2003]/.test(mathDone.slice(0, 160));
    let text = stripTags(mathDone).replace(/^\d+\s*:\s*/, '');
    if (!text) continue;
    lines.push([indented ? `    ${text}` : text]);
  }
  return lines.length ? lines : undefined;
}

// LaTeXML 表格提取：两种形态
//  a) span 嵌套（transformed 布局）：ltx_tr/ltx_td 都是 <span>，无法正则配对，深度扫描
//  b) 原生 <table class="ltx_tabular">：<tr>/<td> 直接 DOM 语义
// 返回行 → 单元格纯文本（数学 alttext → $..$ 保留）。
function extractTableRows(figHtml: string): string[][] | undefined {
  const cellText = (raw: string) => {
    const withMath = raw.replace(/<math([^>]*)>([\s\S]*?)<\/math>/gi, (_x, attrs: string) => {
      const alt = (attrs.match(/alttext="([^"]*)"/) || [])[1];
      return alt ? ` $${decodeEntities(alt)}$ ` : ' ';
    });
    return ' ' + stripTags(withMath) + ' ';
  };
  // 深度扫描配对 span 块
  const spanBlocks = (fragment: string, cls: string) => {
    const out: string[] = [];
    const re = new RegExp(`<span[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(fragment)) !== null) {
      const start = m.index + m[0].length;
      let depth = 1; let pos = start;
      while (depth > 0 && pos < fragment.length) {
        const op = fragment.indexOf('<span', pos);
        const cl = fragment.indexOf('</span>', pos);
        if (cl === -1) return out;
        if (op !== -1 && op < cl) { depth++; pos = fragment.indexOf('>', op) + 1; }
        else { depth--; pos = cl + 7; }
      }
      out.push(fragment.slice(start, pos - 7));
      re.lastIndex = pos;
    }
    return out;
  };

  // 形态 b：原生 <table>——直接 tr/td
  const tableMatch = figHtml.match(/<table[^>]*ltx_tabular[^>]*>([\s\S]*?)<\/table>/i);
  if (tableMatch) {
    const rows: string[][] = [];
    for (const tr of tableMatch[1].match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) ?? []) {
      const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m2 => cellText(m2[1]));
      if (cells.length) rows.push(cells);
    }
    if (rows.length) return rows;
  }

  // 形态 a：span 嵌套
  const rows: string[][] = [];
  for (const tr of spanBlocks(figHtml, 'ltx_tr')) {
    const cells = spanBlocks(tr, 'ltx_td').map(cellText);
    if (cells.length) rows.push(cells);
  }
  return rows.length > 0 ? rows : undefined;
}

function absolutizeImg(src: string, arxivId: string): string {
  if (/^https?:\/\//.test(src)) return src;
  const p = src.replace(/^\.\//, '').replace(/^\//, '');
  // LaTeXML object data 常带版本目录前缀（2609.34683v1/x.svg）——资源实际挂在版本化路径下，
  // 拼到无版本 base 会 404。识别 <arxivId>vN/ 前缀时改用版本化 base。
  const vm = p.match(new RegExp(`^(${arxivId}v\\d+)/(.+)$`, 'i'));
  if (vm) return `https://arxiv.org/html/${vm[1]}/${vm[2]}`;
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
  let out = s;
  // 两遍：&amp;lt; 先还原成 &lt;，再还原成 <
  for (let i = 0; i < 2; i++) {
    out = out
      .replace(/&nbsp;/g, ' ')
      .replace(/&middot;/g, '·')
      .replace(/&times;/g, '×')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&amp;/g, '&');
  }
  return out;
}

// 行内标签（span/em/a）紧贴字母，不能换成空格。
// LaTeXML 把缩写写成 <span>B</span>idirectional，按标签插空格会显示成「B idirectional」。
function stripTags(s: string): string {
  const t = s
    .replace(/<br\b[^>]*>/gi, ' ')
    .replace(/<\/?(?:span|em|strong|b|i|a|cite|code)\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(t).replace(/\s+/g, ' ').trim();
}

// 脚注整段嵌在段落里。按 span 深度摘掉 ltx_note，正文只留句子，注释放到后面。
function extractNotes(html: string, replaceMath: (s: string) => string): { html: string; notes: string[] } {
  const notes: string[] = [];
  const re = /<span\b[^>]*class="[^"]*\bltx_note\b[^"]*"[^>]*>/gi;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out += html.slice(last, m.index);
    let depth = 1;
    let pos = m.index + m[0].length;
    while (depth > 0 && pos < html.length) {
      const op = html.indexOf('<span', pos);
      const cl = html.indexOf('</span>', pos);
      if (cl === -1) { pos = html.length; break; }
      if (op !== -1 && op < cl) { depth++; pos = html.indexOf('>', op) + 1; }
      else { depth--; pos = cl + 7; }
    }
    const inner = html.slice(m.index + m[0].length, Math.max(m.index + m[0].length, pos - 7));
    const cleaned = inner
      .replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, ' ')
      .replace(/<span\b[^>]*\bltx_tag_note\b[^>]*>[\s\S]*?<\/span>/gi, ' ');
    const text = stripTags(replaceMath(cleaned));
    if (text.length > 2) notes.push(text);
    last = pos;
    re.lastIndex = pos;
  }
  out += html.slice(last);
  return { html: out, notes };
}

// figure 里的内容图。页眉 logo、data: 占位像素不收。
function collectImgSrcs(fragment: string): string[] {
  const out: string[] = [];
  const re = /<(?:img|graphics)\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment)) !== null) {
    const src = (m[0].match(/\b(?:src|xlink:href)="([^"]+)"/i) || [])[1];
    if (!src || /^data:/i.test(src)) continue;
    if (/\/static\/|arxiv-logo|smileybones|\/funders\//i.test(src)) continue;
    out.push(src);
  }
  return out;
}

// 没有图片的 figure：生成样本、标注说明这类排版文本。
function extractFigureProse(figHtml: string, replaceMath: (s: string) => string): string[][] | undefined {
  const body = figHtml.replace(/<figcaption[\s\S]*?<\/figcaption>/gi, '');
  const parts = /<p\b|<br\b/i.test(body) ? body.split(/<br\b[^>]*>|<\/p>/i) : [body];
  const lines: string[][] = [];
  for (const part of parts) {
    const text = stripTags(replaceMath(part));
    if (text.length < 2) continue;
    lines.push([text]);
  }
  if (lines.map(l => l[0]).join(' ').length < 40) return undefined;
  return lines;
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
