-- MlbPlayByPlay: Chronologically logs every play within a specific MLB game
CREATE TABLE MlbPlayByPlay (
  GameId INT64 NOT NULL,
  PlayId INT64 NOT NULL,
  Inning INT64 NOT NULL,
  HalfInning STRING(10) NOT NULL,
  BatterId INT64,
  PitcherId INT64,
  PlayType STRING(100),
  Description STRING(MAX),
  IsScoringPlay BOOL NOT NULL,
  AwayScore INT64 NOT NULL,
  HomeScore INT64 NOT NULL,
  CreatedAt TIMESTAMP OPTIONS (allow_commit_timestamp=true)
) PRIMARY KEY (GameId, PlayId);
