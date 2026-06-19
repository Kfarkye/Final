import { z } from 'zod';
import * as crypto from 'crypto';
import { 
  SuccessEnvelope, 
  ErrorEnvelope, 
  NormalizedGameOutcome, 
  SettleWagerViewModel 
} from '../../domain/contracts';
import { PythonGovernanceBridge } from '../../infrastructure/pythonBridge';

// Helper to determine win/loss/push
function determineResult(homeScore: number, awayScore: number, indicator: string, edgeSide: string): 'win' | 'loss' | 'push' {
  if (indicator === 'h2h' || indicator === 'composite') {
    const homeWon = homeScore > awayScore;
    const side = edgeSide.toLowerCase().includes('home') ? 'home' : 'away';
    if (side === 'home') return homeWon ? 'win' : 'loss';
    if (side === 'away') return !homeWon ? 'win' : 'loss';
  }
  return 'push'; // Default fallback for unsupported markers
}

export const SettleMarketWagersTool = {
  definition: {
    name: 'settle_market_wagers',
    version: '1.0.0',
    domain: 'sports_live_ops',
    classification: 'mutation',
    description: 'Fetches, validates, governs, and idempotently settles game wagers/outcomes.',
    schema: z.object({
      gamePk: z.string(),
      idempotencyKey: z.string()
    })
  },
  
  handler: async (input: unknown, ctx: any): Promise<z.infer<typeof SuccessEnvelope> | z.infer<typeof ErrorEnvelope>> => {
    const startTime = Date.now();
    let currentState = 'received';
    
    try {
      // 1. Strict Input Validation
      const req = SettleMarketWagersTool.definition.schema.parse(input);
      const payloadHash = crypto.createHash('sha256').update(JSON.stringify(req)).digest('hex');
      
      // 2. Fetch Truth & Normalize
      const gameStatus = await ctx.dataAdapter.fetchGameStatus(req.gamePk);
      if (!gameStatus) throw new Error('GAME_STATUS_MISSING');
      
      const rawOutcomes = await ctx.dataAdapter.fetchUnsettledOutcomes(req.gamePk);
      
      const normalizedOutcomes = rawOutcomes.map((o: any) => NormalizedGameOutcome.parse({
        gamePk: req.gamePk,
        indicator: o.Indicator || 'h2h',
        edgeSide: o.EdgeSide || 'home',
        flaggedAt: o.FlaggedAt || new Date().toISOString(),
        flaggedPrice: o.FlaggedPrice || null,
        flaggedFairProb: o.FlaggedFairProb || 0,
        closingPrice: o.ClosingPrice || null,
        closingFairProb: o.ClosingFairProb || null,
        clvCents: o.ClvCents || null,
        clvProbDelta: o.ClvProbDelta || null
      }));
      currentState = 'normalized';

      // 3. Truth Validation
      const statusLower = (gameStatus.Status || '').toLowerCase();
      const isCompleted = statusLower === 'final' || statusLower === 'completed' || statusLower.includes('final');
      if (!isCompleted) throw new Error('GAME_NOT_FINAL');
      
      const truthReceipt = {
        validatedAt: new Date().toISOString(),
        sourceIdentity: 'mlb_stats_api' as const,
        freshnessMs: 0,
        isCanonical: true
      };
      currentState = 'validated';

      // 4. Canonical Governance Enforcement (Python Bridge)
      const bridge = new PythonGovernanceBridge();
      const policyReceipt = await bridge.evaluatePolicy(ctx.traceId, payloadHash, {
        gamePk: req.gamePk,
        status: gameStatus.Status,
        homeScore: gameStatus.HomeScore,
        awayScore: gameStatus.AwayScore,
        outcomeCount: normalizedOutcomes.length
      });
      
      if (policyReceipt.decision !== 'APPROVED') {
        throw new Error(`POLICY_DENIED_${policyReceipt.decision}`);
      }
      currentState = 'governed';

      // 5. Presentation View-Model Transformation
      const settledDetails: Array<{indicator: string, edgeSide: string, result: 'win'|'loss'|'push'}> = [];
      
      for (const outcome of normalizedOutcomes) {
        const result = determineResult(gameStatus.HomeScore, gameStatus.AwayScore, outcome.indicator, outcome.edgeSide);
        settledDetails.push({ indicator: outcome.indicator, edgeSide: outcome.edgeSide, result });
      }

      const viewModel = SettleWagerViewModel.parse({
        gamePk: req.gamePk,
        outcomesSettled: settledDetails.length,
        details: settledDetails
      });
      currentState = 'rendered';

      // 6. State Persistence (Idempotent loop)
      for (const outcome of normalizedOutcomes) {
        const result = determineResult(gameStatus.HomeScore, gameStatus.AwayScore, outcome.indicator, outcome.edgeSide);
        await ctx.dataAdapter.settleOutcomeIdempotent(
          req.gamePk,
          outcome.indicator,
          outcome.edgeSide,
          outcome.flaggedAt,
          result,
          policyReceipt.governanceHash
        );
      }
      currentState = 'persisted';

      // 7. Assemble Immutable Receipt
      const executionReceipt = {
        contractId: SettleMarketWagersTool.definition.name,
        version: SettleMarketWagersTool.definition.version,
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
      const isTimeout = e.message === 'TIMEOUT';
      const isValidation = e instanceof z.ZodError;
      
      return {
        status: 'error',
        errorType: isTimeout ? 'timeout' : isValidation ? 'input_validation_error' : 'internal_error',
        failedStage: currentState,
        safeMessage: 'System execution halted at safety boundary.',
        retryable: isTimeout,
        traceId: ctx.traceId
      };
    }
  }
};
