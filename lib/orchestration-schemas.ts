/**
 * Orchestration Schemas V1 — Typed contracts for the agent orchestration runtime
 * 
 * Design principles (from GPT architecture review):
 * 1. Synthesis is owned by the head — not a delegatable role
 * 2. render_ready is derived, never stored as mutable state
 * 3. Two-gate audit: evidence audit + final-output audit
 * 4. Evidence is first-class with traced IDs
 * 5. Specialists receive narrow permissions — no recursive delegation
 * 6. Parallel handoffs supported — independent tasks execute concurrently
 */

// ═══════════════════════════════════════════════════════════════
// Execution Modes
// ═══════════════════════════════════════════════════════════════

export interface SingleModelMode {
  mode: 'single_model';
  selected_model: string;
  passes: ('plan' | 'research' | 'challenge' | 'audit' | 'render')[];
}

export interface CollaborationMode {
  mode: 'collaboration';
  head_model: string;
  role_assignments: {
    research: string;
    audit: string;
    pressure_test: string;
    synthesis: string; // always the head
  };
}

export type ExecutionMode = SingleModelMode | CollaborationMode;

// ═══════════════════════════════════════════════════════════════
// Status Types — no overlapping states
// ═══════════════════════════════════════════════════════════════

/** Task execution lifecycle */
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'blocked' | 'failed';

/** Schema validation result — separate from task lifecycle */
export type ValidationStatus = 'pending' | 'valid' | 'invalid';

// ═══════════════════════════════════════════════════════════════
// Delegation — synthesis is NOT delegatable (head owns it)
// ═══════════════════════════════════════════════════════════════

export type DelegationRole = 'research' | 'audit' | 'pressure_test' | 'fact_check' | 'ui_engineer';
export type SchemaName =
  | 'ResearchEvidenceV1'
  | 'AuditVerdictV1'
  | 'MarketPressureV1'
  | 'FactCheckV1'
  | 'FinalResponseAuditV1'
  | 'DripLiveGameV1';

export interface Delegation {
  task_id: string;
  role: DelegationRole;
  model_preference: string;
  model_used: string; // actual model after fallback resolution
  objective: string;
  required_output_schema: SchemaName;
  inputs: Record<string, any>;
  approved_tools: string[]; // narrow permissions — only tools relevant to the task
  status: TaskStatus;
  validation: ValidationStatus;
  result?: any;
  error?: string;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
}

// ═══════════════════════════════════════════════════════════════
// Evidence — first-class, traceable
// ═══════════════════════════════════════════════════════════════

export interface EvidenceReference {
  evidence_id: string;
  source_type: 'web' | 'tool' | 'database' | 'document';
  source_ref: string; // tool name, URL, table name, etc.
  retrieved_at: string;
  supports: string[]; // list of claim IDs this evidence backs
}

// ═══════════════════════════════════════════════════════════════
// Orchestration State — deterministic state machine
// render_ready is DERIVED via isRenderReady(), never stored
// ═══════════════════════════════════════════════════════════════

export interface OrchestrationState {
  request_id: string;
  mode: ExecutionMode;
  stage: 'planning' | 'delegating' | 'evidence_audit' | 'synthesis' | 'final_audit' | 'render' | 'complete';
  delegations: Delegation[];
  completed_tasks: CompletedTask[];
  blocking_tasks: string[];
  evidence_registry: EvidenceReference[];
  // Audit verdict — set by the audit agent
  audit_verdict?: 'PASS' | 'BLOCK';
  audit_task_id?: string;
  // Final-output audit — second gate after head synthesis
  final_audit_verdict?: 'PASS' | 'BLOCK';
  final_audit_task_id?: string;
  created_at: string;
  updated_at: string;
}

export interface CompletedTask {
  task_id: string;
  role: string;
  model_used: string;
  result: any;
  validation: ValidationStatus;
  duration_ms: number;
}

/** Derive render readiness — never store this as mutable truth */
export function isRenderReady(state: OrchestrationState): boolean {
  // All delegations must have terminal status
  const allDone = state.delegations.every(d =>
    d.status === 'succeeded' || d.status === 'failed'
  );
  // No blocking tasks
  const noBlockers = state.blocking_tasks.length === 0;
  // Evidence audit must pass (if one was requested)
  const evidenceAuditOk = !state.audit_verdict || state.audit_verdict === 'PASS';
  // Final-output audit must pass (if one was requested)
  const finalAuditOk = !state.final_audit_verdict || state.final_audit_verdict === 'PASS';

  return allDone && noBlockers && evidenceAuditOk && finalAuditOk;
}

// ═══════════════════════════════════════════════════════════════
// Specialist Output Schemas
// ═══════════════════════════════════════════════════════════════

