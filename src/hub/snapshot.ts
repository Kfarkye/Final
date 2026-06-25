import { HubEnvelope, RenderSpec } from './render-contract.types';

// ─────────────────────────────────────────────────────────────────
// SNAPSHOT SERIALIZER
// Converts a HubEnvelope into a self-contained, shareable HTML file.
// No React, no fetch — frozen data baked into static markup.
// ─────────────────────────────────────────────────────────────────

export function envelopeToHtml(env: HubEnvelope): string {
  const card = renderCardHtml(env);
  const title = env.summary || `${env.type} · ${env.id}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta property="og:title" content="${esc(title)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
<link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;1,6..72,400&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="preconnect" href="https://midfield.mlbstatic.com">
<link rel="preconnect" href="https://www.mlbstatic.com">
<style>${SNAPSHOT_CSS}</style>
</head>
<body>
  <div class="snap-wrap">
    ${card}
    <div class="snap-foot">
      <span>Truth · ${esc(env.type)}</span>
      <span>${new Date().toISOString().slice(0, 10)}</span>
    </div>
  </div>
</body>
</html>`;
}

// ── Per-type HTML dispatchers ───────────────────────────────────────

function renderCardHtml(env: HubEnvelope): string {
  const r = env.render;
  if (!r) return `<div class="snap-md">${esc(env.summary)}</div>`;

  switch (r.renderType) {
    case 'game-card':       return gameHtml(r);
    case 'player-card':     return playerHtml(r);
    case 'odds-board':      return oddsHtml(r);
    case 'stat-card':       return statHtml(r);
    case 'standings-table': return standingsHtml(r);
    default:                return `<div class="snap-md">${esc(env.summary)}</div>`;
  }
}

// ── Game Card ───────────────────────────────────────────────────────

