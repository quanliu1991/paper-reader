// vault-format：与 electron/vault.ts 格式对齐的轻量解析（Web 端唯一格式代码）。
// 契约：docs/superpowers/plans/2026-11-08-vault-storage-p1-p2.md「格式契约」节。
// 对齐测试：tests/vault-format-align.test.mjs（同 fixture 双侧 round-trip）

export function srcHash(en: string): string {
  // Web 端无 node:crypto——SHA-256 用 SubtleCrypto 是异步的；
  // 对齐测试只验证解析/序列化行为，srcHash 仅作展示用途（截断指纹即可）
  let h = 0;
  const norm = (en ?? '').replace(/\$[^$]*\$/g, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < norm.length; i++) h = (h * 31 + norm.charCodeAt(i)) | 0;
  return `fnv${(h >>> 0).toString(16)}`;
}

// meta.yaml 的最小 YAML 子集解析（键: 值 + 一层嵌套 + 内联数组）
// vault meta.yaml 由 YAML.stringify 生成，形状固定；此处只解析已知键。
export function parseMeta(text: string): any {
  const out: any = { tags: [], pdf: {} };
  let section = '';
  let listKey: string | null = null;
  const listItems: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    // 多行数组项（- item）
    const li = line.match(/^\s+-\s+(.*)$/);
    if (li && listKey) { listItems.push(String(coerce(li[1]))); continue; }
    if (listKey) { out[listKey] = listItems; listKey = null; }
    const indent = line.length - line.trimStart().length;
    const m = line.match(/^(\s*)([\w.]+):\s*(.*)$/);
    if (!m) continue;
    const [, , key, valRaw] = m;
    const val = valRaw.trim();
    if (indent === 0) {
      section = key;
      if (val === '') {
        if (key === 'pdf' || key === 'summary') out[key] = {};
        else if (Array.isArray(out[key]) || key === 'tags') listKey = key; // 后续行可能是 - item
        continue;
      }
      out[key] = coerce(val);
    } else if (section === 'pdf' || section === 'summary') {
      out[section] = out[section] ?? {};
      out[section][key] = coerce(val);
    }
  }
  if (listKey) out[listKey] = listItems;
  if (!out.pdf) out.pdf = {};
  return out;
}

function coerce(v: string): any {
  if (v === 'null' || v === '~') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  // 去引号
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    return v.slice(1, -1);
  }
  // YAML 内联数组 [a, b]
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map(s => coerce(s.trim()));
  }
  return v;
}

// notes.md：定界行解析（对齐 NOTE_RE）
const NOTE_RE = /^<!--\s*note\s+sid=(\S+)\s+legacy=(\d+)\s+seq=(\S*)\s+created=(.+?)\s+updated=(.+?)\s*-->$/;
export function parseNotes(text: string): any[] {
  if (!text?.trim()) return [];
  const out: any[] = [];
  const lines = text.split('\n');
  let cur: any = null;
  const body: string[] = [];
  const flush = () => {
    if (cur) { cur.text = body.join('\n').replace(/\n+$/, ''); out.push(cur); }
    cur = null; body.length = 0;
  };
  let inBody = false;
  for (const line of lines) {
    const m = line.trim().match(NOTE_RE);
    if (m) {
      flush();
      cur = { sid: m[1], legacy_id: Number(m[2]), seq: m[3] === '' ? null : Number(m[3]), created_at: m[4], updated_at: m[5], text: '' };
      inBody = true;
    } else if (inBody && cur) body.push(line);
  }
  flush();
  return out;
}

// digest.md
const DIGEST_HEAD_RE = /^<!--\s*digest\s+kind=(\S+)\s+updated=(.+?)\s*-->$/;
export function parseDigest(text: string): { body: string; updated_at: string } | null {
  if (!text?.trim()) return null;
  const lines = text.split('\n');
  const m = lines[0].trim().match(DIGEST_HEAD_RE);
  if (!m) return { body: text, updated_at: '' };
  return { body: lines.slice(1).join('\n').replace(/\n+$/, ''), updated_at: m[2] };
}

// JSONL 公共
function parseJsonl(text: string): any[] {
  if (!text?.trim()) return [];
  const out: any[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 跳过损坏行 */ }
  }
  return out;
}
export const parseQa = parseJsonl;
export const parseTranslations = parseJsonl;
export const parseFlashcards = parseJsonl;
export function parseAnnotations(text: string): any[] {
  if (!text?.trim()) return [];
  try { const o = JSON.parse(text); return Array.isArray(o?.items) ? o.items : []; } catch { return []; }
}

// annotations 序列化（Task 27 回写用，必须与 electron/vault.ts 字节级一致）
export function serializeAnnotations(items: any[]): string {
  return JSON.stringify({ version: 1, items }, null, 2) + '\n';
}
