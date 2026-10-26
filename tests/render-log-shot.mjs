// 把 build/dedup-scroll-console.txt 渲染成终端风格截图（用户要求日志截图交付）
import { app, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

app.whenReady().then(async () => {
  const src = process.argv[2] ?? path.resolve('build/dedup-scroll-console.txt');
  const out = process.argv[3] ?? path.resolve('build/dedup-scroll-console.png');
  const text = fs.readFileSync(src, 'utf8');
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `<!doctype html><html><body style="margin:0;background:#0c0c0c;padding:0">
  <div style="font-family:Consolas,'Courier New',monospace;font-size:14px;line-height:1.55;color:#d4d4d4;
              padding:18px 22px;white-space:pre-wrap;word-break:break-all">
<div style="color:#9cdcfe;margin-bottom:10px">PS D:\\paper-reader-app&gt; npm run test:dedup-scroll</div>
${esc
    .replace(/(ALL PASS|PASS|PASS'|within&quot;:true|stable=true)/g, '<span style="color:#4ec9b0">$1</span>')
    .replace(/(FAIL|FATAL|within&quot;:false)/g, '<span style="color:#f48771">$1</span>')
    .replace(/(\[A\]|\[B\]|\[dedup-scroll\]|seed:|cluster:|warm-up:|稳定性:|页锚总数=|段数=)/g, '<span style="color:#dcdcaa">$1</span>')}
  </div></body></html>`;
  const win = new BrowserWindow({ width: 1180, height: 900, show: false });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  console.log('saved', out, img.getSize().width + 'x' + img.getSize().height);
  app.quit();
});
