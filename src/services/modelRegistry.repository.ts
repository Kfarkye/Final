// src/services/modelRegistry.repository.ts
// Low-level Spanner read/write operations for the Model Registry

import { Spanner } from '@google-cloud/spanner';
import { env } from '../config/env';
import type {
  ModelRecord,
  ModelSource,
  ModelCapability,
  ModelAlias,
  ModelPricingRecord,
  ModelAvailabilityRecord,
  VerificationEvent,
  ModelFilters,
} from './modelRegistry.types';

// ═══════════════════════════════════════════════════════════════════
// Spanner client — reuses existing env pattern
// ═══════════════════════════════════════════════════════════════════
const spanner = new Spanner({ projectId: env.SPANNER_PROJECT_ID });

function getDatabase() {
  const instanceId = env.MODEL_REGISTRY_SPANNER_INSTANCE_ID || env.SPANNER_INSTANCE_ID || 'clearspace';
  const databaseId = env.MODEL_REGISTRY_SPANNER_DATABASE_ID || 'core-db';
  if (!instanceId || !databaseId) {
    throw new Error('Model Registry Spanner instance and database must be configured');
  }
  return spanner.instance(instanceId).database(databaseId);
}

// Helper: convert Spanner row to plain JSON
function rowToJson(row: any): any {
  if (row.toJSON) return row.toJSON();
  return row;
}

// ═══════════════════════════════════════════════════════════════════
// READ operations
// ═══════════════════════════════════════════════════════════════════

export async function getModelById(provider: string, modelId: string): Promise<ModelRecord | null> {
  const database = getDatabase();
  const query = {
    sql: `SELECT * FROM ModelRegistry WHERE Provider = @provider AND ModelId = @modelId`,
    params: { provider, modelId },
  };
  const [rows] = await database.run(query);
  if (rows.length === 0) return null;
  return rowToJson(rows[0]) as ModelRecord;
}

export async function listModels(filters: ModelFilters = {}): Promise<ModelRecord[]> {
  const database = getDatabase();
  const conditions: string[] = [];
  const params: Record<string, string> = {};

  if (filters.provider) {
    conditions.push('Provider = @provider');
    params.provider = filters.provider;
  }
  if (filters.platform) {
    conditions.push('Platform = @platform');
    params.platform = filters.platform;
  }
  if (filters.status) {
    conditions.push('Status = @status');
    params.status = filters.status;
  }
  if (filters.verificationStatus) {
    conditions.push('VerificationStatus = @verificationStatus');
    params.verificationStatus = filters.verificationStatus;
  }

  let sql = 'SELECT * FROM ModelRegistry';
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY Provider, ModelId';

  const [rows] = await database.run({ sql, params });
  return rows.map(rowToJson) as ModelRecord[];
}

export async function getModelSources(provider: string, modelId: string): Promise<ModelSource[]> {
  const database = getDatabase();
  const [rows] = await database.run({
    sql: `SELECT * FROM ModelSources WHERE Provider = @provider AND ModelId = @modelId ORDER BY CreatedAt DESC`,
    params: { provider, modelId },
  });
  return rows.map(rowToJson) as ModelSource[];
}

export async function getModelCapabilities(provider: string, modelId: string): Promise<ModelCapability[]> {
  const database = getDatabase();
  const [rows] = await database.run({
    sql: `SELECT * FROM ModelCapabilities WHERE Provider = @provider AND ModelId = @modelId ORDER BY CapabilityName`,
    params: { provider, modelId },
  });
  return rows.map(rowToJson) as ModelCapability[];
}

export async function getModelAvailability(provider: string, modelId: string): Promise<ModelAvailabilityRecord[]> {
  const database = getDatabase();
  const [rows] = await database.run({
    sql: `SELECT * FROM ModelAvailability WHERE Provider = @provider AND ModelId = @modelId ORDER BY Platform, Region`,
    params: { provider, modelId },
  });
  return rows.map(rowToJson) as ModelAvailabilityRecord[];
}

export async function getModelPricing(provider: string, modelId: string): Promise<ModelPricingRecord[]> {
  const database = getDatabase();
  const [rows] = await database.run({
    sql: `SELECT * FROM ModelPricing WHERE Provider = @provider AND ModelId = @modelId ORDER BY PricingUnit`,
    params: { provider, modelId },
  });
  return rows.map(rowToJson) as ModelPricingRecord[];
}

