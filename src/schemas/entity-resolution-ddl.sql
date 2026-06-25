-- ═══════════════════════════════════════════════════════════════════
-- Entity Resolution Schema — Vector-Powered
-- Target: clearspace/sports-entities-db (create database first)
--
-- Apply via execute_ddl tool with:
--   instanceId: "clearspace"
--   databaseId: "sports-entities-db"
--
-- Each statement is a separate array element in the ddlStatements arg.
-- ═══════════════════════════════════════════════════════════════════

-- ┌─────────────────────────────────────────────────────────────────┐
-- │ STATEMENT 1: EntityAliases table                               │
-- │ The core lookup surface. Every known name/nickname/slang maps  │
-- │ to a canonical entity + embedding for vector search.           │
-- └─────────────────────────────────────────────────────────────────┘

CREATE TABLE EntityAliases (
  AliasId         STRING(36)   NOT NULL,
  -- The alias text (what users type)
  Alias           STRING(512)  NOT NULL,
  AliasLower      STRING(512)  NOT NULL,
  -- What this alias resolves to
  EntityType      STRING(32)   NOT NULL,  -- 'player' | 'team' | 'stat' | 'venue'
  Sport           STRING(16)   NOT NULL,  -- 'mlb' | 'nba' | 'nfl' | 'nhl' | 'soccer'
  CanonicalId     STRING(64)   NOT NULL,  -- Links to sport-specific PlayerId/TeamId
  CanonicalName   STRING(512)  NOT NULL,
  -- Alias metadata
  AliasSource     STRING(64),             -- 'official' | 'nickname' | 'abbreviation' | 'slang' | 'typo' | 'auto'
  Confidence      FLOAT64      NOT NULL DEFAULT (1.0),
  -- Vector embedding (text-embedding-004 = 768 dimensions)
  -- Used for semantic similarity: "the greek freak" → Giannis
  AliasEmbedding  ARRAY<FLOAT32>(vector_length=>768),
  -- Housekeeping
  CreatedAt       TIMESTAMP    NOT NULL OPTIONS (allow_commit_timestamp=true),
  UpdatedAt       TIMESTAMP    NOT NULL OPTIONS (allow_commit_timestamp=true),
) PRIMARY KEY (AliasId);


-- ┌─────────────────────────────────────────────────────────────────┐
-- │ STATEMENT 2: Exact-match index on lowercase alias              │
-- │ This is the FAST PATH: most lookups hit here first.            │
-- │ "judge" → Aaron Judge, "nyy" → New York Yankees               │
-- └─────────────────────────────────────────────────────────────────┘

CREATE INDEX EntityAliasesByAliasLower
  ON EntityAliases(AliasLower);


-- ┌─────────────────────────────────────────────────────────────────┐
-- │ STATEMENT 3: Sport-scoped index for filtered lookups           │
-- │ "judge" in MLB context vs "judge" in legal context             │
-- └─────────────────────────────────────────────────────────────────┘

CREATE INDEX EntityAliasesBySportAlias
  ON EntityAliases(Sport, AliasLower);


-- ┌─────────────────────────────────────────────────────────────────┐
-- │ STATEMENT 4: Entity type index for batch operations            │
-- │ "give me all player aliases for NBA"                           │
-- └─────────────────────────────────────────────────────────────────┘

CREATE INDEX EntityAliasesByType
  ON EntityAliases(EntityType, Sport);


-- ┌─────────────────────────────────────────────────────────────────┐
-- │ STATEMENT 5: Canonical ID index for reverse lookups            │
-- │ "what aliases exist for LeBron James?"                         │
-- └─────────────────────────────────────────────────────────────────┘

CREATE INDEX EntityAliasesByCanonicalId
  ON EntityAliases(CanonicalId);


-- ┌─────────────────────────────────────────────────────────────────┐
-- │ STATEMENT 6: VECTOR INDEX for semantic similarity search       │
-- │                                                                 │
-- │ This is the magic: when exact-match fails, we fall back to     │
-- │ vector similarity. "the greek freak" has no exact match but    │
-- │ its embedding is close to "Giannis Antetokounmpo".             │
-- │                                                                 │
-- │ Uses COSINE distance (best for text embeddings).               │
-- │ tree_depth=2, num_leaves=1000 is optimal for <100K aliases.    │
-- │ STORING Sport+EntityType enables filtered ANN at leaf level.   │
-- └─────────────────────────────────────────────────────────────────┘

CREATE VECTOR INDEX EntityAliasEmbeddingIndex
  ON EntityAliases(AliasEmbedding)
  STORING (Sport, EntityType)
  WHERE AliasEmbedding IS NOT NULL
  OPTIONS (
    distance_type = 'COSINE',
    tree_depth = 2,
    num_leaves = 1000
  );


-- ┌─────────────────────────────────────────────────────────────────┐
-- │ STATEMENT 7: StatAliases table                                 │
-- │ Maps slang stat names to canonical column names.               │
-- │ "dimes" → Assists, "bombs" → HomeRuns                          │
-- │ Separate from EntityAliases for cleaner query routing.         │
-- └─────────────────────────────────────────────────────────────────┘

CREATE TABLE StatAliases (
  AliasId         STRING(36)   NOT NULL,
  Alias           STRING(256)  NOT NULL,
  AliasLower      STRING(256)  NOT NULL,
  Sport           STRING(16)   NOT NULL,
  CanonicalColumn STRING(128)  NOT NULL,  -- e.g. 'HomeRuns', 'Assists', 'PassTD'
  CanonicalLabel  STRING(128)  NOT NULL,  -- e.g. 'Home Runs', 'Assists', 'Passing Touchdowns'
  TableName       STRING(128),            -- e.g. 'MlbPlayerPerformances', 'NbaPlayerGameStats'
  IsAggregatable  BOOL         NOT NULL DEFAULT (true),
  CreatedAt       TIMESTAMP    NOT NULL OPTIONS (allow_commit_timestamp=true),
) PRIMARY KEY (AliasId);


-- ┌─────────────────────────────────────────────────────────────────┐
-- │ STATEMENT 8: Stat alias lookup index                           │
-- └─────────────────────────────────────────────────────────────────┘

CREATE INDEX StatAliasesByLower
  ON StatAliases(AliasLower, Sport);
