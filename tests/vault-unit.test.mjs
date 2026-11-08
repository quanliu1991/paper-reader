// vault 存储层单元测试：vault-sink 队列（vault.ts 序列化测试在后续任务追加）
// 模式：esbuild 离线自编译（同 topic-graph.test.mjs）
import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import os from 'os';

await build({
  entryPoints: ['electron/vault-sink.ts'],
  bundle: true, platform: 'node', target: 'node20', format: 'esm',
  outfile: 'tests/.tmp-vault/vault-sink.js', logLevel: 'silent',
});

const { createSink } = await import('../tests/.tmp-vault/vault-sink.js');

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- vault-sink ----------
{
  console.log('== vault-sink 队列 ==');
  const flushed = [];
  const sink = createSink({ flush: async (tasks) => { flushed.push(...tasks); }, delayMs: 20 });
  sink.enqueue({ kind: 'meta', paperId: 1 });
  sink.enqueue({ kind: 'meta', paperId: 1 });   // 合并
  sink.enqueue({ kind: 'annotations', paperId: 1 });
  await sink.flush();
  assert(flushed.length === 2, `coalesce 同 key 只留一个（got ${flushed.length}）`);
  assert(flushed[0].kind === 'meta' && flushed[1].kind === 'annotations', '顺序保持');
  assert(sink.stats().pending === 0, 'flush 后 pending=0');
}

{
  console.log('== vault-sink journal 崩溃恢复 ==');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-sink-'));
  const journal = path.join(tmp, 'journal.jsonl');
  // delayMs 大到防抖不会触发：模拟「enqueue 已落 journal、drain 前崩溃」
  const sink1 = createSink({ flush: async () => {}, journalPath: journal, delayMs: 10_000 });
  sink1.enqueue({ kind: 'meta', paperId: 7 });
  assert(fs.existsSync(journal) && fs.readFileSync(journal, 'utf8').includes('"paperId":7'), 'enqueue 即写 journal（防抖窗口内崩溃也不丢）');
  const calls2 = [];
  const sink2 = createSink({ flush: async (tasks) => { calls2.push(tasks); }, journalPath: journal, delayMs: 5 });
  await sink2.flush();
  assert(calls2.length === 1 && calls2[0].length === 1 && calls2[0][0].paperId === 7, '新实例重放未完成任务');
  assert(sink2.stats().pending === 0, '重放后 journal 清空');
  assert(!fs.existsSync(journal) || fs.readFileSync(journal, 'utf8').trim() === '', '成功后 journal truncate');
}

{
  console.log('== vault-sink 错误隔离（毒丸重试一次后丢弃） ==');
  let attempts = 0;
  const sink = createSink({
    flush: async () => { attempts++; throw new Error('disk full'); },
    delayMs: 5,
  });
  sink.enqueue({ kind: 'meta', paperId: 1 });
  await sleep(80); // 触发重试 + 二次失败丢弃
  assert(attempts >= 2, `毒丸至少重试一次（attempts=${attempts}）`);
  assert(sink.stats().errors >= 1, `错误计数（errors=${sink.stats().errors}）`);
  assert(sink.stats().pending === 0, '毒丸最终被丢弃不阻塞队列');
  assert(typeof sink.stats().lastError === 'string' && sink.stats().lastError.includes('disk full'), 'lastError 记录');
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
