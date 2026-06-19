-- MlbGameFirstScore: Fact table identifying who scored first in completed games
CREATE TABLE MlbGameFirstScore (
  Season INT64 NOT NULL,
  GamePk INT64 NOT NULL,
  GameDate DATE NOT NULL,
  AwayTeamCode STRING(10),
  HomeTeamCode STRING(10),
  FirstScoreTeamCode STRING(10),
  FirstScoreInning INT64,
  FirstScoreHalf STRING(10),
  AwayScoredFirst BOOL,
  HomeScoredFirst BOOL,
  AwayFinalRuns INT64,
  HomeFinalRuns INT64,
  CreatedAt TIMESTAMP OPTIONS (allow_commit_timestamp=true)
) PRIMARY KEY (Season, GamePk);

-- MlbTeamScoreFirstRollingSnapshot: Rolling aggregates per team, generated daily
CREATE TABLE MlbTeamScoreFirstRollingSnapshot (
  Season INT64 NOT NULL,
  TeamCode STRING(10) NOT NULL,
  SnapshotDate DATE NOT NULL,
  GamesPlayed INT64,
  ScoredFirstCount INT64,
  OpponentScoredFirstCount INT64,
  ScoredFirstPct FLOAT64,
  OpponentScoredFirstPct FLOAT64,
  CreatedAt TIMESTAMP OPTIONS (allow_commit_timestamp=true)
) PRIMARY KEY (Season, TeamCode, SnapshotDate);

-- MlbTeamToScoreFirstModelSnapshot: The model's predictions and features for upcoming games
CREATE TABLE MlbTeamToScoreFirstModelSnapshot (
  GamePk INT64 NOT NULL,
  GameDate DATE NOT NULL,
  AwayTeamCode STRING(10) NOT NULL,
  HomeTeamCode STRING(10) NOT NULL,
  AwayModelProb FLOAT64,
  HomeModelProb FLOAT64,
  ModelVersion STRING(50),
  FeatureJson STRING(MAX),
  CreatedAt TIMESTAMP OPTIONS (allow_commit_timestamp=true)
) PRIMARY KEY (GamePk);
