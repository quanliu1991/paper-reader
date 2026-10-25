"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// scripts/test-arxiv-entry.ts
var test_arxiv_entry_exports = {};
__export(test_arxiv_entry_exports, {
  default: () => run
});
module.exports = __toCommonJS(test_arxiv_entry_exports);
var import_fs = __toESM(require("fs"));

// electron/arxiv.ts
function normalizeArxivId(input) {
  const s = input.trim();
  const m = s.match(/(\d{4}\.\d{4,5})(v\d+)?/);
  if (!m) return null;
  return m[1];
}
function parseArxivHtml(html, arxivId) {
  const title = extractTitle(html);
  const authors = extractAuthors(html);
  const blocks = [];
  let seq = 0;
  const art = html.match(/<article[^>]*>([\s\S]*)<\/article>/i) || html.match(/<article[^>]*>([\s\S]*)/i);
  const cleaned0 = art ? art[1] : html;
  const cleaned = cleaned0.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<form[\s\S]*?<\/form>/gi, "").replace(/<nav[\s\S]*?<\/nav>/gi, "").replace(/<button[\s\S]*?<\/button>/gi, "").replace(/<annotation[\s\S]*?<\/annotation>/gi, "");
  const NOISE = /^(report (github )?issue|back to abstract|download pdf|have a free development|our team has already|content selection saved|click on the)/i;
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
function absolutizeImg(src, arxivId) {
  if (/^https?:\/\//.test(src)) return src;
  const p = src.replace(/^\.\//, "").replace(/^\//, "");
  return `https://arxiv.org/html/${arxivId}/${p}`;
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

// scripts/test-arxiv-entry.ts
var log = (s) => {
  if (process.env.PR_LOG) import_fs.default.appendFileSync(process.env.PR_LOG, s + "\n");
  else console.log(s);
};
var done = () => {
  if (process.env.PR_DONE) import_fs.default.writeFileSync(process.env.PR_DONE, "1");
};
async function run() {
  const html = import_fs.default.readFileSync("D:/paper-reader-app/tests-sample.html", "utf8");
  const parsed = parseArxivHtml(html, "2609.34683");
  log(`title: ${parsed.title.slice(0, 60)}`);
  log(`blocks: ${parsed.blocks.length}`);
  const heads = parsed.blocks.filter((b) => b.type === "heading").length;
  const paras = parsed.blocks.filter((b) => b.type === "para").length;
  const figs = parsed.blocks.filter((b) => b.type === "fig").length;
  log(`headings: ${heads}, paras: ${paras}, figs: ${figs}`);
  const mathCount = parsed.blocks.filter((b) => /\$[^$]+\$/.test(b.en)).length;
  const blockMath = parsed.blocks.filter((b) => /\$\$[\s\S]+\$\$/.test(b.en)).length;
  log(`paras with math: ${mathCount}, paras with block math: ${blockMath}`);
  const noise = parsed.blocks.filter((b) => /report issue|back to abstract|download pdf/i.test(b.en));
  log(`noise blocks: ${noise.length}`);
  log("\nfirst 4:");
  for (const b of parsed.blocks.slice(0, 4)) log(`  [${b.type}] ${b.en.slice(0, 80)}`);
  log("\na para with block math:");
  const mp = parsed.blocks.find((b) => b.type === "para" && /\$\$/.test(b.en));
  if (mp) log(`  ${mp.en.slice(0, 200)}`);
  log("\nlast 2:");
  for (const b of parsed.blocks.slice(-2)) log(`  [${b.type}] ${b.en.slice(0, 80)}`);
  log("\nnormalize: " + ["2609.34683", "https://arxiv.org/abs/2609.34683", "bad"].map(normalizeArxivId).join(" | "));
  done();
  if (process.env.PR_DONE) process.exit(0);
}
run().catch((e) => {
  log(`FATAL: ${e.stack}`);
  done();
  process.exit(1);
});
