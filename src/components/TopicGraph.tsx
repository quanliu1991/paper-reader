import { useEffect, useMemo, useRef, useState } from 'react';

// v3 B3：主题依赖图——力导向 Canvas 图谱（Obsidian 式导航）
// 节点=论文（分层着色，大小=被引），边=引用（src→dst）。悬停=摘要卡；单击=选中；
// 双击=聚焦邻居；>MAX_RENDER 节点自动降级（不渲染，父层显示列表）。
export interface GraphNode {
  id: string; title: string; layer: string; year: number | null;
  citation_count: number; in_degree: number; imported: boolean;
}
export interface GraphEdge { src: string; dst: string }

const MAX_RENDER = 200;

// 分层 → 主题变量色（暗色/亮色主题均由变量保证可读）
// ux-lint-allow（功能色板：canvas 分层数据可视化配色，非主题色）
const LAYER_COLOR: Record<string, string> = {
  series: '#22d3ee',
  foundation: '#a78bfa',
  key: '#f472b6',
  bridge: '#fbbf24',
  frontier: '#34d399', // ux-lint-allow（色板续行，同上豁免）
  node: '#94a3b8',
  discussion: '#60a5fa',
  context: '#64748b',
};

// canvas 2D 墨色常量：canvas 不支持 var()/color-mix()，主题中性灰白（暗亮主题均可读）
// ux-lint-allow（canvas 绘图常量：非 DOM 样式，无法走 CSS 变量）
const CANVAS_INK = {
  edgeActive: 'rgba(150,150,150,0.45)',
  edgeDim: 'rgba(128,128,128,0.10)',
  importedRing: 'rgba(255,255,255,0.85)',
  selRing: '#fff',
  label: 'rgba(200,200,200,0.9)',
};

interface SimNode { id: string; x: number; y: number; vx: number; vy: number; r: number; node: GraphNode }

