/**
 * DisplayCards — Deterministic card components for inline chat rendering.
 *
 * Architecture:
 *   Backend tool executes → tool_result SSE includes `data` for card-eligible tools
 *   → Frontend matches tool name in CARD_REGISTRY → renders component with data
 *   → Model never touches rendering. Cards are pure data → UI.
 *
 * Data shapes match the actual ESPN tool output from espn.tools.ts:
 *   get_espn_scoreboard → { games: [...], date, total_games, live, final, upcoming }
 *   get_espn_live_games → { games: [...], live_count }
 *   find_espn_game      → single game object
 *   get_espn_game       → single game object
 */

import React, { memo, type ComponentType } from 'react';
import { motion } from 'motion/react';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Shared
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface DisplayCardProps {
  data: any;
  toolName?: string;
  context?: string;
}

const spring = { type: 'spring' as const, stiffness: 450, damping: 45, mass: 0.5 };

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ESPN Game Shape (matches espn.tools.ts output)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface EspnGameResult {
  event_id: string;
  matchup: string;           // "Colorado Rockies @ Chicago Cubs"
  status: 'upcoming' | 'live' | 'final';
  score?: string;            // "Colorado Rockies 5 - Chicago Cubs 8"
  inning?: string;           // "bottom 8"
  venue?: string;
  home_pitcher?: string;
  away_pitcher?: string;
  home_pitcher_record?: string;
  away_pitcher_record?: string;
  espn_url?: string;
}

