import React from 'react';
import { RenderSpec } from '../../hub/render-contract.types';

export function PlayerCard({ render }: { render: RenderSpec }) {
  const f = render.fields || {};
  const variant = render.variant || 'season';

  return (
    <div className="player-card">
      {/* Header — identity */}
      <div className="pc-header">
        {f.headshot && <img className="pc-headshot" src={f.headshot} alt={f.name} />}
        <div className="pc-identity">
          <h3 className="pc-name">{f.name}</h3>
          <div className="pc-meta">
            {f.teamLogo && <img className="pc-teamlogo" src={f.teamLogo} alt={f.teamAbbrev} />}
            <span>{f.position}</span>
            {f.season && variant === 'season' && <span>· {f.season}</span>}
            {variant === 'career' && <span>· Career</span>}
            {variant === 'splits' && <span>· Splits</span>}
          </div>
        </div>
      </div>

      {/* Hero — the answer */}
      {(f.heroStat != null) && (
        <div className="pc-hero">
          <div className="pc-hero-value">
            {f.heroStat}
            <span className="pc-hero-label">{f.heroLabel}</span>
          </div>
          {f.heroContext && <p className="pc-hero-context">{f.heroContext}</p>}
        </div>
      )}

      {/* Supporting slash line */}
      {f.statLine && (
        <div className="pc-statline">
          {f.statLine.split(' / ').map((v: string, i: number) => (
            <div className="pc-stat" key={i}>
              <span className="pc-stat-value">{v}</span>
              <span className="pc-stat-label">{f.statLineLabels?.[i]}</span>
            </div>
          ))}
        </div>
      )}

      {/* Optional breakdown table */}
      {render.rows && render.columns && (
        <table className="pc-breakdown">
          <thead>
            <tr>{render.columns.map(c => <th key={c}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {render.rows.map((row, i) => (
              <tr key={i}>
                {render.columns!.map(c => (
                  <td key={c} className={isNaN(row[c]) ? '' : 'num'}>
                    {row[c] ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
