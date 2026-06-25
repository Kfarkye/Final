import { Spanner } from "@google-cloud/spanner";
import { env } from "../config/env";
import { teamFromAbbr, getTeamAliases, normalizeTeamString, MLB_TEAMS } from "../utils/mlb-teams";
import { logger } from "../utils/logger";
import { randomUUID } from "crypto";
import { edgeDb } from "../db/spanner";
import { RawMarketPayload } from "../types/pm.types";

/**
 * Step 1: Validation Gate (Failure Mode #1)
 * Detects unrendered template variables or empty placeholders in market titles/subtitles.
 */
export function containsTemplateVariables(text: string): boolean {
  const templateRegex = /\b(awayAbbr|homeAbbr|teamName|away_team|home_team|\{\{.*?\}\}|\$\{.*?\}|%[A-Z_]+%)\b/i;
  const placeholderRegex = /\bvs\s+(tbd|\?\?\?|\.)/i;
  return templateRegex.test(text) || placeholderRegex.test(text);
}

// ── Kalshi-specific parsers ─────────────────────────────────────────

/** Extract spread subject from title: "A's wins by over 3.5 runs?" → "A's" */
function extractSpreadSubject(title: string): string | null {
  const match = title.match(/^(.+?)\s+wins?\s+by\s+/i);
  return match ? match[1].trim() : null;
}

/**
 * Extract spread line + direction from title.
 * "wins by over 3.5 runs"  → { line: 3.5, comparator: "over" }
 * "wins by under 2 runs"   → { line: 2,   comparator: "under" }
 * "wins by 3 or more runs" → { line: 3,   comparator: "over" }
 */
function extractSpreadFromTitle(title: string): { line: number; comparator: string } | null {
  // over/under N runs
  let m = title.match(/\b(over|under)\s+(\d+(?:\.\d+)?)\s+runs?\b/i);
  if (m) return { line: Number(m[2]), comparator: m[1].toLowerCase() };
  // "N or more runs" / "N+ runs" → treat as over
  m = title.match(/\b(\d+(?:\.\d+)?)\s*(?:\+|or\s+more)\s+runs?\b/i);
  if (m) return { line: Number(m[1]), comparator: "over" };
  // bare "by N runs" → exact-margin, default over
  m = title.match(/\bby\s+(\d+(?:\.\d+)?)\s+runs?\b/i);
  if (m) return { line: Number(m[1]), comparator: "over" };
  return null;
}

/**
 * Extract total line + direction.
 * Prefers ticker (e.g. KXMLBTOTAL-...-8 → 8) but falls back to title.
 * "Over 8.5 total runs" → { line: 8.5, comparator: "over" }
 */
function extractTotalFromMarket(marketId: string, title: string): { line: number; comparator: string } | null {
  const compMatch = title.match(/\b(over|under)\b/i);
  const comparator = compMatch ? compMatch[1].toLowerCase() : "over";

  // ticker suffix: a bare number after the final dash
  const tickerMatch = marketId.match(/-(\d+(?:\.\d+)?)$/);
  if (tickerMatch) return { line: Number(tickerMatch[1]), comparator };

  // title: "over/under N runs" or "total ... N"
  let m = title.match(/\b(?:over|under)\s+(\d+(?:\.\d+)?)\b/i);
  if (m) return { line: Number(m[1]), comparator };
  m = title.match(/\btotal\b[^0-9]*(\d+(?:\.\d+)?)/i);
  if (m) return { line: Number(m[1]), comparator };
  return null;
}

/** Extract moneyline team abbr from ticker: KXMLBGAME-...-BOS → "BOS" */
function extractTeamFromTicker(ticker: string): string | null {
  const match = ticker.match(/-([A-Z]+)\d*$/);
  return match ? match[1] : null;
}

/**
 * Non-Kalshi spread: extract signed line near a team, not just the first number.
 * "Yankees -1.5 vs Red Sox +1.5" → { line: -1.5, comparator: "spread" }
 * Picks the FIRST signed number but only when adjacent to "run line"/"spread"/whitespace,
 * avoiding years/team-number noise.
 */
