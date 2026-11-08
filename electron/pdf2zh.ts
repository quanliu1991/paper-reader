// pdf2zh（PDFMathTranslate）集成层：生成保留版式的双语 PDF（dual）与纯译文 PDF（mono）
// 通过独立 CLI 子进程调用（uv tool 安装，Python 3.12），进程边界隔离 AGPL 代码。
// 产物落 userData/pdfs/<paperId>-dual.pdf 与 <paperId>-mono.pdf，路径记入 papers.dual_pdf_path。
// 翻译服务复用应用内已配置的默认 Provider（OpenAI 兼容协议），密钥只注入子进程环境，不落盘。
import { app } from 'electron';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import path from 'path';
import * as fs from 'fs';
import * as db from './db';
import * as llm from './llm';

const CLI_NAME = 'pdf2zh';
// uv tool bin 目录（macOS/Linux：~/.local/bin；Windows：~/AppData/Roaming/uv/tools/bin）
function uvToolBin(): string[] {
  const home = app.getPath('home');
  if (process.platform === 'win32') return [path.join(home, 'AppData', 'Roaming', 'uv', 'bin')];
  return [path.join(home, '.local', 'bin')];
}

// 解析 pdf2zh 可执行文件路径（找不到返回 null，由调用方给出带 hint 的报错）
export function resolveCli(): string | null {
  const exe = process.platform === 'win32' ? `${CLI_NAME}.exe` : CLI_NAME;
  for (const dir of [...uvToolBin(), '/usr/local/bin', '/opt/homebrew/bin']) {
    const p = path.join(dir, exe);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* 继续找 */ }
  }
  return null;
}

export function cliHint(): string {
  return `未找到 ${CLI_NAME}。请在终端执行：uv tool install --python 3.12 pdf2zh（需先安装 uv）`;
}

// 在跑任务表：paperId → 进程（重复触发时先杀旧进程）
const running = new Map<number, ChildProcessWithoutNullStreams>();

export interface TranslateArgs {
  paperId: number;
  pages?: string;          // 部分翻译（如 "1-3"），空 = 全文
  noDual?: boolean;        // v3: 默认 true（原版对照只需 mono.pdf，dual.pdf 已随 Pdf2zhView 删除）
  noMono?: boolean;        // 只生成 dual
}

// v3 A3：计算默认翻译页范围——跳过 References 之后的页。
// 用 blocks 表找 References/Bibliography 标题块，按块序占比估算其起始页。
// 返回 null = 全文翻译（找不到 References 或占比异常）。
export function autoPagesArg(paperId: number, numPages: number): string | null {
  if (!numPages || numPages < 4) return null;
  const paper = db.getPaper(paperId) as any;
  if (!paper) return null;
  const blocks = db.getBlocks(paperId) as any[];
  if (!blocks.length) return null;
  const refsIdx = blocks.findIndex(b =>
    b.type === 'heading' && /^(references?|bibliography|literature cited|参考文献)\s*$/i.test((b.en || '').trim()));
  if (refsIdx === -1) return null;
  const ratio = refsIdx / blocks.length;
  // References 若出现在前 60% 则视为误判（如目录里的 References 行），全文翻译
  if (ratio < 0.6) return null;
  const refsPage = Math.max(1, Math.ceil(ratio * numPages));
  // 至少保留正文全部页；References 起始页本身也不译（标题页起跳过）
  if (refsPage >= numPages) return null;
  return `1-${refsPage - 1}`;
}

export function isRunning(paperId: number): boolean {
  return running.has(paperId);
}

// 源 PDF 路径：pdfs/<id>.pdf 优先，回退 papers.file_path（本地导入库）
function sourcePdfPath(paperId: number): string | null {
  const dest = path.join(app.getPath('userData'), 'pdfs', `${paperId}.pdf`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 10000) return dest;
  const paper = db.getPaper(paperId) as any;
  if (paper?.file_path && fs.existsSync(paper.file_path)) return paper.file_path;
  return null;
}

// 基于默认 Provider 构建 pdf2zh 的 OpenAI 兼容服务参数与环境变量
// pdf2zh openai service（OpenAITranslator）：OPENAI_BASE_URL 需为含版本段的 API 根
// （SDK 内部拼 /chat/completions），站内 providers.base_url 约定与此一致。
function providerEnv(provider: llm.ProviderConfig): { service: string; env: Record<string, string> } {
  return {
    service: 'openai',
    env: {
      OPENAI_BASE_URL: provider.baseUrl,
      OPENAI_API_KEY: provider.apiKey,
      OPENAI_MODEL: provider.model,
    },
  };
}