export async function resolveAlias(provider: string, alias: string): Promise<string | null> {
  const database = getDatabase();
  const [rows] = await database.run({
    sql: `SELECT ModelId FROM ModelAliases WHERE Provider = @provider AND Alias = @alias AND (IsDeprecated IS NULL OR IsDeprecated = false)`,
    params: { provider, alias },
  });
  if (rows.length === 0) return null;
  return rowToJson(rows[0]).ModelId;
}

export async function searchModelsExact(query: string): Promise<ModelRecord[]> {
  const database = getDatabase();
  const searchTerm = `%${query}%`;
  const [rows] = await database.run({
    sql: `SELECT * FROM ModelRegistry 
          WHERE LOWER(ModelId) LIKE LOWER(@searchTerm) 
             OR LOWER(DisplayName) LIKE LOWER(@searchTerm)
             OR LOWER(Provider) LIKE LOWER(@searchTerm)
             OR LOWER(Platform) LIKE LOWER(@searchTerm)
          ORDER BY Provider, ModelId`,
    params: { searchTerm },
  });
  return rows.map(rowToJson) as ModelRecord[];
}

// ═══════════════════════════════════════════════════════════════════
// WRITE operations (used by seed script & Phase 3 ingestion)
// ═══════════════════════════════════════════════════════════════════

export async function upsertModel(record: Partial<ModelRecord> & { Provider: string; ModelId: string }): Promise<void> {
  const database = getDatabase();
  const table = database.table('ModelRegistry');
  await table.upsert([{
    ...record,
    UpdatedAt: Spanner.COMMIT_TIMESTAMP,
    CreatedAt: record.CreatedAt || Spanner.COMMIT_TIMESTAMP,
  }]);
}

export async function upsertModels(records: Array<Partial<ModelRecord> & { Provider: string; ModelId: string }>): Promise<void> {
  const database = getDatabase();
  const table = database.table('ModelRegistry');
  const rows = records.map(r => ({
    ...r,
    UpdatedAt: Spanner.COMMIT_TIMESTAMP,
    CreatedAt: r.CreatedAt || Spanner.COMMIT_TIMESTAMP,
  }));
  await table.upsert(rows);
}

export async function upsertSource(source: Partial<ModelSource> & { Provider: string; ModelId: string; SourceUrl: string }): Promise<void> {
  const database = getDatabase();
  const table = database.table('ModelSources');
  await table.upsert([{
    ...source,
    CreatedAt: source.CreatedAt || Spanner.COMMIT_TIMESTAMP,
  }]);
}

export async function upsertSources(sources: Array<Partial<ModelSource> & { Provider: string; ModelId: string; SourceUrl: string }>): Promise<void> {
  const database = getDatabase();
  const table = database.table('ModelSources');
  const rows = sources.map(s => ({
    ...s,
    CreatedAt: s.CreatedAt || Spanner.COMMIT_TIMESTAMP,
  }));
  await table.upsert(rows);
}

export async function upsertCapability(cap: Partial<ModelCapability> & { Provider: string; ModelId: string; CapabilityName: string }): Promise<void> {
  const database = getDatabase();
  const table = database.table('ModelCapabilities');
  await table.upsert([{
    ...cap,
    UpdatedAt: Spanner.COMMIT_TIMESTAMP,
    CreatedAt: cap.CreatedAt || Spanner.COMMIT_TIMESTAMP,
  }]);
}

export async function insertVerificationEvent(event: VerificationEvent): Promise<void> {
  const database = getDatabase();
  const table = database.table('VerificationEvents');
  await table.insert([{
    ...event,
    CreatedAt: Spanner.COMMIT_TIMESTAMP,
  }]);
}

export async function upsertAlias(alias: Partial<ModelAlias> & { Provider: string; Alias: string; ModelId: string }): Promise<void> {
  const database = getDatabase();
  const table = database.table('ModelAliases');
  await table.upsert([{
    ...alias,
    UpdatedAt: Spanner.COMMIT_TIMESTAMP,
    CreatedAt: alias.CreatedAt || Spanner.COMMIT_TIMESTAMP,
  }]);
}
