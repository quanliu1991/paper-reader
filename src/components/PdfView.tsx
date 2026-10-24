import { useEffect, useRef, useState, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// PDF 原版视图：分页 canvas 渲染 + 可见页追踪（懒渲染）
// onVisiblePageChange 上报当前页，供译文面板同步
export default function PdfView({
  paperId, jumpReq, onVisiblePage, visiblePageRef,
}: {
  paperId: number;
  jumpReq: { page: number; seq: number } | null;   // 外部请求跳页（seq 保证同页重复触发）
  onVisiblePage: (p: number) => void;
  visiblePageRef: React.MutableRefObject<number>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [error, setError] = useState('');
  const renderedRef = useRef<Set<number>>(new Set());
  const scrollLockRef = useRef(false);

  // 加载文档
  useEffect(() => {
    let cancelled = false;
    setDoc(null); setError(''); setNumPages(0);
    renderedRef.current.clear();
    (async () => {
      try {
        const task = pdfjsLib.getDocument({ url: `local-pdf://p/${paperId}`, useSystemFonts: true });
        const d = await task.promise;
        if (cancelled) { d.destroy(); return; }
        setDoc(d);
        setNumPages(d.numPages);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [paperId]);

  // 渲染指定页（幂等）
  const renderPage = useCallback(async (d: PDFDocumentProxy, n: number, scale: number) => {
    const host = pageRefs.current.get(n);
    if (!host || renderedRef.current.has(n)) return;
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

  // 可见页追踪 + 懒渲染（IntersectionObserver）
  useEffect(() => {
    if (!doc || !numPages) return;
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const n = Number((en.target as HTMLElement).dataset.page);
        if (en.isIntersecting) {
          // 懒渲染：可见即渲染
          renderPage(doc, n, 1.5);
          if (!scrollLockRef.current) {
            visiblePageRef.current = n;
            onVisiblePage(n);
          }
        }
      }
    }, { root: containerRef.current, rootMargin: '0px 0px -60% 0px' });
    for (const el of pageRefs.current.values()) io.observe(el);
    return () => io.disconnect();
  }, [doc, numPages, renderPage, onVisiblePage, visiblePageRef]);

  // 外部跳页（seq 保证同页重复点击也触发）
  useEffect(() => {
    if (!jumpReq || !numPages) return;
    const el = pageRefs.current.get(jumpReq.page);
    if (el) {
      scrollLockRef.current = true;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.classList.remove('pdf-flash');
      void el.offsetWidth; // 重置动画
      el.classList.add('pdf-flash');
      setTimeout(() => { el.classList.remove('pdf-flash'); scrollLockRef.current = false; }, 1200);
    }
  }, [jumpReq, numPages]);

  if (error) {
    return (
      <div className="pdf-view" ref={containerRef}>
        <div className="pdf-error">
          PDF 未就绪或不可用（{error.slice(0, 80)}）。
          <div className="hint" style={{ marginTop: 6 }}>可稍等后台下载完成，或继续使用文本对照模式。</div>
        </div>
      </div>
    );
  }

  return (
    <div className="pdf-view" ref={containerRef}>
      {!doc && <div className="pdf-loading">PDF 加载中…</div>}
      {doc && Array.from({ length: numPages }, (_, i) => (
        <div
          key={i + 1}
          className="pdf-page"
          data-page={i + 1}
          ref={el => { if (el) pageRefs.current.set(i + 1, el); }}
        >
          <div className="pdf-loading">第 {i + 1} 页</div>
        </div>
      ))}
    </div>
  );
}
