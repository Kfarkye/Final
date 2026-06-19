-- MlbPlayerProfile: Dimension table containing static and seasonal stats for active MLB players
CREATE TABLE MlbPlayerProfile (
  PlayerId INT64 NOT NULL,
  FullName STRING(MAX) NOT NULL,
  TeamCode STRING(10),
  Position STRING(10),
  Bats STRING(10),
  Throws STRING(10),
  Height STRING(20),
  Weight INT64,
  Age INT64,
  SeasonStatsJson STRING(MAX),
  CreatedAt TIMESTAMP OPTIONS (allow_commit_timestamp=true)
) PRIMARY KEY (PlayerId)
