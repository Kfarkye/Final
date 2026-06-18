/**
 * Orchestration Runtime V1 — Deterministic state machine for agent delegation
 * 
 * Architecture (locked by GPT review):
 * - Head decides WHAT to delegate via typed delegate_task tool calls
 * - Backend controls HOW delegation executes (this file)
 * - Parallel independent handoffs supported
 * - Two-gate audit: evidence audit + final-output audit
 * - Specialists receive narrow permissions — no recursive delegation
 * - render_ready is derived, never stored
 * - Evidence is first-class and traceable
 * 
 * This is ADDITIVE — does not modify existing streaming, tool dispatch, or model routing.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  type OrchestrationState,
  type Delegation,
  type CompletedTask,
  type DelegationRole,
  type SchemaName,
  type ExecutionMode,
  type AgentTaskEvent,
  type TaskPolicy,
  type RequestComplexity,
  type OrchestrationEvent,
  type EvidenceReference,
  validateStructure,
  validateSemantics,
  isRenderReady,
  ROLE_FALLBACKS,
  ROLE_REQUIRED,
  ROLE_PROMPTS,
  TASK_POLICIES,
} from './orchestration-schemas.js';

// ═══════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════

const SPECIALIST_TIMEOUT_MS = 30_000;

// ═══════════════════════════════════════════════════════════════
// Logging
// ═══════════════════════════════════════════════════════════════

const log = {
  info: (event: string, data?: any) => console.log(`[orchestration] ${event}`, data ? JSON.stringify(data) : ''),
  warn: (event: string, data?: any) => console.warn(`[orchestration] ${event}`, data ? JSON.stringify(data) : ''),
  error: (event: string, data?: any) => console.error(`[orchestration] ${event}`, data ? JSON.stringify(data) : ''),
};

// ═══════════════════════════════════════════════════════════════
// Injected Interfaces — provided by enterprise-chat-handler
// ═══════════════════════════════════════════════════════════════

export interface SpecialistCaller {
  /** Call a specialist model (non-streaming, JSON mode). Returns raw text. */
  call(model: string, systemPrompt: string, userPrompt: string, signal?: AbortSignal): Promise<string>;
  /** Check if a model is available (has API key configured) */
  isAvailable(model: string): boolean;
}

export interface ActivityEmitter {
  emit(event: AgentTaskEvent): void;
}

export interface EventLogger {
  append(event: OrchestrationEvent): void;
}

// ═══════════════════════════════════════════════════════════════
// Execution Mode Resolver
// ═══════════════════════════════════════════════════════════════

export function resolveExecutionMode(targetModels: string[], explicitMode?: string): ExecutionMode {
  // Collaboration mode: fully deterministic. No model selection.
  // The system assigns the optimal model for each role.
  if (explicitMode === 'collab' || explicitMode === 'collaboration') {
    return {
      mode: 'collaboration',
      head_model: 'gemini',       // best tool use + grounded search
      role_assignments: {
        research: 'gemini',       // grounded, tool-backed fact verification
        audit: 'claude',          // most careful, strictest evidence checking
        pressure_test: 'grok',    // most contrarian, market-aware
        synthesis: 'gemini',      // head always synthesizes
      },
    };
  }

  // Single model: use whatever the user selected (or default)
  return {
    mode: 'single_model',
    selected_model: targetModels[0] || 'gemini',
    passes: ['plan', 'research', 'challenge', 'audit', 'render'],
  };
}

// ═══════════════════════════════════════════════════════════════
// State Management
// ═══════════════════════════════════════════════════════════════

export function createState(requestId: string, mode: ExecutionMode): OrchestrationState {
  const now = new Date().toISOString();
  return {
    request_id: requestId,
    mode,
    stage: 'planning',
    delegations: [],
    completed_tasks: [],
    blocking_tasks: [],
    evidence_registry: [],
    created_at: now,
    updated_at: now,
  };
}

function updateState(state: OrchestrationState, updates: Partial<OrchestrationState>): OrchestrationState {
  return { ...state, ...updates, updated_at: new Date().toISOString() };
}

// ═══════════════════════════════════════════════════════════════
// Model Resolution — capability-based fallback
// ═══════════════════════════════════════════════════════════════

