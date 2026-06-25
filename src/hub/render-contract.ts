import { RenderContract } from './render-contract.types';

// ─────────────────────────────────────────────────────────
// RENDER CONTRACT DISPATCHER
// Derives render + promptHint from entity type + data.
// Each function maps raw data → display fields + anti-hallucination hint.
// ─────────────────────────────────────────────────────────

export function deriveRenderContract(type: string, data: any): RenderContract {
  switch (type) {
    case 'game':      return gameContract(data);
    case 'player':    return playerContract(data);
    case 'team':      return teamContract(data);
    case 'odds':      return oddsContract(data);
    case 'stat':      return statContract(data);
    case 'standings': return standingsContract(data);
    default:
      return {
        render: { renderType: 'markdown' },
        promptHint: 'Present this data conversationally. Cite only fields present in the payload.',
      };
  }
}

// ── GAME — fully wired, normalizes all tool output shapes ──────────────

function gameContract(d: any): RenderContract {
  // ── Status normalization ──────────────────────────────────────────
  // MLB Stats API: "Scheduled" / "In Progress" / "Final"
  // ESPN: "upcoming" / "live" / "final"
  // NHL: "upcoming" / "live" / "final"
  // Hub envelope: "SCHEDULED" / "IN_PROGRESS" / "FINAL"
  const rawStatus = (
    d.status || d.abstract_status || d.game_state || ''
  ).toString().toUpperCase();

  const isFinal = /^(FINAL|GAME.OVER|OFF|POST)/.test(rawStatus);
  const isLive = /^(LIVE|IN.PROGRESS|CRIT)/.test(rawStatus) || (d.live != null && !isFinal);
  const variant = isFinal ? 'final' : isLive ? 'live' : 'pregame';

  // ── Team field normalization ──────────────────────────────────────
  // Some tools return { away_team: { name, id, score } } (MLB Stats API)
  // Others return flat strings { away_team: "White Sox" } (ESPN/NHL)
  // Hub envelope uses { away_team: "...", away_abbrev: "...", away_logo: "..." }
  const awayRaw = d.away_team;
  const homeRaw = d.home_team;

  const awayName   = typeof awayRaw === 'object' ? awayRaw?.name   : awayRaw ?? d.matchup?.split(' @ ')?.[0] ?? '?';
  const homeName   = typeof homeRaw === 'object' ? homeRaw?.name   : homeRaw ?? d.matchup?.split(' @ ')?.[1] ?? '?';
  const awayAbbrev = d.away_abbrev ?? (typeof awayRaw === 'object' ? awayRaw?.abbreviation ?? awayRaw?.abbrev : null) ?? awayName?.slice(0, 3).toUpperCase();
  const homeAbbrev = d.home_abbrev ?? (typeof homeRaw === 'object' ? homeRaw?.abbreviation ?? homeRaw?.abbrev : null) ?? homeName?.slice(0, 3).toUpperCase();
  const awayLogo   = optimizeCdn(d.away_logo ?? (typeof awayRaw === 'object' ? awayRaw?.logo : null));
  const homeLogo   = optimizeCdn(d.home_logo ?? (typeof homeRaw === 'object' ? homeRaw?.logo : null));
  const awayScore  = typeof awayRaw === 'object' ? awayRaw?.score : d.away_score;
  const homeScore  = typeof homeRaw === 'object' ? homeRaw?.score  : d.home_score;

  const venue = d.venue ?? null;
  const startTime = d.start_time ?? d.game_time ?? d.startTimeUTC ?? d.game_time_utc ?? null;

  // ── Multi-game list handling ─────────────────────────────────────
  // Schedule tools return { games: [...] }. For these, build a summary card.
  const games = d.games;
  const isMultiGame = Array.isArray(games);

  const fields: Record<string, any> = {
    header: isMultiGame
      ? `${d.total_games ?? games.length} games`
      : `${awayName} @ ${homeName}`,
    subtitle: isMultiGame
      ? `${d.date ?? 'Today'} · ${d.live ?? d.in_progress ?? 0} live`
      : venue ? `${venue}${startTime ? ' · ' + startTime : ''}` : d.league_label ?? null,
    startTime,
    awayTeam: awayName,
    homeTeam: homeName,
    awayAbbrev,
    homeAbbrev,
    awayLogo,
    homeLogo,
    statusBadge: rawStatus,
    league: d.league_label ?? d.league ?? null,
  };

  // Only surface scores when they actually exist and game is live/final
  if ((isLive || isFinal) && !isMultiGame) {
    fields.awayScore = d.live?.away_score ?? awayScore ?? null;
    fields.homeScore = d.live?.home_score ?? homeScore ?? null;
    fields.period = d.live?.period ?? d.period ?? null;
    fields.line = d.live?.line ?? null;
    fields.balls = d.live?.balls ?? null;
    fields.strikes = d.live?.strikes ?? null;
    fields.outs = d.live?.outs ?? null;
    fields.bases = d.live?.bases ?? null;
    fields.pit = d.live?.pit ?? null;
    fields.bat = d.live?.bat ?? null;
    fields.win = d.live?.win ?? null;
    fields.loss = d.live?.loss ?? null;
    fields.save = d.live?.save ?? null;
    fields.awayRecord = d.away_record ?? null;
    fields.homeRecord = d.home_record ?? null;
  }
  if (d.spread != null) fields.spread = d.spread;
  if (d.total != null) fields.total = d.total;

  // Winner flag for final state
  if (isFinal && fields.awayScore != null && fields.homeScore != null) {
    fields.winner = fields.awayScore > fields.homeScore ? 'away' : 'home';
  }

  // ── Multi-game: attach game list for UI rendering ────────────────
  if (isMultiGame) {
    fields.gameCount = games.length;
    fields.liveCount = d.live ?? d.in_progress ?? 0;
    fields.finalCount = d.final ?? 0;
    fields.upcomingCount = d.upcoming ?? 0;
  }

  // ── Speech instructions — the anti-hallucination layer ───────────
  let promptHint: string;
  if (isMultiGame) {
    promptHint =
      `Schedule with ${games.length} games. ` +
      `Summarize the slate. Do not fabricate any scores — only report scores for games ` +
      `whose status indicates they are live or final. ` +
      `Upcoming/Scheduled games have NO score.`;
  } else if (variant === 'pregame') {
    const lineNote = d.spread == null && d.total == null
      ? ' No betting line is posted — do not cite a spread or total.'
      : '';
    promptHint =
      `Pregame. Status is ${rawStatus} and the game has not started. ` +
      `${startTime ? `Start time: ${startTime}` : ''}${venue ? ` at ${venue}` : ''}. ` +
      `Do NOT state a score or any live data — never state a score for a game that has not started.${lineNote}`;
  } else if (variant === 'live') {
    promptHint =
      `Live game. Use only the score and state in data.live or data. ` +
      `Current: ${awayAbbrev} ${fields.awayScore ?? '?'} - ` +
      `${fields.homeScore ?? '?'} ${homeAbbrev}. ` +
      `Do not invent stats beyond what is present.`;
  } else {
    promptHint =
      `Final. Report the final score from the payload. The game is over. ` +
      `${awayAbbrev} ${fields.awayScore ?? '?'} - ` +
      `${fields.homeScore ?? '?'} ${homeAbbrev}.`;
  }

  return {
    render: {
      renderType: 'game-card',
      variant,
      fields,
      // For multi-game, attach condensed game list as rows
      ...(isMultiGame ? {
        rows: games.map((g: any) => ({
          matchup: g.matchup ?? `${typeof g.away_team === 'object' ? g.away_team?.name : g.away_team} @ ${typeof g.home_team === 'object' ? g.home_team?.name : g.home_team}`,
          status: g.status ?? g.abstract_status ?? '?',
          venue: g.venue ?? null,
          gamePk: g.gamePk ?? g.gameId ?? g.game_id ?? null,
        })),
        columns: ['matchup', 'status', 'venue'],
      } : {}),
    },
    promptHint,
  };
}

