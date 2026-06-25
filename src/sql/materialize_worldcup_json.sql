WITH Venues AS (
  SELECT
    VenueId,
    Name,
    City,
    State,
    Country,
    Capacity,
    ElevationMeters,
    RoofType,
    SurfaceType,
    Timezone,
    Latitude,
    Longitude
  FROM WorldCupVenues
),
Matches AS (
  SELECT
    MatchId,
    GroupLetter,
    MatchNumber,
    HomeTeamCode,
    AwayTeamCode,
    -- Convert Spanner TIMESTAMP to ISO 8601 string
    FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E*SZ', Kickoff) AS Kickoff,
    Stage,
    Status,
    HomeScore,
    AwayScore,
    VenueId,
    EspnEventId,
    LiveMinute,
    LivePeriod,
    LiveStoppage
  FROM WorldCupMatches
),
TeamStats AS (
  SELECT
    t.TeamCode,
    t.Name,
    t.GroupLetter,
    t.FifaRanking,
    t.Confederation,
    t.FlagEmoji,
    COALESCE(t.TeamLogoCdnUrl, t.LogoUrl) AS flagUrl,
    t.Nickname,
    t.IsPlaceholder,
    -- Played: sum of completed matches
    COUNTIF(m.Status = 'completed') AS played,
    -- Won
    COUNTIF(m.Status = 'completed' AND (
      (m.HomeTeamCode = t.TeamCode AND m.HomeScore > m.AwayScore) OR
      (m.AwayTeamCode = t.TeamCode AND m.AwayScore > m.HomeScore)
    )) AS won,
    -- Drawn
    COUNTIF(m.Status = 'completed' AND m.HomeScore = m.AwayScore) AS drawn,
    -- Lost
    COUNTIF(m.Status = 'completed' AND (
      (m.HomeTeamCode = t.TeamCode AND m.HomeScore < m.AwayScore) OR
      (m.AwayTeamCode = t.TeamCode AND m.AwayScore < m.HomeScore)
    )) AS lost,
    -- Goals For
    COALESCE(SUM(CASE WHEN m.Status = 'completed' AND m.HomeTeamCode = t.TeamCode THEN m.HomeScore
                      WHEN m.Status = 'completed' AND m.AwayTeamCode = t.TeamCode THEN m.AwayScore ELSE 0 END), 0) AS goalsFor,
    -- Goals Against
    COALESCE(SUM(CASE WHEN m.Status = 'completed' AND m.HomeTeamCode = t.TeamCode THEN m.AwayScore
                      WHEN m.Status = 'completed' AND m.AwayTeamCode = t.TeamCode THEN m.HomeScore ELSE 0 END), 0) AS goalsAgainst
  FROM WorldCupTeams t
  LEFT JOIN WorldCupMatches m ON (t.TeamCode = m.HomeTeamCode OR t.TeamCode = m.AwayTeamCode) AND m.Stage = 'group'
  GROUP BY 1,2,3,4,5,6,7,8,9
),
TeamStandings AS (
  SELECT
    *,
    goalsFor - goalsAgainst AS goalDifference,
    won * 3 + drawn AS points
  FROM TeamStats
),
TeamStandingsRanked AS (
  SELECT
    *,
    ROW_NUMBER() OVER(
      PARTITION BY GroupLetter
      ORDER BY points DESC, (goalsFor - goalsAgainst) DESC, goalsFor DESC, FifaRanking ASC
    ) AS rank
  FROM TeamStandings
),
Groups AS (
  SELECT
    ts.GroupLetter AS letter,
    -- Aggregate countries from venues for matches in this group
    (SELECT STRING_AGG(DISTINCT v.Country, ' / ' ORDER BY v.Country) FROM Matches m JOIN Venues v ON m.VenueId = v.VenueId WHERE m.GroupLetter = ts.GroupLetter) AS hostLabel,
    ARRAY(
      SELECT AS STRUCT
        TeamCode AS teamCode,
        Name AS name,
        GroupLetter AS groupLetter,
        FifaRanking AS fifaRanking,
        Confederation AS confederation,
        FlagEmoji AS flagEmoji,
        flagUrl,
        Nickname AS nickname,
        IsPlaceholder AS isPlaceholder,
        played,
        won,
        drawn,
        lost,
        goalsFor,
        goalsAgainst,
        goalDifference,
        points,
        (rank <= 2) AS qualificationZone
      FROM TeamStandingsRanked
      WHERE GroupLetter = ts.GroupLetter
      ORDER BY rank
    ) AS standings,
    ARRAY(
      SELECT AS STRUCT
        m.MatchId AS matchId,
        m.GroupLetter AS groupLetter,
        m.MatchNumber AS matchNumber,
        m.HomeTeamCode AS homeTeamCode,
        m.AwayTeamCode AS awayTeamCode,
        m.Kickoff AS kickoff,
        m.Stage AS stage,
        m.Status AS status,
        m.HomeScore AS homeScore,
        m.AwayScore AS awayScore,
        m.VenueId AS venueId,
        (SELECT AS STRUCT 
           v.VenueId AS venueId, 
           v.Name AS name, 
           v.City AS city, 
           v.State AS state, 
           v.Country AS country, 
           v.Capacity AS capacity, 
           v.ElevationMeters AS elevationMeters, 
           v.RoofType AS roofType, 
           v.SurfaceType AS surfaceType, 
           v.Timezone AS timezone, 
           v.Latitude AS latitude, 
           v.Longitude AS longitude 
         FROM Venues v 
         WHERE v.VenueId = m.VenueId
        ) AS venue,
        m.EspnEventId AS espnEventId,
        m.LiveMinute AS liveMinute,
        m.LivePeriod AS livePeriod,
        m.LiveStoppage AS liveStoppage
      FROM Matches m
      WHERE m.GroupLetter = ts.GroupLetter
      ORDER BY m.Kickoff
    ) AS matches,
    (SELECT COUNT(*) FROM Matches m WHERE m.GroupLetter = ts.GroupLetter AND m.Status = 'completed') AS matchesPlayed,
    6 AS totalMatches,
    (SELECT AS STRUCT
       FORMAT_TIMESTAMP('%Y-%m-%d', MIN(PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*SZ', m.Kickoff))) AS start,
       FORMAT_TIMESTAMP('%Y-%m-%d', MAX(PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*SZ', m.Kickoff))) AS `end`
     FROM Matches m WHERE m.GroupLetter = ts.GroupLetter) AS dateRange
  FROM (SELECT DISTINCT GroupLetter FROM TeamStandingsRanked WHERE GroupLetter IS NOT NULL) ts
),
Tournament AS (
  SELECT
    t.TournamentId AS tournamentId,
    t.DisplayName AS displayName,
    t.CurrentSeason AS season,
    48 AS totalTeams,
    12 AS totalGroups,
    72 AS totalGroupMatches,
    ARRAY(SELECT DISTINCT Country FROM Venues WHERE Country IS NOT NULL ORDER BY Country) AS hostNations,
    (SELECT COUNT(*) FROM Venues) AS totalVenues,
    FORMAT_TIMESTAMP('%Y-%m-%d', MIN(PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*SZ', m.Kickoff))) AS startDate,
    FORMAT_TIMESTAMP('%Y-%m-%d', MAX(PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*SZ', m.Kickoff))) AS endDate
  FROM WorldCupTournaments t
  CROSS JOIN Matches m
  GROUP BY t.TournamentId, t.DisplayName, t.CurrentSeason
)
SELECT
  TO_JSON(
    STRUCT(
      (SELECT AS STRUCT * FROM Tournament LIMIT 1) AS tournament,
      ARRAY(SELECT AS STRUCT * FROM Groups ORDER BY letter) AS groups,
      (SELECT AS STRUCT
        'clearspace/sports-worldcup-db' AS dataSource,
        FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E*SZ', CURRENT_TIMESTAMP()) AS fetchedAt,
        'Tournament Data' AS matchdayLabel,
        (SELECT COUNT(*) FROM Matches WHERE Stage = 'group' AND Status = 'completed') AS groupMatchesPlayed,
        72 AS groupMatchesTotal
      ) AS meta
    )
  ) AS json_payload
