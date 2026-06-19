-- MlbGameSchedule: Tracks completed and upcoming MLB games from ESPN
CREATE TABLE MlbGameSchedule (
  GameId INT64 NOT NULL,
  GameDate TIMESTAMP NOT NULL,
  HomeTeamId INT64 NOT NULL,
  AwayTeamId INT64 NOT NULL,
  HomeScore INT64,
  AwayScore INT64,
  Status STRING(50),
  SeasonType INT64,
  CreatedAt TIMESTAMP OPTIONS (allow_commit_timestamp=true)
) PRIMARY KEY (GameId);
