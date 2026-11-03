import path from 'path';
import { build } from 'esbuild';
await build({
  entryPoints: ['src/highlights.ts'],
  bundle: true, platform: 'node', target: 'node20', format: 'esm',
  outfile: 'tests/.tmp-hl/highlights.js', logLevel: 'silent',
  loader: { '.css': 'empty' },
  plugins: [{
    name: 'tsx-ext',
    setup(b) {
      b.onResolve({ filter: /^\.\/components\/RichText$/ }, () => ({ path: path.resolve('src/components/RichText.tsx') }));
    },
  }],
});
const { highlightHtml } = await import('../tests/.tmp-hl/highlights.js');

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}`); }
}

const zh = '推理模型的出现确立了测试时扩展的新范式，但受制于 attention 的二次方复杂度。';
const marked = highlightHtml(zh, [
  { text: '现确立了测试时', color: 'yellow' },
  { text: '确立了测试时扩', color: 'green' },
]);
assert(marked && marked.includes('<mark'), '中文划线会画出来');
assert(marked.includes('确立了测试时扩'), '重叠片段合成后仍保留更长的那句');
assert((marked.match(/<mark/g) || []).length === 1, '重叠划线只画一段，不再切碎');
assert(highlightHtml(zh, [{ text: 'this is english only', color: 'yellow' }]) === null, '对不上的一侧不替换原文');
const math = highlightHtml('注意力是 $O(L^2)$，所以长上下文很贵。', [{ text: '长上下文很贵', color: 'blue' }]);
assert(math && math.includes('katex') && math.includes('长上下文很贵'), '划线段落里的公式仍用 KaTeX');

console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
