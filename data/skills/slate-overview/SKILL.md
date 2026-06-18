---
name: slate-overview
description: |
  Activate when the user asks for the MLB schedule, slate, games today, games tonight, today's games, daily game overview, todays mlb slate.
  - schedule
  - slate
  - games today
  - games tonight
  - today's games
  - what's on today
  - show me the board
  - mlb schedule
  - daily game overview
  - todays mlb
freshnessPolicy: volatile
---
# MLB Slate Overview Skill

## Trigger
User asks for: today's games, the slate, the schedule, "what's on", or "show me the board."

## Tool Chain
1. Call `get_mlb_slate_overview` with the requested date (default: today). This returns ALL data pre-joined.
2. Do NOT call `get_espn_scoreboard`, `get_live_odds`, `get_mlb_standings`, or `get_resolved_pm_markets` separately. The slate tool replaces all of them.
3. If the tool returns `success: false`, fall back to `get_espn_scoreboard` and tell the user odds/PM data is temporarily unavailable.

## Output Format — Oracle Terminal
Render each game in this strict, data-dense format. No conversational filler. No intros. Go straight to the board.

### Time Conversion
- Convert all UTC `startTime` values to **Eastern Time (ET)**.
- Format: `7:10 PM ET`

### ERA Extraction
- The `pitcherRecord` field contains ERA embedded in the string (e.g., `"5-2, 3.15 ERA"`).
- Extract the ERA value and display it in parentheses after the pitcher name.
- If no ERA is parseable, show the full `pitcherRecord` string as-is.

### For **upcoming** games:
```
**[Away] ([W-L], L10: [L10], [Streak]) @ [Home] ([W-L], L10: [L10], [Streak])** | [Time ET]
• Pitchers: [Away SP] ([ERA]) vs [Home SP] ([ERA]) | Lineups: [Status]
• Environment: [Temp], Wind: [Wind] @ [Venue] — or "Dome" if condition indicates retractable/dome
• Sharp Anchor (Pinnacle): [Away ML] / [Home ML] | Fair Prob: [Away%] / [Home%] | Total: O/U [Total]
• Best Available: [Away Best Price] at [Book] / [Home Best Price] at [Book]
• Pred. Markets: Kalshi [Subject] YES at [BestAsk]¢ (Depth: $[DepthUsd]) | Poly [Subject] YES at [BestAsk]¢ (Depth: $[DepthUsd])
• [News/Injury alert if present, otherwise omit this line]
```

### For **live** games:
```
**[Away] [Score] - [Home] [Score]** | [Inning]
• Sharp Line: [Away ML] / [Home ML] | O/U: [Total]
• Pred. Markets: [list contracts with BestAsk + Depth if available]
```

### For **final** games:
```
**[Away] [Score] - [Home] [Score]** | FINAL
```

### For **postponed** or **suspended** games:
```
**[Away] @ [Home]** | POSTPONED (or SUSPENDED [Score])
```

## Rules
- Sort: Live games first, then upcoming by start time, then final, then postponed/suspended at bottom.
- **Sharp Anchor:** Always show Pinnacle odds when available. Label "Sharp Anchor (Pinnacle):".
- **Fair Probability:** Show the devigged fair probability from `odds.fairProb`. Format as percentage: "Fair Prob: NYM 54% / CIN 46%". This is the true no-vig probability.
- **Best Available:** Show the best retail moneyline price from `odds.bestAvailable` with the book name. Example: "NYM -125 at BetMGM / CIN +140 at DraftKings". Do NOT show Pinnacle as best available (it's the sharp anchor).
- **Environment:** Show temp + wind from `environment`. If `condition` contains "Dome" or "Retractable" or if temp/wind are null, just show "Dome" or "Indoor". For outdoor venues, always show wind direction — it materially affects totals.
- **Lineup Status:** Show from `lineupStatus` field. Display as "Confirmed", "Projected", or omit if "unknown".
- **Prediction Markets:** NEVER summarize as "active" or "available". You MUST show the exact `bestAsk` in cents and `depthUsd` in dollars for each contract. Group by platform (Kalshi, Poly). Show the most liquid contract per market type per platform. If `predictionMarkets` is empty, omit the line entirely.
- **ERA:** Extract from `pitcherRecord` string using the pattern `X.XX ERA`. Show in parentheses after pitcher name.
- **Streaks:** Show from `standing.streak` field. Display as the raw value (e.g., "W3", "L2").
- If no odds are available for a game, show "Odds: TBD."
- If standings data is missing, omit the record/L10/streak.
- NEVER add commentary between games. Just the raw board.
- After the board, you may add ONE sentence of synthesis if there's a clear headline angle (e.g., "Two sub-3.00 ERA aces square off in Game 3").
- Check `diagnostics.pillarErrors` — if any source failed, add a brief footer: "⚠️ [Source] data unavailable."

## Degraded Mode
If `diagnostics.pillarErrors` contains entries:
- Still render the board with whatever data is available.
- Append a footer: "⚠️ Degraded: [list failed sources]"
- Do NOT apologize or explain at length. Just flag it.
