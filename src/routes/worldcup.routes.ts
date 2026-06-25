import { Router, Request, Response } from "express";
import { worldCupDb } from "../db/spanner";
import { logger } from "../utils/logger";

const router = Router();

const ABBREVIATION_MAP: Record<string, string> = {
  "United States": "USA",
  "Canada": "Can",
  "Mexico": "Mex"
};

const WORLDCUP_PAYLOAD_SQL = `
WITH
-- ── 1. Per-team aggregated results from COMPLETED group matches ──
team_results AS (
  SELECT
    t.TeamCode,
    -- played / won / drawn / lost
    COUNTIF(m.Status = 'completed')                                        AS played,
    COUNTIF(m.Status = 'completed' AND (
              (m.HomeTeamCode = t.TeamCode AND m.HomeScore > m.AwayScore) OR
              (m.AwayTeamCode = t.TeamCode AND m.AwayScore > m.HomeScore)))AS won,
    COUNTIF(m.Status = 'completed' AND m.HomeScore = m.AwayScore)          AS drawn,
    COUNTIF(m.Status = 'completed' AND (
              (m.HomeTeamCode = t.TeamCode AND m.HomeScore < m.AwayScore) OR
              (m.AwayTeamCode = t.TeamCode AND m.AwayScore < m.HomeScore)))AS lost,
    -- goals
    IFNULL(SUM(IF(m.Status = 'completed',
              IF(m.HomeTeamCode = t.TeamCode, m.HomeScore, m.AwayScore), 0)), 0) AS goals_for,
    IFNULL(SUM(IF(m.Status = 'completed',
              IF(m.HomeTeamCode = t.TeamCode, m.AwayScore, m.HomeScore), 0)), 0) AS goals_against
  FROM WorldCupTeams t
  LEFT JOIN WorldCupMatches m
    ON  m.TournamentId = t.TournamentId
    AND m.GroupLetter  = t.GroupLetter
    AND m.Stage        = 'group'
    AND (m.HomeTeamCode = t.TeamCode OR m.AwayTeamCode = t.TeamCode)
  WHERE t.TournamentId = @tournamentId
  GROUP BY t.TeamCode
),

-- ── 2. Standings rows (team meta + computed stats + rank) ──
standings AS (
  SELECT
    t.GroupLetter,
    t.TeamCode,
    t.Name,
    t.FifaRanking,
    t.Confederation,
    t.FlagEmoji,
    COALESCE(t.TeamLogoCdnUrl, t.LogoUrl)            AS flag_url,
    t.Nickname,
    t.IsPlaceholder,
    r.played, r.won, r.drawn, r.lost,
    r.goals_for, r.goals_against,
    (r.goals_for - r.goals_against)                  AS goal_difference,
    (r.won * 3 + r.drawn)                            AS points,
    ROW_NUMBER() OVER (
      PARTITION BY t.GroupLetter
      ORDER BY (r.won * 3 + r.drawn) DESC,
               (r.goals_for - r.goals_against) DESC,
               r.goals_for DESC,
               IFNULL(t.FifaRanking, 9999) ASC
    )                                                AS rank_in_group
  FROM WorldCupTeams t
  JOIN team_results r USING (TeamCode)
  WHERE t.TournamentId = @tournamentId
),

-- ── 3. Group-level date range + matches-played counts ──
group_stats AS (
  SELECT
    GroupLetter,
    DATE(MIN(Kickoff))                               AS date_start,
    DATE(MAX(Kickoff))                               AS date_end,
    COUNTIF(Status = 'completed')                    AS matches_played
  FROM WorldCupMatches
  WHERE TournamentId = @tournamentId AND Stage = 'group'
  GROUP BY GroupLetter
),

-- ── 4. Group host label (DISTINCT venue countries for the group) ──
group_hosts AS (
  SELECT
    m.GroupLetter,
    STRING_AGG(DISTINCT v.Country, ' / ' ORDER BY v.Country) AS host_label
  FROM WorldCupMatches m
  JOIN WorldCupVenues v
    ON v.TournamentId = m.TournamentId AND v.VenueId = m.VenueId
  WHERE m.TournamentId = @tournamentId AND m.Stage = 'group'
  GROUP BY m.GroupLetter
)

SELECT TO_JSON_STRING(
  JSON_OBJECT(
    -- ─────────── tournament ───────────
    'tournament', (
      SELECT JSON_OBJECT(
        'tournamentId',      tr.TournamentId,
        'displayName',       tr.DisplayName,
        'season',            tr.CurrentSeason,
        'totalTeams',        48,
        'totalGroups',       12,
        'totalGroupMatches', 72,
        'hostNations', (
          SELECT ARRAY_AGG(DISTINCT v.Country ORDER BY v.Country)
          FROM WorldCupVenues v WHERE v.TournamentId = @tournamentId
        ),
        'totalVenues', (
          SELECT COUNT(*) FROM WorldCupVenues v WHERE v.TournamentId = @tournamentId
        ),
        'startDate', (
          SELECT CAST(DATE(MIN(Kickoff)) AS STRING)
          FROM WorldCupMatches WHERE TournamentId = @tournamentId
        ),
        'endDate', (
          SELECT CAST(DATE(MAX(Kickoff)) AS STRING)
          FROM WorldCupMatches WHERE TournamentId = @tournamentId
        )
      )
      FROM WorldCupTournaments tr WHERE tr.TournamentId = @tournamentId
    ),

    -- ─────────── groups[] ───────────
    'groups', (
      SELECT ARRAY_AGG(grp ORDER BY grp_letter)
      FROM (
        SELECT
          gs.GroupLetter AS grp_letter,
          JSON_OBJECT(
            'letter',        gs.GroupLetter,
            'hostLabel',     IFNULL(gh.host_label, ''),
            'matchesPlayed', gs.matches_played,
            'totalMatches',  6,
            'dateRange', JSON_OBJECT(
              'start', CAST(gs.date_start AS STRING),
              'end',   CAST(gs.date_end   AS STRING)
            ),

            -- standings[] (4 teams, ranked)
            'standings', (
              SELECT ARRAY_AGG(
                JSON_OBJECT(
                  'teamCode',          s.TeamCode,
                  'name',              s.Name,
                  'groupLetter',       s.GroupLetter,
                  'fifaRanking',       s.FifaRanking,
                  'confederation',     s.Confederation,
                  'flagEmoji',         s.FlagEmoji,
                  'flagUrl',           s.flag_url,
                  'nickname',          s.Nickname,
                  'isPlaceholder',     s.IsPlaceholder,
                  'played',            s.played,
                  'won',               s.won,
                  'drawn',             s.drawn,
                  'lost',              s.lost,
                  'goalsFor',          s.goals_for,
                  'goalsAgainst',      s.goals_against,
                  'goalDifference',    s.goal_difference,
                  'points',            s.points,
                  'qualificationZone', s.rank_in_group <= 2
                )
                ORDER BY s.rank_in_group
              )
              FROM standings s WHERE s.GroupLetter = gs.GroupLetter
            ),

            -- matches[] (up to 6, chronological)
            'matches', (
              SELECT ARRAY_AGG(
                JSON_OBJECT(
                  'matchId',      m.MatchId,
                  'groupLetter',  m.GroupLetter,
                  'matchNumber',  m.MatchNumber,
                  'homeTeamCode', m.HomeTeamCode,
                  'awayTeamCode', m.AwayTeamCode,
                  'kickoff',      FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', m.Kickoff, 'UTC'),
                  'stage',        m.Stage,
                  'status',       m.Status,
                  'homeScore',    m.HomeScore,
                  'awayScore',    m.AwayScore,
                  'venueId',      m.VenueId,
                  'espnEventId',  m.EspnEventId,
                  'liveMinute',   m.LiveMinute,
                  'livePeriod',   m.LivePeriod,
                  'liveStoppage', m.LiveStoppage,
                  'venue', (
                    SELECT JSON_OBJECT(
                      'venueId',         v.VenueId,
                      'name',            v.Name,
                      'city',            v.City,
                      'state',           v.State,
                      'country',         v.Country,
                      'capacity',        v.Capacity,
                      'elevationMeters', v.ElevationMeters,
                      'roofType',        v.RoofType,
                      'surfaceType',     v.SurfaceType,
                      'timezone',        v.Timezone,
                      'latitude',        v.Latitude,
                      'longitude',       v.Longitude
                    )
                    FROM WorldCupVenues v
                    WHERE v.TournamentId = m.TournamentId AND v.VenueId = m.VenueId
                  )
                )
                ORDER BY m.Kickoff, m.MatchNumber
              )
              FROM WorldCupMatches m
              WHERE m.TournamentId = @tournamentId
                AND m.GroupLetter  = gs.GroupLetter
                AND m.Stage        = 'group'
            )
          ) AS grp
        FROM group_stats gs
        LEFT JOIN group_hosts gh USING (GroupLetter)
      )
    ),

    -- ─────────── meta ───────────
    'meta', JSON_OBJECT(
      'dataSource',         'clearspace/sports-worldcup-db',
      'fetchedAt',          FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', CURRENT_TIMESTAMP(), 'UTC'),
      'matchdayLabel',      (
        SELECT CONCAT('Group stage — ',
                      CAST(COUNTIF(Status='completed') AS STRING), '/72 played')
        FROM WorldCupMatches WHERE TournamentId = @tournamentId AND Stage = 'group'
      ),
      'groupMatchesPlayed', (
        SELECT COUNTIF(Status='completed')
        FROM WorldCupMatches WHERE TournamentId = @tournamentId AND Stage = 'group'
      ),
      'groupMatchesTotal',  72
    )
  )
) AS payload;
`;

router.get("/payload", async (req: Request, res: Response) => {
  const tournamentId = req.query.tournamentId || "wc-2026";
  try {
    const [rows] = await worldCupDb.run({
      sql: WORLDCUP_PAYLOAD_SQL,
      params: { tournamentId },
      types: { tournamentId: "string" },
    });

    if (!rows || rows.length === 0) {
      res.status(404).json({ error: "Tournament payload not found" });
      return;
    }

    const payloadString = rows[0].toJSON().payload;
    const payload = JSON.parse(payloadString);

    // Apply abbreviation lookup map to hostLabel in groups
    if (payload.groups && Array.isArray(payload.groups)) {
      payload.groups.forEach((group: any) => {
        if (group.hostLabel) {
          let updatedHostLabel = group.hostLabel;
          // Replace each full country name with its abbreviation
          Object.keys(ABBREVIATION_MAP).forEach(country => {
            updatedHostLabel = updatedHostLabel.replace(new RegExp(country, 'g'), ABBREVIATION_MAP[country]);
          });
          group.hostLabel = updatedHostLabel;
        }
      });
    }

    res.json(payload);
  } catch (error) {
    logger.error({ err: error }, "Error fetching World Cup payload");
    res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
