/**
 * GenericCards — Data-driven card components powered by the Render Contract system.
 *
 * Architecture:
 *   Tool declares `render: { renderType, title, columns, dataKey }` at registration
 *   → Backend forwards data + render metadata in tool_result SSE
 *   → Frontend routes to the matching generic renderer here
 *   → Zero per-tool components needed. New tools self-render.
 *
 * Render types:
 *   'table'      → GenericTable     — Column-driven data table
 *   'schedule'   → GenericSchedule  — Game schedule with teams, times, scores
 *   'stat-card'  → GenericStatCard  — Key-value stat display
 *   'group-card' → GenericGroupCard — Horizontal scroll of sub-cards
 *   'odds-card'  → GenericOddsCard  — 3-way or 2-way odds display
 *   'raw'        → GenericRawCard   — JSON fallback
 */

import React, { memo } from 'react';
import { motion } from 'motion/react';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Types — mirrors RenderTemplate from tools/types.ts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface RenderColumn {
  key: string;
  label: string;
  align?: 'left' | 'center' | 'right';
  format?: 'number' | 'odds' | 'pct' | 'date' | 'time' | 'score';
}

interface RenderMeta {
  renderType: string;
  title?: string;
  columns?: RenderColumn[];
  dataKey?: string;
  statFields?: Array<{ key: string; label: string; format?: string }>;
}

