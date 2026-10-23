import fs from 'fs';
import { parseArxivHtml, normalizeArxivId } from '../electron/arxiv';

const log = (s: string) => { if (process.env.PR_LOG) fs.appendFileSync(process.env.PR_LOG, s + '\n'); else console.log(s); };
const done = () => { if (process.env.PR_DONE) fs.writeFileSync(process.env.PR_DONE, '1'); };

export default async function run() {
  const html = fs.readFileSync('D:/paper-reader-app/tests-sample.html', 'utf8');
  const parsed = parseArxivHtml(html, '2609.34683');
  log(`title: ${parsed.title.slice(0, 60)}`);
  log(`blocks: ${parsed.blocks.length}`);
  const heads = parsed.blocks.filter(b => b.type === 'heading').length;
  const paras = parsed.blocks.filter(b => b.type === 'para').length;
  const figs = parsed.blocks.filter(b => b.type === 'fig').length;
  log(`headings: ${heads}, paras: ${paras}, figs: ${figs}`);
  const mathCount = parsed.blocks.filter(b => /\$[^$]+\$/.test(b.en)).length;
  const blockMath = parsed.blocks.filter(b => /\$\$[\s\S]+\$\$/.test(b.en)).length;
  log(`paras with math: ${mathCount}, paras with block math: ${blockMath}`);
  const noise = parsed.blocks.filter(b => /report issue|back to abstract|download pdf/i.test(b.en));
  log(`noise blocks: ${noise.length}`);
  log('\nfirst 4:');
  for (const b of parsed.blocks.slice(0, 4)) log(`  [${b.type}] ${b.en.slice(0, 80)}`);
  log('\na para with block math:');
  const mp = parsed.blocks.find(b => b.type === 'para' && /\$\$/.test(b.en));
  if (mp) log(`  ${mp.en.slice(0, 200)}`);
  log('\nlast 2:');
  for (const b of parsed.blocks.slice(-2)) log(`  [${b.type}] ${b.en.slice(0, 80)}`);
  log('\nnormalize: ' + ['2609.34683', 'https://arxiv.org/abs/2609.34683', 'bad'].map(normalizeArxivId).join(' | '));
  done();
  if (process.env.PR_DONE) process.exit(0);
}

run().catch(e => { log(`FATAL: ${e.stack}`); done(); process.exit(1); });
