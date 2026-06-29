import { Spanner } from "@google-cloud/spanner";
import { edgeDb } from "../db/spanner";
import { fetchEspnScoreboard } from "../lib/espn-grounding";

export interface EspnScoreboardIngestResult {
  date: string;
  sourceUrl: string;
  gamesFetched: number;
  gamesUpserted: number;
  eventIds: string[];
}

function dateOnly(value: string): string {
  return value.slice(0, 10);
}

function scoreToNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function statusToSpannerStatus(value: string): string {
  if (value === "live") return "STATUS_IN_PROGRESS";
  if (value === "final") return "STATUS_FINAL";
  return "STATUS_SCHEDULED";
}

function inferSeason(value: string): number | null {
  const year = Number(value.slice(0, 4));
  return Number.isFinite(year) ? year : null;
}

export async function ingestEspnScoreboard(date?: string): Promise<EspnScoreboardIngestResult> {
  const { events, evidence } = await fetchEspnScoreboard(date);
  const rows = events.map((event) => {
    const gameDate = dateOnly(event.date);
    return {
      EventId: event.event_id,
      CompetitionId: event.event_id,
      Venue: event.venue ?? null,
      Status: event.status_type ?? statusToSpannerStatus(event.status),
      HomeTeamId: event.home_team_id ?? null,
      HomeTeamName: event.home_team,
      HomeTeamAbbr: null,
      AwayTeamId: event.away_team_id ?? null,
      AwayTeamName: event.away_team,
      AwayTeamAbbr: null,
      HomeScore: scoreToNumber(event.home_score),
      AwayScore: scoreToNumber(event.away_score),
      CurrentInning: event.inning ? String(event.inning) : null,
      RawJson: {
        source: "espn_scoreboard",
        sourceUrl: event.source_url,
        status: event.status,
        statusType: event.status_type,
        fetchedAt: event.fetched_at,
      },
      GameDate: gameDate,
      StartTime: new Date(event.date),
      Season: inferSeason(event.date),
      FetchedAt: new Date(event.fetched_at),
      CreatedAt: Spanner.COMMIT_TIMESTAMP,
      UpdatedAt: Spanner.COMMIT_TIMESTAMP,
      HomeStartingPitcherName: event.home_pitcher ?? null,
      AwayStartingPitcherName: event.away_pitcher ?? null,
    };
  });

  if (rows.length > 0) {
    await edgeDb.table("MlbGames").upsert(rows);
  }

  return {
    date: date ?? dateOnly(new Date().toISOString()),
    sourceUrl: evidence.source_url,
    gamesFetched: events.length,
    gamesUpserted: rows.length,
    eventIds: rows.map((row) => row.EventId),
  };
}
