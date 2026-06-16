// scripts/seed-model-registry.ts
// Seeds the ModelRegistry + ModelSources tables with initial data
// Run: SPANNER_INSTANCE_ID=clearspace SPANNER_DATABASE_ID=core-db npx tsx scripts/seed-model-registry.ts

import { Spanner } from '@google-cloud/spanner';

const PROJECT_ID = process.env.GCP_PROJECT || process.env.SPANNER_PROJECT_ID || 'gen-lang-client-0281999829';
const INSTANCE_ID = process.env.SPANNER_INSTANCE_ID || 'clearspace';
const DATABASE_ID = process.env.SPANNER_DATABASE_ID || 'core-db';

const spanner = new Spanner({ projectId: PROJECT_ID });
const database = spanner.instance(INSTANCE_ID).database(DATABASE_ID);

// ═══════════════════════════════════════════════════════════════════
// Seed Model Records
// ═══════════════════════════════════════════════════════════════════

const SEED_MODELS = [
  // Google / Gemini
  {
    Provider: 'Google', ModelId: 'gemini-3.5-flash',
    DisplayName: 'Gemini 3.5 Flash', Platform: 'Vertex AI',
    ProviderModelFamily: 'Gemini', Status: 'active',
    VerificationStatus: 'needs_review', EndpointType: 'vertex_native',
    DefaultRegion: 'us-central1', SupportsStreaming: true,
    SupportsToolCalling: true, SupportsJsonMode: true,
    SupportsVision: true, SupportsReasoning: false,
    OfficialDocUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/learn/models',
  },
  {
    Provider: 'Google', ModelId: 'gemini-3.1-pro',
    DisplayName: 'Gemini 3.1 Pro', Platform: 'Vertex AI',
    ProviderModelFamily: 'Gemini', Status: 'active',
    VerificationStatus: 'needs_review', EndpointType: 'vertex_native',
    DefaultRegion: 'us-central1', SupportsStreaming: true,
    SupportsToolCalling: true, SupportsJsonMode: true,
    SupportsVision: true, SupportsReasoning: true,
    OfficialDocUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/learn/models',
  },
  {
    Provider: 'Google', ModelId: 'gemini-deep-think',
    DisplayName: 'Gemini Deep Think', Platform: 'Vertex AI',
    ProviderModelFamily: 'Gemini', Status: 'active',
    VerificationStatus: 'needs_review', EndpointType: 'vertex_native',
    DefaultRegion: 'us-central1', SupportsStreaming: true,
    SupportsToolCalling: true, SupportsReasoning: true,
    OfficialDocUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/learn/models',
  },
  {
    Provider: 'Google', ModelId: 'gemini-3.1-flash-lite',
    DisplayName: 'Gemini 3.1 Flash Lite', Platform: 'Vertex AI',
    ProviderModelFamily: 'Gemini', Status: 'active',
    VerificationStatus: 'needs_review', EndpointType: 'vertex_native',
    DefaultRegion: 'us-central1', SupportsStreaming: true,
    SupportsToolCalling: true,
    OfficialDocUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/learn/models',
  },

  // Anthropic / Claude
  {
    Provider: 'Anthropic', ModelId: 'claude-opus-4-6',
    DisplayName: 'Claude Opus 4.6', Platform: 'Vertex AI',
    ProviderModelFamily: 'Claude', Status: 'active',
    VerificationStatus: 'needs_review', EndpointType: 'vertex_maas',
    DefaultRegion: 'us-east5', SupportsStreaming: true,
    SupportsToolCalling: true, SupportsVision: true, SupportsReasoning: true,
    OfficialDocUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-claude',
  },
  {
    Provider: 'Anthropic', ModelId: 'claude-sonnet-4-6',
    DisplayName: 'Claude Sonnet 4.6', Platform: 'Vertex AI',
    ProviderModelFamily: 'Claude', Status: 'active',
    VerificationStatus: 'needs_review', EndpointType: 'vertex_maas',
    DefaultRegion: 'us-east5', SupportsStreaming: true,
    SupportsToolCalling: true, SupportsVision: true,
    OfficialDocUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-claude',
  },
  {
    Provider: 'Anthropic', ModelId: 'claude-haiku-4-5@20251001',
    DisplayName: 'Claude Haiku 4.5', Platform: 'Vertex AI',
    ProviderModelFamily: 'Claude', Status: 'active',
    VerificationStatus: 'needs_review', EndpointType: 'vertex_maas',
    DefaultRegion: 'us-east5', SupportsStreaming: true,
    SupportsToolCalling: true, SupportsVision: true,
    OfficialDocUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-claude',
  },

  // OpenAI
  {
    Provider: 'OpenAI', ModelId: 'gpt-5.5',
    DisplayName: 'GPT-5.5', Platform: 'OpenAI API',
    ProviderModelFamily: 'GPT', Status: 'active',
    VerificationStatus: 'needs_review', EndpointType: 'openai_sdk',
    SupportsStreaming: true, SupportsToolCalling: true,
    SupportsJsonMode: true, SupportsVision: true, SupportsReasoning: true,
    OfficialDocUrl: 'https://platform.openai.com/docs/models',
  },
  {
    Provider: 'OpenAI', ModelId: 'gpt-5.4',
    DisplayName: 'GPT-5.4', Platform: 'OpenAI API',
    ProviderModelFamily: 'GPT', Status: 'active',
    VerificationStatus: 'needs_review', EndpointType: 'openai_sdk',
    SupportsStreaming: true, SupportsToolCalling: true,
    SupportsJsonMode: true, SupportsVision: true,
    OfficialDocUrl: 'https://platform.openai.com/docs/models',
  },
  {
    Provider: 'OpenAI', ModelId: 'gpt-5.4-mini',
    DisplayName: 'GPT-5.4 Mini', Platform: 'OpenAI API',
    ProviderModelFamily: 'GPT', Status: 'active',
    VerificationStatus: 'needs_review', EndpointType: 'openai_sdk',
    SupportsStreaming: true, SupportsToolCalling: true,
    SupportsJsonMode: true,
    OfficialDocUrl: 'https://platform.openai.com/docs/models',
  },
  {
    Provider: 'OpenAI', ModelId: 'gpt-5.4-nano',
    DisplayName: 'GPT-5.4 Nano', Platform: 'OpenAI API',
    ProviderModelFamily: 'GPT', Status: 'active',
    VerificationStatus: 'needs_review', EndpointType: 'openai_sdk',
    SupportsStreaming: true, SupportsToolCalling: true,
    OfficialDocUrl: 'https://platform.openai.com/docs/models',
  },

  // xAI / Grok
  {
    Provider: 'xAI', ModelId: 'grok-4.3',
    DisplayName: 'Grok 4.3', Platform: 'Vertex AI',
    ProviderModelFamily: 'Grok', Status: 'active',
    VerificationStatus: 'needs_review', EndpointType: 'vertex_maas',
    DefaultRegion: 'us-central1', SupportsStreaming: true,
    SupportsToolCalling: true, SupportsVision: true,
    ContextWindowTokens: 2000000,
    OfficialDocUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-grok',
  },
  {
    Provider: 'xAI', ModelId: 'grok-4.20-reasoning',
    DisplayName: 'Grok 4.20 Reasoning', Platform: 'Vertex AI',
    ProviderModelFamily: 'Grok', Status: 'active',
    VerificationStatus: 'needs_review', EndpointType: 'vertex_maas',
    DefaultRegion: 'us-central1', SupportsStreaming: true,
    SupportsToolCalling: true, SupportsReasoning: true,
    ContextWindowTokens: 2000000,
    OfficialDocUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-grok',
  },
  {
    Provider: 'xAI', ModelId: 'grok-4.20-non-reasoning',
    DisplayName: 'Grok 4.20 Non-Reasoning', Platform: 'Vertex AI',
    ProviderModelFamily: 'Grok', Status: 'active',
    VerificationStatus: 'needs_review', EndpointType: 'vertex_maas',
    DefaultRegion: 'us-central1', SupportsStreaming: true,
    SupportsToolCalling: true,
    ContextWindowTokens: 2000000,
    OfficialDocUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-grok',
  },
  {
    Provider: 'xAI', ModelId: 'grok-4.1-fast-reasoning',
    DisplayName: 'Grok 4.1 Fast Reasoning', Platform: 'Vertex AI',
    ProviderModelFamily: 'Grok', Status: 'active',
    VerificationStatus: 'needs_review', EndpointType: 'vertex_maas',
    DefaultRegion: 'us-central1', SupportsStreaming: true,
    SupportsReasoning: true,
    OfficialDocUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-grok',
  },

  // DeepSeek
  {
    Provider: 'DeepSeek', ModelId: 'deepseek-v3.2-maas',
    DisplayName: 'DeepSeek V3.2 MaaS', Platform: 'Vertex AI',
    ProviderModelFamily: 'DeepSeek', Status: 'active',
    VerificationStatus: 'needs_review', EndpointType: 'vertex_maas',
    DefaultRegion: 'us-central1', SupportsStreaming: true,
    SupportsToolCalling: true, SupportsReasoning: true,
    ContextWindowTokens: 163840,
    DataBoundaryNotes: 'MaaS APIs on Google Cloud are structurally isolated with zero outbound internet access',
    OfficialDocUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-deepseek',
  },
  {
    Provider: 'DeepSeek', ModelId: 'deepseek-r1-0528-maas',
    DisplayName: 'DeepSeek R1 0528 MaaS', Platform: 'Vertex AI',
    ProviderModelFamily: 'DeepSeek', Status: 'active',
    VerificationStatus: 'needs_review', EndpointType: 'vertex_maas',
    DefaultRegion: 'us-central1', SupportsStreaming: true,
    SupportsReasoning: true,
    ContextWindowTokens: 163840,
    DataBoundaryNotes: 'MaaS APIs on Google Cloud are structurally isolated with zero outbound internet access',
    OfficialDocUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-deepseek',
  },
  {
    Provider: 'DeepSeek', ModelId: 'deepseek-v3.1-maas',
    DisplayName: 'DeepSeek V3.1 MaaS', Platform: 'Vertex AI',
    ProviderModelFamily: 'DeepSeek', Status: 'active',
    VerificationStatus: 'needs_review', EndpointType: 'vertex_maas',
    DefaultRegion: 'us-central1', SupportsStreaming: true,
    SupportsToolCalling: true,
    OfficialDocUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-deepseek',
  },
  {
    Provider: 'DeepSeek', ModelId: 'deepseek-ocr-maas',
    DisplayName: 'DeepSeek OCR MaaS', Platform: 'Vertex AI',
    ProviderModelFamily: 'DeepSeek', Status: 'active',
    VerificationStatus: 'needs_review', EndpointType: 'vertex_maas',
    DefaultRegion: 'us-central1', SupportsVision: true,
    OfficialDocUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-deepseek',
  },
];

