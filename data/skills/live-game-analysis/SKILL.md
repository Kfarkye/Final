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
  - get_mlb_game_state
  - get_live_odds
  - get_resolved_pm_markets
  - get_espn_scoreboard
---

# Live Game Analysis Skill

## Live Market Synchronization Contract (The Triple-Fetch Protocol)
For **any** in-game betting query, you must execute the Triple-Fetch Protocol in parallel before outputting a recommendation:
1. `get_mlb_game_state` (or equivalent): Lock in the exact current inning, score, outs, and baserunners.
2. `get_live_odds`: Pull the current retail lines and alternate totals.
3. `get_resolved_pm_markets`: Pull Kalshi/Polymarket contracts for the true probability anchor.

## Latency Reconciliation
- You must explicitly compare the game state against the odds feed.
- If the odds feed is suspended or hasn't updated to reflect recent plays (e.g. runs just scored in play-by-play), **explicitly flag the latency arb opportunity** or pause the recommendation until the market resets.

## The 'Buy Up' Evaluation Logic
- Calculate the +EV threshold for alternate lines based on the new game state (score, inning, outs) + `get_game_environment`.
- Example logic: *"The sharp fair value of Under 9.5 is 58% (-138). You can buy up to Under 9.5 safely up to a price of -130 (leaving a ~3% edge)."*

## Critical Rules
- ALL data in live analysis is volatile. No caching.
- Always report the timestamp of the data fetch.
- Speak in concise, rapid trader jargon during live games. No fluff.
- If a tool returns stale data (> 2 minutes old), WARN the user.

## Output Format
- Current score + inning/quarter/period
- Key situation (runners, outs, count for baseball)
- Latency check (are odds synced with the current score?)
- De-vig'd PM line vs retail line
- Highest +EV alternate line ("Buy Up" logic)
- If position held: exposure status and recommendation
- Last 3 plays or key developments