export interface GenericCardProps {
  data: any;
  render: RenderMeta;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Shared utilities
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const spring = { type: 'spring' as const, stiffness: 450, damping: 45, mass: 0.5 };

/** Resolve a dotted key path from an object — e.g., 'odds[0].home' */
function resolveKey(obj: any, path: string): any {
  if (!obj || !path) return undefined;
  return path.split(/[.\[\]]+/).filter(Boolean).reduce((acc, key) => {
    if (acc == null) return undefined;
    return acc[key];
  }, obj);
}

/** Format a cell value based on the column's format hint */
function formatValue(value: any, format?: string): string {
  if (value == null || value === '') return '—';
  switch (format) {
    case 'odds': {
      const n = Number(value);
      if (isNaN(n)) return String(value);
      return n > 0 ? `+${n}` : `${n}`;
    }
    case 'pct': {
      const n = Number(value);
      if (isNaN(n)) return String(value);
      return `${(n * 100).toFixed(1)}%`;
    }
    case 'number': {
      const n = Number(value);
      if (isNaN(n)) return String(value);
      return n.toLocaleString();
    }
    case 'date': {
      try {
        return new Date(value).toLocaleDateString('en-US', {
          timeZone: 'America/New_York',
          month: 'short', day: 'numeric',
        });
      } catch { return String(value); }
    }
    case 'time': {
      try {
        return new Date(value).toLocaleTimeString('en-US', {
          timeZone: 'America/New_York',
          hour: 'numeric', minute: '2-digit', hour12: true,
        });
      } catch { return String(value); }
    }
    case 'score': {
      return value != null ? String(value) : '—';
    }
    default:
      return String(value);
  }
}

/** Card header bar with title and optional count */
function CardHeader({ title, count }: { title?: string; count?: number }) {
  if (!title) return null;
  return (
    <div className="flex items-center justify-between mb-3">
      <span className="text-[10px] font-bold text-white/40 uppercase tracking-[0.2em]">
        {title}
      </span>
      {count != null && (
        <span className="text-[10px] text-white/20 font-mono">{count} items</span>
      )}
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GenericTable — Column-driven data table
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const GenericTable = memo(({ data, render }: GenericCardProps) => {
  const columns = render.columns || [];
  const rows: any[] = render.dataKey ? resolveKey(data, render.dataKey) || [] : (Array.isArray(data) ? data : []);

  if (!columns.length || !rows.length) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring}
      className="w-full my-3"
    >
      <CardHeader title={render.title} count={rows.length} />
      <div className="overflow-x-auto scrollbar-none rounded-xl border border-white/[0.06]">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-white/[0.06]">
              {columns.map((col, ci) => (
                <th
                  key={ci}
                  className={`px-3 py-2.5 font-bold text-white/30 uppercase tracking-wider text-[9px] whitespace-nowrap ${
                    col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left'
                  }`}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr
                key={ri}
                className="border-b border-white/[0.03] last:border-b-0 hover:bg-white/[0.02] transition-colors"
              >
                {columns.map((col, ci) => (
                  <td
                    key={ci}
                    className={`px-3 py-2 text-white/70 font-mono whitespace-nowrap ${
                      col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left'
                    }`}
                  >
                    {formatValue(resolveKey(row, col.key), col.format)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </motion.div>
  );
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GenericSchedule — Game schedule with teams, times, scores
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function StatusDot({ status }: { status: string }) {
  const isLive = status === 'live';
  const isFinal = status === 'final';

  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-[0.12em] ${
      isLive ? 'bg-emerald-500/15 text-emerald-400' : isFinal ? 'bg-white/5 text-white/30' : 'bg-blue-500/10 text-blue-400/70'
    }`}>
      {isLive && (
        <motion.span
          className="size-1 rounded-full bg-emerald-400"
          animate={{ opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
        />
      )}
      {status}
    </span>
  );
}

const ScheduleGameCard = memo(({ game }: { game: any }) => {
  const home = game.home || {};
  const away = game.away || {};
  const status = game.status || 'upcoming';
  const hasScores = home.score != null && away.score != null;
  const isPostponed = status === 'postponed' || status === 'suspended';

  // Time formatting
  let timeLabel = '';
  if (game.startTime && status === 'upcoming') {
    try {
      timeLabel = new Date(game.startTime).toLocaleTimeString('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric', minute: '2-digit', hour12: true,
      });
    } catch { /* ignore */ }
  }

  return (
    <div className={`bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4 transition-colors hover:border-white/[0.12] ${isPostponed ? 'opacity-40' : ''}`}>
      {/* Status + time */}
      <div className="flex items-center justify-between mb-3">
        <StatusDot status={status} />
        {game.clock && status === 'live' && (
          <span className="text-[10px] text-emerald-400/60 font-mono">{game.clock}</span>
        )}
        {timeLabel && (
          <span className="text-[10px] text-white/20 font-mono">{timeLabel}</span>
        )}
      </div>

      {/* Away team */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-[11px] font-bold text-white/25 w-6">{away.abbreviation || '???'}</span>
          <span className="text-[13px] font-semibold text-white/85 truncate">{away.team || 'Away'}</span>
        </div>
        {hasScores && (
          <span className={`text-lg font-bold font-mono tabular-nums flex-shrink-0 ${
            away.score > home.score ? 'text-white' : 'text-white/30'
          }`}>
            {away.score}
          </span>
        )}
      </div>

      {/* Home team */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-[11px] font-bold text-white/25 w-6">{home.abbreviation || '???'}</span>
          <span className="text-[13px] font-semibold text-white/85 truncate">{home.team || 'Home'}</span>
        </div>
        {hasScores && (
          <span className={`text-lg font-bold font-mono tabular-nums flex-shrink-0 ${
            home.score > away.score ? 'text-white' : 'text-white/30'
          }`}>
            {home.score}
          </span>
        )}
      </div>

      {/* Venue */}
      {game.venue && (
        <div className="mt-2.5 pt-2 border-t border-white/[0.04]">
          <span className="text-[9px] text-white/15 font-mono truncate block">{game.venue}</span>
        </div>
      )}
    </div>
  );
});

export const GenericSchedule = memo(({ data, render }: GenericCardProps) => {
  const games: any[] = render.dataKey ? resolveKey(data, render.dataKey) || [] : (Array.isArray(data) ? data : []);
  if (!games.length) return null;

  const liveCount = games.filter(g => g.status === 'live').length;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring}
      className="w-full my-3"
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] font-bold text-white/40 uppercase tracking-[0.2em]">
          {render.title || 'Schedule'}
        </span>
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
          <div key={game.eventId || i} className="min-w-[260px] max-w-[300px] snap-start flex-shrink-0">
            <ScheduleGameCard game={game} />
          </div>
        ))}
      </div>
    </motion.div>
  );
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GenericStatCard — Key-value stat display
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const GenericStatCard = memo(({ data, render }: GenericCardProps) => {
  const fields = render.statFields || [];
  if (!fields.length || !data) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring}
      className="w-full my-3"
    >
      <CardHeader title={render.title} />
      <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4">
        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          {fields.map((field, i) => {
            const value = resolveKey(data, field.key);
            return (
              <div key={i} className="flex flex-col">
                <span className="text-[9px] text-white/25 uppercase tracking-wider font-bold mb-0.5">
                  {field.label}
                </span>
                <span className="text-[15px] text-white/85 font-semibold font-mono tabular-nums">
                  {formatValue(value, field.format)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GenericGroupCard — Horizontal scroll of sub-items
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const GenericGroupCard = memo(({ data, render }: GenericCardProps) => {
  const items: any[] = render.dataKey ? resolveKey(data, render.dataKey) || [] : (Array.isArray(data) ? data : []);
  const columns = render.columns || [];
  if (!items.length) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring}
      className="w-full my-3"
    >
      <CardHeader title={render.title} count={items.length} />
      <div className="flex gap-3 overflow-x-auto scrollbar-none pb-1 -mx-1 px-1 snap-x snap-mandatory">
        {items.map((item, i) => (
          <div key={i} className="min-w-[220px] max-w-[280px] snap-start flex-shrink-0 bg-white/[0.03] border border-white/[0.06] rounded-2xl p-3.5 hover:border-white/[0.12] transition-colors">
            {columns.map((col, ci) => {
              const value = resolveKey(item, col.key);
              return (
                <div key={ci} className="flex items-center justify-between mb-1 last:mb-0">
                  <span className="text-[10px] text-white/25 uppercase tracking-wider">{col.label}</span>
                  <span className={`text-[12px] font-mono text-white/70 ${col.align === 'right' ? 'text-right' : ''}`}>
                    {formatValue(value, col.format)}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </motion.div>
  );
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GenericRawCard — JSON fallback for 'raw' renderType
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const GenericRawCard = memo(({ data, render }: GenericCardProps) => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring}
      className="w-full my-3"
    >
      <CardHeader title={render.title || 'Data'} />
      <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3 overflow-x-auto">
        <pre className="text-[11px] text-white/50 font-mono whitespace-pre-wrap break-words leading-relaxed">
          {JSON.stringify(data, null, 2)}
        </pre>
      </div>
    </motion.div>
  );
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Hub Render Contract Cards — adapted from src/components/cards/*
// These wrap the new hub card components to match GenericCardProps
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { GameCard } from './components/cards/GameCard';
import { PlayerCard } from './components/cards/PlayerCard';
import { OddsBoard } from './components/cards/OddsBoard';
import { StatCard } from './components/cards/StatCard';
import { StandingsTable } from './components/cards/StandingsTable';
import './components/cards/cards.css';

/** Adapter: GenericCardProps → RenderSpec for hub cards */
const HubGameCard = memo(({ data, render }: GenericCardProps) => (
  <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="w-full max-w-[360px] my-3">
    <GameCard render={render as any} />
  </motion.div>
));

const HubPlayerCard = memo(({ data, render }: GenericCardProps) => (
  <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="w-full max-w-[420px] my-3">
    <PlayerCard render={render as any} />
  </motion.div>
));

const HubOddsBoard = memo(({ data, render }: GenericCardProps) => (
  <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="w-full max-w-[480px] my-3">
    <OddsBoard render={render as any} />
  </motion.div>
));

const HubStatCard = memo(({ data, render }: GenericCardProps) => (
  <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="w-full max-w-[320px] my-3">
    <StatCard render={render as any} />
  </motion.div>
));

const HubStandingsTable = memo(({ data, render }: GenericCardProps) => (
  <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="w-full my-3">
    <StandingsTable render={render as any} />
  </motion.div>
));

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Registry — maps renderType strings → generic components
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const GENERIC_RENDERERS: Record<string, React.ComponentType<GenericCardProps>> = {
  // Existing generic renderers
  'table':      GenericTable,
  'schedule':   GenericSchedule,
  'group-card': GenericGroupCard,
  'raw':        GenericRawCard,
  // Hub render-contract cards
  'game-card':        HubGameCard,
  'player-card':      HubPlayerCard,
  'odds-board':       HubOddsBoard,
  'stat-card':        HubStatCard,
  'standings-table':  HubStandingsTable,
};

