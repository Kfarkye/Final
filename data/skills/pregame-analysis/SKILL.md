---
name: pregame-analysis
description: |
  Activate when the user asks about:
  - upcoming games, tonight's slate, tomorrow's games
  - betting preview, pitching matchups, lineups
  - injuries, weather, park factors
  - odds, lines, totals, run lines, spreads
  Do NOT activate for live in-progress games or historical analysis.
freshnessPolicy: volatile
requiredTools:
  - get_mlb_schedule
  - get_mlb_odds
  - get_starting_pitchers
  - search_web
---

# Pregame Analysis Skill

## Required Workflow
1. Fetch current schedule using `get_mlb_schedule` or equivalent sport tool.
2. Fetch current odds if betting/value is requested.
3. Fetch starting pitchers or confirmed starters where available.
4. Check relevant news/injuries via `search_web`.
5. Use persistent Knowledge Items only as CONTEXT, never as current truth.
6. Clearly separate in your response:
   - ✅ Verified live data (from tools, with timestamps)
   - 📚 Historical context (from Knowledge Items, with "as of" dates)
   - 🤖 Model opinion (clearly labeled as inference)
   - ⚠️ Uncertainty (what you couldn't verify)

## Output Format
- Slate summary with game times
- Key matchups (pitching, bullpen, lineup)
- Market context (lines, totals, movement)
- Risks / unknowns
- Suggested next checks

## Anti-Patterns
- NEVER cite yesterday's odds as today's odds
- NEVER present a Knowledge Item analysis_snapshot as current fact
- ALWAYS include data timestamps in your response
- NEVER guess at starting lineups — either fetch them or say "not yet confirmed"
