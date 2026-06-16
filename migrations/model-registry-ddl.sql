-- Model Registry DDL Migration
-- Target: clearspace instance / core-db database
-- Applied via: gcloud spanner databases ddl update

-- ═══════════════════════════════════════════════════════════════════
-- 1. ModelRegistry — Canonical model records
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE ModelRegistry (
  Provider STRING(64) NOT NULL,
  ModelId STRING(128) NOT NULL,

  DisplayName STRING(256),
  Platform STRING(128),
  ProviderModelFamily STRING(128),

  Status STRING(32),
  VerificationStatus STRING(32),

  EndpointType STRING(128),
  DefaultRegion STRING(128),
  SupportsRegionalEndpoints BOOL,
  SupportsGlobalEndpoint BOOL,
  SupportsBatch BOOL,
  SupportsStreaming BOOL,
  SupportsToolCalling BOOL,
  SupportsJsonMode BOOL,
  SupportsVision BOOL,
  SupportsAudio BOOL,
  SupportsVideo BOOL,
  SupportsReasoning BOOL,

  ContextWindowTokens INT64,
  MaxOutputTokens INT64,

  RoutingNotes STRING(MAX),
  AvailabilityNotes STRING(MAX),
  DataBoundaryNotes STRING(MAX),
  VersioningNotes STRING(MAX),

  OfficialDocUrl STRING(MAX),
  VerifiedAt TIMESTAMP,
  SourceHash STRING(128),

  CreatedAt TIMESTAMP OPTIONS (allow_commit_timestamp=true),
  UpdatedAt TIMESTAMP OPTIONS (allow_commit_timestamp=true)
) PRIMARY KEY (Provider, ModelId);

-- ═══════════════════════════════════════════════════════════════════
-- 2. ModelSources — Official source citations
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE ModelSources (
  Provider STRING(64) NOT NULL,
  ModelId STRING(128) NOT NULL,
  SourceUrl STRING(MAX) NOT NULL,

  SourceTitle STRING(512),
  SourceType STRING(64),
  RetrievedAt TIMESTAMP,
  ContentHash STRING(128),
  Excerpt STRING(MAX),
  Confidence FLOAT64,

  CreatedAt TIMESTAMP OPTIONS (allow_commit_timestamp=true)
) PRIMARY KEY (Provider, ModelId, SourceUrl),
  INTERLEAVE IN PARENT ModelRegistry ON DELETE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- 3. ModelCapabilities — Normalized source-linked facts
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE ModelCapabilities (
  Provider STRING(64) NOT NULL,
  ModelId STRING(128) NOT NULL,
  CapabilityName STRING(128) NOT NULL,

  CapabilityValueString STRING(MAX),
  CapabilityValueNumber FLOAT64,
  CapabilityValueBool BOOL,
  Unit STRING(64),

  SourceUrl STRING(MAX),
  SourceRetrievedAt TIMESTAMP,
  VerificationStatus STRING(32),
  Confidence STRING(64),

  CreatedAt TIMESTAMP OPTIONS (allow_commit_timestamp=true),
  UpdatedAt TIMESTAMP OPTIONS (allow_commit_timestamp=true)
) PRIMARY KEY (Provider, ModelId, CapabilityName),
  INTERLEAVE IN PARENT ModelRegistry ON DELETE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- 4. ModelAliases — Maps UI/router aliases to canonical model IDs
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE ModelAliases (
  Provider STRING(64) NOT NULL,
  Alias STRING(128) NOT NULL,

  ModelId STRING(128) NOT NULL,
  AliasType STRING(64),
  IsDefault BOOL,
  IsDeprecated BOOL,

  CreatedAt TIMESTAMP OPTIONS (allow_commit_timestamp=true),
  UpdatedAt TIMESTAMP OPTIONS (allow_commit_timestamp=true)
) PRIMARY KEY (Provider, Alias);

-- ═══════════════════════════════════════════════════════════════════
-- 5. ModelPricing — Optional pricing metadata
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE ModelPricing (
  Provider STRING(64) NOT NULL,
  ModelId STRING(128) NOT NULL,
  PricingUnit STRING(64) NOT NULL,

  PriceUsd FLOAT64,
  UnitSize INT64,
  Currency STRING(16),
  Region STRING(128),

  SourceUrl STRING(MAX),
  RetrievedAt TIMESTAMP,
  VerificationStatus STRING(32),

  CreatedAt TIMESTAMP OPTIONS (allow_commit_timestamp=true),
  UpdatedAt TIMESTAMP OPTIONS (allow_commit_timestamp=true)
) PRIMARY KEY (Provider, ModelId, PricingUnit, Region),
  INTERLEAVE IN PARENT ModelRegistry ON DELETE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- 6. ModelAvailability — Platform/region availability tracking
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE ModelAvailability (
  Provider STRING(64) NOT NULL,
  ModelId STRING(128) NOT NULL,
  Platform STRING(128) NOT NULL,
  Region STRING(128) NOT NULL,

  IsAvailable BOOL,
  AvailabilityType STRING(64),
  EndpointName STRING(MAX),
  QuotaNotes STRING(MAX),

  SourceUrl STRING(MAX),
  RetrievedAt TIMESTAMP,
  VerificationStatus STRING(32),

  CreatedAt TIMESTAMP OPTIONS (allow_commit_timestamp=true),
  UpdatedAt TIMESTAMP OPTIONS (allow_commit_timestamp=true)
) PRIMARY KEY (Provider, ModelId, Platform, Region),
  INTERLEAVE IN PARENT ModelRegistry ON DELETE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- 7. VerificationEvents — Append-only verification log
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE VerificationEvents (
  Provider STRING(64) NOT NULL,
  ModelId STRING(128) NOT NULL,
  VerificationEventId STRING(128) NOT NULL,

  EventType STRING(64),
  EventStatus STRING(64),
  SourceUrl STRING(MAX),
  RetrievedAt TIMESTAMP,
  PreviousHash STRING(128),
  NewHash STRING(128),
  DiffSummary STRING(MAX),
  Notes STRING(MAX),

  CreatedAt TIMESTAMP OPTIONS (allow_commit_timestamp=true)
) PRIMARY KEY (Provider, ModelId, VerificationEventId),
  INTERLEAVE IN PARENT ModelRegistry ON DELETE CASCADE;
