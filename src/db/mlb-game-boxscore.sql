-- MlbGameBoxscore: Tracks individual player statistics for a specific MLB game
CREATE TABLE MlbGameBoxscore (
  GameId INT64 NOT NULL,
  PlayerId INT64 NOT NULL,
  TeamId INT64 NOT NULL,
  IsPitcher BOOL NOT NULL,
  AtBats INT64,
  Hits INT64,
  Runs INT64,
  RBIs INT64,
  HomeRuns INT64,
  Walks INT64,
  Strikeouts INT64,
  InningsPitched FLOAT64,
  EarnedRuns INT64,
  PitchesThrown INT64,
  StatsJson STRING(MAX),
  CreatedAt TIMESTAMP OPTIONS (allow_commit_timestamp=true)
) PRIMARY KEY (GameId, PlayerId);
