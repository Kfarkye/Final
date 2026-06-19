-- MlbTeamProfile: Dimension table for MLB teams
CREATE TABLE MlbTeamProfile (
  TeamId INT64 NOT NULL,
  TeamCode STRING(10) NOT NULL,
  FullName STRING(MAX) NOT NULL,
  ShortName STRING(MAX),
  LocationName STRING(MAX),
  DivisionId INT64,
  LeagueId INT64,
  VenueName STRING(MAX),
  CreatedAt TIMESTAMP OPTIONS (allow_commit_timestamp=true)
) PRIMARY KEY (TeamId)
