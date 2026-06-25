#!/bin/bash
# apply-entity-ddl.sh — Apply remaining DDL statements after EntityAliases table exists
# Run from reverie root

PROJECT="gen-lang-client-0281999829"
INSTANCE="clearspace"
DB="sports-entities-db"

echo "=== Creating indexes on EntityAliases ==="

gcloud spanner databases ddl update "$DB" \
  --instance="$INSTANCE" \
  --project="$PROJECT" \
  --ddl='CREATE INDEX EntityAliasesByAliasLower ON EntityAliases(AliasLower);
CREATE INDEX EntityAliasesBySportAlias ON EntityAliases(Sport, AliasLower);
CREATE INDEX EntityAliasesByType ON EntityAliases(EntityType, Sport);
CREATE INDEX EntityAliasesByCanonicalId ON EntityAliases(CanonicalId)'

echo "=== Creating StatAliases table ==="

gcloud spanner databases ddl update "$DB" \
  --instance="$INSTANCE" \
  --project="$PROJECT" \
  --ddl='CREATE TABLE StatAliases (
  AliasId         STRING(36)   NOT NULL,
  Alias           STRING(256)  NOT NULL,
  AliasLower      STRING(256)  NOT NULL,
  Sport           STRING(16)   NOT NULL,
  CanonicalColumn STRING(128)  NOT NULL,
  CanonicalLabel  STRING(128)  NOT NULL,
  TableName       STRING(128),
  IsAggregatable  BOOL         NOT NULL DEFAULT (true),
  CreatedAt       TIMESTAMP    NOT NULL OPTIONS (allow_commit_timestamp=true),
) PRIMARY KEY (AliasId)'

echo "=== Creating StatAliases index ==="

gcloud spanner databases ddl update "$DB" \
  --instance="$INSTANCE" \
  --project="$PROJECT" \
  --ddl='CREATE INDEX StatAliasesByLower ON StatAliases(AliasLower, Sport)'

echo "=== Done. Vector index will be applied AFTER seed data is loaded ==="
echo "(Vector indexes perform better when created after data is present)"