// ── PLAYER — the StatMuse core ────────────────────────────────────────

function playerContract(d: any): RenderContract {
  const variant =
    d.scope === 'career' ? 'career'
    : d.scope === 'splits' ? 'splits'
    : 'season';

  const fields: Record<string, any> = {
    name: d.full_name || d.name,
    team: d.team,
    teamAbbrev: d.team_abbrev,
    position: d.position,
    headshot: optimizeCdn(d.headshot_url),
    teamLogo: optimizeCdn(d.team_logo),
    sport: d.sport,
    season: d.season,

    // The hero line — the single number the question is about
    heroStat: d.hero_stat,
    heroLabel: d.hero_label,
    heroContext: d.hero_context,

    // The supporting slash line
    statLine: d.stat_line,
    statLineLabels: d.stat_labels,
  };

  const scopeNote =
    variant === 'career' ? 'career totals/averages'
    : variant === 'splits' ? `splits (${d.split_label || 'situational'})`
    : `the ${d.season} season`;

  const promptHint =
    `StatMuse-style answer about ${fields.name}. ` +
    `Lead with the hero stat: ${fields.heroStat} ${fields.heroLabel}. ` +
    `Scope is ${scopeNote}. ` +
    `${fields.heroContext ? `Context: ${fields.heroContext}. ` : ''}` +
    `Cite ONLY the numbers in this payload. Do not compute or estimate ` +
    `any stat not explicitly present. If the user asked about a stat that ` +
    `isn't in the payload, say it's not available rather than guessing.`;

  return {
    render: {
      renderType: 'player-card',
      variant,
      fields,
      rows: d.breakdown ?? undefined,
      columns: d.breakdown_columns ?? undefined,
    },
    promptHint,
  };
}

