import React from 'react';
import { HubEnvelope } from '../hub/render-contract.types';
import { GameCard } from './cards/GameCard';
import { PlayerCard } from './cards/PlayerCard';
import { OddsBoard } from './cards/OddsBoard';
import { StatCard } from './cards/StatCard';
import { StandingsTable } from './cards/StandingsTable';

/**
 * HubRenderer — dispatches any hub envelope to the right card component.
 * Falls back to summary text for unknown renderTypes or missing render spec.
 */
export function HubRenderer({ envelope }: { envelope: HubEnvelope }) {
  const { render } = envelope;

  if (!render) {
    return <div className="hub-fallback">{envelope.summary}</div>;
  }

  switch (render.renderType) {
    case 'game-card':       return <GameCard render={render} />;
    case 'player-card':     return <PlayerCard render={render} />;
    case 'odds-board':      return <OddsBoard render={render} />;
    case 'stat-card':       return <StatCard render={render} />;
    case 'standings-table': return <StandingsTable render={render} />;
    default:
      return <div className="hub-fallback">{envelope.summary}</div>;
  }
}
