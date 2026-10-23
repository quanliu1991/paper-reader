// GitHub 知识库仓库桥：读写本地克隆（如 D:\paper）
// 读：.fulltext 缓存导入、笔记浏览、术语表（glossary/terms.yaml）
// 写：问答对追加到笔记 ❓ Q&A 节（只追加，不重写——遵守仓库 AGENTS.md 归档安全规则）
import fs from 'fs';
import path from 'path';
import { getSetting } from './db';

export function getRepoRoot(): string | null {
  const p = getSetting('repo_path');
  if (p && fs.existsSync(path.join(p, 'AGENTS.md'))) return p;
  return null;
}

export function setRepoRoot(p: string): { ok: boolean; error?: string } {
  if (!fs.existsSync(path.join(p, 'AGENTS.md'))) {
    return { ok: false, error: '未找到 AGENTS.md——请确认这是 paper 知识库仓库的本地克隆' };
  }
  return { ok: true };
}

// ---------- 读：全文缓存 ----------
export function listFulltextFiles(repoRoot: string): Array<{ file: string; arxivId: string }> {
  const dir = path.join(repoRoot, 'notes', 'papers', '.fulltext');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.txt'))
    .map(f => ({ file: f, arxivId: f.replace(/\.txt$/, '') }));
}

export function readFulltext(repoRoot: string, arxivId: string): string | null {
  const p = path.join(repoRoot, 'notes', 'papers', '.fulltext', `${arxivId}.txt`);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

// ---------- 读：笔记列表 ----------
export function listNotes(repoRoot: string): string[] {
  const dir = path.join(repoRoot, 'notes', 'papers');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.md'));
}

export function readNote(repoRoot: string, name: string): string | null {
  const p = path.join(repoRoot, 'notes', 'papers', name);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

// ---------- 读：术语表（供翻译干预）----------
// 极简 YAML 解析：只取 terms: 下的词条（term: level / 解释）。不引 js-yaml 依赖。
export interface GlossaryTerm { term: string; level: string; explain: string }

export function loadGlossary(repoRoot: string): GlossaryTerm[] {
  const p = path.join(repoRoot, 'glossary', 'terms.yaml');
  if (!fs.existsSync(p)) return [];
  const out: GlossaryTerm[] = [];
  let current: GlossaryTerm | null = null;
  let inTerms = false;
  for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^terms:/.test(line)) { inTerms = true; continue; }
    if (!inTerms) continue;
    const nameMatch = line.match(/^  ([^#].+?):\s*$/);
    if (nameMatch) {
      if (current) out.push(current);
      current = { term: nameMatch[1].trim(), level: '', explain: '' };
      continue;
    }
    if (current) {
      const lv = line.match(/level:\s*(\w+)/);
      if (lv) current.level = lv[1];
      const ex = line.match(/解释:\s*(.+)$/);
      if (ex) current.explain = ex[1].trim();
    }
  }
  if (current) out.push(current);
  return out;
}

// ---------- 写：问答对追加到笔记 ----------
// 目标笔记不存在时按 slug 新建；存在时在文件末尾追加「## Q&A（Paper Reader）」节
export function appendQaToNote(
  repoRoot: string,
  paperArxivId: string,
  qa: { question: string; answer: string; date: string }
): { ok: boolean; note?: string; error?: string } {
  const dir = path.join(repoRoot, 'notes', 'papers');
  if (!fs.existsSync(dir)) return { ok: false, error: 'notes/papers 目录不存在' };

  // 找已有笔记：按 arxiv id 匹配 front-matter
  let target: string | null = null;
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.md'))) {
    const content = fs.readFileSync(path.join(dir, f), 'utf8');
    if (content.includes(`arxiv: ${paperArxivId}`) || content.includes(`arxiv:${paperArxivId}`)) {
      target = f; break;
    }
  }
  if (!target) {
    target = `paper-reader-${paperArxivId.replace(/\./g, '-')}.md`;
    const front = `---\n论文: (Paper Reader 导入)\narxiv: ${paperArxivId}\n日期: ${qa.date}\n子方向: inference-other\n状态: App 问答沉淀\n---\n\n# ${paperArxivId}\n`;
    fs.writeFileSync(path.join(dir, target), front, 'utf8');
  }

  const notePath = path.join(dir, target);
  const existing = fs.readFileSync(notePath, 'utf8');
  const section = '\n## Q&A（Paper Reader）\n\n'
    + `> ❓ **Q:** ${qa.question}（${qa.date}，Paper Reader）\n>\n`
    + `> **A:** ${qa.answer}（${qa.date} 答）\n`;
  const header = existing.includes('## Q&A（Paper Reader）') ? '' : section;
  const addition = (existing.includes('## Q&A（Paper Reader）') ? '\n' : '') + section;
  // 简化：首次追加节头+条目，之后只追加条目
  const entry = `> ❓ **Q:** ${qa.question}（${qa.date}，Paper Reader）\n>\n> **A:** ${qa.answer}（${qa.date} 答）\n`;
  const toAppend = existing.includes('## Q&A（Paper Reader）')
    ? `\n${entry}`
    : `\n${'## Q&A（Paper Reader）'}\n\n${entry}`;
  fs.appendFileSync(notePath, toAppend, 'utf8');
  return { ok: true, note: target };
}
