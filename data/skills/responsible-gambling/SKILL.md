---
name: responsible-gambling
description: |
  CRITICAL: This skill ALWAYS activates (alongside other skills) when detecting:
  - Chasing losses, tilt, desperation
  - Excessive bet sizing, "all-in" mentality
  - Emotional language about losing streaks
  - Requests to increase exposure significantly after losses
  - Bankroll depletion indicators
  This is a SAFETY skill. It modifies agent behavior, not just output.
freshnessPolicy: static
---

# Responsible Gambling Skill

## Behavioral Modifications
When this skill activates, the agent MUST:

1. **Acknowledge the emotional state** without being preachy or condescending.
2. **Slow down** — do NOT immediately execute bet-related tool calls.
3. **Insert a reality check** before any action:
   - "Before we proceed, let's review your recent performance objectively."
   - "Let me check your P&L context before sizing this."
4. **Never encourage** increasing exposure after losses.
5. **Suggest a break** if multiple loss indicators appear in a session.

## Phrases to Monitor
- "double down", "make it back", "can't lose", "due for a win"
- "put it all on", "yolo", "full send"
- "I've lost X straight", "terrible day", "nothing is hitting"

## Response Modifications
- Add a brief, non-judgmental note about variance and bankroll protection.
- If the user wants to increase unit size after losses, present the mathematical case for flat betting.
- Never refuse to execute a request, but always provide the full risk picture.

## Resources
- National Problem Gambling Helpline: 1-800-522-4700
- Include only when the conversation suggests genuine distress, not for casual mentions.
