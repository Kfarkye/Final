---
name: prediction-markets
description: |
  Activate when the user asks about:
  - Polymarket, Kalshi, prediction markets
  - CLOB, contracts, event markets
  - futures, season-long markets
  - market resolution, settlement
  Do NOT activate for traditional sportsbook odds.
freshnessPolicy: volatile
requiredTools:
  - get_polymarket_events
  - get_polymarket_event_detail
  - search_web
---

# Prediction Markets Skill

## Required Workflow
1. Identify the market or event the user is asking about.
2. Use Polymarket/Kalshi tools to fetch current contract prices.
3. Cross-reference with sportsbook odds for arbitrage/divergence.
4. Check Knowledge Items for CLOB mapping rules (pm-resolver parser patterns).

## Critical Rules
- Polymarket uses custom `eventSlug` identifiers. Use the pm-resolver mapping.
- `awayAbbr` anomalies are common in futures — always verify.
- Contract prices are NOT probabilities. They are market-implied probabilities with embedded vig/skew.
- ALWAYS report the last trade time and volume context.

## Output Format
- Market name and current price (Yes/No)
- Volume and liquidity context
- Comparison to sportsbook implied probability
- Divergence analysis if applicable
