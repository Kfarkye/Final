import { z } from 'zod';
import * as crypto from 'crypto';
import { 
  SuccessEnvelope, 
  ErrorEnvelope, 
  NormalizedLiveGame, 
  LiveGameViewModel 
} from '../../domain/contracts';
import { PythonGovernanceBridge } from '../../infrastructure/pythonBridge';

export const LiveGameUpdateTool = {
  definition: {
    name: 'update_live_game_state',
    version: '1.0.0',
    domain: 'sports_live_ops',
    classification: 'mutation',
    description: 'Fetches, normalizes, governs, and renders live game state.',
    schema: z.object({
      eventId: z.string(),
      idempotencyKey: z.string()
    })
  },
  
  handler: async (input: unknown, ctx: any): Promise<z.infer<typeof SuccessEnvelope> | z.infer<typeof ErrorEnvelope>> => {
    const startTime = Date.now();
    let currentState = 'received';
    
    try {
      // 1. Strict Input Validation
      const req = LiveGameUpdateTool.definition.schema.parse(input);
      const payloadHash = crypto.createHash('sha256').update(JSON.stringify(req)).digest('hex');
      
      // 2. Fetch Truth & Normalize
      const rawData = await ctx.dataAdapter.fetchEvent(req.eventId);
      if (!rawData) throw new Error('DATA_MISSING');
      
      const normalized = NormalizedLiveGame.parse(rawData);
      currentState = 'normalized';

      // 3. Truth & Freshness Validation
      const freshnessMs = Date.now() - new Date(rawData.updatedAt).getTime();
      if (freshnessMs > 30000) throw new Error('STALE_DATA');
      
      const truthReceipt = {
        validatedAt: new Date().toISOString(),
        sourceIdentity: 'sportradar' as const,
        freshnessMs,
        isCanonical: true
      };
      currentState = 'validated';

      // 4. Canonical Governance Enforcement (Python Bridge)
      const bridge = new PythonGovernanceBridge();
      const policyReceipt = await bridge.evaluatePolicy(ctx.traceId, payloadHash, {
        eventId: normalized.eventId,
        period: normalized.period,
        scoreDiff: Math.abs(normalized.homeTeam.score - normalized.awayTeam.score)
      });
      
      if (policyReceipt.decision !== 'APPROVED') {
        throw new Error(`POLICY_DENIED_${policyReceipt.decision}`);
      }
      currentState = 'governed';

      // 5. Presentation View-Model Transformation
      const viewModel = LiveGameViewModel.parse({
        hero: {
          homeScore: normalized.homeTeam.score,
          awayScore: normalized.awayTeam.score,
          situationStr: `${normalized.period} · ${normalized.clock}`
        },
        feed: [] // Hydrated via discrete feed adapter if needed
      });
      currentState = 'rendered';

      // 6. State Persistence
      await ctx.db.persistArtifact(req.eventId, viewModel, policyReceipt.governanceHash);
      currentState = 'persisted';

      // 7. Assemble Immutable Receipt
      const executionReceipt = {
        contractId: LiveGameUpdateTool.definition.name,
        version: LiveGameUpdateTool.definition.version,
        actorId: ctx.actorId,
        traceId: ctx.traceId,
        payloadHash,
        durationMs: Date.now() - startTime,
        resultStatus: 'COMPLETED' as const
      };
      currentState = 'completed';

      return {
        status: 'success',
        contractId: executionReceipt.contractId,
        contractVersion: executionReceipt.version,
        result: viewModel,
        truthReceipt,
        policyReceipt,
        executionReceipt,
        traceId: ctx.traceId
      };

    } catch (e: any) {
      // Map thrown errors to strict Discriminated Union ErrorEnvelope
      const isTimeout = e.message === 'TIMEOUT';
      const isValidation = e instanceof z.ZodError;
      
      return {
        status: 'error',
        errorType: isTimeout ? 'timeout' : isValidation ? 'input_validation_error' : 'internal_error',
        failedStage: currentState,
        safeMessage: 'System execution halted at safety boundary.',
        retryable: isTimeout, // Do not auto-retry validation or policy failures
        traceId: ctx.traceId
      };
    }
  }
};