// Parse "Colorado Rockies 5 - Chicago Cubs 8" → away/home teams & scores
function parseScoreLine(matchup: string, score?: string): {
  awayName: string; homeName: string;
  awayScore: number | null; homeScore: number | null;
  awayAbbr: string; homeAbbr: string;
} {
  // matchup format: "Away Team @ Home Team"
  const [awayRaw, homeRaw] = matchup.split(' @ ');
  const awayName = awayRaw?.trim() || 'Away';
  const homeName = homeRaw?.trim() || 'Home';

  // Abbreviation: last word of team name
  const awayAbbr = awayName.split(' ').pop()?.slice(0, 3).toUpperCase() || 'AWY';
  const homeAbbr = homeName.split(' ').pop()?.slice(0, 3).toUpperCase() || 'HOM';

  let awayScore: number | null = null;
  let homeScore: number | null = null;

  if (score) {
    // "Colorado Rockies 5 - Chicago Cubs 8"
    const m = score.match(/(\d+)\s*-\s*.*?(\d+)\s*$/);
    if (m) {
      awayScore = parseInt(m[1]);
      homeScore = parseInt(m[2]);
    }
  }

  return { awayName, homeName, awayScore, homeScore, awayAbbr, homeAbbr };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Status Pill
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function StatusPill({ status, inning }: { status: string; inning?: string }) {
  const isLive = status === 'live';
  const isFinal = status === 'final';
  const label = isLive ? (inning || 'Live') : isFinal ? 'Final' : status;

  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-[0.12em] ${isLive ? 'bg-emerald-500/15 text-emerald-400' : isFinal ? 'bg-white/5 text-white/30' : 'bg-blue-500/10 text-blue-400/70'
      }`}>
      {isLive && (
        <motion.span
          className="size-1 rounded-full bg-emerald-400"
          animate={{ opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
        />
      )}
      {label}
    </span>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Single Game Card — the core component
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const GameCard = memo(({ game }: { game: EspnGameResult }) => {
  const { awayName, homeName, awayScore, homeScore, awayAbbr, homeAbbr } = parseScoreLine(game.matchup, game.score);
  const hasScores = awayScore !== null && homeScore !== null;

  return (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4 transition-colors hover:border-white/[0.12]">
      {/* Status + Venue */}
      <div className="flex items-center justify-between mb-3.5">
        <StatusPill status={game.status} inning={game.inning} />
        {game.venue && (
          <span className="text-[9px] text-white/15 font-mono truncate max-w-[140px]">
            {game.venue}
          </span>
        )}
      </div>

      {/* Away Team Row */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-[13px] font-semibold text-white/85 truncate">{awayName}</span>
          {game.away_pitcher && (
            <span className="text-[10px] text-white/20 truncate hidden min-[340px]:inline">
              {game.away_pitcher}
            </span>
          )}
        </div>
        {hasScores && (
          <span className={`text-lg font-bold font-mono tabular-nums ml-3 flex-shrink-0 ${awayScore! > homeScore! ? 'text-white' : 'text-white/30'
            }`}>
            {awayScore}
          </span>
        )}
      </div>

      {/* Home Team Row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-[13px] font-semibold text-white/85 truncate">{homeName}</span>
          {game.home_pitcher && (
            <span className="text-[10px] text-white/20 truncate hidden min-[340px]:inline">
              {game.home_pitcher}
            </span>
          )}
        </div>
        {hasScores && (
          <span className={`text-lg font-bold font-mono tabular-nums ml-3 flex-shrink-0 ${homeScore! > awayScore! ? 'text-white' : 'text-white/30'
            }`}>
            {homeScore}
          </span>
        )}
      </div>

      {/* Upcoming: show pitchers prominently */}
      {game.status === 'upcoming' && (game.away_pitcher || game.home_pitcher) && (
        <div className="mt-3 pt-2.5 border-t border-white/[0.04] space-y-1">
          {game.away_pitcher && (
            <div className="flex items-center gap-2">
              <span className="text-[9px] font-bold text-white/15 uppercase tracking-wider w-4">A</span>
              <span className="text-[11px] text-white/40">{game.away_pitcher}</span>
              {game.away_pitcher_record && (
                <span className="text-[10px] text-white/15 font-mono">{game.away_pitcher_record}</span>
              )}
            </div>
          )}
          {game.home_pitcher && (
            <div className="flex items-center gap-2">
              <span className="text-[9px] font-bold text-white/15 uppercase tracking-wider w-4">H</span>
              <span className="text-[11px] text-white/40">{game.home_pitcher}</span>
              {game.home_pitcher_record && (
                <span className="text-[10px] text-white/15 font-mono">{game.home_pitcher_record}</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Scoreboard Card — renders get_espn_scoreboard / get_espn_live_games / get_espn_final_scores
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const ScoreboardCard = memo(({ data }: DisplayCardProps) => {
  // Normalize: tool output can have `games`, `results`, or be a single game
  let games: EspnGameResult[] = [];
  let label = 'Slate';
  let liveCount = 0;

  if (data?.games && Array.isArray(data.games)) {
    games = data.games;
    label = data.date || 'Today';
    liveCount = data.live ?? games.filter((g: any) => g.status === 'live').length;
  } else if (data?.results && Array.isArray(data.results)) {
    games = data.results;
    label = data.date || 'Results';
  } else if (data?.live_count !== undefined && data?.games) {
    games = data.games;
    label = 'Live';
    liveCount = data.live_count;
  }

  if (!games.length) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring}
      className="w-full my-3"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <span className="text-[10px] font-bold text-white/40 uppercase tracking-[0.2em]">
            {label}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[10px] font-mono">
          <span className="text-white/20">{games.length} games</span>
          {liveCount > 0 && (
            <>
              <span className="size-0.5 rounded-full bg-white/15" />
              <span className="text-emerald-400/80">{liveCount} live</span>
            </>
          )}
        </div>
      </div>

      {/* Horizontal scroll — snap to cards */}
      <div className="flex gap-3 overflow-x-auto scrollbar-none pb-1 -mx-1 px-1 snap-x snap-mandatory">
        {games.map((game, i) => (
          <div key={game.event_id || i} className="min-w-[280px] max-w-[320px] snap-start flex-shrink-0">
            <GameCard game={game} />
          </div>
        ))}
      </div>
    </motion.div>
  );
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Single Game Card — renders find_espn_game / get_espn_game
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const SingleGameCard = memo(({ data }: DisplayCardProps) => {
  // The data IS the game (flat object with matchup, status, score, etc.)
  if (!data?.matchup) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring}
      className="w-full max-w-[320px] my-3"
    >
      <GameCard game={data as EspnGameResult} />
    </motion.div>
  );
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Slate Game Card — typed against UnifiedGame from mlb-slate-aggregator
// Handles both get_mlb_slate_overview (full) and get_mlb_schedule (simple)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Extracts team abbreviation from full name — last word, 3 chars max. */
function teamAbbr(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (parts[parts.length - 1] || '???').slice(0, 3).toUpperCase();
}

/** Formats American odds for display (+150, -120). */
function fmtOdds(odds: number | null | undefined): string {
  if (odds == null) return '—';
  return odds > 0 ? `+${odds}` : `${odds}`;
}

/** Formats game time from ISO string to ET. */
function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return '';
  }
}

/** Parses score summary "Team A 5 - Team B 3" into [away, home] numbers. */
function parseScore(scoreSummary: string | null): [number | null, number | null] {
  if (!scoreSummary) return [null, null];
  const m = scoreSummary.match(/(\d+)\s*-\s*.*?(\d+)\s*$/);
  if (!m) return [null, null];
  return [parseInt(m[1]), parseInt(m[2])];
}

const SlateGameCard = memo(({ game }: { game: any }) => {
  const awayTeam = game.away?.team || game.away_team?.name || '?';
  const homeTeam = game.home?.team || game.home_team?.name || '?';
  const awayAbbr = teamAbbr(awayTeam);
  const homeAbbr = teamAbbr(homeTeam);

  const status: string = game.status || 'upcoming';
  const isLive = status === 'live';
  const isFinal = status === 'final';
  const isPostponed = status === 'postponed' || status === 'suspended';

  // Score — from `score` summary string or from team score fields
  const [awayScore, homeScore] = game.score
    ? parseScore(game.score)
    : [game.away_team?.score ?? null, game.home_team?.score ?? null];
  const hasScores = awayScore !== null && homeScore !== null;

  // Standings — from UnifiedGame shape
  const awayRecord = game.away?.standing
    ? `${game.away.standing.wins}-${game.away.standing.losses}`
    : game.away_team?.record || null;
  const homeRecord = game.home?.standing
    ? `${game.home.standing.wins}-${game.home.standing.losses}`
    : game.home_team?.record || null;

  // Pitchers — from both shapes
  const awayPitcher = game.away?.pitcher || game.probable_pitchers?.away?.name || null;
  const homePitcher = game.home?.pitcher || game.probable_pitchers?.home?.name || null;
  const awayPitcherRecord = game.away?.pitcherRecord || null;
  const homePitcherRecord = game.home?.pitcherRecord || null;

  // Odds — from UnifiedGame only
  const pinnacle = game.odds?.pinnacle;
  const hasPinnacle = pinnacle && (pinnacle.awayML != null || pinnacle.homeML != null);

  return (
    <div className={`bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4 transition-colors hover:border-white/[0.12] ${isPostponed ? 'opacity-40' : ''}`}>
      {/* Status row */}
      <div className="flex items-center justify-between mb-3">
        <StatusPill status={status} inning={game.inning || undefined} />
        {!isLive && !isFinal && !isPostponed && game.startTime && (
          <span className="text-[10px] text-white/20 font-mono">{fmtTime(game.startTime)}</span>
        )}
        {game.venue && !game.startTime && (
          <span className="text-[9px] text-white/15 font-mono truncate max-w-[130px]">{game.venue}</span>
        )}
      </div>

      {/* Away team */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-[13px] font-semibold text-white/85">{awayAbbr}</span>
          {awayRecord && <span className="text-[10px] text-white/20 font-mono">{awayRecord}</span>}
          {hasPinnacle && <span className="text-[10px] text-white/15 font-mono ml-auto mr-2">{fmtOdds(pinnacle.awayML)}</span>}
        </div>
        {hasScores && (
          <span className={`text-lg font-bold font-mono tabular-nums flex-shrink-0 ${awayScore! > homeScore! ? 'text-white' : 'text-white/30'}`}>
            {awayScore}
          </span>
        )}
      </div>

      {/* Home team */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-[13px] font-semibold text-white/85">{homeAbbr}</span>
          {homeRecord && <span className="text-[10px] text-white/20 font-mono">{homeRecord}</span>}
          {hasPinnacle && <span className="text-[10px] text-white/15 font-mono ml-auto mr-2">{fmtOdds(pinnacle.homeML)}</span>}
        </div>
        {hasScores && (
          <span className={`text-lg font-bold font-mono tabular-nums flex-shrink-0 ${homeScore! > awayScore! ? 'text-white' : 'text-white/30'}`}>
            {homeScore}
          </span>
        )}
      </div>

      {/* Pitcher matchup — upcoming games only */}
      {status === 'upcoming' && (awayPitcher || homePitcher) && (
        <div className="mt-3 pt-2.5 border-t border-white/[0.04] space-y-1">
          {awayPitcher && (
            <div className="flex items-center gap-2">
              <span className="text-[9px] font-bold text-white/15 uppercase tracking-wider w-4">A</span>
              <span className="text-[11px] text-white/40 truncate">{awayPitcher}</span>
              {awayPitcherRecord && <span className="text-[10px] text-white/15 font-mono">{awayPitcherRecord}</span>}
            </div>
          )}
          {homePitcher && (
            <div className="flex items-center gap-2">
              <span className="text-[9px] font-bold text-white/15 uppercase tracking-wider w-4">H</span>
              <span className="text-[11px] text-white/40 truncate">{homePitcher}</span>
              {homePitcherRecord && <span className="text-[10px] text-white/15 font-mono">{homePitcherRecord}</span>}
            </div>
          )}
        </div>
      )}

      {/* Total line — if available */}
      {pinnacle?.total != null && status === 'upcoming' && (
        <div className="mt-2 flex items-center gap-1.5">
          <span className="text-[9px] text-white/12 uppercase tracking-wider">O/U</span>
          <span className="text-[10px] text-white/25 font-mono">{pinnacle.total}</span>
        </div>
      )}
    </div>
  );
});

const SlateCard = memo(({ data }: DisplayCardProps) => {
  // Normalize: both get_mlb_slate_overview and get_mlb_schedule put games in data.games
  const games: any[] = data?.games || [];
  if (!games.length) return null;

  const date = data?.date || 'Today';
  const liveCount = games.filter((g: any) => g.status === 'live' || g.abstract_status === 'Live').length;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring}
      className="w-full my-3"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] font-bold text-white/40 uppercase tracking-[0.2em]">{date}</span>
        <div className="flex items-center gap-2 text-[10px] font-mono">
          <span className="text-white/20">{games.length} games</span>
          {liveCount > 0 && (
            <>
              <span className="size-0.5 rounded-full bg-white/15" />
              <span className="text-emerald-400/80">{liveCount} live</span>
            </>
          )}
        </div>
      </div>

      {/* Horizontal scroll — snap to cards */}
      <div className="flex gap-3 overflow-x-auto scrollbar-none pb-1 -mx-1 px-1 snap-x snap-mandatory">
        {games.map((game: any, i: number) => (
          <div key={game.eventId || game.gamePk || i} className="min-w-[260px] max-w-[300px] snap-start flex-shrink-0">
            <SlateGameCard game={game} />
          </div>
        ))}
      </div>
    </motion.div>
  );
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Card Registry — maps tool names → components
// Keys match EXACTLY to the tool names in DISPLAY_CARD_TOOLS (backend)
// and espn.tools.ts definitions.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export const CARD_REGISTRY: Record<string, ComponentType<DisplayCardProps>> = {
  // Multi-game views (ESPN)
  get_espn_scoreboard: ScoreboardCard,
  get_espn_live_games: ScoreboardCard,
  get_espn_final_scores: ScoreboardCard,
  // Single-game views (ESPN)
  find_espn_game: SingleGameCard,
  get_espn_game: SingleGameCard,
  // Slate views (MLB contract — UnifiedGame[])
  get_mlb_slate_overview: SlateCard,
  get_mlb_schedule: SlateCard,
};

// ── Render Contract: Generic Renderers ──────────────────────────────
// New tools declare `render: { renderType }` at registration time.
// The frontend routes to the matching generic component here.
import { GENERIC_RENDERERS } from './GenericCards';

/**
 * Renders a display card by tool name. Returns null if no matching renderer.
 *
 * Resolution order:
 *   1. Legacy CARD_REGISTRY (exact tool name match → custom component)
 *   2. Render contract (render.renderType → generic component)
 *   3. null (no card)
 */
export function renderCard(cardType: string, data: any, context?: string, render?: any): React.ReactNode {
  // Legacy path: exact tool name → custom component
  const LegacyCard = CARD_REGISTRY[cardType];
  if (LegacyCard) return <LegacyCard data={data} toolName={cardType} context={context} />;

  // Render contract path: renderType → generic component
  if (render?.renderType) {
    const GenericCard = GENERIC_RENDERERS[render.renderType];
    if (GenericCard) return <GenericCard data={data} render={render} />;
  }

  return null;
}