function gameHtml(r: RenderSpec): string {
  const f = r.fields || {};
  const variant = r.variant || 'pregame';

  const as = f.awayScore;
  const hs = f.homeScore;
  const winA = variant === 'final' && f.winner === 'away';
  const winH = variant === 'final' && f.winner === 'home';

  const side = (abbrev: string, name: string, logo: string, record: string, runs: number | null, win: boolean, isHome: boolean) => `
    <div class="side ${isHome ? 'home' : ''}">
      <span class="tlogo">${logo ? `<img src="${esc(logo)}" alt="">` : ''}</span>
      <div class="tinfo">
        <div class="city">${esc(name?.split(' ').slice(0, -1).join(' '))}</div>
        <div class="name serif">${esc(name?.split(' ').slice(-1).join(' '))}</div>
        ${record ? `<div class="rec tnum">${esc(record)}</div>` : ''}
      </div>
      ${runs != null ? `<span class="runs ${win ? 'win' : 'lose'}">${runs}</span>` : ''}
    </div>`;

  const dec = (d: any, lbl: string) => d ? `
    <div class="d">
      <span class="lbl">${lbl}</span>
      <span class="nm">${esc(d.name)}</span>
      <span class="ln ${d.elite ? 'elite' : ''} tnum">${esc(d.line || '')}</span>
    </div>` : '';

  let rheHtml = '';
  if (variant !== 'pregame' && f.line && f.line.away && f.line.home) {
    const row = (ab: string, o: any, win: boolean) => `
      <span class="tm">${esc(ab)}</span>
      <span class="v ${win ? '' : 'dimv'}">${o.r}</span>
      <span class="v ${win ? '' : 'dimv'}">${o.h}</span>
      <span class="v ${win ? '' : 'dimv'}">${o.e}</span>`;
    rheHtml = `
      <div class="rhe">
        <div class="grid">
          <span class="tm"></span><span class="hdr">R</span><span class="hdr">H</span><span class="hdr">E</span>
          ${row(f.awayAbbrev, f.line.away, as > hs)}
          ${row(f.homeAbbrev, f.line.home, hs > as)}
        </div>
      </div>`;
  }

  let stateHtml = '';
  if (variant === 'live') {
    const b = f.bases || {};
    const diamondHtml = `
      <span class="diamond" role="img">
        <span class="base b2 ${b.on2 ? 'on scoring' : ''}"></span>
        <span class="base b3 ${b.on3 ? 'on scoring' : ''}"></span>
        <span class="base b1 ${b.on1 ? 'on' : ''}"></span>
      </span>`;
    let outsHtml = '';
    for (let i = 0; i < 3; i++) { outsHtml += `<span class="out ${i < (f.outs ?? 0) ? 'on' : ''}"></span>`; }
    outsHtml = `<span class="outs">${outsHtml}</span>`;
    
    stateHtml = `
      <span class="chip live">● ${esc(f.period)}</span>
      <span class="count-state">${diamondHtml}<span class="bs tnum">${f.balls ?? 0}-${f.strikes ?? 0}</span>${outsHtml}</span>`;
  } else if (variant === 'final') {
    stateHtml = `<span class="chip final">Final</span>`;
  } else {
    stateHtml = `<span class="chip upcoming">${fmtTime(f.startTime)}</span>`;
  }

  let liveMatchupHtml = '';
  if (variant === 'live' && f.pit && f.bat) {
    liveMatchupHtml = `
      <div class="matchup-live">
        <span class="headshot">${f.pit.id ? `<img src="https://midfield.mlbstatic.com/v1/people/${f.pit.id}/spots/120" alt="">` : ''}</span>
        <div class="mu-txt">
          <span class="role">Pitching</span> <b>${esc(f.pit.name)}</b> ${esc(f.pit.line || '')}
          &nbsp;·&nbsp; <span class="role">At Bat</span> <b>${esc(f.bat.name)}</b> ${esc(f.bat.line || '')}
        </div>
      </div>`;
  }

  let decoHtml = '';
  if (variant === 'final' && (f.win || f.loss || f.save)) {
    decoHtml = `<div class="deco">${dec(f.win, 'W')}${dec(f.loss, 'L')}${dec(f.save, 'S')}</div>`;
  } else if (variant === 'pregame' && (f.spread || f.total)) {
    decoHtml = `
      <div class="deco">
        ${f.spread ? `<div class="d"><span class="lbl">SPREAD</span><span class="nm tnum">${esc(f.spread)}</span></div>` : ''}
        ${f.total ? `<div class="d"><span class="lbl">TOTAL</span><span class="nm tnum">O/U ${esc(f.total)}</span></div>` : ''}
      </div>`;
  }

  return `
    <div class="card game-card--${variant}">
      <div class="axis">
        ${side(f.awayAbbrev, f.awayTeam, f.awayLogo, f.awayRecord || '', as, as > hs, false)}
        <span class="atmark serif">at</span>
        ${side(f.homeAbbrev, f.homeTeam, f.homeLogo, f.homeRecord || '', hs, hs > as, true)}
      </div>
      ${rheHtml}
      <div class="state">
        <div class="state-l">${stateHtml}</div>
        <span class="venue">${esc(f.venue)}</span>
      </div>
      ${liveMatchupHtml}
      ${decoHtml}
    </div>`;
}

// ── Player Card ─────────────────────────────────────────────────────

function playerHtml(r: RenderSpec): string {
  const f = r.fields || {};
  const slash = String(f.statLine || '').split(' / ').filter(Boolean);
  const labels = f.statLineLabels || [];

  return `<div class="player-card">
    <div class="pc-header">
      ${f.headshot ? `<img class="pc-headshot" src="${esc(f.headshot)}" alt="">` : ''}
      <div class="pc-identity">
        <h3 class="pc-name">${esc(f.name)}</h3>
        <div class="pc-meta">
          ${f.teamLogo ? `<img class="pc-teamlogo" src="${esc(f.teamLogo)}" alt="">` : ''}
          ${esc(f.position || '')} ${f.team ? '· ' + esc(f.team) : ''} ${f.season ? '· ' + esc(f.season) : ''}
        </div>
      </div>
    </div>
    <div class="pc-hero">
      <div class="pc-hero-value">${esc(f.heroStat)}<span class="pc-hero-label">${esc(f.heroLabel)}</span></div>
      ${f.heroContext ? `<p class="pc-hero-context">${esc(f.heroContext)}</p>` : ''}
    </div>
    ${slash.length > 1 ? `<div class="pc-statline">${slash.map((v: string, i: number) =>
      `<div class="pc-stat"><span class="pc-stat-value">${esc(v)}</span><span class="pc-stat-label">${esc(labels[i] || '')}</span></div>`
    ).join('')}</div>` : ''}
    ${r.rows && r.columns ? breakdownTableHtml(r.rows, r.columns) : ''}
  </div>`;
}

