import { edgeDb } from "../db/spanner";
import { logger } from "../utils/logger";

// Helper to determine win/loss/push/half-win/half-loss for Soccer
export function determineSoccerResult(
  homeScore: number, 
  awayScore: number, 
  market: string, 
  side: string, 
  line: number | null
): 'win' | 'loss' | 'push' | 'half-win' | 'half-loss' {
  if (market === 'h2h' || market === 'composite') {
    const homeWon = homeScore > awayScore;
    const tie = homeScore === awayScore;
    const awayWon = homeScore < awayScore;
    
    if (tie) {
       // draw is a real outcome in 3-way soccer h2h
       if (side.toLowerCase() === 'draw') return 'win';
       return 'loss';
    } else if (homeWon) {
       if (side.toLowerCase() === 'home' || side.toLowerCase().includes('home')) return 'win';
       return 'loss';
    } else if (awayWon) {
       if (side.toLowerCase() === 'away' || side.toLowerCase().includes('away')) return 'win';
       return 'loss';
    }
  }

  if ((market === 'totals' || market === 'alternate_totals') && line !== null) {
    const total = homeScore + awayScore;
    const diff = total - line;
    
    if (diff === 0) return 'push';
    
    if (side.toLowerCase() === 'over') {
      if (diff >= 0.5) return 'win';
      if (diff <= -0.5) return 'loss';
      if (diff === 0.25) return 'half-win';
      if (diff === -0.25) return 'half-loss';
    } else if (side.toLowerCase() === 'under') {
      if (diff <= -0.5) return 'win';
      if (diff >= 0.5) return 'loss';
      if (diff === -0.25) return 'half-win';
      if (diff === 0.25) return 'half-loss';
    }
  }

  if ((market === 'spreads' || market === 'alternate_spreads') && line !== null) {
    const isHome = side.toLowerCase() === 'home' || side.toLowerCase().includes('home');
    const isAway = side.toLowerCase() === 'away' || side.toLowerCase().includes('away');
    
    let diff = 0;
    if (isHome) {
      diff = (homeScore + line) - awayScore;
    } else if (isAway) {
      diff = (awayScore + line) - homeScore;
    } else {
      return 'push'; // unrecognized side
    }

    if (diff === 0) return 'push';
    if (diff >= 0.5) return 'win';
    if (diff <= -0.5) return 'loss';
    if (diff === 0.25) return 'half-win';
    if (diff === -0.25) return 'half-loss';
  }

  return 'push'; // Default fallback for unsupported markers
}

export async function runSoccerSettlement(): Promise<{ gamesSettled: number; outcomesSettled: number }> {
  logger.info({ msg: "Starting Soccer Settlement Worker" });
  let gamesSettled = 0;
  let outcomesSettled = 0;

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    logger.warn({ msg: "ODDS_API_KEY is not configured. Skipping Odds API soccer settlement fetch." });
    return { gamesSettled, outcomesSettled };
  }

  try {
    // 1. Fetch completed events
    const daysFrom = 3;
    const scoresUrl = `https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup/scores/?daysFrom=${daysFrom}&apiKey=${apiKey}`;
    const scoresRes = await fetch(scoresUrl);
    
    if (!scoresRes.ok) {
      logger.warn({ msg: "Odds API soccer scores fetch failed", status: scoresRes.status });
      return { gamesSettled, outcomesSettled };
    }
    
    const scoresData = await scoresRes.json();
    if (!Array.isArray(scoresData) || scoresData.length === 0) {
       logger.info({ msg: "No recent soccer games found for settlement." });
       return { gamesSettled, outcomesSettled };
    }

    const completedGames = scoresData.filter((game: any) => game.completed === true && game.scores !== null);
    
    if (completedGames.length === 0) {
       logger.info({ msg: "no completed games — graceful exit" });
       return { gamesSettled, outcomesSettled };
    }

    for (const game of completedGames) {
      const homeScoreObj = game.scores?.find((s: any) => s.name === game.home_team);
      const awayScoreObj = game.scores?.find((s: any) => s.name === game.away_team);

      if (!homeScoreObj || !awayScoreObj) continue;

      const homeScore = parseInt(homeScoreObj.score, 10);
      const awayScore = parseInt(awayScoreObj.score, 10);

      if (isNaN(homeScore) || isNaN(awayScore)) continue;

      try {
        await edgeDb.runTransactionAsync(async (transaction) => {
          // 2. Find Pending Ledger Positions
          const [pendingOutcomes] = await transaction.run({
            sql: `SELECT PickId, EventId, Market, Side, EntryPrice, Contracts, Line, MaxPayout 
                  FROM PickLedger 
                  WHERE EventId = @eventId AND Result = 'pending'`,
            params: { eventId: game.id },
            types: { eventId: 'string' }
          });

          if (pendingOutcomes.length === 0) {
             // Let's also update the SoccerGames status to 'completed' and set scores
             await transaction.runUpdate({
               sql: `UPDATE SoccerGames SET Status = 'completed', HomeScore = @homeScore, AwayScore = @awayScore WHERE EventId = @eventId AND Status != 'completed'`,
               params: { homeScore, awayScore, eventId: game.id },
               types: { homeScore: 'int64', awayScore: 'int64', eventId: 'string' }
             });
             await transaction.commit();
             return;
          }

          // 3. Execute Auto-Grading (DML Updates)
          for (const pick of pendingOutcomes as any[]) {
            const result = determineSoccerResult(homeScore, awayScore, pick.Market, pick.Side, pick.Line ?? null);
            
            // Calculate 0-1 contract model PnL
            let pnl = 0.0;
            const cost = pick.EntryPrice * pick.Contracts;
            const maxPayout = pick.MaxPayout || pick.Contracts;
            
            if (result === 'win') {
              pnl = maxPayout - cost;
            } else if (result === 'loss') {
              pnl = -cost;
            } else if (result === 'push') {
              pnl = 0.0;
            } else if (result === 'half-win') {
              pnl = (maxPayout - cost) / 2.0;
            } else if (result === 'half-loss') {
              pnl = -cost / 2.0;
            }
            
            await transaction.runUpdate({
              sql: `UPDATE PickLedger 
                    SET Result = @result, SettledAt = PENDING_COMMIT_TIMESTAMP(), SettledPnL = @pnl 
                    WHERE PickId = @pickId AND EventId = @eventId AND Result = 'pending'`,
              params: {
                result,
                pnl,
                pickId: pick.PickId,
                eventId: pick.EventId
              },
              types: {
                result: 'string',
                pnl: 'float64',
                pickId: 'string',
                eventId: 'string'
              }
            });
            outcomesSettled++;
          }
          
          // Also update SoccerGames table to 'completed'
          await transaction.runUpdate({
            sql: `UPDATE SoccerGames SET Status = 'completed', HomeScore = @homeScore, AwayScore = @awayScore WHERE EventId = @eventId AND Status != 'completed'`,
            params: { homeScore, awayScore, eventId: game.id },
            types: { homeScore: 'int64', awayScore: 'int64', eventId: 'string' }
          });

          await transaction.commit();
          gamesSettled++;
        });
      } catch (err: any) {
        logger.error({ msg: `Failed settlement transaction for game ${game.id}`, error: err.message });
      }
    }

    logger.info({ msg: "Soccer Settlement complete", gamesSettled, outcomesSettled });

  } catch (err: any) {
    logger.error({ msg: "Failed soccer settlement worker", error: err.message });
  }

  return { gamesSettled, outcomesSettled };
}