// ═══════════════════════════════════════════════════════════════════
// Seed Source Records
// ═══════════════════════════════════════════════════════════════════

const SEED_SOURCES = [
  { Provider: 'Google', ModelId: 'gemini-3.5-flash', SourceUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/learn/models', SourceTitle: 'Gemini models on Vertex AI', SourceType: 'official_doc' },
  { Provider: 'Google', ModelId: 'gemini-3.1-pro', SourceUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/learn/models', SourceTitle: 'Gemini models on Vertex AI', SourceType: 'official_doc' },
  { Provider: 'Google', ModelId: 'gemini-deep-think', SourceUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/learn/models', SourceTitle: 'Gemini models on Vertex AI', SourceType: 'official_doc' },
  { Provider: 'Google', ModelId: 'gemini-3.1-flash-lite', SourceUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/learn/models', SourceTitle: 'Gemini models on Vertex AI', SourceType: 'official_doc' },
  { Provider: 'Anthropic', ModelId: 'claude-opus-4-6', SourceUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-claude', SourceTitle: 'Claude on Vertex AI', SourceType: 'official_doc' },
  { Provider: 'Anthropic', ModelId: 'claude-sonnet-4-6', SourceUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-claude', SourceTitle: 'Claude on Vertex AI', SourceType: 'official_doc' },
  { Provider: 'Anthropic', ModelId: 'claude-haiku-4-5@20251001', SourceUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-claude', SourceTitle: 'Claude on Vertex AI', SourceType: 'official_doc' },
  { Provider: 'OpenAI', ModelId: 'gpt-5.5', SourceUrl: 'https://platform.openai.com/docs/models', SourceTitle: 'OpenAI Models', SourceType: 'official_doc' },
  { Provider: 'OpenAI', ModelId: 'gpt-5.4', SourceUrl: 'https://platform.openai.com/docs/models', SourceTitle: 'OpenAI Models', SourceType: 'official_doc' },
  { Provider: 'OpenAI', ModelId: 'gpt-5.4-mini', SourceUrl: 'https://platform.openai.com/docs/models', SourceTitle: 'OpenAI Models', SourceType: 'official_doc' },
  { Provider: 'OpenAI', ModelId: 'gpt-5.4-nano', SourceUrl: 'https://platform.openai.com/docs/models', SourceTitle: 'OpenAI Models', SourceType: 'official_doc' },
  { Provider: 'xAI', ModelId: 'grok-4.3', SourceUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-grok', SourceTitle: 'Grok on Vertex AI', SourceType: 'official_doc' },
  { Provider: 'xAI', ModelId: 'grok-4.20-reasoning', SourceUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-grok', SourceTitle: 'Grok on Vertex AI', SourceType: 'official_doc' },
  { Provider: 'xAI', ModelId: 'grok-4.20-non-reasoning', SourceUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-grok', SourceTitle: 'Grok on Vertex AI', SourceType: 'official_doc' },
  { Provider: 'xAI', ModelId: 'grok-4.1-fast-reasoning', SourceUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-grok', SourceTitle: 'Grok on Vertex AI', SourceType: 'official_doc' },
  { Provider: 'DeepSeek', ModelId: 'deepseek-v3.2-maas', SourceUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-deepseek', SourceTitle: 'DeepSeek on Vertex AI', SourceType: 'official_doc' },
  { Provider: 'DeepSeek', ModelId: 'deepseek-r1-0528-maas', SourceUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-deepseek', SourceTitle: 'DeepSeek on Vertex AI', SourceType: 'official_doc' },
  { Provider: 'DeepSeek', ModelId: 'deepseek-v3.1-maas', SourceUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-deepseek', SourceTitle: 'DeepSeek on Vertex AI', SourceType: 'official_doc' },
  { Provider: 'DeepSeek', ModelId: 'deepseek-ocr-maas', SourceUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-deepseek', SourceTitle: 'DeepSeek on Vertex AI', SourceType: 'official_doc' },
];

// ═══════════════════════════════════════════════════════════════════
// Seed execution
// ═══════════════════════════════════════════════════════════════════

async function seed() {
  console.log(`\n🌱 Seeding Model Registry into ${INSTANCE_ID}/${DATABASE_ID}...\n`);

  // 1. Upsert model records — normalize all rows to same column set
  const modelTable = database.table('ModelRegistry');
  
  // All possible columns for ModelRegistry (Spanner requires all rows in a batch to have same columns)
  const MODEL_COLUMNS = [
    'Provider', 'ModelId', 'DisplayName', 'Platform', 'ProviderModelFamily',
    'Status', 'VerificationStatus', 'EndpointType', 'DefaultRegion',
    'SupportsRegionalEndpoints', 'SupportsGlobalEndpoint', 'SupportsBatch',
    'SupportsStreaming', 'SupportsToolCalling', 'SupportsJsonMode',
    'SupportsVision', 'SupportsAudio', 'SupportsVideo', 'SupportsReasoning',
    'ContextWindowTokens', 'MaxOutputTokens',
    'RoutingNotes', 'AvailabilityNotes', 'DataBoundaryNotes', 'VersioningNotes',
    'OfficialDocUrl', 'VerifiedAt', 'SourceHash',
    'CreatedAt', 'UpdatedAt',
  ];

  const modelRows = SEED_MODELS.map(m => {
    const row: Record<string, any> = {};
    for (const col of MODEL_COLUMNS) {
      row[col] = (m as any)[col] ?? null;
    }
    row.CreatedAt = Spanner.COMMIT_TIMESTAMP;
    row.UpdatedAt = Spanner.COMMIT_TIMESTAMP;
    return row;
  });

  console.log(`  📦 Upserting ${modelRows.length} model records...`);
  // Batch in groups of 10 to stay under mutation limits
  for (let i = 0; i < modelRows.length; i += 10) {
    const batch = modelRows.slice(i, i + 10);
    await modelTable.upsert(batch);
    console.log(`     ✓ Batch ${Math.floor(i / 10) + 1}: ${batch.length} records`);
  }

  // 2. Upsert source records
  const sourceTable = database.table('ModelSources');
  const sourceRows = SEED_SOURCES.map(s => ({
    ...s,
    Confidence: 0.9,
    CreatedAt: Spanner.COMMIT_TIMESTAMP,
  }));

  console.log(`  📎 Upserting ${sourceRows.length} source records...`);
  for (let i = 0; i < sourceRows.length; i += 10) {
    const batch = sourceRows.slice(i, i + 10);
    await sourceTable.upsert(batch);
    console.log(`     ✓ Batch ${Math.floor(i / 10) + 1}: ${batch.length} records`);
  }

  console.log(`\n✅ Seed complete: ${SEED_MODELS.length} models, ${SEED_SOURCES.length} sources\n`);
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Seed failed:', err);
    process.exit(1);
  });