function resolveModel(
  role: DelegationRole,
  preference: string | undefined,
  caller: SpecialistCaller,
): { model: string | null; fallback: boolean; note?: string } {
  // Try the preferred model first
  const preferred = preference || ROLE_FALLBACKS[role][0];
  if (caller.isAvailable(preferred)) {
    return { model: preferred, fallback: false };
  }

  // Walk the fallback chain for this role
  for (const candidate of ROLE_FALLBACKS[role]) {
    if (candidate !== preferred && caller.isAvailable(candidate)) {
      return {
        model: candidate,
        fallback: true,
        note: `${role} reassigned from ${preferred} to ${candidate}`,
      };
    }
  }

  // No model available for this role
  if (ROLE_REQUIRED[role]) {
    return { model: null, fallback: true, note: `${role} blocked — no available model` };
  }
  return { model: null, fallback: true, note: `${role} skipped — optional and no model available` };
}

// ═══════════════════════════════════════════════════════════════
// Core: Execute a single delegation
// ═══════════════════════════════════════════════════════════════

export async function executeDelegation(
  state: OrchestrationState,
  delegationArgs: {
    role: DelegationRole;
    model_preference?: string;
    objective: string;
    required_output_schema: SchemaName;
    inputs?: Record<string, any>;
  },
  policy: TaskPolicy,
  caller: SpecialistCaller,
  emitter: ActivityEmitter,
  eventLog: EventLogger,
  signal?: AbortSignal,
): Promise<{ state: OrchestrationState; result: any }> {

  const seq = state.delegations.length;

  // ── Guard: budget ──
  if (state.delegations.length >= policy.max_delegations) {
    const msg = `Delegation budget exhausted (${policy.max_delegations} max)`;
    log.warn('budget_exhausted', { request_id: state.request_id, max: policy.max_delegations });
    eventLog.append({
      request_id: state.request_id, sequence: seq, event_type: 'budget_exhausted',
      payload: { max: policy.max_delegations }, created_at: new Date().toISOString(),
    });
    return { state, result: { error: msg, validation: 'invalid' } };
  }

  // ── Resolve model with capability fallback ──
  const resolution = resolveModel(delegationArgs.role, delegationArgs.model_preference, caller);

  if (!resolution.model) {
    log.warn('model_resolution_failed', { role: delegationArgs.role, note: resolution.note });
    emitter.emit({
      event: 'agent_task_failed',
      agent: delegationArgs.model_preference || 'unknown',
      label: resolution.note || `${delegationArgs.role} unavailable`,
    });
    eventLog.append({
      request_id: state.request_id, sequence: seq, event_type: 'model_unavailable',
      agent: delegationArgs.model_preference, payload: { role: delegationArgs.role, note: resolution.note },
      created_at: new Date().toISOString(),
    });
    return { state, result: { error: resolution.note, validation: 'invalid', skipped: !ROLE_REQUIRED[delegationArgs.role] } };
  }

  // ── Create delegation record ──
  const taskId = `task_${uuidv4().slice(0, 8)}`;
  const delegation: Delegation = {
    task_id: taskId,
    role: delegationArgs.role,
    model_preference: delegationArgs.model_preference || resolution.model,
    model_used: resolution.model,
    objective: delegationArgs.objective,
    required_output_schema: delegationArgs.required_output_schema,
    inputs: delegationArgs.inputs || {},
    approved_tools: [], // V1: specialists don't get tools, only context
    status: 'queued',
    validation: 'pending',
    started_at: new Date().toISOString(),
  };

  state = updateState(state, {
    delegations: [...state.delegations, delegation],
    stage: delegationArgs.role === 'audit' ? 'evidence_audit' : 'delegating',
  });

  // ── Emit SSE: task started ──
  const label = buildActivityLabel(delegationArgs.role, delegationArgs.objective);
  emitter.emit({ event: 'agent_task_started', agent: resolution.model, label, task_id: taskId });

  if (resolution.fallback && resolution.note) {
    emitter.emit({ event: 'agent_task_started', agent: resolution.model, label: resolution.note, task_id: taskId });
  }

  eventLog.append({
    request_id: state.request_id, sequence: seq, event_type: 'delegation_started',
    task_id: taskId, agent: resolution.model,
    payload: { role: delegationArgs.role, objective: delegationArgs.objective, fallback: resolution.fallback },
    created_at: new Date().toISOString(),
  });

  // ── Update status ──
  delegation.status = 'running';

  // ── Build specialist prompt (narrow — only relevant context) ──
  const systemPrompt = ROLE_PROMPTS[delegationArgs.role];
  const userPrompt = buildSpecialistPrompt(
    delegationArgs.objective,
    delegationArgs.inputs,
    delegationArgs.required_output_schema,
  );

  // ── Execute with retry ──
  let result: any = null;
  let validationStatus: 'valid' | 'invalid' = 'invalid';
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= policy.max_retries_per_task; attempt++) {
    try {
      if (signal?.aborted) throw new Error('Aborted');

      const startMs = Date.now();
      const rawResponse = await Promise.race([
        caller.call(resolution.model, systemPrompt, userPrompt, signal),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Specialist timeout (${SPECIALIST_TIMEOUT_MS}ms)`)), SPECIALIST_TIMEOUT_MS)
        ),
      ]);
      const durationMs = Date.now() - startMs;

      // ── Parse JSON ──
      result = parseSpecialistResponse(rawResponse);
      if (!result) {
        lastError = 'Failed to parse specialist response as JSON';
        log.warn('parse_failed', { taskId, attempt, model: resolution.model });
        if (attempt < policy.max_retries_per_task) continue;
        break;
      }

      // ── Structural validation ──
      const structural = validateStructure(result, delegationArgs.required_output_schema);
      if (!structural.valid) {
        lastError = `Missing fields: ${structural.missing.join(', ')}`;
        log.warn('structural_validation_failed', { taskId, attempt, missing: structural.missing });
        if (attempt < policy.max_retries_per_task) continue;
        break;
      }

      // ── Semantic validation ──
      const semanticIssues = validateSemantics(result, delegationArgs.required_output_schema, state);
      if (semanticIssues.length > 0) {
        log.warn('semantic_issues', { taskId, issues: semanticIssues });
        // Semantic issues are warnings, not blocking (V1)
      }

      validationStatus = 'valid';

      // ── Record success ──
      delegation.status = 'succeeded';
      delegation.validation = validationStatus;
      delegation.completed_at = new Date().toISOString();
      delegation.duration_ms = durationMs;
      delegation.result = result;

      // ── Register evidence from research specialists ──
      if (result.evidence && Array.isArray(result.evidence)) {
        state = updateState(state, {
          evidence_registry: [...state.evidence_registry, ...result.evidence],
        });
      }

      // ── Record audit verdict if this was an audit task ──
      if (delegationArgs.role === 'audit') {
        const isEvidence = delegationArgs.required_output_schema === 'AuditVerdictV1';
        const isFinal = delegationArgs.required_output_schema === 'FinalResponseAuditV1';
        if (isEvidence) {
          state = updateState(state, { audit_verdict: result.verdict, audit_task_id: taskId });
        } else if (isFinal) {
          state = updateState(state, { final_audit_verdict: result.verdict, final_audit_task_id: taskId });
        }
      }

      const completedTask: CompletedTask = {
        task_id: taskId,
        role: delegationArgs.role,
        model_used: resolution.model,
        result,
        validation: validationStatus,
        duration_ms: durationMs,
      };

      state = updateState(state, {
        completed_tasks: [...state.completed_tasks, completedTask],
        delegations: state.delegations.map(d => d.task_id === taskId ? delegation : d),
      });

      emitter.emit({ event: 'agent_task_completed', agent: resolution.model, task_id: taskId, duration_ms: durationMs });

      eventLog.append({
        request_id: state.request_id, sequence: seq, event_type: 'delegation_completed',
        task_id: taskId, agent: resolution.model,
        payload: { role: delegationArgs.role, durationMs, validation: validationStatus, semanticIssues },
        created_at: new Date().toISOString(),
      });

      log.info('delegation_completed', { taskId, role: delegationArgs.role, model: resolution.model, durationMs, validationStatus });
      break;

    } catch (err: any) {
      lastError = err.message;
      if (err.message === 'Aborted' || signal?.aborted) {
        delegation.status = 'blocked';
        delegation.error = 'Aborted by user';
        break;
      }
      log.error('delegation_error', { taskId, attempt, error: err.message });
    }
  }

  // ── Handle failure ──
  if (delegation.status !== 'succeeded') {
    delegation.status = delegation.status === 'blocked' ? 'blocked' : 'failed';
    delegation.validation = 'invalid';
    delegation.error = lastError;
    delegation.completed_at = new Date().toISOString();

    state = updateState(state, {
      blocking_tasks: ROLE_REQUIRED[delegationArgs.role]
        ? [...state.blocking_tasks, taskId]
        : state.blocking_tasks,
      delegations: state.delegations.map(d => d.task_id === taskId ? delegation : d),
    });

    emitter.emit({
      event: 'agent_task_failed',
      agent: resolution.model,
      task_id: taskId,
      reason: lastError,
    });

    eventLog.append({
      request_id: state.request_id, sequence: seq, event_type: 'delegation_failed',
      task_id: taskId, agent: resolution.model,
      payload: { role: delegationArgs.role, error: lastError, required: ROLE_REQUIRED[delegationArgs.role] },
      created_at: new Date().toISOString(),
    });

    return { state, result: { error: lastError, validation: 'invalid', partial: result } };
  }

  return { state, result };
}

// ═══════════════════════════════════════════════════════════════
// Batch Execution — parallel independent delegations
// ═══════════════════════════════════════════════════════════════

export async function executeDelegationBatch(
  state: OrchestrationState,
  delegations: {
    role: DelegationRole;
    model_preference?: string;
    objective: string;
    required_output_schema: SchemaName;
    inputs?: Record<string, any>;
  }[],
  policy: TaskPolicy,
  caller: SpecialistCaller,
  emitter: ActivityEmitter,
  eventLog: EventLogger,
  signal?: AbortSignal,
): Promise<{ state: OrchestrationState; results: any[] }> {

  // Limit concurrency
  const maxParallel = Math.min(delegations.length, policy.max_parallel || 2);
  const results: any[] = [];
  let currentState = state;

  // Execute in batches of maxParallel
  for (let i = 0; i < delegations.length; i += maxParallel) {
    const batch = delegations.slice(i, i + maxParallel);
    const batchResults = await Promise.all(
      batch.map(d => executeDelegation(currentState, d, policy, caller, emitter, eventLog, signal))
    );

    // Merge states — take the latest state, accumulate results
    for (const br of batchResults) {
      currentState = br.state;
      results.push(br.result);
    }
  }

  return { state: currentState, results };
}

// ═══════════════════════════════════════════════════════════════
// Orchestration Summary
// ═══════════════════════════════════════════════════════════════

export function emitSummary(state: OrchestrationState, emitter: ActivityEmitter): void {
  const modelsUsed = new Set(state.completed_tasks.map(t => t.model_used));
  const agentsUsed = modelsUsed.size;
  const sourcesVerified = state.evidence_registry.length;
  const auditPassed = state.audit_verdict !== 'BLOCK' && state.final_audit_verdict !== 'BLOCK';

  // Build fallback note
  const fallbacks = state.delegations
    .filter(d => d.model_used !== d.model_preference)
    .map(d => `${d.role} reassigned`);
  const skipped = state.delegations
    .filter(d => d.status === 'failed' && !ROLE_REQUIRED[d.role])
    .map(d => `${d.role} skipped`);
  const fallbackNote = [...fallbacks, ...skipped].join(' · ') || undefined;

  emitter.emit({
    event: 'orchestration_summary',
    agents_used: agentsUsed,
    sources_verified: sourcesVerified,
    audit_passed: auditPassed,
    fallback_note: fallbackNote,
  });
}

// ═══════════════════════════════════════════════════════════════
// Task Policy Resolution
// ═══════════════════════════════════════════════════════════════

export function resolveTaskPolicy(complexity: RequestComplexity): TaskPolicy {
  return TASK_POLICIES[complexity] || TASK_POLICIES.factual;
}

// ═══════════════════════════════════════════════════════════════
// In-Memory Event Log (V1 — Spanner persistence in V2)
// ═══════════════════════════════════════════════════════════════

export function createEventLog(): EventLogger {
  const events: OrchestrationEvent[] = [];
  return {
    append(event: OrchestrationEvent) {
      events.push(event);
      log.info(`event: ${event.event_type}`, { task_id: event.task_id, agent: event.agent });
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function buildActivityLabel(role: DelegationRole, objective: string): string {
  const labels: Record<DelegationRole, string> = {
    research: 'Verifying',
    audit: 'Auditing',
    pressure_test: 'Pressure testing',
    fact_check: 'Fact checking',
  };
  const short = objective.length > 40 ? objective.slice(0, 37) + '...' : objective;
  return `${labels[role]} · ${short}`;
}

function buildSpecialistPrompt(objective: string, inputs: Record<string, any> | undefined, schema: SchemaName): string {
  let prompt = `TASK: ${objective}\n\n`;
  if (inputs && Object.keys(inputs).length > 0) {
    prompt += `CONTEXT:\n${JSON.stringify(inputs, null, 2)}\n\n`;
  }
  prompt += `REQUIRED OUTPUT: Return ONLY a valid JSON object matching the ${schema} schema.\nNo prose, no markdown fences, no explanations. Just the raw JSON object.`;
  return prompt;
}

function parseSpecialistResponse(raw: string): any | null {
  // Direct parse
  try { return JSON.parse(raw); } catch { /* continue */ }
  // Extract from markdown code block
  const jsonMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[1].trim()); } catch { /* continue */ }
  }
  // First { to last }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch { /* continue */ }
  }
  return null;
}