/** ResearchEvidenceV1 — returned by research specialists (default: Gemini) */
export interface ResearchEvidence {
  verified_facts: {
    fact: string;
    evidence_ids: string[]; // traceable to evidence_registry
    confidence: 'high' | 'medium' | 'low';
  }[];
  tool_results: {
    tool_name: string;
    status: 'validated' | 'failed' | 'skipped';
  }[];
  conflicts: string[];
  freshness: {
    checked_at: string;
    stale_sources: string[];
  };
  evidence: EvidenceReference[]; // sources discovered during research
}

/** AuditVerdictV1 — returned by evidence audit specialists (default: Claude) */
export interface AuditVerdict {
  verdict: 'PASS' | 'BLOCK';
  blocking_issues: string[];
  approved_claims: string[];
  rejected_claims: {
    claim: string;
    reason: string;
  }[];
  approved_data_blocks: string[];
  evidence_coverage: {
    total_claims: number;
    claims_with_evidence: number;
    unsupported_claims: number;
  };
}

/** FinalResponseAuditV1 — second-gate audit of the head's candidate response */
export interface FinalResponseAudit {
  verdict: 'PASS' | 'BLOCK';
  blocking_issues: string[];
  unapproved_claims: {
    claim: string;
    reason: string;
    location: string; // where in the candidate response
  }[];
  approved_for_render: boolean;
  corrections: {
    original: string;
    corrected: string;
    reason: string;
  }[];
}

/** MarketPressureV1 — returned by pressure test specialists (default: Grok) */
export interface MarketPressure {
  contrarian_view: string;
  market_context: string;
  risk_factors: string[];
  confidence_adjustment: number; // -1.0 to +1.0
}

/** FactCheckV1 — returned by fact-check specialists */
export interface FactCheck {
  claims_checked: {
    claim: string;
    verified: boolean;
    evidence_ids: string[];
    correction?: string;
  }[];
  overall_accuracy: 'high' | 'medium' | 'low';
}


/** DripLiveGameV1 — Payload for The Drip live in-game UI */
export interface DripLiveGame {
  markets: {
    total: DripMarket;
    moneyline: DripMarket;
    runline: DripMarket;
  };
  plays: DripPlay[];
  booth: DripBoothParagraph[];
}

export interface DripMarket {
  name: string;
  cells: DripMarketCell[];
  read: string;
  movement: number;
  openLine: number | null;
  liveLine: number | null;
}

export interface DripMarketCell {
  num: string;
  cap: string;
  arrow?: 'up' | 'down';
}

export interface DripPlay {
  inning: string;
  desc: string;
  scoreAfter: string | null;
  isScoring: boolean | null;
}

export interface DripBoothParagraph {
  text: string;
  type: 'lead' | 'normal' | 'aside';
}

// ═══════════════════════════════════════════════════════════════
// SSE Activity Events — emitted by backend, not model
// ═══════════════════════════════════════════════════════════════

export interface AgentTaskEvent {
  event: 'agent_task_started' | 'agent_task_completed' | 'agent_task_blocked' | 'agent_task_failed' | 'orchestration_summary';
  agent?: string;
  label?: string;
  task_id?: string;
  duration_ms?: number;
  reason?: string;
  // Summary fields
  agents_used?: number;
  sources_verified?: number;
  audit_passed?: boolean;
  fallback_note?: string; // "pressure test reassigned" or "pressure test skipped"
  drip_live_game?: DripLiveGame; // Extracted live game UI payload
}

// ═══════════════════════════════════════════════════════════════
// Schema Validation — structural + semantic
// ═══════════════════════════════════════════════════════════════

const SCHEMA_REQUIRED_FIELDS: Record<SchemaName, string[]> = {
  ResearchEvidenceV1: ['verified_facts', 'tool_results', 'conflicts', 'freshness', 'evidence'],
  AuditVerdictV1: ['verdict', 'blocking_issues', 'approved_claims', 'rejected_claims', 'approved_data_blocks', 'evidence_coverage'],
  MarketPressureV1: ['contrarian_view', 'market_context', 'risk_factors', 'confidence_adjustment'],
  FactCheckV1: ['claims_checked', 'overall_accuracy'],
  FinalResponseAuditV1: ['verdict', 'blocking_issues', 'unapproved_claims', 'approved_for_render'],
  DripLiveGameV1: ['markets', 'plays', 'booth'],
};

/** Structural validation — checks required fields exist */
export function validateStructure(result: any, schema: SchemaName): { valid: boolean; missing: string[] } {
  if (!result || typeof result !== 'object') {
    return { valid: false, missing: SCHEMA_REQUIRED_FIELDS[schema] || [] };
  }
  const required = SCHEMA_REQUIRED_FIELDS[schema];
  if (!required) return { valid: false, missing: [`Unknown schema: ${schema}`] };
  const missing = required.filter(field => !(field in result));
  return { valid: missing.length === 0, missing };
}

