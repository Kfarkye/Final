---
name: spanner-googlesql
description: >
  GoogleSQL dialect reference for Cloud Spanner. Activates when the AI needs to
  write Spanner SQL queries, DML, or mutations. Covers dialect differences,
  timestamp functions, Node.js client patterns, and common pitfalls.
keywords:
  - spanner
  - googlesql
  - execute_sql
  - describe_spanner
  - database
  - schema
  - DDL
  - DML
  - mutation
  - PENDING_COMMIT_TIMESTAMP
---

# Spanner GoogleSQL Reference

## GoogleSQL vs Standard SQL — Key Differences

### Timestamps
- `CURRENT_TIMESTAMP()` — returns current time (use in SELECT)
- `PENDING_COMMIT_TIMESTAMP()` — use ONLY in DML INSERT/UPDATE for commit timestamp columns
- **NEVER** use `NOW()`, `GETDATE()`, `SYSDATE()` — these do not exist in GoogleSQL
- Timestamp literals: `TIMESTAMP '2024-01-15T00:00:00Z'`
- Casting: `CAST('2024-01-15' AS DATE)`, `CAST('2024-01-15T00:00:00Z' AS TIMESTAMP)`

### Types
- `INT64` not `INT`, `INTEGER`, `BIGINT`
- `FLOAT64` not `FLOAT`, `DOUBLE`, `REAL`
- `BOOL` not `BOOLEAN`
- `STRING(MAX)` not `VARCHAR`, `TEXT`
- `BYTES(MAX)` not `BLOB`, `VARBINARY`
- `NUMERIC` — exact decimal (good for prices/odds)
- `JSON` — native JSON type, query with `JSON_VALUE()`, `JSON_QUERY()`
- `ARRAY<TYPE>` — native arrays, query with `UNNEST()`

### No AUTO_INCREMENT / SERIAL
Spanner has no auto-increment. Use UUIDs or composite keys:
```sql
-- Generate UUID in application code, not SQL
INSERT INTO MyTable (Id, ...) VALUES (GENERATE_UUID(), ...)
```

### No DEFAULT values
Columns cannot have DEFAULT values in Spanner. Always provide all values in INSERT.

### Commit Timestamp Columns
Columns declared with `OPTIONS (allow_commit_timestamp = true)` MUST use:
```sql
-- In DML:
INSERT INTO MyTable (Id, CreatedAt) VALUES ('abc', PENDING_COMMIT_TIMESTAMP())
UPDATE MyTable SET UpdatedAt = PENDING_COMMIT_TIMESTAMP() WHERE Id = 'abc'

-- In Node.js mutations:
table.upsert([{ Id: 'abc', CreatedAt: Spanner.commitTimestamp() }])
```

### String Comparison
- Case-insensitive: `LOWER(col) = LOWER('value')`
- No `ILIKE` — use `REGEXP_CONTAINS(col, r'(?i)pattern')`
- Pattern matching: `REGEXP_CONTAINS(Name, r'(?i)yankees')`

### Pagination
```sql
SELECT * FROM MyTable ORDER BY CreatedAt DESC LIMIT 50 OFFSET 0
```

### INTERLEAVE IN PARENT
Child tables are physically co-located with parent rows:
```sql
CREATE TABLE ChildTable (
  ParentId STRING(MAX) NOT NULL,
  ChildId STRING(MAX) NOT NULL,
  ...
) PRIMARY KEY (ParentId, ChildId),
INTERLEAVE IN PARENT ParentTable ON DELETE CASCADE
```

### JSON Querying
```sql
-- Extract scalar value
SELECT JSON_VALUE(RawJson, '$.home_team') AS home FROM MyTable
-- Extract object/array
SELECT JSON_QUERY(RawJson, '$.bookmakers') AS books FROM MyTable
-- Filter on JSON field
WHERE JSON_VALUE(RawJson, '$.status') = 'active'
```

### Array Operations
```sql
-- Unnest array column
SELECT t.Id, elem FROM MyTable t, UNNEST(t.Tags) AS elem
-- Array contains
WHERE 'mlb' IN UNNEST(Tags)
-- Array aggregation
SELECT ARRAY_AGG(DISTINCT Market) AS markets FROM CurrentOdds
```

## Node.js Spanner Client Patterns

### Read Query
```typescript
const database = spanner.instance('clearspace').database('sports-mlb-db');
const [rows] = await database.run({ sql: 'SELECT * FROM MyTable LIMIT 10' });
const data = rows.map(row => row.toJSON());
```

### Parameterized Query (ALWAYS use for user input)
```typescript
const [rows] = await database.run({
  sql: 'SELECT * FROM CurrentOdds WHERE Market = @market AND IsActive = TRUE',
  params: { market: 'h2h' },
  types: { market: { type: 'string' } }
});
```

### Write DML (single statement)
```typescript
await database.runTransactionAsync(async (transaction) => {
  const [count] = await transaction.runUpdate({
    sql: `UPDATE CurrentOdds SET IsActive = FALSE, UpdatedAt = PENDING_COMMIT_TIMESTAMP()
          WHERE ValidUntil < CURRENT_TIMESTAMP() AND IsActive = TRUE`
  });
  await transaction.commit();
  console.log(`Updated ${count} rows`);
});
```

### Mutations (batch insert/upsert — faster than DML for bulk ops)
```typescript
const table = database.table('MlbOddsHistory');
await table.upsert([
  {
    EventId: 'evt_123',
    SnapshotId: '2024-06-25T00:00:00Z_draftkings',
    Provider: 'draftkings',
    HomeMoneyLine: -150,
    CreatedAt: Spanner.commitTimestamp(),  // NOT a string, NOT PENDING_COMMIT_TIMESTAMP()
    UpdatedAt: Spanner.commitTimestamp(),
  }
]);
```

### Key Differences: DML vs Mutations
| Feature | DML (runUpdate) | Mutations (insert/upsert) |
|---------|-----------------|--------------------------|
| Timestamp | `PENDING_COMMIT_TIMESTAMP()` | `Spanner.commitTimestamp()` |
| Speed | Slower (parsed SQL) | Faster (direct API) |
| Transactions | Yes (read-your-writes) | Yes (blind writes) |
| Use when | Need WHERE clauses, joins | Bulk insert/upsert |

## Common Pitfalls

1. **`Spanner.commitTimestamp()` is NOT a string** — don't use `'spanner.commitTimestamp()'` (that's a literal string)
2. **`PENDING_COMMIT_TIMESTAMP()` only works in DML** — not in SELECT
3. **No `INSERT ... ON DUPLICATE KEY UPDATE`** — use `INSERT OR UPDATE` or mutations `table.upsert()`
4. **Transaction timeouts** — default is 10s, large DML needs explicit timeout
5. **Read-only transactions see a consistent snapshot** — they don't see concurrent writes
6. **`toJSON()` is required** — Spanner rows are not plain objects, call `.toJSON()` to serialize
