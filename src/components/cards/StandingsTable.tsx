import React from 'react';
import { RenderSpec } from '../../hub/render-contract.types';

function isNumCol(c: string) {
  return ['pos', 'p', 'w', 'd', 'l', 'gd', 'pts', 'odds'].includes(c);
}

export function StandingsTable({ render }: { render: RenderSpec }) {
  const f = render.fields || {};
  const groups = (render as any).groups || [];

  if (!groups.length) return null;

  return (
    <div className="standings">
      {f.title && <div className="st-title">{f.title}</div>}

      <div className="st-grid">
        {groups.map((g: any) => (
          <div className="st-group" key={g.label}>
            <div className="st-group-head">
              <span className="st-group-label">{g.label}</span>
              {g.host && <span className="st-group-host">{g.host}</span>}
            </div>

            <table className="st-table">
              <thead>
                <tr>
                  {(g.columns || []).map((c: string) => (
                    <th key={c} className={isNumCol(c) ? 'num' : ''}>{c.toUpperCase()}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(g.rows || []).map((r: any) => (
                  <tr key={r.code || r.team} className={r._advancing ? 'st-adv' : ''}>
                    {(g.columns || []).map((c: string) => (
                      <td key={c} className={isNumCol(c) ? 'num' : ''}>
                        {c === 'team' ? (
                          <span className="st-team">
                            {r.logo && <img src={r.logo} alt={r.code} />}
                            {r.team}
                            {r.rank && <span className="st-rank">{r.rank}</span>}
                          </span>
                        ) : c === 'odds' ? (
                          <span className="st-odds">{r.odds ?? '—'}</span>
                        ) : (
                          r[c] ?? '—'
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}
