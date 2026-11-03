import { useEffect, useState, useRef } from 'react';
import { useStore } from '../store';
import { toast, toastErr } from './Toast';
import { IconPlus, IconTrash, IconBack } from './icons';
import DigestCard, { DigestDoc, toDigestDoc } from './DigestCard';

interface TopicRow {
  id: number; name: string; query: string; status: string;
  node_count: number; edge_count: number; note: string; updated_at: string;
}
interface TopicPaper {
  arxiv_id: string; title: string; year: number | null; citation_count: number;
  layer: string; in_degree: number; out_degree: number; read_order: number | null;
  imported: number; library_paper_id: number | null;
}

const LAYER_ORDER = ['series', 'foundation', 'key', 'bridge', 'node', 'frontier', 'discussion', 'context'] as const;

const LAYER_META: Record<string, { label: string; cls: string; hint: string }> = {
  series: { label: '系列正文', cls: 'series', hint: '标题就是这个系列的技术报告，按发表时间读' },
  foundation: { label: '地基', cls: 'foundation', hint: '领域早期的奠基性工作，被图内大量依赖' },
  key: { label: '核心', cls: 'key', hint: '图内被引最高的关键论文' },
  bridge: { label: '桥梁', cls: 'bridge', hint: '连接多方工作，引用与被引都多' },
  frontier: { label: '前沿', cls: 'frontier', hint: '近两年的最新工作' },
  node: { label: '节点', cls: 'node', hint: '主题相关论文' },
  discussion: { label: '评测与转述', cls: 'discussion', hint: '别人写的评测、对比和解读，不是系列原文' },
  context: { label: '外部参照', cls: 'context', hint: '引用图带出来的其他工作，需要时再读' },
};

