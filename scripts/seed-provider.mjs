// 一次性：把 llm.txt 导入真实库 providers（走与 app 相同的 AES-GCM 加密链路）
// 用法：node scripts/seed-provider.mjs（无原生依赖：加密用 node:crypto，写库走 sqlite3 CLI）
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

const ud = path.join(os.homedir(), 'Library/Application Support/Paper Reader');
const dbPath = path.join(ud, 'paper-reader.db');
const txt = path.resolve('llm.txt');
if (!fs.existsSync(txt)) { console.error('llm.txt 不存在'); process.exit(1); }
const m = fs.readFileSync(txt, 'utf8').trim().match(/^(\S+)\s+(\S+)\s+(\S+)\s*$/m);
if (!m) { console.error('llm.txt 格式不符'); process.exit(1); }
const [, key, baseUrl, model] = m;
const base = baseUrl.replace(/\/chat\/completions$/, '');

// master key：与 electron/llm.ts 完全一致的 .mk 约定（不存在则生成——首次加密会创建）
const keyPath = path.join(ud, '.mk');
let masterKey;
if (fs.existsSync(keyPath)) {
  masterKey = Buffer.from(fs.readFileSync(keyPath, 'utf8'), 'hex');
} else {
  masterKey = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, masterKey.toString('hex'), { mode: 0o600 });
}

const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
const enc = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
const tag = cipher.getAuthTag();
const keyEnc = `${iv.toString('hex')}.${tag.toString('hex')}.${enc.toString('hex')}`;

const has = execFileSync('sqlite3', [dbPath, 'SELECT COUNT(*) FROM providers;'], { encoding: 'utf8' }).trim();
if (Number(has) > 0) {
  console.log('providers 已有', has, '条，跳过');
} else {
  const name = /bigmodel/i.test(base) ? '智谱 BigModel' : 'LLM';
  execFileSync('sqlite3', [dbPath,
    `INSERT INTO providers (name, protocol, base_url, api_key, model, is_default) VALUES ('${name}','openai','${base}','${keyEnc}','${model}',1);`]);
  console.log(`已导入「${name}/${model}」→ base=${base}（AES-256-GCM 加密存储）`);
}
