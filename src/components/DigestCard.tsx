import AnswerText from './AnswerText';

export interface DigestCite {
  token: string;
  paperId: number;
  pid: number | null;
}

export interface DigestDoc {
  body: string;
  updated_at: string;
  cites: DigestCite[];
}

export function toDigestDoc(row: { body: string; updated_at: string; cites?: DigestCite[] } | null | undefined): DigestDoc | null {
  if (!row?.body) return null;
  return { body: row.body, updated_at: row.updated_at, cites: row.cites ?? [] };
}

export default function DigestCard({
  kicker,
  doc,
  busy,
  emptyHint,
  onGenerate,
  onOpen,
}: {
  kicker: string;
  doc: DigestDoc | null;
  busy: boolean;
  emptyHint: string;
  onGenerate: () => void;
  onOpen: (paperId: number, pid: number | null) => void;
}) {
  return (
    <div className="digest-card">
      <div className="digest-bar">
        <span className="digest-kicker">{kicker}</span>
        {doc?.updated_at && <span className="digest-time">{doc.updated_at.slice(0, 16)}</span>}
        <button className="ghost-btn" onClick={onGenerate} disabled={busy}>
          {busy ? '生成中…' : doc ? '重新生成' : '生成'}
        </button>
      </div>
      {doc?.body ? (
        <div className="digest-body">
          <AnswerText
            text={doc.body}
            onJump={(ref) => {
              const hit = doc.cites.find(c => c.token === ref);
              if (hit) onOpen(hit.paperId, hit.pid);
            }}
          />
        </div>
      ) : (
        <p className="digest-empty">{emptyHint}</p>
      )}
    </div>
  );
}