// ── TEAM ──────────────────────────────────────────────────────────────

function teamContract(d: any): RenderContract {
  return {
    render: {
      renderType: 'team-card',
      variant: 'full',
      fields: {
        name: d.team_name || d.name,
        abbrev: d.abbrev,
        logo: optimizeCdn(d.logo_url),
        record: d.record,
        standing: d.standing,
        league: d.league_label,
      },
    },
    promptHint:
      `Team summary. Report record and standing from the payload. ` +
      `Do not invent W-L beyond data.record.`,
  };
}

// ── ODDS — multi-book comparison ──────────────────────────────────────

function oddsContract(d: any): RenderContract {
  const rows = (d.books ?? d.lines ?? []).map((b: any) => ({
    book: b.book || b.sportsbook,
    side: b.side,
    price: b.price,
    line: b.line ?? null,
    _best: false,
  }));

  // Flag the best price per side
  const sides = [...new Set(rows.map((r: any) => r.side))];
  for (const side of sides) {
    const sideRows = rows.filter((r: any) => r.side === side);
    if (sideRows.length === 0) continue;
    const best = sideRows.reduce((a: any, b: any) =>
      americanToDecimal(b.price) > americanToDecimal(a.price) ? b : a
    );
    best._best = true;
  }

  return {
    render: {
      renderType: 'odds-board',
      variant: 'full',
      fields: {
        market: d.market || d.market_label,
        event: d.event_label,
        awayTeam: d.away_team,
        homeTeam: d.home_team,
        sharpAnchor: d.sharp_price ?? null,
        bestNote: d.best_note ?? null,
      },
      rows,
      columns: ['book', 'side', 'price', 'line'],
    },
    promptHint:
      `Odds comparison for ${d.market || 'this market'}${d.event_label ? ` — ${d.event_label}` : ''}. ` +
      `Report every price EXACTLY as written — these are live American odds, do not round or convert. ` +
      `The best available price per side is flagged with _best. ` +
      `${d.sharp_price ? `Sharp anchor is ${d.sharp_price}; compare retail prices against it for edge. ` : ''}` +
      `If asked for a play, identify the side with the best price relative to the sharp number and state the edge. ` +
      `Never invent a book or a price not in the payload.`,
  };
}

