// src/services/modelRegistry.types.ts
// TypeScript interfaces mirroring the Spanner ModelRegistry schema

// ═══════════════════════════════════════════════════════════════════
// Row types — map 1:1 to Spanner tables
// ═══════════════════════════════════════════════════════════════════

export interface ModelRecord {
  Provider: string;
  ModelId: string;
  DisplayName: string | null;
  Platform: string | null;
  ProviderModelFamily: string | null;
  Status: 'active' | 'deprecated' | 'experimental' | 'unavailable' | null;
  VerificationStatus: 'verified' | 'unverified' | 'stale' | 'needs_review' | null;
  EndpointType: string | null;
  DefaultRegion: string | null;
  SupportsRegionalEndpoints: boolean | null;
  SupportsGlobalEndpoint: boolean | null;
  SupportsBatch: boolean | null;
  SupportsStreaming: boolean | null;
  SupportsToolCalling: boolean | null;
  SupportsJsonMode: boolean | null;
  SupportsVision: boolean | null;
  SupportsAudio: boolean | null;
  SupportsVideo: boolean | null;
  SupportsReasoning: boolean | null;
  ContextWindowTokens: number | null;
  MaxOutputTokens: number | null;
  RoutingNotes: string | null;
  AvailabilityNotes: string | null;
  DataBoundaryNotes: string | null;
  VersioningNotes: string | null;
  OfficialDocUrl: string | null;
  VerifiedAt: string | null;
  SourceHash: string | null;
  CreatedAt: string | null;
  UpdatedAt: string | null;
}

export interface ModelSource {
  Provider: string;
  ModelId: string;
  SourceUrl: string;
  SourceTitle: string | null;
  SourceType: 'official_doc' | 'api_response' | 'model_endpoint' | 'pricing_page' | null;
  RetrievedAt: string | null;
  ContentHash: string | null;
  Excerpt: string | null;
  Confidence: number | null;
  CreatedAt: string | null;
}

export interface ModelCapability {
  Provider: string;
  ModelId: string;
  CapabilityName: string;
  CapabilityValueString: string | null;
  CapabilityValueNumber: number | null;
  CapabilityValueBool: boolean | null;
  Unit: string | null;
  SourceUrl: string | null;
  SourceRetrievedAt: string | null;
  VerificationStatus: string | null;
  Confidence: 'official_doc' | 'inferred' | 'api_verified' | 'manual_review' | null;
  CreatedAt: string | null;
  UpdatedAt: string | null;
}

export interface ModelAlias {
  Provider: string;
  Alias: string;
  ModelId: string;
  AliasType: 'display' | 'legacy' | 'router_default' | 'sdk_alias' | null;
  IsDefault: boolean | null;
  IsDeprecated: boolean | null;
  CreatedAt: string | null;
  UpdatedAt: string | null;
}

export interface ModelPricingRecord {
  Provider: string;
  ModelId: string;
  PricingUnit: string;
  PriceUsd: number | null;
  UnitSize: number | null;
  Currency: string | null;
  Region: string;
  SourceUrl: string | null;
  RetrievedAt: string | null;
  VerificationStatus: string | null;
  CreatedAt: string | null;
  UpdatedAt: string | null;
}

export interface ModelAvailabilityRecord {
  Provider: string;
  ModelId: string;
  Platform: string;
  Region: string;
  IsAvailable: boolean | null;
  AvailabilityType: 'public' | 'preview' | 'allowlist' | 'invitation_only' | 'deprecated' | null;
  EndpointName: string | null;
  QuotaNotes: string | null;
  SourceUrl: string | null;
  RetrievedAt: string | null;
  VerificationStatus: string | null;
  CreatedAt: string | null;
  UpdatedAt: string | null;
}

export interface VerificationEvent {
  Provider: string;
  ModelId: string;
  VerificationEventId: string;
  EventType: 'doc_fetch' | 'api_check' | 'parser_update' | 'manual_review' | 'stale_detected' | null;
  EventStatus: 'success' | 'failed' | 'changed' | 'unchanged' | 'needs_review' | null;
  SourceUrl: string | null;
  RetrievedAt: string | null;
  PreviousHash: string | null;
  NewHash: string | null;
  DiffSummary: string | null;
  Notes: string | null;
  CreatedAt: string | null;
}

// ═══════════════════════════════════════════════════════════════════
// Query / Response types
// ═══════════════════════════════════════════════════════════════════

export interface ModelFilters {
  provider?: string;
  platform?: string;
  status?: string;
  verificationStatus?: string;
  capability?: string;
}

export interface ModelDetailResponse {
  model: ModelRecord;
  sources: ModelSource[];
  capabilities: ModelCapability[];
  availability: ModelAvailabilityRecord[];
  pricing: ModelPricingRecord[];
}

export interface ModelValidationResult {
  valid: boolean;
  error?: string;
  requestedTokens?: number;
  modelContextWindowTokens?: number;
  suggestedModels?: Array<{ provider: string; modelId: string; contextWindowTokens: number }>;
}

export interface ModelSearchResult {
  provider: string;
  modelId: string;
  platform: string | null;
  displayName: string | null;
  status: string | null;
  verificationStatus: string | null;
  score: number;
}

export interface ModelSearchResponse {
  query: string;
  results: ModelSearchResult[];
}