function breakdownTableHtml(rows: any[], columns: string[]): string {
  if (!rows.length || !columns.length) return '';
  return `<table class="pc-breakdown">
    <thead><tr>${columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(row =>
      `<tr>${columns.map(c => `<td class="${typeof row[c] === 'number' ? 'num' : ''}">${esc(row[c] ?? '—')}</td>`).join('')}</tr>`
    ).join('')}</tbody>
  </table>`;
}

// ── Odds Board ──────────────────────────────────────────────────────

function oddsHtml(r: RenderSpec): string {
  const f = r.fields || {};
  const allRows = r.rows || [];
  const sides = [...new Set(allRows.map((x: any) => x.side))];
  const books = groupByBook(allRows);

  return `<div class="odds-board">
    <div class="ob-header">
      <div class="ob-market">${esc(f.market)}</div>
      ${f.event ? `<div class="ob-event">${esc(f.event)}</div>` : ''}
      ${f.sharpAnchor ? `<div class="ob-sharp">Sharp <span>${esc(f.sharpAnchor)}</span></div>` : ''}
    </div>
    <table class="ob-table">
      <thead><tr><th>Book</th>${sides.map(s => `<th class="num">${esc(s as string)}</th>`).join('')}</tr></thead>
      <tbody>${books.map(({ book, prices }) => `<tr>
        <td class="ob-book">${esc(book)}</td>
        ${sides.map(side => {
          const c = prices.find((p: any) => p.side === side);
          return `<td class="num ${c?._best ? 'ob-best' : ''}">${c ? esc(fmtPrice(c.price, c.line)) : '—'}</td>`;
        }).join('')}
      </tr>`).join('')}</tbody>
    </table>
  </div>`;
}

// ── Stat Card ───────────────────────────────────────────────────────

function statHtml(r: RenderSpec): string {
  const f = r.fields || {};
  return `<div class="stat-card">
    ${f.label ? `<div class="sc-label">${esc(f.label)}</div>` : ''}
    <div class="sc-hero">
      <span class="sc-value">${esc(f.value)}</span>
      ${f.rank ? `<span class="sc-rank">${esc(f.rank)}</span>` : ''}
    </div>
    ${f.subject ? `<div class="sc-subject">${f.subjectLogo ? `<img src="${esc(f.subjectLogo)}" alt="">` : ''}${esc(f.subject)} ${f.qualifier ? `<span class="sc-qual">· ${esc(f.qualifier)}</span>` : ''}</div>` : ''}
    ${f.context ? `<p class="sc-context">${esc(f.context)}</p>` : ''}
    ${r.rows ? leaderboardHtml(r.rows) : ''}
  </div>`;
}

function leaderboardHtml(rows: any[]): string {
  if (!rows.length) return '';
  return `<div class="sc-board">${rows.map((r: any, i: number) =>
    `<div class="sc-row ${i === 0 ? 'sc-row--lead' : ''}"><span class="sc-rownum">${esc(r.rank)}</span><span class="sc-rowname">${esc(r.name)}</span><span class="sc-rowval">${esc(r.value)}</span></div>`
  ).join('')}</div>`;
}

// ── Standings Table ─────────────────────────────────────────────────

function standingsHtml(r: RenderSpec): string {
  const f = r.fields || {};
  const groups = (r as any).groups || [];

  return `<div class="standings">
    ${f.title ? `<div class="st-title">${esc(f.title)}</div>` : ''}
    <div class="st-grid">${groups.map((g: any) => `<div class="st-group">
      <div class="st-group-head">
        <span class="st-group-label">${esc(g.label)}</span>
        ${g.host ? `<span class="st-group-host">${esc(g.host)}</span>` : ''}
      </div>
      <table class="st-table">
        <thead><tr>${(g.columns || []).map((c: string) =>
          `<th class="${isNumCol(c) ? 'num' : ''}">${c.toUpperCase()}</th>`
        ).join('')}</tr></thead>
        <tbody>${(g.rows || []).map((row: any) =>
          `<tr class="${row._advancing ? 'st-adv' : ''}">${(g.columns || []).map((c: string) =>
            `<td class="${isNumCol(c) ? 'num' : ''}">${
              c === 'team'
                ? `<span class="st-team">${row.logo ? `<img src="${esc(row.logo)}" alt="">` : ''}${esc(row.team)}${row.rank ? `<span class="st-rank">${esc(row.rank)}</span>` : ''}</span>`
                : c === 'odds'
                ? `<span class="st-odds">${esc(row.odds ?? '—')}</span>`
                : esc(String(row[c] ?? '—'))
            }</td>`
          ).join('')}</tr>`
        ).join('')}</tbody>
      </table>
    </div>`).join('')}</div>
  </div>`;
}

