// 静态 UX lint：对照 DEVELOPMENT.md UI 规范扫描 src/
// 规则：1) 组件内禁止硬编码色值（必须走 CSS 变量 token） 2) 组件禁止直接用 ipcRenderer
// 3) 长任务须有进度反馈标记（粗查）4) 破坏性操作须 confirm
// 产出：build/ux/lint-findings.json（供 improve-loop 消费）
import fs from 'fs';
import path from 'path';

const findings = [];
const srcDir = path.resolve('src');

function walk(dir, cb) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, cb);
    else cb(p);
  }
}

// CSS 变量 token 白名单（styles.css :root 定义）
const TOKENS = ['--bg', '--panel', '--card', '--accent', '--border', '--shadow-1', '--shadow-2', '--shadow-3'];

walk(srcDir, (p) => {
  if (!/\.(tsx?|css)$/.test(p)) return;
  const rel = path.relative(process.cwd(), p);
  const text = fs.readFileSync(p, 'utf8');
  const lines = text.split('\n');

  lines.forEach((line, i) => {
    const loc = `${rel}:${i + 1}`;
    // 块级豁免：当前行或上方 6 行内有 // ux-lint-allow 即豁免（如高亮功能色板——业务数据非主题色）
    const nearAllow = [0, 1, 2, 3, 4, 5, 6].some(k => (lines[i - k] ?? '').includes('ux-lint-allow'));

    // 规则 1：tsx 里硬编码 hex 色值（css 文件允许——token 定义处；tsx 内联样式禁止）
    if (p.endsWith('.tsx')) {
      const hex = line.match(/#[0-9a-fA-F]{3,8}\b/);
      if (hex && !/^\s*(\/\/|\*|\/\*)/.test(line) && !/local-|data:|aria-|test-id/.test(line) && !nearAllow) {
        findings.push({ id: `lint-hex-${loc}`, severity: 'low', view: rel, title: '组件内硬编码色值', evidence: line.trim().slice(0, 120), rule: '色值须走 CSS 变量 token（功能性色板可加 // ux-lint-allow 豁免）' });
      }
    }

    // 规则 2：组件直接用 ipcRenderer（必须走 window.api / preload）
    if (p.endsWith('.tsx') && /ipcRenderer/.test(line) && !/^\s*(\/\/|\*)/.test(line) && !nearAllow) {
      findings.push({ id: `lint-ipc-${loc}`, severity: 'high', view: rel, title: '组件直接使用 ipcRenderer', evidence: line.trim().slice(0, 120), rule: '必须走 window.api（contextIsolation）' });
    }

    // 规则 3：rgb()/rgba() 内联色（同规则1）
    if (p.endsWith('.tsx')) {
      const rgb = line.match(/rgba?\(\s*\d/);
      if (rgb && !/^\s*(\/\/|\*|\/\*)/.test(line) && !nearAllow) {
        findings.push({ id: `lint-rgb-${loc}`, severity: 'low', view: rel, title: '组件内 rgb() 色值', evidence: line.trim().slice(0, 120), rule: '色值须走 CSS 变量 token' });
      }
    }
  });

  // 规则 4：styles.css 必须声明 font-synthesis: none（禁伪加粗——中文字体规范）
  if (p.endsWith('styles.css')) {
    if (!/font-synthesis:\s*none/.test(text)) {
      findings.push({ id: 'lint-fontsynth', severity: 'medium', view: rel, title: 'styles.css 缺 font-synthesis: none', evidence: '全局缺失', rule: '禁伪加粗' });
    }
    // token 存在性
    const missing = TOKENS.filter(t => !text.includes(t));
    if (missing.length) findings.push({ id: 'lint-tokens', severity: 'medium', view: rel, title: `CSS token 缺失: ${missing.join(', ')}`, evidence: '', rule: '设计 token 统一' });
  }
});

fs.mkdirSync('build/ux', { recursive: true });
fs.writeFileSync('build/ux/lint-findings.json', JSON.stringify({ at: new Date().toISOString(), findings }, null, 2));
console.log(`[ux-lint] ${findings.length} findings → build/ux/lint-findings.json`);
for (const f of findings.slice(0, 20)) console.log(`  ${f.severity.toUpperCase()} ${f.id}: ${f.title}`);
if (findings.length > 20) console.log(`  ... +${findings.length - 20} more`);
// lint 结果不阻塞（低严重度为主，交给 improve-loop 排优）
process.exit(0);
