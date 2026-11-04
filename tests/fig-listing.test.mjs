import { build } from 'esbuild';
import fs from 'fs';

await build({
  entryPoints: ['electron/arxiv.ts'],
  bundle: true, platform: 'node', target: 'node20', format: 'esm',
  outfile: 'tests/.tmp-align/arxiv.js', logLevel: 'silent',
});
const { parseArxivHtml } = await import('../tests/.tmp-align/arxiv.js');

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}`); }
}

const mini = `<article>
<p>${'This is a paragraph of the paper. '.repeat(8)}</p>
<figure class="ltx_float ltx_float_algorithm">
<figcaption>Algorithm 1 Muon Optimizer</figcaption>
<div class="ltx_listingline"><span class="ltx_tag ltx_tag_listingline"><span>1:</span></span>
Learning rate <math alttext="\\eta" display="inline"><mi>η</mi></math>, momentum</div>
<div class="ltx_listingline"><span class="ltx_tag ltx_tag_listingline"><span>3:</span></span>
\u2003\u2002<span class="ltx_text ltx_font_bold">for</span> each step</div>
</figure>
</article>`;
const miniParsed = parseArxivHtml(mini, '2606.19348');
const alg = miniParsed.blocks.find(b => b.type === 'fig');
assert(alg && !alg.figPath, '算法块没有图片地址');
assert(alg?.figTableRows?.length === 2, '算法按行抽出');
assert(alg?.figTableRows?.[0][0].includes('$\\eta$'), '行内公式保留成 LaTeX');
assert(alg?.figTableRows?.[1][0].startsWith('    for'), '嵌套步骤保留缩进，不再显示成下载中');

if (fs.existsSync('/tmp/v4.html')) {
  const full = parseArxivHtml(fs.readFileSync('/tmp/v4.html', 'utf8'), '2606.19348');
  const real = full.blocks.find(b => b.type === 'fig' && /Muon Optimizer/.test(b.en));
  assert(real && real.figTableRows?.length > 8, 'DeepSeek-V4 的 Algorithm 1 抽出多行');
  assert(real?.figTableRows?.some(r => /eta|\\eta|Newton/.test(r[0])), '算法正文在，不只是标题');
  const stillImage = full.blocks.filter(b => b.type === 'fig' && !b.figPath && !b.figTableRows && !(b.en || '').trim());
  assert(stillImage.length === 0, '没有既无图也无图注的空块');
}

const words = `<article><p>We introduce BERT , which stands for <span class="ltx_text ltx_font_bold">B</span>idirectional <span class="ltx_text ltx_font_bold">E</span>ncoder. Fish &amp; chips &middot; served.</p></article>`;
const joined = parseArxivHtml(words, '1810.04805');
const para = joined.blocks.find(b => b.type === 'para');
assert(para && para.en.includes('Bidirectional Encoder'), '小写字母紧贴的缩写不再被拆开');
assert(para && !para.en.includes('B idirectional'), '缩写中间没有多余空格');
assert(para && para.en.includes('Fish & chips · served'), '正文里的 &amp; 和 &middot; 要还原');

const panels = `<article><figure class="ltx_figure"><img src="1706.03762v7/Figures/a.png"><img src="1706.03762v7/Figures/ModalNet-20.png"><figcaption>Figure 2: Model architecture with multi-head attention.</figcaption></figure></article>`;
const panelParsed = parseArxivHtml(panels, '1706.03762');
const panelFigs = panelParsed.blocks.filter(b => b.type === 'fig');
assert(panelFigs.length === 2, '同一张 figure 里的两张子图都保留');
assert(/ModalNet-20\.png$/.test(panelFigs[1].figPath || ''), '第二张子图地址还在');
assert(panelFigs[1].en.trim() === '', '续图不重复图注');

const teaser = `<article><div class="ltx_para"><img src="2304.02643v1/teaser.png" alt="[Uncaptioned image]"></div><figure class="ltx_figure"><figcaption>Figure 1: We aim to build a foundation model for segmentation.</figcaption></figure></article>`;
const teaserParsed = parseArxivHtml(teaser, '2304.02643');
const teaserFigs = teaserParsed.blocks.filter(b => b.type === 'fig');
assert(teaserFigs.length === 1, '图注单独成 figure 时并回前面的裸图');
assert(/teaser\.png$/.test(teaserFigs[0].figPath || ''), 'teaser 图片地址保留');
assert(teaserFigs[0].en.startsWith('Figure 1:'), '图注写在这张图上');

const news = `<article><figure class="ltx_figure"><p>Title: United Methodists Agree to Historic Split<br>Article: After two days of intense debate the church agreed to a historic split that created a new denomination for the members.</p><figcaption>Figure 3.14: generated news article that humans could not tell apart.</figcaption></figure></article>`;
const newsParsed = parseArxivHtml(news, '2005.14165');
const newsFig = newsParsed.blocks.find(b => b.type === 'fig');
assert(newsFig && !newsFig.figPath && newsFig.figTableRows?.length >= 2, '没有图片的样例抽成段落');
assert(newsFig?.figTableRows?.some(r => /United Methodists/.test(r[0])), '样例正文在，不再显示成下载中');

const chart = `<article><figure class="ltx_figure"><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L10 10"/></svg><figcaption>Figure 5: Ablation over number of training steps and accuracy.</figcaption></figure></article>`;
const chartParsed = parseArxivHtml(chart, '1810.04805');
const chartFig = chartParsed.blocks.find(b => b.type === 'fig');
assert(chartFig?.figPath === 'inline:', '内联 svg 标成待落盘，而不是空地址');

const noted = `<article><p>See the footnote here.<span class="ltx_note ltx_role_footnote"><sup class="ltx_note_mark">7</sup><span class="ltx_note_outer"><span class="ltx_note_content"><sup class="ltx_note_mark">7</sup><span class="ltx_tag ltx_tag_note">7</span> Additional samples are in the appendix for this model.</span></span></span> The rest of the sentence stays in the paragraph and is long enough to keep.</p></article>`;
const notedParsed = parseArxivHtml(noted, '2005.14165');
const notedParas = notedParsed.blocks.filter(b => b.type === 'para').map(b => b.en);
assert(notedParas[0] && !/7 7/.test(notedParas[0]) && notedParas[0].includes('rest of the sentence'), '脚注标记不再重复插进正文');
assert(notedParas.some(t => /Additional samples are in the appendix/.test(t)), '脚注正文单独成段');

const capNote = `<article><figure class="ltx_table"><table class="ltx_tabular"><tr><td>80.5</td></tr></table><figcaption>Table 1: GLUE results.<span class="ltx_note ltx_role_footnote"><sup>9</sup><span class="ltx_note_outer"><span class="ltx_note_content"><sup>9</sup><span class="ltx_tag ltx_tag_note">9</span> See question 10 in the FAQ for this benchmark.</span></span></span></figcaption></figure></article>`;
const capParsed = parseArxivHtml(capNote, '1810.04805');
const capFig = capParsed.blocks.find(b => b.type === 'fig');
assert(capFig && !/9 9/.test(capFig.en) && capFig.en.includes('GLUE results'), '表注里的脚注标记被摘掉');
assert(capParsed.blocks.some(b => /See question 10/.test(b.en)), '表注脚注单独成段');

console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
