// 测试 fetchAndParse 对 text 论文能否拿到 HTML
import { build } from 'esbuild';
await build({
  entryPoints: ['electron/arxiv.ts'],
  bundle: true, platform: 'node', format: 'esm',
  outfile: 'tests/.arxiv-bundle2.mjs', external: ['electron'], logLevel: 'silent',
});
const arxiv = await import('../tests/.arxiv-bundle2.mjs');
for (const id of ['2609.34683', '2610.24133', '2610.28577']) {
  try {
    const r = await arxiv.fetchAndParse(id);
    console.log(`${id}: importType=${r.importType}, title=${r.title.slice(0, 50)}, blocks=${r.blocks.length}`);
  } catch (e) {
    console.log(`${id}: ERROR ${e.message}`);
  }
}
