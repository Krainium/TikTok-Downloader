import { humanBytes, humanDuration, humanSpeed } from '../format';

export interface ProgressState {
  label: string;
  pct: number; // -1 when total unknown
  downloaded: number;
  total: number | null;
  speed: number;
  useProxy: boolean;
}

export function ProgressCard({ p }: { p: ProgressState }) {
  const known = p.pct >= 0;
  const eta = known && p.speed > 0 && p.total ? (p.total - p.downloaded) / p.speed : null;
  const size = p.total ? `${humanBytes(p.downloaded)} / ${humanBytes(p.total)}` : humanBytes(p.downloaded);

  return (
    <section className="card progress-card">
      <div className="progress-head">
        <span className="progress-label">
          {p.label}
          {p.useProxy ? ' · proxy' : ''}
        </span>
        <span className="progress-pct">{known ? `${p.pct}%` : '…'}</span>
      </div>
      <div className="bar">
        <i className="bar-fill" style={{ width: known ? `${p.pct}%` : '100%' }} />
      </div>
      <div className="progress-meta">
        <span>{size}</span>
        <span>{humanSpeed(p.speed)}</span>
        <span>ETA {humanDuration(eta)}</span>
      </div>
    </section>
  );
}
