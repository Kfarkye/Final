import React from 'react';
import { RenderSpec } from '../../hub/render-contract.types';

export function StatCard({ render }: { render: RenderSpec }) {
  const f = render.fields || {};

  return (
    <div className="stat-card">
      {f.label && <div className="sc-label">{f.label}</div>}

      <div className="sc-hero">
        <span className="sc-value">{f.value ?? '—'}</span>
        {f.rank && <span className="sc-rank">{f.rank}</span>}
      </div>

      {f.subject && (
        <div className="sc-subject">
          {f.subjectLogo && <img src={f.subjectLogo} alt={f.subject} />}
          <span>{f.subject}</span>
          {f.qualifier && <span className="sc-qual">· {f.qualifier}</span>}
        </div>
      )}

      {f.context && <p className="sc-context">{f.context}</p>}

      {/* Optional mini-leaderboard */}
      {render.rows && (
        <div className="sc-board">
          {render.rows.map((r: any, i: number) => (
            <div className={`sc-row ${i === 0 ? 'sc-row--lead' : ''}`} key={i}>
              <span className="sc-rownum">{r.rank}</span>
              <span className="sc-rowname">{r.name}</span>
              <span className="sc-rowval">{r.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
