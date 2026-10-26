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
  const re = /<(h[1-6])[^>]*>([\s\S]*?)<\/\1>|<p[^>]*>([\s\S]*?)<\/p>|<(table|div)[^>]*class="[^"]*ltx_equation[^"]*"[^>]*>([\s\S]*?)<\/\4>|<figure[^>]*>([\s\S]*?)<\/figure>/gi;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    if (m[1]) {
      const level = Number(m[1][1]);
      const text = stripTags(replaceMath(m[2])).trim();
      if (!text || NOISE.test(text)) continue;
      blocks.push({ seq: seq++, type: "heading", level, en: text });
    } else if (m[3] !== void 0) {
      const text = stripTags(replaceMath(m[3])).trim();
      if (!text || NOISE.test(text)) continue;
      if (TOC_LINE.test(text) && text.length > 200) continue;
      if (text.length < 2) continue;
      blocks.push({ seq: seq++, type: "para", level: 0, en: text });
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
      const cap = capMatch ? stripTags(replaceMath(capMatch[1])).trim() : "";
      const imgMatch = figHtml.match(/<(?:img|graphics)[^>]*(?:xlink:href|src)="([^"]+)"[^>]*>/i);
      let img = imgMatch ? imgMatch[1] : "";
      if (img && !/^data:/.test(img)) img = absolutizeImg(img, arxivId);
      const hasSvg = /<svg/i.test(figHtml);
      if (cap && !NOISE.test(cap) || img || hasSvg) {
        blocks.push({
          seq: seq++,
          type: "fig",
          level: 0,
          en: cap || (kind === "table" ? "\u8868\u683C" : "\u56FE"),
          figPath: img || void 0,
          figKind: kind
        });
      }
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
function absolutizeImg(src, arxivId) {
  if (/^https?:\/\//.test(src)) return src;
  const p = src.replace(/^\.\//, "").replace(/^\//, "");
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
  return s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
function stripTags(s) {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
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
