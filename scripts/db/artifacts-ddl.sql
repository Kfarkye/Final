-- Deliverable 1: Artifacts table DDL for Spanner (sports-mlb-db)
-- Run via: gcloud spanner databases ddl update sports-mlb-db --instance=clearspace --ddl-file=...

CREATE TABLE Artifacts (
  Id            STRING(36)   NOT NULL,
  Slug          STRING(200)  NOT NULL,
  TenantId      STRING(64)   NOT NULL,
  Visibility    STRING(16)   NOT NULL,
  GcsPath       STRING(512)  NOT NULL,
  Title         STRING(300),
  Description   STRING(1024),
  IndexStatus   STRING(32),
  IndexVerdict  STRING(32),
  LastInspected TIMESTAMP,
  CreatedAt     TIMESTAMP    NOT NULL OPTIONS (allow_commit_timestamp = true),
  UpdatedAt     TIMESTAMP    NOT NULL OPTIONS (allow_commit_timestamp = true),
) PRIMARY KEY (Id);

CREATE UNIQUE INDEX ArtifactsBySlug ON Artifacts(Slug);
CREATE INDEX ArtifactsByTenant ON Artifacts(TenantId);
CREATE INDEX ArtifactsPublic ON Artifacts(Visibility) STORING (Slug, UpdatedAt);
