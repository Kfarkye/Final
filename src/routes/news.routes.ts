import { Router, Request, Response } from "express";
import { fetchEspnNews } from "../services/news/espn-news-client";
import { normalizeArticleBatch } from "../services/news/news-normalizer";
import { buildScorerContext, resolveMatchedGames } from "../services/news/news-market-mapper";
import { scoreAndPartitionArticles } from "../services/news/news-signal-scorer";
import { logger } from "../utils/logger";

const router = Router();

router.get("/market-relevant", async (req: Request, res: Response) => {
  const startMs = Date.now();
  try {
    const league = ((req.query.league as string) || 'mlb').toLowerCase() as any;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);

    const validLeagues = ['mlb', 'nba', 'nfl', 'nhl', 'mls'];
    if (!validLeagues.includes(league)) {
      return res.status(400).json({ error: `Unsupported league: ${league}. Use: ${validLeagues.join(', ')}` });
    }

    // 1. Fetch ESPN articles
    const espnResponse = await fetchEspnNews(league, limit);

    // 2. Normalize (preserves raw ESPN categories for scorer)
    const normalized = normalizeArticleBatch(
      espnResponse.articles,
      league,
      espnResponse.fetchedAt,
      espnResponse.sourceMeta.url
    );

    // 3. Build scorer context (Spanner MlbGames + PmResolvedMarket → teamId indexes)
    //    v3: only upcoming/live games count as "active" — finals/postponed excluded
    const { scorerContext, activeGames, mapperDiagnostics } = await buildScorerContext();

    // 4. Score and partition using corrected scorer
    const scored = scoreAndPartitionArticles(normalized, scorerContext);

    // 5. Build response cards — v3: pass article.publishedAt for time-gating
    const buildCard = ({ article, score }: { article: any; score: any }) => {
      // resolveMatchedGames now: filters final/postponed, prefers both-team, time-gates
      const matchedGames = resolveMatchedGames(score.matchedTeamIds, activeGames, article.publishedAt);
      return {
        articleId: article.articleId,
        headline: article.headline,
        description: article.description,
        source: 'ESPN' as const,
        url: article.url,
        imageUrl: article.imageUrl,
        publishedAt: article.publishedAt,
        league: article.league,
        label: score.label,
        score: score.score,
        whyItMatters: score.whyItMatters,
        reasons: score.reasons,
        isMedia: score.isMedia,
        isBroadArticle: score.isBroadArticle,
        availabilityAngle: score.availabilityAngle,
        matchedEvents: matchedGames,
        sourceMeta: article.sourceMeta,
      };
    };

    const premiumRail = scored.premium.map(buildCard);
    const generalNews = scored.general.map(buildCard);
    const secondary = scored.secondary.map(buildCard);

    res.json({
      generatedAt: new Date().toISOString(),
      feature: 'market_relevant_news',
      league: league.toUpperCase(),
      latencyMs: Date.now() - startMs,

      premiumRail,
      generalNews,
      secondary,

      // Empty-state contract: premium being empty is CORRECT, not broken.
      emptyState: premiumRail.length === 0 ? {
        message: "No availability or prediction-market-linked news right now. " +
                 "Market-relevant news is intermittent — this is normal on a quiet news day.",
        showGeneralInstead: generalNews.length > 0,
      } : null,

      diagnostics: {
        // Scorer diagnostics
        articlesFetched: scored.diagnostics.fetched,
        premium: scored.diagnostics.premium,
        general: scored.diagnostics.general,
        secondary: scored.diagnostics.secondary,
        suppressed: scored.diagnostics.suppressed,
        mediaDownweighted: scored.diagnostics.mediaDownweighted,
        broadArticlesSuppressed: scored.diagnostics.broadArticlesSuppressed,
        // Mapper diagnostics (v3 — corrected naming)
        ...mapperDiagnostics,
        latencyMs: Date.now() - startMs,
      },
      sourceMeta: [{ source: 'espn', isSimulated: false, fetchedAt: espnResponse.fetchedAt }],
    });
  } catch (err: any) {
    logger.error({ msg: "Market-Relevant News pipeline failed", err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Keep old route as alias for backward compat (redirects silently)
router.get("/market-moving", (req, res) => {
  const qs = req.url.includes('?') ? req.url.split('?')[1] : '';
  res.redirect(301, `/api/news/market-relevant${qs ? '?' + qs : ''}`);
});

export default router;
