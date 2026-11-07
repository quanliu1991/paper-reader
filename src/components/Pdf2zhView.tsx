import { useEffect, useRef, useState, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// pdf2zh 双语版式视图：加载 pdfs/<paperId>-dual.pdf（pdf2zh 重排产物，
// 每段原文下紧跟译文，公式/图表/目录保留），单一滚动流，无任何同步代码。
// 生成入口与进度由 Reader.tsx 顶部工具栏承担（pdf2zh:translate IPC）。
export default function Pdf2zhView({ paperId }: { paperId: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [error, setError] = useState('');
  const [visiblePage, setVisiblePage] = useState(1);
  const renderedRef = useRef<Set<number>>(new Set());
  // 进度条高度偶发为 0 导致 canvas 黑块：渲染前重测容器宽度（与 DualPdfView 同策略）
  const [renderTick, setRenderTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => { if (!cancelled) setRenderTick(x => x + 1); }, 60);
    return () => { cancelled = true; clearTimeout(t); };
  }, []);

  // 加载 dual PDF（url 直指 local-pdf://p/<paperId>-dual）
  useEffect(() => {
    let cancelled = false;
    setDoc(null); setError(''); setNumPages(0); setVisiblePage(1);
    renderedRef.current.clear();
    (async () => {
      try {
        const d = await (pdfjsLib.getDocument({ url: `local-pdf://p/${paperId}-dual`, useSystemFonts: true })).promise;
        if (cancelled) { d.destroy(); return; }
        setDoc(d);
        setNumPages(d.numPages);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [paperId]);

  // 渲染指定页（幂等，带宽度守卫）
  const renderPage = useCallback(async (d: PDFDocumentProxy, n: number, scale: number) => {
    const host = pageRefs.current.get(n);
    if (!host || renderedRef.current.has(n)) return;
    if (host.clientWidth < 50) return; // 容器还没布局好，等下一轮 IntersectionObserver
    renderedRef.current.add(n);
    try {
      const page = await d.getPage(n);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = '100%';
      canvas.style.display = 'block';
      const ctx = canvas.getContext('2d')!;
      await page.render({ canvasContext: ctx, viewport }).promise;
      const loading = host.querySelector('.pdf-loading');
      if (loading) loading.remove();
      host.appendChild(canvas);
    } catch {
      renderedRef.current.delete(n);
    }
  }, []);

  // 可见页追踪 + 懒渲染
  useEffect(() => {
    if (!doc || !numPages) return;
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const n = Number((en.target as HTMLElement).dataset.page);
        if (en.isIntersecting) {
          renderPage(doc, n, 1.5);
          setVisiblePage(n);
        }
      }
    }, { root: containerRef.current, rootMargin: '0px 0px -60% 0px' });
    for (const el of pageRefs.current.values()) io.observe(el);
    return () => io.disconnect();
  }, [doc, numPages, renderPage, renderTick]);

  if (error) {
    return (
      <div className="dpv-wrap">
        <div className="pdf-error">
          双语版式 PDF 不可用（{error.slice(0, 80)}）。
          <div className="hint" style={{ marginTop: 6 }}>请先在工具栏点「生成双语版式 PDF」，或查看生成日志排查。</div>
        </div>
      </div>
    );
  }

  return (
    <div className="dpv-wrap">
      <div className="dpv-toolbar">
        <span className="dpv-mode-switch" style={{ color: '#ddd' }}>双语版式（pdf2zh 重排）</span>
        <span className="dpv-page-indicator">{numPages ? `第 ${visiblePage}/${numPages} 页` : '加载中…'}</span>
      </div>
      <div className="dpv-scroll" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }} ref={containerRef}>
        {!doc && <div className="pdf-loading" style={{ padding: '160px 0' }}>双语 PDF 加载中…</div>}
        {doc && Array.from({ length: numPages }, (_, i) => (
          <div
            key={i + 1}
            className="pdf-page"
            data-page={i + 1}
            style={{ width: 'min(100%, 860px)', margin: '0 auto 14px' }}
            ref={el => { if (el) pageRefs.current.set(i + 1, el); }}
          >
            <div className="pdf-loading">第 {i + 1} 页</div>
          </div>
        ))}
      </div>
    </div>
  );
}
