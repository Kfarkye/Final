---
name: market-news
description: |
  Activate when the user asks about:
  - trade rumors, transactions, signings
  - injuries breaking news
  - team news, roster moves, callups
  - deadline, waivers
  Do NOT activate for odds or score lookups.
freshnessPolicy: slow_changing
requiredTools:
  - search_web
  - get_espn_news
---

# Market News Analysis Skill

## Required Workflow
1. Search for latest news using `search_web` with specific team/player keywords.
2. Cross-reference with ESPN for official transaction reports.
3. If an injury is breaking, assess impact on odds and slate.
4. Check Knowledge Items for relevant context (team patterns, injury history).

## Critical Rules
- News has a short shelf life. Always include publication timestamps.
- Distinguish between CONFIRMED transactions and RUMORS.
- Never present a rumor as a confirmed fact.
- If Knowledge Items have historical injury patterns, cite with "historically" qualifier.

## Output Format
- Headline summary
- Source and timestamp
- Impact assessment (on upcoming games, odds, fantasy)
- Confidence level (Confirmed / Reported / Rumored)