function extractSpreadLineGeneric(text: string): number | null {
  // signed number with optional decimal, must be a standalone token
  const m = text.match(/(?:^|\s)([-+]\d+(?:\.\d+)?)(?=\s|$)/);
  return m ? Number(m[1]) : null;
}

/** Non-Kalshi total: only grab a number in over/under/total context. */
function extractTotalLineGeneric(text: string): number | null {
  const m = text.match(/\b(?:over|under|total)\b[^0-9]*(\d+(?:\.\d+)?)/i);
  return m ? Number(m[1]) : null;
}
/**
 * Parse game date from Kalshi ticker middle segment.
 * "26JUN172140PITATH" → "2026-06-17"
 * Format: YY + MON(3-letter) + DD + HHMM + TEAMS
 */
function parseGameDateFromTicker(tickerMiddle: string): string | null {
  const MONTHS: Record<string, string> = {
    JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
    JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12'
  };
  const m = tickerMiddle.match(/^(\d{2})([A-Z]{3})(\d{2})/);
  if (!m) return null;
  const [, yy, mon, dd] = m;
  const mm = MONTHS[mon];
  if (!mm) return null;
  return `20${yy}-${mm}-${dd}`;
}

/**
 * Parse team abbreviations from Kalshi ticker.
 * Uses the per-market suffix (e.g. "-PIT") as the primary single-team key,
 * and extracts both teams from the event-level middle segment by matching
 * known abbreviations against the teams blob — avoiding the variable-length
 * bisection problem (SDTEX = SD+TEX, not SDT+EX).
 */
function parseTickerTeams(marketId: string): { awayAbbr: string | null; homeAbbr: string | null; singleTeamAbbr: string | null } {
  const segments = marketId.split('-');
  // Per-market suffix: KXMLBGAME-...-BOS → "BOS"
  const singleTeamAbbr = segments.length >= 3 ? segments[segments.length - 1].replace(/\d+$/, '') : null;

  if (segments.length < 2) return { awayAbbr: null, homeAbbr: null, singleTeamAbbr };

  // Extract teams blob from middle segment: "26JUN172140PITATH" → "PITATH"
  const middle = segments[1];
  const teamsBlob = middle.replace(/^\d{2}[A-Z]{3}\d{6}/, ''); // strip "26JUN172140"

  // Try all known abbreviations against the blob, longest-first to avoid partial matches
  const allAbbrs = Array.from(
    new Set(MLB_TEAMS.flatMap(t => t.abbr))
  ).sort((a, b) => b.length - a.length);

  let awayAbbr: string | null = null;
  let homeAbbr: string | null = null;

  // Away team is first in the blob, home team second
  for (const abbr of allAbbrs) {
    if (teamsBlob.startsWith(abbr)) {
      awayAbbr = abbr;
      const remainder = teamsBlob.substring(abbr.length);
      for (const abbr2 of allAbbrs) {
        if (remainder === abbr2) {
          homeAbbr = abbr2;
          break;
        }
      }
      if (homeAbbr) break;
      // If no match for remainder, reset and try next prefix
      awayAbbr = null;
    }
  }

  return { awayAbbr, homeAbbr, singleTeamAbbr };
}

/**
 * Resolver Service for Prediction Markets
 */
export class PmResolver {
  private static dbInstance = edgeDb;

  public static _setTestDatabase(db: any) {
    this.dbInstance = db;
  }