export default function TopicGraph({
  nodes, edges, onOpen, onImport,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onOpen: (n: GraphNode) => void;
  onImport: (n: GraphNode) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ n: GraphNode; x: number; y: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const simRef = useRef<{ nodes: SimNode[]; edges: GraphEdge[]; raf: number | null }>({ nodes: [], edges: [], raf: null });
  const cbRef = useRef({ onOpen, onImport });
  cbRef.current = { onOpen, onImport };

  const degree = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of edges) { m.set(e.src, (m.get(e.src) ?? 0) + 1); m.set(e.dst, (m.get(e.dst) ?? 0) + 1); }
    return m;
  }, [edges]);

  // 初始化 + 简易力导向模拟（斥力 + 边弹簧 + 向心），rAF 节流
  useEffect(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    if (nodes.length > MAX_RENDER) return; // 降级：父层处理

    const W = wrap.clientWidth, H = Math.max(420, Math.min(640, wrap.clientHeight));
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    const maxDeg = Math.max(1, ...nodes.map(n => degree.get(n.id) ?? 1));
    const sim: SimNode[] = nodes.map((n, i) => {
      const a = (i / Math.max(1, nodes.length)) * Math.PI * 2;
      const rad = 120 + (i % 7) * 26;
      const deg = degree.get(n.id) ?? 1;
      return {
        id: n.id, node: n, x: W / 2 + Math.cos(a) * rad, y: H / 2 + Math.sin(a) * rad,
        vx: 0, vy: 0, r: 5 + (deg / maxDeg) * 9,
      };
    });
    const byId = new Map(sim.map(s => [s.id, s]));
    const validEdges = edges.filter(e => byId.has(e.src) && byId.has(e.dst));
    const state = simRef.current;
    state.nodes = sim; state.edges = validEdges;

    let iter = 0;
    const MAX_ITER = 260;
    const hoverRef = { current: null as SimNode | null };

    function tick() {
      iter++;
      const alpha = Math.max(0.001, 0.06 * (1 - iter / MAX_ITER));
      // 斥力（O(n²) 但 n≤200 可接受）
      for (let i = 0; i < sim.length; i++) {
        for (let j = i + 1; j < sim.length; j++) {
          const a = sim[i], b = sim[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
          const d = Math.sqrt(d2);
          const f = 900 / d2;
          const fx = (dx / d) * f, fy = (dy / d) * f;
          a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
        }
      }
      // 边弹簧 + 向心
      for (const e of validEdges) {
        const a = byId.get(e.src)!, b = byId.get(e.dst)!;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const f = (d - 80) * 0.012;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      }
      for (const s of sim) {
        s.vx += (W / 2 - s.x) * 0.002; s.vy += (H / 2 - s.y) * 0.002;
        s.x += s.vx * alpha; s.y += s.vy * alpha;
        s.vx *= 0.86; s.vy *= 0.86;
        // 边界约束
        s.x = Math.max(s.r + 4, Math.min(W - s.r - 4, s.x));
        s.y = Math.max(s.r + 4, Math.min(H - s.r - 4, s.y));
      }
      draw();
      if (iter < MAX_ITER || alpha > 0.003) state.raf = requestAnimationFrame(tick);
    }

    function draw() {
      ctx.clearRect(0, 0, W, H);
      // 边
      const sel = selected;
      const neighbors = new Set<string>();
      if (sel) {
        neighbors.add(sel);
        for (const e of validEdges) {
          if (e.src === sel) neighbors.add(e.dst);
          if (e.dst === sel) neighbors.add(e.src);
        }
      }
      ctx.lineWidth = 1;
      for (const e of validEdges) {
        const a = byId.get(e.src)!, b = byId.get(e.dst)!;
        const active = !sel || (e.src === sel || e.dst === sel);
        ctx.strokeStyle = active ? CANVAS_INK.edgeActive : CANVAS_INK.edgeDim;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      // 节点
      for (const s of sim) {
        const dim = sel && !neighbors.has(s.id);
        ctx.globalAlpha = dim ? 0.25 : 1;
        ctx.fillStyle = LAYER_COLOR[s.node.layer] ?? LAYER_COLOR.node;
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
        if (s.node.imported) { // 已导入：白描边
          ctx.strokeStyle = CANVAS_INK.importedRing; ctx.lineWidth = 1.6;
          ctx.stroke();
        }
        if (s.id === sel) {
          ctx.strokeStyle = CANVAS_INK.selRing; ctx.lineWidth = 2.2;
          ctx.beginPath(); ctx.arc(s.x, s.y, s.r + 3, 0, Math.PI * 2); ctx.stroke();
        }
        // 度数大的节点带标题
        if (s.r > 9) {
          ctx.globalAlpha = dim ? 0.25 : 0.9;
          ctx.fillStyle = CANVAS_INK.label;
          ctx.font = '10px "Segoe UI", sans-serif';
          const t = s.node.title.length > 26 ? s.node.title.slice(0, 25) + '…' : s.node.title;
          ctx.fillText(t, s.x + s.r + 4, s.y + 3);
        }
        ctx.globalAlpha = 1;
      }
    }

    state.raf = requestAnimationFrame(tick);

    // 命中检测（悬停/点击）
    const toLocal = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const pick = (x: number, y: number): SimNode | null => {
      for (let i = sim.length - 1; i >= 0; i--) {
        const s = sim[i];
        if (Math.hypot(s.x - x, s.y - y) <= s.r + 3) return s;
      }
      return null;
    };
    const onMove = (e: MouseEvent) => {
      const { x, y } = toLocal(e);
      const hit = pick(x, y);
      hoverRef.current = hit;
      canvas.style.cursor = hit ? 'pointer' : 'default';
      setHover(hit ? { n: hit.node, x: hit.x + hit.r + 12, y: hit.y - 8 } : null);
    };
    let lastClick = 0;
    const onClick = (e: MouseEvent) => {
      const { x, y } = toLocal(e);
      const hit = pick(x, y);
      if (!hit) { setSelected(null); return; }
      const now = Date.now();
      if (now - lastClick < 320) {
        // 双击 = 打开（已导入直接阅读；未导入先入库）
        cbRef.current.onOpen(hit.node);
      } else {
        setSelected(hit.id);
      }
      lastClick = now;
      draw();
    };
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('click', onClick);
    return () => {
      if (state.raf) cancelAnimationFrame(state.raf);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('click', onClick);
    };
  }, [nodes, edges, degree, selected]);

  if (nodes.length > MAX_RENDER) {
    return <div className="graph-fallback">节点过多（{nodes.length}），已切换为列表模式</div>;
  }

  return (
    <div className="topic-graph-wrap" ref={wrapRef}>
      <canvas ref={canvasRef} />
      {hover && (
        <div className="graph-hover-card" style={{ left: Math.min(hover.x, (wrapRef.current?.clientWidth ?? 400) - 280), top: Math.max(4, hover.y) }}>
          <div className="gh-title">{hover.n.title}</div>
          <div className="gh-meta">
            <span className="gh-layer" style={{ color: LAYER_COLOR[hover.n.layer] ?? undefined }}>● {hover.n.layer}</span>
            {hover.n.year && <span>{hover.n.year}</span>}
            <span>被引 {hover.n.citation_count}</span>
            {hover.n.imported && <span className="gh-imported">已入库</span>}
          </div>
          <div className="gh-actions">
            {hover.n.imported
              ? <button className="primary" onClick={() => cbRef.current.onOpen(hover.n)}>阅读</button>
              : <button onClick={() => cbRef.current.onImport(hover.n)}>入库</button>}
          </div>
        </div>
      )}
      <div className="graph-legend">
        {Object.entries(LAYER_COLOR).map(([k, c]) => (
          <span key={k}><i style={{ background: c }} />{k}</span>
        ))}
      </div>
      <div className="graph-hint">单击聚焦邻居 · 双击打开 · 圆越大被引越多 · 白边=已入库</div>
    </div>
  );
}