// ── Shared helpers ──────────────────────────────────────────────────

function esc(s: any): string {
  return String(s ?? '').replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c)
  );
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch { return iso; }
}

function groupByBook(rows: any[]): { book: string; prices: any[] }[] {
  const m = new Map<string, any[]>();
  for (const r of rows) {
    if (!m.has(r.book)) m.set(r.book, []);
    m.get(r.book)!.push(r);
  }
  return [...m.entries()].map(([book, prices]) => ({ book, prices }));
}

function fmtPrice(p: any, line: any): string {
  const s = typeof p === 'number' ? (p > 0 ? `+${p}` : `${p}`) : String(p);
  return line != null ? `${Number(line) > 0 ? '+' : ''}${line} (${s})` : s;
}

function isNumCol(c: string): boolean {
  return ['pos', 'p', 'w', 'd', 'l', 'gd', 'pts', 'odds'].includes(c);
}

// ── Inlined CSS — The Drip aesthetic, self-contained ────────────────

const SNAPSHOT_CSS = `
/* ═══════ Truth Design System v1.0 — four values ═══════ */
:root{
  --t-surface-0:#0a0a0b; --t-surface-1:#101012; --t-surface-2:#141417; --t-surface-3:#1a1a1e;
  --t-white:#ededee; --t-white-dim:rgba(237,237,238,.80); --t-white-50:rgba(237,237,238,.50);
  --t-grey:#7a7a86; --t-grey-fade:#34343d; --t-grey-dim:#50505a;
  --t-blue:#4b9cd3; --t-blue-soft:rgba(75,156,211,.70);
  --t-blue-dim:rgba(75,156,211,.14);
  --t-border:rgba(255,255,255,.07); --t-border-subtle:rgba(255,255,255,.045);
  --t-glow:rgba(75,156,211,.04);
  /* mobile sizing floors */
  --tap-min:44px;          /* Apple HIG interactive minimum */
  --fs-floor:11px;         /* legibility floor for meta text */
}

/* ── Card ── */
.card{background:var(--t-surface-1);border:1px solid var(--t-border);border-radius:14px;overflow:hidden;margin-bottom:11px;
  transition:transform .25s cubic-bezier(.16,1,.3,1),border-color .25s;}
@media (hover:hover){.card:hover{transform:translateY(-1px);border-color:var(--t-grey-fade);}}

/* matchup axis — min-height clears 44px tap floor */
.axis{display:grid;grid-template-columns:1fr 38px 1fr;align-items:center;padding:15px 16px 13px;min-height:var(--tap-min);}
.side{display:flex;align-items:center;gap:10px;min-width:0;}
.side.home{flex-direction:row-reverse;text-align:right;}
.tlogo{width:36px;height:36px;flex:none;display:flex;align-items:center;justify-content:center;overflow:hidden;}
.tlogo img{width:32px;height:32px;object-fit:contain;}
.tlogo .ab{font-family:'Newsreader',serif;font-size:12px;color:var(--t-grey-dim);}
.tinfo{min-width:0;}
.tinfo .city{font-size:11px;font-weight:500;letter-spacing:.8px;text-transform:uppercase;color:var(--t-grey);line-height:1.3;}
.tinfo .name{font-family:'Newsreader',serif;font-size:19px;line-height:1.12;letter-spacing:-0.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.tinfo .rec{font-size:11px;color:var(--t-grey-fade);font-variant-numeric:tabular-nums;margin-top:2px;}
.runs{font-family:'Newsreader',serif;font-size:28px;line-height:1;letter-spacing:-1px;flex:none;font-variant-numeric:tabular-nums;}
.win{color:var(--t-white);} .lose{color:var(--t-grey-dim);}
.atmark{font-family:'Newsreader',serif;font-style:italic;font-size:13px;color:var(--t-grey-fade);text-align:center;}

/* R/H/E — bumped to legible floor */
.rhe{display:flex;justify-content:flex-end;padding:0 16px 12px;}
.rhe .grid{display:grid;grid-template-columns:auto 28px 28px 28px;gap:3px 6px;text-align:right;align-items:center;
  font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.02em;}
.rhe .hdr{color:var(--t-grey-dim);font-size:10px;text-transform:uppercase;letter-spacing:.1em;}
.rhe .tm{color:var(--t-grey);text-align:left;padding-right:6px;font-weight:500;}
.rhe .v{color:var(--t-white-dim);font-weight:500;}
.rhe .v.dimv{color:var(--t-grey);}

/* state strip */
.state{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 16px;
  border-top:1px solid var(--t-border-subtle);min-height:var(--tap-min);}
.state-l{display:flex;align-items:center;gap:13px;min-width:0;}
.chip{font-family:'JetBrains Mono',monospace;font-weight:500;letter-spacing:.04em;font-size:12px;text-transform:uppercase;white-space:nowrap;}
.chip.live{color:var(--t-blue-soft);}
.chip.final{color:var(--t-grey);}
.chip.upcoming{color:var(--t-grey-dim);}
.count-state{display:flex;align-items:center;gap:9px;}
.bs{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--t-grey);font-variant-numeric:tabular-nums;}

/* OUTS — 7px pips, clearly legible */
.outs{display:flex;gap:4px;}
.out{width:7px;height:7px;border-radius:50%;border:1.5px solid var(--t-grey-dim);}
.out.on{background:var(--t-white-dim);border-color:var(--t-white-dim);}

/* ── BASE DIAMOND — true symmetric geometry, 26px field, 9px bases ── */
.diamond{position:relative;width:26px;height:26px;flex:none;}
.base{position:absolute;width:9px;height:9px;background:transparent;
  border:1.5px solid var(--t-grey-dim);border-radius:1.5px;transform:rotate(45deg);
  transition:background .2s ease,border-color .2s ease;}
.base.b2{top:0;    left:8.5px;}   /* 2nd — top center   */
.base.b3{top:8.5px;left:0;}        /* 3rd — middle left  */
.base.b1{top:8.5px;left:17px;}     /* 1st — middle right */
.base.on{background:var(--t-white-dim);border-color:var(--t-white-dim);}
.base.on.scoring{background:var(--t-blue);border-color:var(--t-blue);}

.venue{font-size:11px;color:var(--t-grey-fade);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:right;}

/* decision line */
.deco{display:flex;flex-wrap:wrap;gap:7px 18px;padding:13px 16px;border-top:1px solid var(--t-border-subtle);background:var(--t-surface-0);min-height:var(--tap-min);align-items:center;}
.deco .d{display:flex;align-items:baseline;gap:6px;font-size:13px;}
.deco .lbl{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--t-grey-dim);text-transform:uppercase;letter-spacing:.08em;}
.deco .nm{color:var(--t-white-dim);font-weight:500;}
.deco .ln{color:var(--t-grey);font-variant-numeric:tabular-nums;}
.deco .ln.elite{color:var(--t-blue);}

/* live matchup */
.matchup-live{display:flex;align-items:center;gap:12px;padding:12px 16px;border-top:1px solid var(--t-border-subtle);background:var(--t-surface-0);}
.headshot{width:40px;height:40px;border-radius:8px;flex:none;overflow:hidden;background:var(--t-surface-2);display:flex;align-items:center;justify-content:center;}
.headshot img{width:100%;height:100%;object-fit:cover;object-position:top center;}
.headshot .ab{font-family:'Newsreader',serif;font-size:13px;color:var(--t-grey-dim);}
.mu-txt{font-size:13px;color:var(--t-grey);line-height:1.45;}
.mu-txt .role{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--t-grey-dim);text-transform:uppercase;letter-spacing:.08em;}
.mu-txt b{color:var(--t-white-dim);font-weight:500;}


*{margin:0;padding:0;box-sizing:border-box}
body{background:#000;color:#fff;font-family:'Inter',system-ui,sans-serif;-webkit-font-smoothing:antialiased;padding:40px 20px;display:flex;justify-content:center}
.snap-wrap{max-width:480px;width:100%}
.snap-foot{display:flex;justify-content:space-between;margin-top:16px;font-size:0.6875rem;color:#555;text-transform:uppercase;letter-spacing:0.06em}
.snap-md{font-size:0.875rem;color:#888;line-height:1.5}

/* Game Card */
.game-card{background:#0f0f0f;border:1px solid #1a1a1a;border-radius:16px;padding:16px 18px;max-width:360px}
.gc-status{display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:0.625rem;text-transform:uppercase;letter-spacing:0.08em}
.gc-badge{color:#666;font-weight:600}
.gc-time{margin-left:auto;color:#888;font-variant-numeric:tabular-nums}
.gc-period{margin-left:auto;color:#FF453A;font-weight:700;font-variant-numeric:tabular-nums}
.gc-teams{display:flex;flex-direction:column;gap:10px}
.gc-team{display:flex;align-items:center;gap:10px}
.gc-team img{width:26px;height:26px;object-fit:contain}
.gc-abbrev{font-size:0.9375rem;font-weight:600;letter-spacing:-0.01em;color:#888}
.gc-score{margin-left:auto;font-size:1.5rem;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:-0.03em;color:#888}
.gc-meta{display:flex;align-items:center;gap:12px;margin-top:14px;padding-top:12px;border-top:1px solid #1a1a1a;font-size:0.6875rem;color:#888}
.gc-line{color:#7BAFD4;font-weight:600;font-variant-numeric:tabular-nums}
.game-card--pregame .gc-badge{color:#7BAFD4}
.game-card--pregame .gc-abbrev{color:#fff}
.game-card--live{border-left:2px solid #FF453A}
.game-card--live .gc-badge{color:#FF453A;font-weight:700}
.game-card--live .gc-score,.game-card--live .gc-abbrev{color:#fff}
.gc-pulse{width:6px;height:6px;border-radius:50%;background:#FF453A;animation:gc-pulse-anim 1.5s ease-in-out infinite}
@keyframes gc-pulse-anim{0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(255,69,58,0.4)}50%{opacity:0.6;box-shadow:0 0 0 5px rgba(255,69,58,0)}}
.game-card--final{opacity:0.92}
.game-card--final .gc-badge{color:#666}
.game-card--final .gc-score{color:#777}
.game-card--final .gc-team.winner .gc-score{color:#fff}
.game-card--final .gc-team.winner .gc-abbrev{color:#fff;font-weight:700}

/* Player Card */
.player-card{background:#0f0f0f;border:1px solid #1a1a1a;border-radius:16px;padding:20px;max-width:420px}
.pc-header{display:flex;align-items:center;gap:14px;margin-bottom:18px}
.pc-headshot{width:52px;height:52px;border-radius:12px;object-fit:cover;background:#161616}
.pc-identity{flex:1;min-width:0}
.pc-name{font-size:1.05rem;font-weight:700;letter-spacing:-0.02em;margin:0}
.pc-meta{display:flex;align-items:center;gap:6px;font-size:0.75rem;color:#888;margin-top:2px}
.pc-teamlogo{width:16px;height:16px;object-fit:contain}
.pc-hero{margin-bottom:16px}
.pc-hero-value{font-size:3rem;font-weight:800;line-height:1;letter-spacing:-0.04em;font-variant-numeric:tabular-nums;display:flex;align-items:baseline;gap:8px}
.pc-hero-label{font-size:1rem;font-weight:600;color:#888;letter-spacing:0}
.pc-hero-context{font-size:0.8125rem;color:#aaa;margin-top:6px;line-height:1.4;margin-bottom:0}
.pc-statline{display:flex;gap:0;border-top:1px solid #1a1a1a;padding-top:14px}
.pc-stat{flex:1;text-align:center;position:relative}
.pc-stat+.pc-stat::before{content:'';position:absolute;left:0;top:15%;height:70%;width:1px;background:#1a1a1a}
.pc-stat-value{display:block;font-size:1.25rem;font-weight:700;font-variant-numeric:tabular-nums}
.pc-stat-label{display:block;font-size:0.625rem;text-transform:uppercase;letter-spacing:0.08em;color:#666;margin-top:2px}
.pc-breakdown{width:100%;margin-top:16px;border-top:1px solid #1a1a1a;border-collapse:collapse}
.pc-breakdown th{text-align:left;font-size:0.625rem;text-transform:uppercase;letter-spacing:0.06em;color:#666;padding:8px 6px}
.pc-breakdown td{font-size:0.75rem;padding:5px 6px;border-top:1px solid #141414;font-variant-numeric:tabular-nums}
.pc-breakdown td.num,.pc-breakdown th:not(:first-child){text-align:right}

/* Odds Board */
.odds-board{background:#0f0f0f;border:1px solid #1a1a1a;border-radius:16px;overflow:hidden;max-width:480px}
.ob-header{display:flex;align-items:baseline;gap:10px;padding:14px 18px;border-bottom:1px solid #1a1a1a}
.ob-market{font-size:0.875rem;font-weight:700;letter-spacing:-0.01em}
.ob-event{font-size:0.75rem;color:#888}
.ob-sharp{margin-left:auto;font-size:0.6875rem;color:#666;text-transform:uppercase;letter-spacing:0.06em}
.ob-sharp span{color:#7BAFD4;font-weight:700;margin-left:4px}
.ob-table{width:100%;border-collapse:collapse}
.ob-table th{text-align:left;font-size:0.625rem;text-transform:uppercase;letter-spacing:0.06em;color:#666;padding:8px 18px;background:#0a0a0a}
.ob-table th.num,.ob-table td.num{text-align:right;font-variant-numeric:tabular-nums}
.ob-table td{padding:8px 18px;font-size:0.8125rem;border-top:1px solid #141414}
.ob-book{color:#aaa;font-weight:500}
.ob-best{color:#7BAFD4;font-weight:700;position:relative}
.ob-best::after{content:'●';font-size:0.4rem;color:#7BAFD4;position:absolute;top:8px;right:8px}

/* Stat Card */
.stat-card{background:#0f0f0f;border:1px solid #1a1a1a;border-radius:16px;padding:20px;max-width:340px}
.sc-label{font-size:0.625rem;text-transform:uppercase;letter-spacing:0.1em;color:#666;font-weight:600;margin-bottom:10px}
.sc-hero{display:flex;align-items:baseline;gap:10px}
.sc-value{font-size:3.5rem;font-weight:800;line-height:1;letter-spacing:-0.04em;font-variant-numeric:tabular-nums}
.sc-rank{font-size:0.75rem;font-weight:700;color:#7BAFD4;background:rgba(123,175,212,0.1);padding:3px 8px;border-radius:6px}
.sc-subject{display:flex;align-items:center;gap:7px;margin-top:12px;font-size:0.875rem;font-weight:600}
.sc-subject img{width:18px;height:18px;object-fit:contain}
.sc-qual{color:#777;font-weight:400;font-size:0.75rem}
.sc-context{font-size:0.8125rem;color:#aaa;margin-top:8px;line-height:1.45}
.sc-board{margin-top:16px;border-top:1px solid #1a1a1a;padding-top:8px}
.sc-row{display:flex;align-items:center;gap:10px;padding:5px 0;font-size:0.8125rem}
.sc-rownum{color:#666;width:20px;font-variant-numeric:tabular-nums}
.sc-rowname{flex:1;color:#aaa}
.sc-rowval{font-weight:600;font-variant-numeric:tabular-nums;color:#888}
.sc-row--lead .sc-rowname,.sc-row--lead .sc-rowval{color:#fff}

/* Standings Table */
.standings{max-width:100%}
.st-title{font-size:1rem;font-weight:700;letter-spacing:-0.02em;margin-bottom:16px}
.st-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
.st-group{background:#0f0f0f;border:1px solid #1a1a1a;border-radius:14px;overflow:hidden}
.st-group-head{display:flex;justify-content:space-between;align-items:baseline;padding:12px 16px;border-bottom:1px solid #1a1a1a}
.st-group-label{font-size:1.125rem;font-weight:700;letter-spacing:-0.02em}
.st-group-host{font-size:0.5625rem;text-transform:uppercase;letter-spacing:0.06em;color:#666;font-weight:600}
.st-table{width:100%;border-collapse:collapse}
.st-table th{font-size:0.5625rem;color:#666;font-weight:600;padding:8px 10px;text-align:left;text-transform:uppercase;letter-spacing:0.06em}
.st-table th.num,.st-table td.num{text-align:right;font-variant-numeric:tabular-nums}
.st-table td{font-size:0.8125rem;padding:8px 10px;border-top:1px solid #141414}
.st-team{display:flex;align-items:center;gap:8px;font-weight:600}
.st-team img{width:20px;height:20px;border-radius:3px;object-fit:contain}
.st-rank{font-size:0.625rem;color:#666;font-weight:400;margin-left:auto}
.st-odds{color:#7BAFD4;font-weight:600}
.st-adv td:first-child{position:relative}
.st-adv td:first-child::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:#7BAFD4}
.st-adv td{background:rgba(123,175,212,0.03)}
`;
