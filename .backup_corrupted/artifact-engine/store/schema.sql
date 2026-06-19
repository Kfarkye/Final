-- ============================================================================
-- Production-Hardened Artifact Engine Spanner Schema
-- ============================================================================

CREATE TABLE Artifacts (
  ArtifactId STRING(64) NOT NULL,
  Title STRING(MAX) NOT NULL,
  SchemaVer INT64 NOT NULL,
  LayoutJson STRING(MAX) NOT NULL,
  Rev INT64 NOT NULL,
  UpdatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true)
) PRIMARY KEY (ArtifactId);

CREATE TABLE Blocks (
  ArtifactId STRING(64) NOT NULL,
  BlockId STRING(128) NOT NULL,
  Domain STRING(64) NOT NULL,
  Type STRING(64) NOT NULL,
  Version INT64 NOT NULL,
  DataJson STRING(MAX) NOT NULL,
  ProvenanceJson STRING(MAX) NOT NULL,
  Slot STRING(64) NOT NULL,
  RenderOrder INT64 NOT NULL,
  ContentHash STRING(16) NOT NULL,
  UpdatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true)
) PRIMARY KEY (ArtifactId, BlockId),
  INTERLEAVE IN PARENT Artifacts ON DELETE CASCADE;

CREATE TABLE ArtifactRequests (
  RequestId STRING(128) NOT NULL,
  ArtifactId STRING(64) NOT NULL,
  CommittedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true)
) PRIMARY KEY (RequestId);

CREATE TABLE ArtifactLedger (
  ArtifactId STRING(64) NOT NULL,
  Rev INT64 NOT NULL,
  SnapshotJson STRING(MAX) NOT NULL,
  CommittedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true)
) PRIMARY KEY (ArtifactId, Rev),
  INTERLEAVE IN PARENT Artifacts ON DELETE CASCADE;