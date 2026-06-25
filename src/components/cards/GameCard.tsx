import React from 'react';
import { RenderSpec } from '../../hub/render-contract.types';

function formatTime(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  } catch { return iso; }
}

const headUrl = (id: string | number) => `https://midfield.mlbstatic.com/v1/people/${id}/spots/120`;

function side(abbrev: string, name: string, logo: string, record: string, runs: number | null, win: boolean, isHome: boolean) {
  return (
    <div className={`side ${isHome ? 'home' : ''}`}>
      <span className="tlogo">
        <img src={logo} alt={abbrev} />
      </span>
      <div className="tinfo">
        <div className="city">{name?.split(' ').slice(0, -1).join(' ')}</div>
        <div className="name serif">{name?.split(' ').slice(-1).join(' ')}</div>
        {record ? <div className="rec tnum">{record}</div> : null}
      </div>
      {runs != null ? <span className={`runs ${win ? 'win' : 'lose'}`}>{runs}</span> : null}
    </div>
  );
}

function rhe(f: Record<string, any>, winA: boolean, winH: boolean) {
  if (!f.line || !f.line.away || !f.line.home) return null;
  const { away, home } = f.line;
  
  const row = (ab: string, o: any, win: boolean) => (
    <>
      <span className="tm">{ab}</span>
      <span className={`v ${win ? '' : 'dimv'}`}>{o.r}</span>
      <span className={`v ${win ? '' : 'dimv'}`}>{o.h}</span>
      <span className={`v ${win ? '' : 'dimv'}`}>{o.e}</span>
    </>
  );

  return (
    <div className="rhe">
      <div className="grid">
        <span className="tm"></span><span className="hdr">R</span><span className="hdr">H</span><span className="hdr">E</span>
        {row(f.awayAbbrev, away, winA)}
        {row(f.homeAbbrev, home, winH)}
      </div>
    </div>
  );
}

function diamond(b: any) {
  if (!b) return null;
  return (
    <span className="diamond" role="img" aria-label={`Bases: ${[b.on1 && '1st', b.on2 && '2nd', b.on3 && '3rd'].filter(Boolean).join(', ') || 'empty'}`}>
      <span className={`base b2 ${b.on2 ? 'on scoring' : ''}`}></span>
      <span className={`base b3 ${b.on3 ? 'on scoring' : ''}`}></span>
      <span className={`base b1 ${b.on1 ? 'on' : ''}`}></span>
    </span>
  );
}

function outs(n: number) {
  if (n == null) return null;
  let s = [];
  for (let i = 0; i < 3; i++) s.push(<span key={i} className={`out ${i < n ? 'on' : ''}`}></span>);
  return <span className="outs" aria-label={`${n} out`}>{s}</span>;
}

export function GameCard({ render }: { render: RenderSpec }) {
  const f = render.fields || {};
  const variant = render.variant || 'pregame';

  const winA = variant === 'final' && f.winner === 'away';
  const winH = variant === 'final' && f.winner === 'home';
  const as = f.awayScore;
  const hs = f.homeScore;

  const dec = (d: any, lbl: string) => d ? (
    <div className="d">
      <span className="lbl">{lbl}</span>
      <span className="nm">{d.name}</span>
      <span className={`ln ${d.elite ? 'elite' : ''} tnum`}>{d.line || ''}</span>
    </div>
  ) : null;

  return (
    <div className={`card game-card--${variant}`}>
      <div className="axis">
        {side(f.awayAbbrev, f.awayTeam, f.awayLogo, f.awayRecord || '', as, as > hs, false)}
        <span className="atmark serif">at</span>
        {side(f.homeAbbrev, f.homeTeam, f.homeLogo, f.homeRecord || '', hs, hs > as, true)}
      </div>
      
      {variant !== 'pregame' && rhe(f, as > hs, hs > as)}

      <div className="state">
        <div className="state-l">
          {variant === 'live' && (
            <>
              <span className="chip live">● {f.period}</span>
              <span className="count-state">
                {diamond(f.bases)}
                <span className="bs tnum">{f.balls ?? 0}-{f.strikes ?? 0}</span>
                {outs(f.outs ?? 0)}
              </span>
            </>
          )}
          {variant === 'final' && (
            <span className="chip final">Final</span>
          )}
          {variant === 'pregame' && (
            <span className="chip upcoming">{formatTime(f.startTime)}</span>
          )}
        </div>
        <span className="venue">{f.venue}</span>
      </div>

      {variant === 'live' && f.pit && f.bat && (
        <div className="matchup-live">
          <span className="headshot">
            {f.pit.id && <img src={headUrl(f.pit.id)} alt="" />}
          </span>
          <div className="mu-txt">
            <span className="role">Pitching</span> <b>{f.pit.name}</b> {f.pit.line || ''}
            &nbsp;·&nbsp; <span className="role">At Bat</span> <b>{f.bat.name}</b> {f.bat.line || ''}
          </div>
        </div>
      )}

      {variant === 'final' && (f.win || f.loss || f.save) && (
        <div className="deco">
          {dec(f.win, 'W')}
          {dec(f.loss, 'L')}
          {dec(f.save, 'S')}
        </div>
      )}

      {variant === 'pregame' && (f.spread || f.total) && (
        <div className="deco">
          {f.spread && <div className="d"><span className="lbl">SPREAD</span><span className="nm tnum">{f.spread}</span></div>}
          {f.total && <div className="d"><span className="lbl">TOTAL</span><span className="nm tnum">O/U {f.total}</span></div>}
        </div>
      )}
    </div>
  );
}
