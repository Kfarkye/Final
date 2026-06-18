---
name: live-game-analysis
description: |
  Activate when the user asks about:
  - live games, in-progress scores, what's happening
  - current inning, quarter, period
  - live betting, in-game value, hedging
  - position exposure during a live game
  Do NOT activate for pregame analysis or historical recaps.
freshnessPolicy: volatile
requiredTools:
  - get_mlb_scores
  - get_live_odds
  - get_espn_scoreboard
---

# Live Game Analysis Skill

## Required Workflow
1. Fetch LIVE scores using `get_mlb_scores` or `get_espn_scoreboard`.
2. If user has a position, fetch live odds to evaluate exposure.
3. Report the score, inning/period, and game situation.
4. If betting value is requested, calculate pace vs. projected total.

## Critical Rules
- ALL data in live analysis is volatile. No caching.
- Always report the timestamp of the data fetch.
- Speak in concise, rapid trader jargon during live games. No fluff.
- If a tool returns stale data (> 2 minutes old), WARN the user.

## Output Format
- Current score + inning/quarter/period
- Key situation (runners, outs, count for baseball)
- If position held: exposure status and recommendation
- Last 3 plays or key developments