// ── STAT — single-value answer with optional leaderboard ──────────────

function statContract(d: any): RenderContract {
  const fields: Record<string, any> = {
    label: d.label,
    value: d.value,
    subject: d.subject,
    subjectLogo: optimizeCdn(d.subject_logo),
    context: d.context,
    rank: d.rank,
    qualifier: d.qualifier,
    sport: d.sport,
  };

  return {
    render: {
      renderType: 'stat-card',
      variant: 'full',
      fields,
      rows: d.leaderboard ?? undefined,
      columns: d.leaderboard ? ['rank', 'name', 'value'] : undefined,
    },
    promptHint:
      `Single-stat answer. ${fields.subject ? `${fields.subject}: ` : ''}` +
      `${fields.value} ${fields.label}` +
      `${fields.qualifier ? ` (${fields.qualifier})` : ''}. ` +
      `${fields.context ? `Context: ${fields.context}. ` : ''}` +
      `State the value and its context conversationally. Cite only what's in the payload. ` +
      `Do not extrapolate, project, or compute any number not given. ` +
      `${fields.rank ? `This is ranked ${fields.rank} — you may say so.` : ''}`,
  };
}

// ── STANDINGS — World Cup groups, division races, league tables ───────

function standingsContract(d: any): RenderContract {
  const groups = d.groups ?? [{ label: d.label, teams: d.teams }];

  return {
    render: {
      renderType: 'standings-table',
      variant: d.groups ? 'compact' : 'full',
      fields: {
        title: d.title,
        scope: d.scope,
      },
      // groups go in a custom key so multiple tables render in one card
      ...({ groups: groups.map((g: any) => ({
        label: g.label,
        host: g.host ?? null,
        columns: g.columns ?? ['pos', 'team', 'p', 'w', 'd', 'l', 'gd', 'pts'],
        rows: (g.teams || []).map((t: any, i: number) => ({
          pos: i + 1,
          team: t.team_name || t.name,
          code: t.code,
          logo: optimizeCdn(t.logo),
          rank: t.fifa_rank ? `#${t.fifa_rank}` : null,
          odds: t.odds ?? null,
          p: t.played ?? 0,
          w: t.wins ?? 0,
          d: t.draws ?? 0,
          l: t.losses ?? 0,
          gd: t.goal_diff ?? 0,
          pts: t.points ?? 0,
          _advancing: i < (g.advance ?? 2),
        })),
      })) } as any),
    } as any,
    promptHint:
      `Standings for ${d.title || 'this competition'}. ` +
      `Report positions, points, and records exactly as in the payload. ` +
      `Top ${groups[0]?.advance ?? 2} per group advance (flagged _advancing). ` +
      `Do not invent results or project outcomes unless asked. ` +
      `If asked who advances, base it only on current points/GD in the data.`,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────

function americanToDecimal(american: string | number): number {
  const n = typeof american === 'string' ? parseInt(american) : american;
  if (isNaN(n)) return 1;
  return n > 0 ? n / 100 + 1 : 100 / Math.abs(n) + 1;
}

/**
 * Optimizes ESPN CDN images for iOS scale sizes using the image combiner.
 * Requests a 156x156 (@3x of 52px) transparent PNG to avoid massive 500x500 downsampling artifacts.
 */
function optimizeCdn(url: string | null | undefined, size: number = 156): string | null {
  if (!url || typeof url !== 'string') return null;
  if (url.includes('a.espncdn.com') && !url.includes('combiner/i')) {
    try {
      const parsed = new URL(url);
      return `https://a.espncdn.com/combiner/i?img=${parsed.pathname}&w=${size}&h=${size}&transparent=true`;
    } catch {
      return url;
    }
  }
  return url;
}
