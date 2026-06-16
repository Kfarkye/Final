import { Spanner } from "@google-cloud/spanner";
import { env } from "../config/env";
import { getTeamNickname } from "../workers/odds-backfill-worker";
import { logger } from "../utils/logger";
import { randomUUID } from "crypto";

const spanner = new Spanner({ projectId: env.SPANNER_PROJECT_ID });

export interface RawMarketPayload {
  platform: 'kalshi' | 'polymarket';
  marketId: string;
  title: string;
  subtitle?: string;
  rulesText?: string;
  outcomesJson: any; // array or object of outcomes
  closeTimeUtc?: string;
  rawJson: any;
}

/**
 * Step 1: Validation Gate (Failure Mode #1)
 * Detects unrendered template variables or empty placeholders in market titles/subtitles.
 */
export function containsTemplateVariables(text: string): boolean {
  const templateRegex = /\b(awayAbbr|homeAbbr|teamName|away_team|home_team|\{\{.*?\}\}|\$\{.*?\}|%[A-Z_]+%)\b/i;
  const placeholderRegex = /\bvs\s+(tbd|\?\?\?|\.)/i;
  return templateRegex.test(text) || placeholderRegex.test(text);
}

/**
 * Normalizes a team name/nickname into a standardized key.
 */
function normalizeTeamString(name: string): string {
  return name.toLowerCase().replace(/[\.\-']/g, '').replace(/baseball|team|club/gi, '').trim();
}

/**
 * Resolver Service for Prediction Markets
 */
export class PmResolver {
  private static getDatabase() {
    return spanner.instance("clearspace").database("sports-mlb-db");
  }

  public static async quarantineMarket(
    platform: string,
    marketId: string,
    title: string,
    reason: string,
    detail: string
  ): Promise<void> {
    const db = this.getDatabase();
    logger.warn({ msg: "Quarantining market", platform, marketId, reason, detail });
    
    try {
      const table = db.table("PmQuarantine");
      await table.upsert([{
        Platform: platform,
        MarketId: marketId,
        Title: title,
        Reason: reason,
        Detail: detail,
        CapturedAt: new Date()
      }]);
    } catch (err: any) {
      logger.error({ msg: "Failed to write PmQuarantine mutation", error: err.message });
    }
  }

  /**
   * Main Resolution Pipeline
   */
  public static async resolveAndStore(payload: RawMarketPayload): Promise<{ status: 'resolved' | 'quarantined'; count: number }> {
    const db = this.getDatabase();
    const { platform, marketId, title, subtitle = "", rulesText = "", outcomesJson, closeTimeUtc, rawJson } = payload;

    // --- STEP 1: VALIDATION GATE ---
    if (containsTemplateVariables(title) || containsTemplateVariables(subtitle)) {
      const detail = `Title: "${title}", Subtitle: "${subtitle}"`;
      await this.quarantineMarket(platform, marketId, title, "unrendered_template", detail);
      return { status: 'quarantined', count: 0 };
    }

    // Write to Raw Market Ledger (Untouched, Append-Only)
    try {
      const table = db.table("PmRawMarket");
      await table.upsert([{
        Platform: platform,
        MarketId: marketId,
        Title: title,
        Subtitle: subtitle,
        RulesText: rulesText,
        OutcomesJson: JSON.stringify(outcomesJson),
        CloseTimeUtc: closeTimeUtc ? new Date(closeTimeUtc) : null,
        RawJson: JSON.stringify(rawJson),
        CapturedAt: new Date()
      }]);
    } catch (err: any) {
      logger.error({ msg: "Failed to write raw market tick", error: err.message });
    }

    // --- STEP 2: EVENT RESOLUTION ---
    // Fetch all active/recent MLB games from Spanner (+/- 2 days window around close time)
    const targetDate = closeTimeUtc ? new Date(closeTimeUtc) : new Date();
    const dateStart = new Date(targetDate.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const dateEnd = new Date(targetDate.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    let games: any[] = [];
    try {
      const [rows] = await db.run({
        sql: `
          SELECT EventId, HomeTeamName, AwayTeamName, GameDate, StartTime
          FROM MlbGames
          WHERE GameDate >= @dateStart AND GameDate <= @dateEnd
        `,
        params: { dateStart, dateEnd }
      });
      games = rows.map((r: any) => r.toJSON());
    } catch (err: any) {
      logger.error({ msg: "Failed to fetch games for resolver", error: err.message });
      await this.quarantineMarket(platform, marketId, title, "database_error", err.message);
      return { status: 'quarantined', count: 0 };
    }

    // Match title teams against games list
    let matchedGame: any = null;
    let matchReason = "";

    const titleNormalized = normalizeTeamString(title + " " + subtitle);

    for (const game of games) {
      const homeNick = getTeamNickname(game.HomeTeamName);
      const awayNick = getTeamNickname(game.AwayTeamName);
      const homeNickNorm = normalizeTeamString(homeNick);
      const awayNickNorm = normalizeTeamString(awayNick);
      const homeTeamNorm = normalizeTeamString(game.HomeTeamName);
      const awayTeamNorm = normalizeTeamString(game.AwayTeamName);

      // Check if both teams in the game are mentioned in the title/subtitle
      const homeMatches = titleNormalized.includes(homeNickNorm) || titleNormalized.includes(homeTeamNorm);
      const awayMatches = titleNormalized.includes(awayNickNorm) || titleNormalized.includes(awayTeamNorm);

      if (homeMatches && awayMatches) {
        if (matchedGame) {
          // Ambiguous: matched more than one game
          await this.quarantineMarket(platform, marketId, title, "ambiguous_event", `Matched EventIds: ${matchedGame.EventId} and ${game.EventId}`);
          return { status: 'quarantined', count: 0 };
        }
        matchedGame = game;
      }
    }

    if (!matchedGame) {
      await this.quarantineMarket(platform, marketId, title, "no_event_match", "Could not resolve title to any game in MlbGames schedule window");
      return { status: 'quarantined', count: 0 };
    }

    // --- STEP 3: GROUPING / EXPLOSION (Failure Mode #2) ---
    // If outcomes list is an array of size > 2 with separate player entries, or structured as props
    const isPlayerProp = titleNormalized.includes("hit a home run") || titleNormalized.includes("home run") || titleNormalized.includes("strikeouts") || titleNormalized.includes("hit") || titleNormalized.includes("hr");
    const outcomes = Array.isArray(outcomesJson) ? outcomesJson : (outcomesJson?.outcomes || outcomesJson?.tokens || []);

    const resolvedLegs: any[] = [];
    const groupId = payload.rawJson?.eventId || payload.rawJson?.group_ticker || marketId;

    if (isPlayerProp && outcomes.length > 2) {
      // Explode grouped props (e.g. Player A, Player B to hit HR)
      let legIndex = 0;
      for (const token of outcomes) {
        const tokenName = token.name || token.title || "";
        if (!tokenName || tokenName.toLowerCase() === "no" || tokenName.toLowerCase() === "yes") continue;

        // Parse price/probability
        const yesProb = token.price !== undefined ? parseFloat(token.price) : (token.probability || 0);
        const bestBid = token.best_bid !== undefined ? parseFloat(token.best_bid) : yesProb;
        const bestAsk = token.best_ask !== undefined ? parseFloat(token.best_ask) : yesProb;
        const depth = token.depth !== undefined ? parseFloat(token.depth) : 0;

        resolvedLegs.push({
          Platform: platform,
          MarketId: marketId,
          CanonicalEventId: matchedGame.EventId,
          League: "MLB",
          MarketType: "player_prop",
          Subject: tokenName,
          SubjectKind: "player",
          Line: 0.5, // Default for anytime hits/HRs
          Comparator: "yes",
          HomeAwayContext: "unknown", // Derived later if rosters joined
          YesProb: yesProb,
          BestBid: bestBid,
          BestAsk: bestAsk,
          DepthUsd: depth,
          GroupId: groupId,
          LegIndex: legIndex++
        });
      }
    } else {
      // Standard binary outcome (Moneyline, spread, total)
      // Determine Market Type
      let marketType = "moneyline";
      let line = 0;
      let comparator = "yes";
      let subject = "yes";
      let subjectKind = "team";

      if (titleNormalized.includes("run line") || titleNormalized.includes("spread") || titleNormalized.includes("win by")) {
        marketType = "spread";
      } else if (titleNormalized.includes("total runs") || titleNormalized.includes("over/under") || titleNormalized.includes("total")) {
        marketType = "total";
      }

      // Populate bids/asks from YES token or outcome list
      let yesProb = 0.5;
      let bestBid = 0.5;
      let bestAsk = 0.5;
      let depth = 0;

      if (Array.isArray(outcomesJson)) {
        const yesToken = outcomesJson.find((o: any) => (o.name || "").toLowerCase() === "yes" || (o.label || "").toLowerCase() === "yes");
        if (yesToken) {
          yesProb = yesToken.price !== undefined ? parseFloat(yesToken.price) : (yesToken.probability || 0.5);
          bestBid = yesToken.best_bid !== undefined ? parseFloat(yesToken.best_bid) : yesProb;
          bestAsk = yesToken.best_ask !== undefined ? parseFloat(yesToken.best_ask) : yesProb;
          depth = yesToken.depth !== undefined ? parseFloat(yesToken.depth) : 0;
        } else if (outcomesJson.length === 2) {
          // e.g. outcome[0] is home, outcome[1] is away
          // For simplicity, we treat the first outcome as the primary resolved leg
          const primary = outcomesJson[0];
          yesProb = primary.price !== undefined ? parseFloat(primary.price) : (primary.probability || 0.5);
          bestBid = primary.best_bid !== undefined ? parseFloat(primary.best_bid) : yesProb;
          bestAsk = primary.best_ask !== undefined ? parseFloat(primary.best_ask) : yesProb;
          depth = primary.depth !== undefined ? parseFloat(primary.depth) : 0;
          subject = primary.name || primary.title || "home";
        }
      }

      resolvedLegs.push({
        Platform: platform,
        MarketId: marketId,
        CanonicalEventId: matchedGame.EventId,
        League: "MLB",
        MarketType: marketType,
        Subject: subject,
        SubjectKind: subjectKind,
        Line: line,
        Comparator: comparator,
        HomeAwayContext: "neutral", // derived from event if subject maps to team
        YesProb: yesProb,
        BestBid: bestBid,
        BestAsk: bestAsk,
        DepthUsd: depth,
        GroupId: groupId,
        LegIndex: 0
      });
    }

    if (resolvedLegs.length === 0) {
      await this.quarantineMarket(platform, marketId, title, "polarity_unknown", "Failed to parse individual outcomes or tokens from outcomesJson");
      return { status: 'quarantined', count: 0 };
    }

    // Write all resolved legs to PmResolvedMarket
    try {
      const resolvedAt = new Date().toISOString();
      await db.runTransactionAsync(async (transaction) => {
        for (const leg of resolvedLegs) {
          await transaction.runUpdate({
            sql: `
              INSERT OR UPDATE INTO PmResolvedMarket (
                Platform, MarketId, CanonicalEventId, League, MarketType, Subject,
                SubjectKind, Line, Comparator, HomeAwayContext, YesProb, BestBid,
                BestAsk, DepthUsd, GroupId, LegIndex, ResolvedAt, ResolverVersion
              ) VALUES (
                @platform, @marketId, @canonicalEventId, @league, @marketType, @subject,
                @subjectKind, @line, @comparator, @homeAwayContext, @yesProb, @bestBid,
                @bestAsk, @depthUsd, @groupId, @legIndex, @resolvedAt, @resolverVersion
              )
            `,
            params: {
              platform: leg.Platform,
              marketId: leg.MarketId,
              canonicalEventId: leg.CanonicalEventId,
              league: leg.League,
              marketType: leg.MarketType,
              subject: leg.Subject,
              subjectKind: leg.SubjectKind,
              line: leg.Line,
              comparator: leg.Comparator,
              homeAwayContext: leg.HomeAwayContext,
              yesProb: leg.YesProb,
              bestBid: leg.BestBid,
              bestAsk: leg.BestAsk,
              depthUsd: leg.DepthUsd,
              groupId: leg.GroupId,
              legIndex: leg.LegIndex,
              resolvedAt: resolvedAt,
              resolverVersion: '1.1.0'
            }
          });
        }
        await transaction.commit();
      });
      return { status: 'resolved', count: resolvedLegs.length };
    } catch (err: any) {
      logger.error({ msg: "Failed to write resolved market legs", error: err.message });
      await this.quarantineMarket(platform, marketId, title, "write_error", err.message);
      return { status: 'quarantined', count: 0 };
    }
  }
}