  private static getDatabase() {
    return this.dbInstance;
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

    // --- STEP 1B: OUTRIGHT / FUTURES DETECTION ---
    const titleNormalized = normalizeTeamString(title + " " + subtitle);
    const outrightKeywords = ["champion", "to win", "outright", "awards"];
    // "winner" is excluded: Kalshi binary moneylines use "Winner?" in titles
    // (e.g. "Toronto vs Boston Winner?") which are NOT outrights.
    
    const outcomes = Array.isArray(outcomesJson) ? outcomesJson : (outcomesJson?.outcomes || outcomesJson?.tokens || []);
    const isPlayerProp = titleNormalized.includes("hit a home run") || titleNormalized.includes("home run") || titleNormalized.includes("strikeouts") || titleNormalized.includes("hit") || titleNormalized.includes("hr");

    const hasOutrightKeyword = outrightKeywords.some(keyword => titleNormalized.includes(keyword));
    // Only treat "winner" as outright if outcomes > 2 (true multi-way market, not binary Yes/No)
    const hasWinnerWithMultiOutcome = titleNormalized.includes("winner") && outcomes.length > 2;
    const isMultiOutcomeNonProp = outcomes.length > 3 && !isPlayerProp;
    const tokensAreYesNo = outcomes.length === 2 && outcomes.some((o: any) => {
      const n = (o.name || o.title || o.label || "").toLowerCase();
      return n === "yes" || n === "no";
    });
    const isOutright = (hasOutrightKeyword || hasWinnerWithMultiOutcome || isMultiOutcomeNonProp) && !tokensAreYesNo;

    let matchedGame: any = null;
    let isForcedOutrightType = false;

    if (isOutright) {
      // Bypass H2H lookup and create a tournament slug
      const slug = (title + " " + subtitle).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      matchedGame = { EventId: slug, League: "TOURNAMENT" };
      isForcedOutrightType = true;
    } else {
      // --- STEP 2: EVENT RESOLUTION ---
      // Fetch all active/recent MLB games from Spanner (+/- 2 days window around close time)
      let targetDate = closeTimeUtc ? new Date(closeTimeUtc) : new Date();

      if (platform === 'kalshi') {
        const segments = marketId.split('-');
        if (segments.length >= 2) {
          const dateMatchPart = segments[1];
          const dateStrMatch = dateMatchPart.match(/^(\d{2})([A-Z]{3})(\d{2})/);
          if (dateStrMatch) {
            const [ , yy, mon, dd ] = dateStrMatch;
            const months: Record<string, string> = { "JAN":"01", "FEB":"02", "MAR":"03", "APR":"04", "MAY":"05", "JUN":"06", "JUL":"07", "AUG":"08", "SEP":"09", "OCT":"10", "NOV":"11", "DEC":"12" };
            if (months[mon]) {
              const fullYear = "20" + yy;
              const isoDateStr = `${fullYear}-${months[mon]}-${dd}T12:00:00Z`;
              targetDate = new Date(isoDateStr);
            }
          }
        }
      }

      const dateStart = new Date(targetDate.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const dateEnd = new Date(targetDate.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      let games: any[] = [];
      const tags = payload.rawJson?.eventTags || [];
      const isSoccerTag = tags.some((t: any) => (t.label || "").toLowerCase() === "soccer" || (t.slug || "").toLowerCase() === "soccer");
      const isMlbTag = tags.some((t: any) => (t.label || "").toLowerCase() === "mlb" || (t.slug || "").toLowerCase() === "mlb" || (t.label || "").toLowerCase() === "baseball");
      const forceSoccer = isSoccerTag || payload.rawJson?.league === 'soccer';
      const forceMlb = isMlbTag || payload.rawJson?.league === 'mlb';

      if (!forceSoccer) {
        try {
          const [rows] = await db.run({
            sql: `
              SELECT EventId, HomeTeamName, AwayTeamName, GameDate, StartTime, 'MLB' as League
              FROM MlbGames
              WHERE GameDate >= @dateStart AND GameDate <= @dateEnd
            `,
            params: { dateStart, dateEnd }
          });
          games.push(...rows.map((r: any) => r.toJSON()));
        } catch (err: any) {
          logger.error({ msg: "Failed to fetch MlbGames for resolver", error: err.message });
        }
      }

      if (!forceMlb && games.length === 0) {
        try {
          const [rows] = await db.run({
            sql: `
              SELECT EventId, HomeTeam as HomeTeamName, AwayTeam as AwayTeamName, CommenceTime as GameDate, CommenceTime as StartTime, 'SOCCER' as League
              FROM SoccerGames
              WHERE CommenceTime >= @dateStart AND CommenceTime <= @dateEnd
            `,
            params: { dateStart, dateEnd }
          });
          games.push(...rows.map((r: any) => r.toJSON()));
        } catch (err: any) {
          logger.error({ msg: "Failed to fetch SoccerGames for resolver", error: err.message });
        }
      }

      if (games.length === 0) {
        await this.quarantineMarket(platform, marketId, title, "database_error_or_no_games", "Could not fetch games or no games scheduled in window");
        return { status: 'quarantined', count: 0 };
      }

      // Match title teams against games list
      let matchReason = "";

      for (const game of games) {
        // Step 1: Attempt ticker-based match for Kalshi
        if (platform === 'kalshi') {
          const { awayAbbr, homeAbbr } = parseTickerTeams(marketId);
          if (awayAbbr && homeAbbr) {
            const awayTeamObj = teamFromAbbr(awayAbbr);
            const homeTeamObj = teamFromAbbr(homeAbbr);

            if (!awayTeamObj || !homeTeamObj) {
              // Dictionary gap — NOT a no_event_match. Tag it distinctly.
              await this.quarantineMarket(
                platform, marketId, title,
                "unmapped_ticker_abbr",
                `away=${awayAbbr}(${awayTeamObj ? "ok" : "MISS"}) home=${homeAbbr}(${homeTeamObj ? "ok" : "MISS"})`
              );
              return { status: 'quarantined', count: 0 };
            }
              
            // Match game teams against ticker teams using aliases (handles "Athletics" vs "Oakland Athletics")
            const homeGameNorm = normalizeTeamString(game.HomeTeamName);
            const awayGameNorm = normalizeTeamString(game.AwayTeamName);
            const homeTickerAliases = getTeamAliases(homeTeamObj.fullName);
            const awayTickerAliases = getTeamAliases(awayTeamObj.fullName);

            const homeMatch = homeTickerAliases.some(a => homeGameNorm === a || homeGameNorm.includes(a));
            const awayMatch = awayTickerAliases.some(a => awayGameNorm === a || awayGameNorm.includes(a));

            if (homeMatch && awayMatch) {
              matchedGame = game;
              break;
            }
          }
        }
        // Step 2: Fallback to title alias matching
        if (!matchedGame) {
          const homeAliases = getTeamAliases(game.HomeTeamName);
          const awayAliases = getTeamAliases(game.AwayTeamName);

          const homeMatches = homeAliases.some(a => titleNormalized.includes(a));
          const awayMatches = awayAliases.some(a => titleNormalized.includes(a));

          if (homeMatches && awayMatches) {
            if (matchedGame) {
              // Ambiguous: matched more than one game
              await this.quarantineMarket(platform, marketId, title, "ambiguous_event", `Matched EventIds: ${matchedGame.EventId} and ${game.EventId}`);
              return { status: 'quarantined', count: 0 };
            }
            matchedGame = game;
          }
        }
      }

      if (!matchedGame) {
        await this.quarantineMarket(platform, marketId, title, "no_event_match", "Could not resolve title to any game in scheduled window");
        return { status: 'quarantined', count: 0 };
      }
    }

    // --- STEP 3: GROUPING / EXPLOSION (Failure Mode #2) ---
    // If outcomes list is an array of size > 2 with separate player entries, or structured as props

    const resolvedLegs: any[] = [];
    const groupId = payload.rawJson?.eventId || payload.rawJson?.group_ticker || marketId;

    if ((isPlayerProp && outcomes.length > 2) || isForcedOutrightType) {
      // Explode grouped props (e.g. Player A, Player B to hit HR) or outright futures
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
          League: matchedGame.League,
          MarketType: isForcedOutrightType ? "outright_future" : "player_prop",
          Subject: tokenName,
          SubjectKind: isForcedOutrightType ? "team" : "player",
          Line: 0.5, // Default for anytime hits/HRs or outrights
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
      let marketType = isForcedOutrightType ? "outright_future" : "moneyline";
      let line = 0;
      let comparator = "yes";
      let subject = "yes";
      let subjectKind = "team";

      if (platform === "kalshi" && payload.rawJson?.eventDetails?.series_ticker) {
        const st = payload.rawJson.eventDetails.series_ticker;
        if (st.includes("KXMLBGAME")) {
          marketType = "moneyline";
          subject = extractTeamFromTicker(marketId) ?? subject;
          comparator = "win";
        } else if (st.includes("KXMLBSPREAD")) {
          marketType = "spread";
          subject = extractSpreadSubject(title) ?? subject;
          const sp = extractSpreadFromTitle(title);
          if (sp) { line = sp.line; comparator = sp.comparator; }
        } else if (st.includes("KXMLBTOTAL")) {
          marketType = "total";
          const tot = extractTotalFromMarket(marketId, title);
          if (tot) { line = tot.line; comparator = tot.comparator; }
        }
      } else if (!isForcedOutrightType) {
        if (titleNormalized.includes("run line") || titleNormalized.includes("spread") ||
            titleNormalized.includes("win by") || subtitle.match(/[-+]\d+\.\d+/)) {
          marketType = "spread";
          const l = extractSpreadLineGeneric(title) ?? extractSpreadLineGeneric(subtitle);
          if (l !== null) line = l;
          comparator = "spread";
        } else if (titleNormalized.includes("total runs") || titleNormalized.includes("over/under") ||
                   titleNormalized.includes("total") || subtitle.toLowerCase().includes("over")) {
          marketType = "total";
          const l = extractTotalLineGeneric(title) ?? extractTotalLineGeneric(subtitle);
          if (l !== null) line = l;
          const compMatch = (title + " " + subtitle).match(/\b(over|under)\b/i);
          comparator = compMatch ? compMatch[1].toLowerCase() : "over";
        }
      }

      // Populate bids/asks using the SAME normalized `outcomes` array used elsewhere.
      let yesProb = 0.5, bestBid = 0.5, bestAsk = 0.5, depth = 0;
      let pricesFound = false;

      const pickNum = (v: any, fallback: number) =>
        v !== undefined && v !== null && !Number.isNaN(parseFloat(v)) ? parseFloat(v) : fallback;

      if (Array.isArray(outcomes) && outcomes.length > 0) {
        const yesToken = outcomes.find((o: any) =>
          (o.name || o.label || o.title || "").toLowerCase() === "yes");

        const token = yesToken ?? (outcomes.length === 2 ? outcomes[0] : null);

        if (token) {
          yesProb = pickNum(token.price, pickNum(token.probability, 0.5));
          bestBid = pickNum(token.best_bid, yesProb);
          bestAsk = pickNum(token.best_ask, yesProb);
          depth   = pickNum(token.depth, 0);
          pricesFound = true;

          // Subject inference for non-Kalshi binary markets
          if (subject === "yes") {
            if (platform !== "kalshi" && subtitle) {
              subject = subtitle;
            } else if (!yesToken) {
              subject = token.name || token.title || "home";
            }
          }
        }
      }

      // Don't silently emit a fabricated 50/50 leg.
      if (!pricesFound) {
        await this.quarantineMarket(
          platform, marketId, title,
          "no_priced_outcome",
          `Could not locate a priced YES/primary token. outcomes.length=${Array.isArray(outcomes) ? outcomes.length : "n/a"}`
        );
        return { status: 'quarantined', count: 0 };
      }

      resolvedLegs.push({
        Platform: platform,
        MarketId: marketId,
        CanonicalEventId: matchedGame.EventId,
        League: matchedGame.League,
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
              line: Spanner.float(leg.Line ?? 0.0),
              comparator: leg.Comparator,
              homeAwayContext: leg.HomeAwayContext,
              yesProb: leg.YesProb !== null && leg.YesProb !== undefined ? Spanner.float(leg.YesProb) : null,
              bestBid: leg.BestBid !== null && leg.BestBid !== undefined ? Spanner.float(leg.BestBid) : null,
              bestAsk: leg.BestAsk !== null && leg.BestAsk !== undefined ? Spanner.float(leg.BestAsk) : null,
              depthUsd: leg.DepthUsd !== null && leg.DepthUsd !== undefined ? Spanner.float(leg.DepthUsd) : null,
              groupId: leg.GroupId,
              legIndex: leg.LegIndex,
              resolvedAt: resolvedAt,
              resolverVersion: '1.1.0'
            },
            types: {
              platform: "string",
              marketId: "string",
              canonicalEventId: "string",
              league: "string",
              marketType: "string",
              subject: "string",
              subjectKind: "string",
              line: "float64",
              comparator: "string",
              homeAwayContext: "string",
              yesProb: "float64",
              bestBid: "float64",
              bestAsk: "float64",
              depthUsd: "float64",
              groupId: "string",
              legIndex: "int64",
              resolvedAt: "timestamp",
              resolverVersion: "string"
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