export default function TopicView() {
  const [topics, setTopics] = useState<TopicRow[]>([]);
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [building, setBuilding] = useState(false);
  const [buildMsg, setBuildMsg] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<{ papers: TopicPaper[]; topic: TopicRow } | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [digest, setDigest] = useState<DigestDoc | null>(null);
  const [digestBusy, setDigestBusy] = useState(false);
  const openPaper = useStore(s => s.openPaper);
  const setView = useStore(s => s.setView);
  const msgRef = useRef('');

  async function refresh() { setTopics(await window.api.listTopics()); }
  useEffect(() => {
    refresh();
    const remembered = useStore.getState().openTopicId;
    if (remembered) openTopic(remembered);
    const off = window.api.onTopicProgress((p: any) => {
      if (msgRef.current !== p.msg) { msgRef.current = p.msg; setBuildMsg(p.msg); }
    });
    return off;
  }, []);

  async function build() {
    if (!query.trim() || building) return;
    setBuilding(true); setBuildMsg('启动构建…'); msgRef.current = '';
    try {
      const r = await window.api.buildTopic({ name: name.trim() || query.trim(), query: query.trim() });
      toast('success', `主题库构建完成：${r.nodeCount} 篇论文 / ${r.edgeCount} 条依赖`);
      setName(''); setQuery('');
      await refresh();
      await openTopic(r.topicId);
    } catch (e: any) { toastErr(e); } finally { setBuilding(false); setBuildMsg(''); }
  }

  async function openTopic(id: number) {
    useStore.setState({ openTopicId: id });
    setOpenId(id);
    setDigest(null);
    const d = await window.api.getTopic(id);
    setDetail(d);
    try {
      if (typeof window.api.getDigest === 'function') {
        setDigest(toDigestDoc(await window.api.getDigest('topic', id)));
      }
    } catch (e: any) { toastErr(e); }
  }

  async function genTopic() {
    if (!openId || digestBusy) return;
    if (typeof window.api.genTopicDigest !== 'function') {
      toast('info', '请先停掉并重新运行 npm run electron:dev，再生成精炼笔记');
      return;
    }
    setDigestBusy(true);
    try {
      const row = await window.api.genTopicDigest(openId);
      setDigest(toDigestDoc(row));
      toast('success', '已生成主题精炼笔记');
    } catch (e: any) { toastErr(e); } finally { setDigestBusy(false); }
  }

  function openCite(paperId: number, pid: number | null) {
    if (pid) localStorage.setItem(`paper:${paperId}:pid`, String(pid));
    openPaper(paperId);
  }

  async function importPaper(p: TopicPaper) {
    if (importing) return;
    setImporting(p.arxiv_id);
    try {
      const r = await window.api.importTopicPaper({ topicId: openId!, arxivId: p.arxiv_id });
      toast('success', `已导入：${p.title.slice(0, 40)}`);
      const d = await window.api.getTopic(openId!);
      setDetail(d);
      // 不自动跳转，留在主题页继续浏览；用户可稍后从论文库打开
      void r;
    } catch (e: any) { toastErr(e); } finally { setImporting(null); }
  }

  async function readNow(p: TopicPaper) {
    if (importing) return;
    // 先备齐论文再交给 openPaper 切视图。提前 setView('reader') 时 currentPaper 仍为空，
    // Reader 会在渲染期读 paper.id 抛错，React 卸掉整棵树，页面变成空白且不再恢复。
    setImporting(p.arxiv_id);
    try {
      let paperId = p.library_paper_id;
      if (!paperId) {
        // imported=1 但 library_paper_id 为空：论文曾被导入但已删除 → 重新导入
        const r = await window.api.importTopicPaper({ topicId: openId!, arxivId: p.arxiv_id });
        paperId = r.paperId;
      }
      if (!paperId) throw new Error('没有得到可打开的论文');
      await openPaper(paperId);
    } catch (e: any) { toastErr(e); } finally { setImporting(null); }
  }

  async function rebuild() {
    if (!detail?.topic || building) return;
    setBuilding(true); setBuildMsg('重新构建…'); msgRef.current = '';
    try {
      const r = await window.api.buildTopic({ name: detail.topic.name, query: detail.topic.query });
      toast('success', `已按当前规则重新构建：${r.nodeCount} 篇`);
      await refresh();
      await openTopic(r.topicId);
    } catch (e: any) { toastErr(e); } finally { setBuilding(false); setBuildMsg(''); }
  }

  async function removeTopic(e: React.MouseEvent, id: number, name: string) {
    e.stopPropagation();
    if (!confirm(`删除主题「${name}」？（只删主题图，不影响已导入的论文）`)) return;
    await window.api.deleteTopic(id);
    if (openId === id) { setOpenId(null); setDetail(null); setDigest(null); }
    if (useStore.getState().openTopicId === id) useStore.setState({ openTopicId: null });
    refresh();
  }

  // 详情视图
  if (openId && detail) {
    const papers = detail.papers ?? [];
    const byLayer = (l: string) => papers.filter(p => p.layer === l);
    return (
      <div className="topic-page">
        <div className="list-head">
          <button className="icon-btn" onClick={() => { useStore.setState({ openTopicId: null }); setOpenId(null); setDetail(null); setDigest(null); }} title="返回主题列表"><IconBack /></button>
          <h1>{detail.topic?.name}</h1>
          <span className="count">{papers.length} 篇 · {detail.topic?.query}</span>
          <button className="ghost-btn" onClick={rebuild} disabled={building}>{building ? (buildMsg || '重新构建中…') : '重新构建'}</button>
        </div>
        {building && buildMsg && <div className="topic-progress">{buildMsg}</div>}
        <div className="topic-order-hint">
          {papers.some(p => p.layer === 'series')
            ? '这是一个系列：先按发表时间读「系列正文」。评测和外部参照放在后面，编号即阅读顺序。'
            : '阅读顺序建议：从地基（领域奠基工作）→ 核心 → 桥梁 → 前沿（最新进展）。编号即推荐顺序。'}
        </div>
        <DigestCard
          kicker="这个主题我带走的"
          doc={digest}
          busy={digestBusy}
          emptyHint="把这个主题里你已经留下划线、笔记或提问的论文合成一页，按推荐阅读顺序串起来。标记可以点回某一篇的段落。"
          onGenerate={genTopic}
          onOpen={openCite}
        />
        {LAYER_ORDER.map(layer => {
          const list = byLayer(layer);
          if (!list.length) return null;
          const meta = LAYER_META[layer];
          return (
            <section key={layer} className="topic-section">
              <div className={`layer-head ${meta.cls}`}>
                <span className="layer-badge">{meta.label}</span>
                <span className="layer-hint">{meta.hint}</span>
                <span className="layer-count">{list.length}</span>
              </div>
              {list.map(p => (
                <div key={p.arxiv_id} className="topic-paper">
                  <span className="read-order">#{p.read_order}</span>
                  <div className="tp-main">
                    <div className="tp-title" title={p.title}>{p.title}</div>
                    <div className="tp-meta">
                      <span>arXiv:{p.arxiv_id}</span>
                      {p.year && <span>{p.year}</span>}
                      {p.citation_count > 0 && <span>被引 {p.citation_count}</span>}
                      {p.in_degree > 0 && <span title="图内被引">图内被引 {p.in_degree}</span>}
                    </div>
                  </div>
                  <div className="tp-actions">
                    <button className="primary" onClick={() => readNow(p)} disabled={!!importing}>
                      {importing === p.arxiv_id ? (p.library_paper_id ? '打开中…' : '导入中…') : '阅读'}
                    </button>
                    {!(p.library_paper_id || p.imported) && (
                      <button onClick={() => importPaper(p)} disabled={!!importing}>
                        {importing === p.arxiv_id ? '导入中…' : '入库'}
                      </button>
                    )}
                    <a className="arxiv-link" href={`https://arxiv.org/abs/${p.arxiv_id}`} target="_blank" rel="noreferrer">arXiv</a>
                  </div>
                </div>
              ))}
            </section>
          );
        })}
      </div>
    );
  }

  // 列表视图
  return (
    <div className="topic-page">
      <div className="list-head">
        <h1>主题依赖库</h1>
        <span className="count">{topics.length} 个主题</span>
      </div>
      <div className="import-box topic-build-box">
        <IconPlus s={16} />
        <input
          type="text" placeholder="主题名（可选，如：投机解码）"
          value={name} onChange={e => setName(e.target.value)} disabled={building}
        />
        <input
          type="text" className="query-input" placeholder="arXiv 搜索词（如 speculative decoding LLM）"
          value={query} onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && build()} disabled={building}
        />
        <button className="primary" onClick={build} disabled={building || !query.trim()}>
          {building ? (buildMsg || '构建中…') : '构建依赖库'}
        </button>
      </div>
      {building && buildMsg && <div className="topic-progress">{buildMsg}</div>}

      {topics.length === 0 && !building && (
        <div className="empty-hint">
          <div className="empty-icon">🕸️</div>
          输入主题关键词构建论文依赖库：自动搜索种子论文、<br />
          拉取引用关系、按「地基 → 核心 → 桥梁 → 前沿」分层并推荐阅读顺序。
        </div>
      )}

      {topics.map(t => (
        <div key={t.id} className="topic-card" onClick={() => openTopic(t.id)}>
          <div className="tc-main">
            <div className="tc-name">{t.name}</div>
            <div className="tc-meta">
              <span>{t.node_count} 篇</span>
              <span>{t.edge_count} 条依赖</span>
              <span>“{t.query}”</span>
              {t.status === 'error' && <span className="err">{t.note?.slice(0, 60)}</span>}
            </div>
          </div>
          <button className="icon-danger" onClick={e => removeTopic(e, t.id, t.name)} title="删除主题"><IconTrash s={15} /></button>
        </div>
      ))}
    </div>
  );
}
