// 视觉检验：ux-audit 截图 → 视觉模型断言（图表可见/无大面积空白/无公式豆腐块/排版正常）
// Provider：本地多模态优先（Qwen3.6-35B 加载后自动切）→ 云端 glm-5.3-flash；都不可用 SKIP
// 产出：VISUAL-JUDGE-FINDING 行 + build/ux/visual-judge.json（含 vision_confidence）
import { app } from 'electron';
import { resolveProvider, chatJson } from '../electron/vision';
import fs from 'fs';
import path from 'path';

const log = (s: string) => { if (process.env.PR_E2E_LOG) fs.appendFileSync(process.env.PR_E2E_LOG, s + '\n'); };
const vFinding = (f: any) => log('VISUAL-JUDGE-FINDING: ' + JSON.stringify(f));
const finish = () => { if (process.env.PR_E2E_DONE) fs.writeFileSync(process.env.PR_E2E_DONE, '1'); };

const shotDir = path.resolve('build/ux/screenshots');

// 每个视图的检查点（图表可见性只对含图表的视图强断言）
const CHECKS: Record<string, { blank: boolean; formula: boolean; layout: boolean; desc: string }> = {
  '01-paper-list': { blank: true, formula: false, layout: true, desc: '论文卡列表' },
  '02-reader-dual': { blank: true, formula: true, layout: true, desc: '双栏对照阅读' },
  '02-reader-bilingual': { blank: true, formula: true, layout: true, desc: '双语书模式' },
  '02-reader-zh': { blank: true, formula: true, layout: true, desc: '纯译文模式' },
  '03-ask-panel': { blank: true, formula: false, layout: true, desc: '问答侧栏' },
  '04-review': { blank: true, formula: false, layout: true, desc: '闪卡复习' },
  '05-palette': { blank: true, formula: false, layout: true, desc: '命令面板' },
  '06-settings': { blank: true, formula: false, layout: true, desc: '设置页' },
};

app.whenReady().then(async () => {
  const results: any[] = [];
  try {
    if (process.env.PR_E2E_USER_DATA) app.setPath('userData', process.env.PR_E2E_USER_DATA);
    log('== 视觉检验 ==');

    const provider = await resolveProvider();
    if (!provider) {
      log('provider: NONE → SKIP');
      vFinding({ id: 'visual-no-provider', severity: 'medium', view: 'visual-judge', title: '无可用视觉模型', evidence: 'local 未加载且云端未配' });
      log('VISUAL JUDGE DONE');
      finish();
      setTimeout(() => app.quit(), 200);
      return;
    }
    log(`provider: ${provider.kind} (${provider.model})`);

    const shots = fs.existsSync(shotDir) ? fs.readdirSync(shotDir).filter(f => f.endsWith('.png')) : [];
    if (shots.length === 0) {
      vFinding({ id: 'visual-no-shots', severity: 'medium', view: 'visual-judge', title: '无截图可检（先跑 ux:audit）', evidence: `${shotDir} empty` });
      log('VISUAL JUDGE DONE');
      finish();
      setTimeout(() => app.quit(), 200);
      return;
    }

    for (const shot of shots) {
      const name = shot.replace('.png', '');
      const check = CHECKS[name];
      if (!check) continue;
      const img = fs.readFileSync(path.join(shotDir, shot));
      const b64 = img.toString('base64');
      // 视觉断言提问；明确「内容少」与「异常空白」的区别（种子论文段落少属正常，不立案）
      const ask = [
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
          { type: 'text', text: `这是论文阅读 App「${check.desc}」视图截图（注意：这是测试环境，种子论文段落较少，页面下方留白属正常排版，不算问题）。只报告真正的渲染异常。只输出 JSON：
{"render_ok": 布尔(内容是否正常渲染), "content_truncated": 布尔(内容是否被截断/加载失败/显示错误占位), "tofu_boxes": 布尔(是否有乱码方块/未渲染字符), "layout_broken": 布尔(布局是否明显错位/重叠/元素溢出), "confidence": 0-1(判定置信度), "note": "一句话异常描述或空"}` },
        ] },
      ];
      const r = await chatJson(provider, ask, { maxTokens: 400, timeoutMs: 120000 });
      if (!r) {
        log(`${name}: judge-parse-fail（重试一次）`);
        const r2 = await chatJson(provider, ask, { maxTokens: 400, timeoutMs: 120000 });
        if (!r2) { results.push({ view: name, error: 'parse-fail' }); continue; }
        Object.assign(r, r2);
      }
      const conf = Number(r.confidence ?? 0.5);
      log(`${name}: renderOk=${r.render_ok}, truncated=${r.content_truncated}, tofu=${r.tofu_boxes}, broken=${r.layout_broken}, conf=${conf}`);
      results.push({ view: name, ...r });

      // 高严重度：内容截断/豆腐块（置信度 ≥0.7 才立案，防误报）
      if (conf >= 0.7) {
        if (r.content_truncated) vFinding({ id: `visual-truncated-${name}`, severity: 'high', view: name, title: `${check.desc}内容截断/加载失败`, evidence: String(r.note ?? ''), screenshot: shot });
        if (r.tofu_boxes) vFinding({ id: `visual-tofu-${name}`, severity: 'high', view: name, title: `${check.desc}存在乱码方块`, evidence: String(r.note ?? ''), screenshot: shot });
        if (r.layout_broken) vFinding({ id: `visual-layout-${name}`, severity: 'medium', view: name, title: `${check.desc}布局错位`, evidence: String(r.note ?? ''), screenshot: shot });
        if (r.render_ok === false) vFinding({ id: `visual-render-${name}`, severity: 'high', view: name, title: `${check.desc}渲染异常`, evidence: String(r.note ?? ''), screenshot: shot });
      }
    }

    fs.mkdirSync('build/ux', { recursive: true });
    fs.writeFileSync('build/ux/visual-judge.json', JSON.stringify({ at: new Date().toISOString(), provider: { kind: provider.kind, model: provider.model }, results }, null, 2));
    log('VISUAL JUDGE DONE');
  } catch (e: any) {
    log(`FATAL: ${e?.stack ?? e}`);
    vFinding({ id: 'visual-judge-crash', severity: 'high', view: 'visual-judge', title: '视觉检验崩溃', evidence: String(e?.message ?? e) });
  }
  finish();
  setTimeout(() => app.quit(), 200);
});