/** Semantic validation — checks data quality beyond structure */
export function validateSemantics(result: any, schema: SchemaName, state: OrchestrationState): string[] {
  const issues: string[] = [];

  if (schema === 'ResearchEvidenceV1' && result.verified_facts) {
    // Every high-confidence fact must have evidence IDs
    for (const fact of result.verified_facts) {
      if (fact.confidence === 'high' && (!fact.evidence_ids || fact.evidence_ids.length === 0)) {
        issues.push(`High-confidence fact "${fact.fact.slice(0, 50)}..." has no evidence IDs`);
      }
    }
    // Freshness timestamp must be valid
    if (result.freshness?.checked_at) {
      const ts = new Date(result.freshness.checked_at).getTime();
      if (isNaN(ts)) issues.push('freshness.checked_at is not a valid timestamp');
    }
  }

  if (schema === 'AuditVerdictV1' && result.evidence_coverage) {
    // Unsupported claims should block
    if (result.evidence_coverage.unsupported_claims > 0 && result.verdict === 'PASS') {
      issues.push('Verdict is PASS but unsupported_claims > 0');
    }
  }

  if (schema === 'MarketPressureV1') {
    // confidence_adjustment must be in range
    if (typeof result.confidence_adjustment === 'number') {
      if (result.confidence_adjustment < -1 || result.confidence_adjustment > 1) {
        issues.push(`confidence_adjustment ${result.confidence_adjustment} is out of [-1, 1] range`);
      }
    }
  }

  if (schema === 'FinalResponseAuditV1') {
    // If blocking issues exist, approved_for_render must be false
    if (result.blocking_issues?.length > 0 && result.approved_for_render === true) {
      issues.push('approved_for_render is true but blocking_issues exist');
    }
  }

  return issues;
}

// ═══════════════════════════════════════════════════════════════
// Task Policy — determines delegation budget by request type
// ═══════════════════════════════════════════════════════════════

export type RequestComplexity = 'trivial' | 'factual' | 'market' | 'deep_research';

export interface TaskPolicy {
  max_delegations: number;
  max_parallel: number;
  max_retries_per_task: number;
  max_final_audit_attempts: number;
  required_roles: DelegationRole[];
  optional_roles: DelegationRole[];
}

export const TASK_POLICIES: Record<RequestComplexity, TaskPolicy> = {
  trivial: {
    max_delegations: 0,
    max_parallel: 0,
    max_retries_per_task: 0,
    max_final_audit_attempts: 0,
    required_roles: [],
    optional_roles: [],
  },
  factual: {
    max_delegations: 2,
    max_parallel: 2,
    max_retries_per_task: 1,
    max_final_audit_attempts: 1,
    required_roles: ['research', 'audit'],
    optional_roles: [],
  },
  market: {
    max_delegations: 3,
    max_parallel: 2,
    max_retries_per_task: 1,
    max_final_audit_attempts: 1,
    required_roles: ['research', 'audit'],
    optional_roles: ['pressure_test'],
  },
  deep_research: {
    max_delegations: 4,
    max_parallel: 3,
    max_retries_per_task: 1,
    max_final_audit_attempts: 1,
    required_roles: ['research', 'fact_check', 'audit'],
    optional_roles: ['pressure_test'],
  },
};

// ═══════════════════════════════════════════════════════════════
// Role Fallback Matrix — capability-based, not blind
// ═══════════════════════════════════════════════════════════════

export const ROLE_FALLBACKS: Record<DelegationRole, string[]> = {
  research: ['gemini', 'chatgpt', 'claude'],
  audit: ['claude', 'chatgpt', 'gemini'],
  pressure_test: ['grok', 'chatgpt', 'claude'],
  fact_check: ['gemini', 'claude', 'chatgpt'],
  ui_engineer: ['gemini', 'claude', 'chatgpt'],
};

/** Whether a role is required or can be skipped */
export const ROLE_REQUIRED: Record<DelegationRole, boolean> = {
  research: true,   // usually required for current-info requests
  audit: true,      // required for consequential responses
  pressure_test: false, // optional — skip if unavailable
  fact_check: false,    // optional
  ui_engineer: false,   // optional — triggered specifically for UI widgets
};

// ═══════════════════════════════════════════════════════════════
// delegate_task Tool Definition
// ═══════════════════════════════════════════════════════════════

