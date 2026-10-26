// 诊断：fig img 为什么没加载（协议响应 / src / complete / naturalWidth / 位置）
import { app, BrowserWindow } from 'electron';
import * as path from 'path';

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 900, show: true, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true } });
  win.webContents.on('console-message', (_e, _l, msg) => console.log('[renderer]', msg));
  await win.loadURL(process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5199');
  const code = `
    (async () => {
      const r = await fetch('local-figure://1/fig-1.png');
      const r2 = await fetch('local-figure://1/fig-1.png').catch(e => ({ status: 'ERR ' + e.message }));
      const st = window.__store.getState();
      await st.openPaper(1);
      st.setLayout('pdf-layout');
      await new Promise(r => setTimeout(r, 2500));
      const R = document.querySelector('.dpv-right');
      const figs = [...document.querySelectorAll('.dpv-right figure.dpv-zhfig')];
      const withImg = figs.filter(f => f.querySelector('img'));
      const im = withImg[0]?.querySelector('img');
      if (im && R) {
        R.scrollTop = im.closest('figure').offsetTop - R.offsetTop - 60;
        await new Promise(r => setTimeout(r, 1000));
      }
      return {
        fetchStatus: r.status ?? r2.status,
        figTotal: figs.length, withImg: withImg.length,
        imgSrc: im?.src, complete: im?.complete, nw: im?.naturalWidth,
        rectTop: im?.getBoundingClientRect().top, viewportH: innerHeight,
        figPaths: st.blocks.filter(b => b.type === 'fig').slice(0, 3).map(b => b.fig_path),
      };
    })()
  `;
  const diag = await win.webContents.executeJavaScript(code);
  console.log(JSON.stringify(diag, null, 2));
  app.quit();
});
