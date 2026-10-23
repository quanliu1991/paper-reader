// 网络层：fetch 重试封装（Node 22 内置 fetch，走系统代理）
export interface FetchOpts {
  timeout?: number;   // ms
  retries?: number;
  headers?: Record<string, string>;
}

export async function fetchWithRetry(url: string, opts: FetchOpts = {}): Promise<string> {
  const { timeout = 60000, retries = 2, headers = {} } = opts;
  let lastErr: unknown = null;
  for (let i = 0; i <= retries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const resp = await fetch(url, { headers, signal: ctl.signal });
      clearTimeout(timer);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.text();
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (i < retries) await sleep(1500 * (i + 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function downloadBinary(url: string, dest: string, opts: FetchOpts = {}): Promise<void> {
  const { timeout = 120000, retries = 1, headers = {} } = opts;
  const fs = await import('fs');
  let lastErr: unknown = null;
  for (let i = 0; i <= retries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const resp = await fetch(url, { headers, signal: ctl.signal });
      clearTimeout(timer);
      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      fs.mkdirSync(require('path').dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      return;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (i < retries) await sleep(1500);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