export const DELEGATE_TASK_TOOL = {
  name: 'delegate_task',
  description: 'Dispatch a subtask to a specialist agent. The backend validates authorization, resolves the model, executes the task, validates the output schema, and returns the structured result. Use this to delegate research, auditing, pressure testing, or fact checking. Do NOT delegate synthesis — that is your responsibility as the head agent.',
  parameters: {
    type: 'object' as const,
    properties: {
      role: {
        type: 'string' as const,
        enum: ['research', 'audit', 'pressure_test', 'fact_check', 'ui_engineer'],
        description: 'The specialist role to dispatch to. Synthesis is not delegatable.',
      },
      model_preference: {
        type: 'string' as const,
        enum: ['gemini', 'claude', 'grok', 'deepseek'],
        description: 'Preferred model. Backend will fallback to capable alternatives if unavailable.',
      },
      objective: {
        type: 'string' as const,
        description: 'Clear, specific task description for the specialist',
      },
      required_output_schema: {
        type: 'string' as const,
        enum: ['ResearchEvidenceV1', 'AuditVerdictV1', 'MarketPressureV1', 'FactCheckV1', 'FinalResponseAuditV1', 'DripLiveGameV1'],
        description: 'Expected output schema. Backend validates the response against this.',
      },
      inputs: {
        type: 'object' as const,
        description: 'Contextual data the specialist needs. Keep this narrow — only what is relevant to the task.',
      },
    },
    required: ['role', 'objective', 'required_output_schema'],
  },
};

// ═══════════════════════════════════════════════════════════════
// Specialist System Prompts — narrow scope, no recursive delegation
// ═══════════════════════════════════════════════════════════════

export const ROLE_PROMPTS: Record<DelegationRole, string> = {
  research: `You are a RESEARCH SPECIALIST agent in an orchestrated team.

SCOPE: Verify facts, check sources, discover evidence. Return structured evidence.
OUTPUT: Return ONLY valid JSON matching the ResearchEvidenceV1 schema. No prose.
RULES:
- Verify every fact against available tools before marking confidence as "high"
- Generate a unique evidence_id (ev_XXXX) for each source you consult
- If a source is stale (>24h for live sports), mark it in freshness.stale_sources
- You may NOT delegate to other agents
- You may NOT make claims beyond what your tools return
- You receive only the context relevant to your task, not the full conversation`,

  audit: `You are an AUDIT SPECIALIST agent in an orchestrated team.

SCOPE: Check claims for evidence backing, reject unsupported statements, verify data consistency.
OUTPUT: Return ONLY valid JSON matching the AuditVerdictV1 or FinalResponseAuditV1 schema. No prose.
RULES:
- Set verdict to "BLOCK" if ANY claim lacks evidence backing
- Count evidence coverage precisely — every claim must trace to an evidence_id
- Be strict. The renderer cannot fix bad data. You are the last gate.
- For FinalResponseAuditV1: check the candidate response against approved evidence
- You may NOT delegate to other agents
- You may NOT introduce new claims — only evaluate existing ones`,

  pressure_test: `You are a MARKET PRESSURE TEST agent in an orchestrated team.

SCOPE: Challenge the primary analysis with contrarian perspectives and market structure awareness.
OUTPUT: Return ONLY valid JSON matching the MarketPressureV1 schema. No prose.
RULES:
- Identify what the consensus is missing
- Flag risk factors the primary analysis underweights
- confidence_adjustment ranges from -1.0 (strong downgrade) to +1.0 (strong confirmation)
- You may NOT delegate to other agents
- Ground your contrarian view in market mechanics, not speculation`,

  fact_check: `You are a FACT CHECK agent in an orchestrated team.

SCOPE: Verify specific claims against available data.
OUTPUT: Return ONLY valid JSON matching the FactCheckV1 schema. No prose.
RULES:
- For each claim, check against tool outputs
- If a claim is wrong, provide the exact correction with evidence_ids
- You may NOT delegate to other agents
- You may NOT make new claims — only verify or correct existing ones`,

  ui_engineer: `You are a UI ENGINEER agent in an orchestrated team.

SCOPE: Translate verified data and state into specialized UI schema payloads for the frontend.
OUTPUT: Return ONLY valid JSON matching the requested schema (e.g., DripLiveGameV1). No prose.
RULES:
- Do NOT invent, guess, or hallucinate data. Map only what is provided in the inputs.
- You are strictly a formatter. Maintain structural fidelity.
- You may NOT delegate to other agents.`,
};

// ═══════════════════════════════════════════════════════════════
// Orchestration Event — append-only audit trail
// ═══════════════════════════════════════════════════════════════

export interface OrchestrationEvent {
  request_id: string;
  sequence: number;
  event_type: string;
  task_id?: string;
  agent?: string;
  payload: unknown;
  created_at: string;
}
