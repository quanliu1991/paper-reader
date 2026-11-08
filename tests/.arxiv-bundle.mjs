// electron/net.ts
async function fetchWithRetry(url, opts = {}) {
  const { timeout = 6e4, retries = 2, headers = {} } = opts;
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const resp = await fetch(url, { headers, signal: ctl.signal });
      clearTimeout(timer);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.text();
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (i < retries) await sleep(1500 * (i + 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// electron/arxiv.ts
function normalizeArxivId(input) {
  const s = input.trim();
  const m = s.match(/(\d{4}\.\d{4,5})(v\d+)?/);
  if (!m) return null;
  return m[1];
}
async function fetchAndParse(arxivId) {
  const htmlUrl = `https://arxiv.org/html/${arxivId}`;
  let html = null;
  try {
    html = await fetchWithRetry(htmlUrl, { timeout: 6e4, retries: 2 });
  } catch {
  }
  if (html && html.length > 5e3 && /<html/i.test(html)) {
    const parsed = parseArxivHtml(html, arxivId);
    if (parsed.blocks.length > 20) return parsed;
  }
  const err = new Error("NO_HTML_VERSION");
  err.code = "NO_HTML_VERSION";
  err.hint = `arXiv ${arxivId} \u6CA1\u6709 HTML \u7248\uFF08\u5E38\u89C1\u4E8E\u8001\u8BBA\u6587\uFF09\u3002\u4E24\u6761\u66FF\u4EE3\u8DEF\u5F84\uFF1A
1) \u5728\u77E5\u8BC6\u5E93\u7CBE\u8BFB\u540E\u4ECE .fulltext \u7F13\u5B58\u5BFC\u5165\uFF08\u8BBE\u7F6E \u2192 \u4ED3\u5E93\u8FDE\u63A5\uFF09
2) \u624B\u52A8\u7C98\u8D34\u8BBA\u6587\u6587\u672C\u5BFC\u5165`;
  throw err;
}
function parseArxivHtml(html, arxivId) {
  const title = extractTitle(html);
  const authors = extractAuthors(html);
  const blocks = [];
  let seq = 0;
  const art = html.match(/<article[^>]*>([\s\S]*)<\/article>/i) || html.match(/<article[^>]*>([\s\S]*)/i);
  const cleaned0 = art ? art[1] : html;
  const cleaned = cleaned0.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<form[\s\S]*?<\/form>/gi, "").replace(/<nav[\s\S]*?<\/nav>/gi, "").replace(/<button[\s\S]*?<\/button>/gi, "").replace(/<annotation[\s\S]*?<\/annotation>/gi, "");
  const NOISE = /^(report (github )?issue|back to abstract|download pdf|have a free development|our team has already|content selection saved|click on the|colour theme|toggle navigation)/i;
  const TOC_LINE = /^(\d+(\.\d+)*\s+[A-Za-z][^0-9]+){4,}/;
  const mathRe = /<math([^>]*)>([\s\S]*?)<\/math>/gi;
  function replaceMath(source) {
    return source.replace(mathRe, (_m, attrs) => {
      const alt = (attrs.match(/alttext="([^"]*)"/) || [])[1];
      if (!alt) return " [\u516C\u5F0F] ";
      const isBlock = /display="block"/.test(attrs);
      const tex = decodeEntities(alt);
      return isBlock ? ` $$${tex}$$ ` : ` $${tex}$ `;
    });
  }
  const pushFig = (en, figPath, figKind, rows, htmlTable) => {
    blocks.push({
      seq: seq++,
      type: "fig",
      level: 0,
      en,
      figPath,
      figKind,
      figHtmlTable: htmlTable || void 0,
      figTableRows: rows
    });
  };
  const re = /<(h[1-6])[^>]*>([\s\S]*?)<\/\1>|<p[^>]*>([\s\S]*?)<\/p>|<(table|div)[^>]*class="[^"]*ltx_equation[^"]*"[^>]*>([\s\S]*?)<\/\4>|<figure[^>]*>([\s\S]*?)<\/figure>|<img\b[^>]*>/gi;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    if (m[1]) {
      const level = Number(m[1][1]);
      const text = stripTags(replaceMath(m[2])).trim();
      if (!text || NOISE.test(text)) continue;
      blocks.push({ seq: seq++, type: "heading", level, en: text });
    } else if (m[3] !== void 0) {
      const pulled = extractNotes(m[3], replaceMath);
      for (const src of collectImgSrcs(pulled.html)) pushFig("", absolutizeImg(src, arxivId), "figure");
      const text = stripTags(replaceMath(pulled.html)).trim();
      const drop = !text || NOISE.test(text) || TOC_LINE.test(text) && text.length > 200 || text.length < 2 || /^\d{1,4}$/.test(text) || /hereby grants permission to reproduce/i.test(text);
      if (!drop) blocks.push({ seq: seq++, type: "para", level: 0, en: text });
      for (const note of pulled.notes) blocks.push({ seq: seq++, type: "para", level: 0, en: note });
    } else if (m[5] !== void 0) {
      const text = stripTags(replaceMath(m[5])).trim();
      if (text && /\$\$/.test(text)) {
        blocks.push({ seq: seq++, type: "para", level: 0, en: text });
      }
    } else if (m[6] !== void 0) {
      const figHtml = m[6];
      const figClass = (m[0].match(/class="([^"]*)"/) || [])[1] ?? "";
      const kind = /ltx_table/.test(figClass) ? "table" : "figure";
      const capMatch = figHtml.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i);
      const capPulled = extractNotes(capMatch ? capMatch[1] : "", replaceMath);
      const cap = stripTags(replaceMath(capPulled.html)).trim();
      const capOk = !!cap && !NOISE.test(cap);
      const pushCapNotes = () => {
        for (const note of capPulled.notes) blocks.push({ seq: seq++, type: "para", level: 0, en: note });
      };
      const srcs = collectImgSrcs(figHtml).map((s) => absolutizeImg(s, arxivId));
      if (srcs.length) {
        srcs.forEach((src, idx) => {
          const en = idx === 0 ? capOk ? cap : kind === "table" ? "\u8868\u683C" : "\u56FE" : " ";
          pushFig(en, src, kind);
        });
        pushCapNotes();
        continue;
      }
      const objMatch = figHtml.match(/<object[^>]*type="image\/svg\+xml"[^>]*data="([^"]+)"[^>]*>/i) || figHtml.match(/<object[^>]*data="([^"]+\.svg)"[^>]*>/i);
      const img = objMatch && !/^data:/i.test(objMatch[1]) ? absolutizeImg(objMatch[1], arxivId) : "";
      const hasSvg = /<svg/i.test(figHtml);
      const listingRows = !img && !hasSvg ? extractListingLines(figHtml, replaceMath) : void 0;
      const tableRows = !img && !hasSvg && !listingRows && /ltx_tabular/i.test(figHtml) ? extractTableRows(figHtml) : void 0;
      const proseRows = !img && !hasSvg && !listingRows && !tableRows ? extractFigureProse(figHtml, replaceMath) : void 0;
      const rows = listingRows || tableRows || proseRows;
      if (img || hasSvg || rows) {
        pushFig(
          capOk ? cap : kind === "table" ? "\u8868\u683C" : "\u56FE",
          img || (hasSvg ? "inline:" : void 0),
          kind,
          rows,
          !!tableRows
        );
        pushCapNotes();
      } else if (capOk) {
        const prev = blocks[blocks.length - 1];
        if (prev && prev.type === "fig" && prev.figPath && !prev.en.trim()) prev.en = cap;
        else pushFig(cap, void 0, kind);
        pushCapNotes();
      }
    } else if (/^<img\b/i.test(m[0])) {
      for (const src of collectImgSrcs(m[0])) pushFig("", absolutizeImg(src, arxivId), "figure");
    }
  }
  return { arxivId, title, authors, blocks, importType: "html" };
}
async function downloadFigures(paperId, arxivId, html, figuresDir) {
  const fs = await import("fs");
  const path = await import("path");
  const result = /* @__PURE__ */ new Map();
  fs.mkdirSync(figuresDir, { recursive: true });
  const figs = html.match(/<figure[^>]*>[\s\S]*?<\/figure>/gi) || [];
  let i = 0;
  for (const figHtml of figs) {
    i++;
    const imgMatch = figHtml.match(/<(?:img|graphics)[^>]*(?:xlink:href|src)="([^"]+)"[^>]*>/i);
    let src = imgMatch ? imgMatch[1] : "";
    if (!src || /^data:/.test(src)) {
      continue;
    }
    const url = absolutizeImg(src, arxivId);
    const ext = (url.match(/\.(svg|png|jpg|jpeg|gif)$/i) || [, "png"])[1];
    const fname = `fig-${i}.${ext}`;
    const dest = path.join(figuresDir, fname);
    try {
      await downloadToFile(url, dest);
      result.set(i, fname);
    } catch {
    }
  }
  return result;
}
async function downloadToFile(url, dest) {
  const fs = await import("fs");
  const resp = await fetch(url, { signal: AbortSignal.timeout(3e4) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(dest, buf);
}
function extractListingLines(figHtml, replaceMath) {
  if (!/ltx_listingline/i.test(figHtml)) return void 0;
  const lines = [];
  const re = /<div[^>]*class="[^"]*\bltx_listingline\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let m;
  while ((m = re.exec(figHtml)) !== null) {
    const mathDone = replaceMath(m[1]);
    const indented = /[\u2002\u2003]/.test(mathDone.slice(0, 160));
    let text = stripTags(mathDone).replace(/^\d+\s*:\s*/, "");
    if (!text) continue;
    lines.push([indented ? `    ${text}` : text]);
  }
  return lines.length ? lines : void 0;
}
function extractTableRows(figHtml) {
  const cellText = (raw) => {
    const withMath = raw.replace(/<math([^>]*)>([\s\S]*?)<\/math>/gi, (_x, attrs) => {
      const alt = (attrs.match(/alttext="([^"]*)"/) || [])[1];
      return alt ? ` $${decodeEntities(alt)}$ ` : " ";
    });
    return " " + stripTags(withMath) + " ";
  };
  const spanBlocks = (fragment, cls) => {
    const out = [];
    const re = new RegExp(`<span[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>`, "g");
    let m;
    while ((m = re.exec(fragment)) !== null) {
      const start = m.index + m[0].length;
      let depth = 1;
      let pos = start;
      while (depth > 0 && pos < fragment.length) {
        const op = fragment.indexOf("<span", pos);
        const cl = fragment.indexOf("</span>", pos);
        if (cl === -1) return out;
        if (op !== -1 && op < cl) {
          depth++;
          pos = fragment.indexOf(">", op) + 1;
        } else {
          depth--;
          pos = cl + 7;
        }
      }
      out.push(fragment.slice(start, pos - 7));
      re.lastIndex = pos;
    }
    return out;
  };
  const tableMatch = figHtml.match(/<table[^>]*ltx_tabular[^>]*>([\s\S]*?)<\/table>/i);
  if (tableMatch) {
    const rows2 = [];
    for (const tr of tableMatch[1].match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) ?? []) {
      const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m2) => cellText(m2[1]));
      if (cells.length) rows2.push(cells);
    }
    if (rows2.length) return rows2;
  }
  const rows = [];
  for (const tr of spanBlocks(figHtml, "ltx_tr")) {
    const cells = spanBlocks(tr, "ltx_td").map(cellText);
    if (cells.length) rows.push(cells);
  }
  return rows.length > 0 ? rows : void 0;
}
function absolutizeImg(src, arxivId) {
  if (/^https?:\/\//.test(src)) return src;
  const p = src.replace(/^\.\//, "").replace(/^\//, "");
  const vm = p.match(new RegExp(`^(${arxivId}v\\d+)/(.+)$`, "i"));
  if (vm) return `https://arxiv.org/html/${vm[1]}/${vm[2]}`;
  return `https://arxiv.org/html/${arxivId}/${p}`;
}
function parsePlainText(text, arxivId, title) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let seq = 0;
  let buf = [];
  const flush = () => {
    const t = buf.join(" ").trim();
    if (t.length > 1) {
      const isHeading = t.length < 80 && /^(abstract|references|appendix|[0-9]+\.|chapter| acknowledg)/i.test(t);
      blocks.push({ seq: seq++, type: isHeading ? "heading" : "para", level: isHeading ? 2 : 0, en: t });
    }
    buf = [];
  };
  for (const line of lines) {
    if (line.trim() === "") flush();
    else buf.push(line.trim());
  }
  flush();
  return { arxivId, title: title || arxivId, authors: "", blocks, importType: "text" };
}
function decodeEntities(s) {
  let out = s;
  for (let i = 0; i < 2; i++) {
    out = out.replace(/&nbsp;/g, " ").replace(/&middot;/g, "\xB7").replace(/&times;/g, "\xD7").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/&amp;/g, "&");
  }
  return out;
}
function stripTags(s) {
  const t = s.replace(/<br\b[^>]*>/gi, " ").replace(/<\/?(?:span|em|strong|b|i|a|cite|code)\b[^>]*>/gi, "").replace(/<[^>]+>/g, " ");
  return decodeEntities(t).replace(/\s+/g, " ").trim();
}
function extractNotes(html, replaceMath) {
  const notes = [];
  const re = /<span\b[^>]*class="[^"]*\bltx_note\b[^"]*"[^>]*>/gi;
  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(html)) !== null) {
    out += html.slice(last, m.index);
    let depth = 1;
    let pos = m.index + m[0].length;
    while (depth > 0 && pos < html.length) {
      const op = html.indexOf("<span", pos);
      const cl = html.indexOf("</span>", pos);
      if (cl === -1) {
        pos = html.length;
        break;
      }
      if (op !== -1 && op < cl) {
        depth++;
        pos = html.indexOf(">", op) + 1;
      } else {
        depth--;
        pos = cl + 7;
      }
    }
    const inner = html.slice(m.index + m[0].length, Math.max(m.index + m[0].length, pos - 7));
    const cleaned = inner.replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, " ").replace(/<span\b[^>]*\bltx_tag_note\b[^>]*>[\s\S]*?<\/span>/gi, " ");
    const text = stripTags(replaceMath(cleaned));
    if (text.length > 2) notes.push(text);
    last = pos;
    re.lastIndex = pos;
  }
  out += html.slice(last);
  return { html: out, notes };
}
function collectImgSrcs(fragment) {
  const out = [];
  const re = /<(?:img|graphics)\b[^>]*>/gi;
  let m;
  while ((m = re.exec(fragment)) !== null) {
    const src = (m[0].match(/\b(?:src|xlink:href)="([^"]+)"/i) || [])[1];
    if (!src || /^data:/i.test(src)) continue;
    if (/\/static\/|arxiv-logo|smileybones|\/funders\//i.test(src)) continue;
    out.push(src);
  }
  return out;
}
function extractFigureProse(figHtml, replaceMath) {
  const body = figHtml.replace(/<figcaption[\s\S]*?<\/figcaption>/gi, "");
  const parts = /<p\b|<br\b/i.test(body) ? body.split(/<br\b[^>]*>|<\/p>/i) : [body];
  const lines = [];
  for (const part of parts) {
    const text = stripTags(replaceMath(part));
    if (text.length < 2) continue;
    lines.push([text]);
  }
  if (lines.map((l) => l[0]).join(" ").length < 40) return void 0;
  return lines;
}
function extractTitle(html) {
  const h1 = html.match(/<h1[^>]*class="[^"]*ltx_title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return stripTags(h1[1]).trim();
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return t ? stripTags(t[1]).trim() : "Untitled";
}
function extractAuthors(html) {
  const m = html.match(/<div[^>]*class="[^"]*ltx_authors[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (!m) return "";
  return stripTags(m[1]).replace(/\s+/g, " ").trim().slice(0, 500);
}
export {
  downloadFigures,
  fetchAndParse,
  normalizeArxivId,
  parseArxivHtml,
  parsePlainText
};