// 翻译并落库。onLine 每行收到子进程 stderr/stdout（pdf2zh 进度走 stderr）。
export function translateDualPdf(
  args: TranslateArgs,
  hooks: {
    onLine: (line: string) => void;
    onDone: (dualPath: string | null, monoPath: string | null) => void;
    onError: (err: string) => void;
  },
): void {
  const { paperId } = args;
  const cli = resolveCli();
  if (!cli) { hooks.onError(cliHint()); return; }
  if (running.has(paperId)) running.get(paperId)!.kill('SIGTERM');

  const src = sourcePdfPath(paperId);
  if (!src) {
    hooks.onError('源 PDF 不存在（pdfs 目录与 file_path 均未命中）。请先等 PDF 下载完成或重新导入。');
    return;
  }

  // 默认 Provider 必须已配置（译文质量与站内翻译一致的前提下复用同一服务）
  const provider = defaultProvider();
  if (!provider) { hooks.onError('未配置 LLM Provider，请先到设置页添加'); return; }
  const { service, env } = providerEnv(provider);

  // 产物输出目录：userData/pdfs/（pdf2zh 产出 <name>-mono.pdf / <name>-dual.pdf，跑完改名归位）
  const pdfsDir = path.join(app.getPath('userData'), 'pdfs');
  fs.mkdirSync(pdfsDir, { recursive: true });
  const tmpOut = path.join(pdfsDir, `p2z-${paperId}-${Date.now()}`);
  fs.mkdirSync(tmpOut, { recursive: true });

  const cliArgs = [
    src,
    '-s', service,
    '-lo', 'zh',
    '-o', tmpOut,
  ];
  // v3 D2：mono-only——原版对照只用 mono.pdf，dual.pdf 生成纯属浪费（时间/磁盘近半）
  if (args.noDual !== false) cliArgs.push('--no-dual');
  if (args.pages) cliArgs.push('-p', args.pages);
  if (args.noMono) cliArgs.push('--no-mono');

  hooks.onLine(`$ ${CLI_NAME} ${cliArgs.join(' ')}`);

  const child = spawn(cli, cliArgs, {
    env: {
      ...process.env,
      ...env,
      // 国内网络兜底：HF 模型下载走镜像（已装模型则不生效）
      HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com',
      NO_COLOR: '1',
    },
  });
  running.set(paperId, child);

  let errTail = '';
  const pump = (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      if (errTail.length < 4000) errTail += line + '\n';
      hooks.onLine(t);
    }
  };
  child.stdout.on('data', pump);
  child.stderr.on('data', pump);
  child.on('error', (e) => {
    running.delete(paperId);
    hooks.onError(`启动 ${CLI_NAME} 失败：${e.message}`);
  });
  child.on('close', (code) => {
    running.delete(paperId);
    if (code !== 0) {
      hooks.onError(`${CLI_NAME} 退出码 ${code}。最近输出：\n${errTail.slice(-1500)}`);
      try { fs.rmSync(tmpOut, { recursive: true, force: true }); } catch { /* 忽略 */ }
      return;
    }
    // 产物归位：<paperId>-dual.pdf / <paperId>-mono.pdf
    let dualPath: string | null = null;
    let monoPath: string | null = null;
    try {
      const files = fs.readdirSync(tmpOut).filter(f => f.endsWith('.pdf'));
      const dual = files.find(f => f.includes('dual'));
      const mono = files.find(f => f.includes('mono'));
      if (dual) {
        dualPath = path.join(pdfsDir, `${paperId}-dual.pdf`);
        fs.copyFileSync(path.join(tmpOut, dual), dualPath);
      }
      if (mono && !args.noMono) {
        monoPath = path.join(pdfsDir, `${paperId}-mono.pdf`);
        fs.copyFileSync(path.join(tmpOut, mono), monoPath);
      }
      fs.rmSync(tmpOut, { recursive: true, force: true });
    } catch (e: any) {
      hooks.onError(`产物归位失败：${e?.message ?? e}`);
      return;
    }
    if (!dualPath && !monoPath) {
      hooks.onError('pdf2zh 执行完成但没有产出 PDF（检查上方日志）。');
      return;
    }
    db.setPaperDualPdfPath(paperId, dualPath);
    db.setPaperMonoPdfPath(paperId, monoPath);
    hooks.onDone(dualPath, monoPath);
  });
}

export function cancelTranslate(paperId: number): boolean {
  const child = running.get(paperId);
  if (!child) return false;
  child.kill('SIGTERM');
  running.delete(paperId);
  return true;
}

// 与 main.ts 的 getDefaultProvider 一致的本地实现（读 providers 表默认行 + 解密 key）
function defaultProvider(): llm.ProviderConfig | null {
  const d = db.getDb();
  let row = d.prepare('SELECT * FROM providers WHERE is_default=1').get() as any;
  if (!row) row = d.prepare('SELECT * FROM providers ORDER BY id LIMIT 1').get() as any;
  if (!row) return null;
  return {
    id: row.id, name: row.name, protocol: row.protocol,
    baseUrl: row.base_url, apiKey: llm.decryptSecret(row.api_key), model: row.model,
  };
}

// 探测某论文是否已有双语/纯译 PDF（阅读器入口按钮的显隐与直开依据）
export function dualPdfStatus(paperId: number): { exists: boolean; monoExists: boolean; path: string | null; monoPath: string | null; generating: boolean } {
  const pdfsDir = path.join(app.getPath('userData'), 'pdfs');
  const dest = path.join(pdfsDir, `${paperId}-dual.pdf`);
  const monoDest = path.join(pdfsDir, `${paperId}-mono.pdf`);
  const exists = fs.existsSync(dest);
  const paper = db.getPaper(paperId) as any;
  const recorded = paper?.dual_pdf_path ?? null;
  const monoExists = fs.existsSync(monoDest);
  const monoRecorded = paper?.mono_pdf_path ?? null;
  return {
    exists: exists || !!recorded,
    monoExists: monoExists || !!monoRecorded,
    path: exists ? dest : recorded,
    monoPath: monoExists ? monoDest : monoRecorded,
    generating: running.has(paperId),
  };
}
