# Truth Edge Engine Real-Data Cutover Spec

## Purpose

Truth must produce user-facing edge readouts from real live source data only. Mock, simulated, fixture, or pre-seeded data may exist for unit/integration tests, but must never power production routes, MCP tools, or user-facing narratives.

This spec converts the current resolver/edge-engine work from a passing simulated E2E into a production-ready real-data path.

## Naming Rule

Use **Truth** for the product/project name in all user-facing copy, docs, logs, route descriptions, and specs.

Do not call the product "Anti Gravity". Anti Gravity is the Google agent/environment, not the project.

Required cleanup:

- Rename test banners from `Anti Gravity E2E Edge Engine Test` to `Truth E2E Edge Engine Test`.
- Rename docs references from `Anti Gravity Edge Engine` to `Truth Edge Engine` unless explicitly referring to the Google tool/environment.
- Rename staged specs/docs accordingly.

## Current Status From Agent Report

The following appear complete based on the latest agent report:

- Spanner mutation key failures were fixed by replacing table upsert/insert calls with transactional SQL `INSERT OR UPDATE` DML.
- Explicit Spanner parameter type maps were added for JSON, TIMESTAMP, FLOAT64, STRING, BOOL.
- Float64 values were wrapped with `Spanner.float()` where required.
- `syncFromHistory(gamePk)` was added to bridge `MlbOddsHistory` into `OddsSnapshot`.
- `computeEdgeState(gamePk)` invokes `syncFromHistory(gamePk)` before computing edge state.
- `npx tsc --noEmit` reportedly passes.
- Simulated integration script reportedly passes.

These are good engineering fixes, but the current E2E still uses mock/simulated data. That means the integration test passing is not sufficient production proof.

## Critical Production Rule

User-facing routes and tools must reject simulated data.

Applies to:

- `GET /api/edge/board`
- `GET /api/edge/game/:gamePk`
- `get_edge_readout`
- Any UI dashboard using the edge API
- Any narrative response presented to the user as real

Required guard:

```ts
export function assertLiveEdgeSource(sourceMeta: EdgeSourceMeta[]) {
  for (const source of sourceMeta) {
    if (source.isSimulated !== false) {
      throw new Error("User-facing edge routes cannot use simulated data");
    }
  }
}
```

If `isSimulated` is missing, null, or undefined, treat it as unsafe.

Allowed exceptions only:

```ts
NODE_ENV === "test"
```

or explicit local-only flag:

```ts
ALLOW_EDGE_FIXTURES=true
```

Production and staging user-facing routes must default to live-only.

## Required Source Metadata Contract

Every edge candidate returned to a user must include provenance.

```ts
export type EdgeSourceMeta = {
  source: "odds_api" | "espn" | "mlb_stats" | "polymarket" | "kalshi" | "spanner_history";
  bookmaker?: string;
  eventId: string;
  market: string;
  fetchedAt: string;
  sourceUpdatedAt?: string | null;
  isSimulated: false;
};
```

Rules:

- `isSimulated` must be explicitly false.
- `fetchedAt` must be populated.
- `eventId` must be populated.
- Book prices must include bookmaker identity.
- If data was generated from `MlbOddsHistory`, source should still preserve the original provider/bookmaker and the historical snapshot timestamp.

## Live Data Cutover Requirements

The simulated E2E is not enough. Add a live-read smoke test that uses existing real Spanner data.

### Required script

Create:

```text
scripts/smoke-edge-live.ts
```

Purpose:

- Select a real MLB game with available odds history.
- Verify Pinnacle exists in the real data for at least one market if available.
- Verify book tiers resolve using existing tier config.
- Run `computeEdgeState(gamePk)` against real data only.
- Verify `GameEdgeState` writes successfully.
- Verify no edge source metadata is simulated.
- Verify any emitted narrative passes title/selection quality gates.

### Script behavior

Pseudocode:

```ts
async function main() {
  const gamePk = await findRecentGameWithOddsHistory({
    requireAnyOdds: true,
    preferPinnacle: true,
  });

  if (!gamePk) {
    throw new Error("No real MLB game with odds history found");
  }

  const state = await edgeEngine.computeEdgeState(gamePk, {
    sourceMode: "live",
    allowFixtures: false,
  });

  assertNoSimulatedSources(state.sourceMeta);
  assertNoPlaceholderLeak(JSON.stringify(state));
  assertNoGroupedPlayerPropEdges(state.edges ?? []);

  console.log("✅ Truth live edge smoke passed", { gamePk });
}
```

Do not seed mock games, mock odds, mock Polymarket tokens, or mock EdgeOutcome rows in this script.

## Keep Simulated Tests, But Label Them Correctly

The existing `scripts/test-edge-engine.ts` is valuable as an integration/fixture test, but it must be renamed or clearly labeled.

Recommended rename:

```text
scripts/test-edge-engine-fixture.ts
```

Banner:

```text
=== Truth Fixture E2E Edge Engine Test ===
```

It must not be confused with live verification.

## Pinnacle and Book Tier Logic

Use existing book-tier code/config. Do not create a second tier implementation.

Expected behavior:

1. Pinnacle is primary sharp anchor.
2. If Pinnacle is missing/stale for a market, use configured fallback Tier 1 sharp books.
3. If no Tier 1 exists, use broader consensus with downgraded confidence.
4. Never claim Pinnacle-led movement unless historical snapshots prove observed lead-lag order.

### Anchor selection contract

```ts
export type SharpAnchorSelection =
  | {
      type: "primary_anchor";
      label: "Pinnacle";
      books: NormalizedBookPrice[];
    }
  | {
      type: "fallback_tier1_consensus";
      label: "Tier 1 sharp consensus";
      books: NormalizedBookPrice[];
    }
  | {
      type: "market_consensus";
      label: "Market consensus";
      books: NormalizedBookPrice[];
      confidencePenalty: number;
    }
  | {
      type: "no_anchor";
      label: "No sharp anchor available";
      books: [];
      confidencePenalty: number;
    };
```

### User-facing wording

If historical lead/lag is proven:

```text
Pinnacle moved first in observed snapshots, and tier-2 books followed.
```

If historical lead/lag is not proven:

```text
Pinnacle is the sharp reference here, and this book is still off the sharper number.
```

Do not say:

```text
Pinnacle caused the move.
```

## Edge Unit Rules

### Main markets

Valid unit:

```text
event + market + outcome + bookmaker + price
```

Example:

```text
Braves ML -118 at BetMGM
```

### Player props

Valid unit:

```text
event + player + stat + side + line + bookmaker + price
```

Example:

```text
Aaron Judge over 1.5 total bases +125 at DraftKings
```

Hard block:

```text
No player-prop edge without player + stat + side + line + price.
```

Reject:

```text
Yankees vs Red Sox player props edge
```

That is a category, not a bettable selection.

## Market Title Quality Gate

Block all user-facing titles containing:

```text
awayAbbr
homeAbbr
teamAbbr
opponentAbbr
undefined
null
${
{{
}}
```

Bad:

```text
Will Norway wins by over 2.5 goals (IRQ vs awayAbbr on Jun 26)?
```

Good:

```text
Norway to beat Iraq by 3+ goals — Jun 26
```

or:

```text
Norway -2.5 vs Iraq — Jun 26
```

Required function:

```ts
export function assertNoPlaceholderLeak(text: string) {
  const forbidden = [
    "awayAbbr",
    "homeAbbr",
    "teamAbbr",
    "opponentAbbr",
    "undefined",
    "null",
    "${",
    "{{",
    "}}",
  ];

  for (const token of forbidden) {
    if (text.includes(token)) {
      throw new Error(`Template leak detected: ${token}`);
    }
  }
}
```

## API Response Contract

`GET /api/edge/board` must return:

```ts
export type EdgeBoardResponse = {
  generatedAt: string;
  sourceMode: "live";
  sport?: string;
  edges: EdgeCard[];
  warnings?: string[];
};
```

`EdgeCard`:

```ts
export type EdgeCard = {
  edgeId: string;
  sport: string;
  league: string;

  event: {
    eventId: string;
    label: string;
    startTime: string;
  };

  market: {
    group: "main" | "derivative" | "player_props" | "team_props" | "prediction";
    type: string;
    label: string;
  };

  selection: {
    label: string;
    playerName?: string;
    teamName?: string;
    side: string;
    line?: number | null;
  };

  book: {
    bookmaker: string;
    offeredPriceAmerican?: number;
    offeredPriceDecimal?: number;
    offeredAsk?: number;
    offeredBid?: number;
  };

  fair: {
    anchorType: "pinnacle" | "tier1_consensus" | "market_consensus" | "model" | "cobb";
    fairProbability: number;
    fairPriceAmerican?: number;
  };

  edge: {
    estimatedEV?: number;
    probabilityPointGap?: number;
    confidence: number;
    urgency: "low" | "medium" | "high";
    signals: string[];
    riskFlags: string[];
  };

  narrative: {
    headline: string;
    summary: string;
    lean?: string;
    receipts?: string[];
  };

  sourceMeta: EdgeSourceMeta[];
};
```

## Narrative Requirements

Default narrative must collapse complexity into sport-native betting language.

### MLB example

```text
Braves ML still looks stale at BetMGM.

Pinnacle and the sharper part of the market are closer to Braves -130, but BetMGM is still showing -118. Starters are confirmed and there’s no obvious lineup downgrade.

Lean: Braves ML if you can still get -120 or better.
```

### Soccer example

```text
Norway -2.5 is the cleaner display.

This is a handicap-style market: Norway need to win by 3+ goals. Do not show this as “IRQ vs awayAbbr” or as a generic match market.
```

### Prediction market example

```text
Polymarket is cheaper than the sportsbook reference, but liquidity matters.

YES is offered around 42¢ while the sharper sportsbook-equivalent probability is closer to 46%. Treat it as actionable only if the ask is still there and the contract terms match.
```

## Approval Modal UX Fix

The current approval modal reportedly displays generic Spanner/live-database warning copy for `write_staged_file`, even when writing a staged spec to:

```text
forge/staged/specs/...
```

This is unsafe UX because it trains users to ignore warnings.

Add a separate issue/spec for approval modal copy and severity.

### Required behavior

Tool-specific approval labels:

- `write_staged_file`: "Stage file for review"; severity low/medium; no live DB language.
- `execute_ddl`: "Modify live Spanner schema"; severity high.
- `execute_sql` DML: "Modify live Spanner rows"; severity high.
- `deploy_staged_mcp`: "Deploy staged code to Cloud Run"; severity high.
- `write_storage_text`: "Write Cloud Storage object"; severity depends on bucket/path.

Do not show "modify live database state" for staging file writes.

## Acceptance Criteria

### Compile

```bash
npx tsc --noEmit
```

must pass.

### Fixture test

```bash
npx tsx scripts/test-edge-engine-fixture.ts
```

must pass and clearly label itself as fixture/simulated.

### Live smoke

```bash
npx tsx scripts/smoke-edge-live.ts
```

must pass without inserting mock games, mock odds, mock markets, or mock outcomes.

### API route validation

Call:

```http
GET /api/edge/board
GET /api/edge/game/:gamePk
```

Both must:

- return `sourceMode: "live"`
- include source metadata with `isSimulated: false`
- reject missing source metadata
- include no unresolved placeholders
- include no category-only player prop edges
- use Truth naming

## Final Definition of Done

Truth Edge Engine is production-ready only when:

1. Simulated fixture tests pass.
2. Live smoke test passes against real Spanner odds history.
3. User-facing routes hard-block simulated data.
4. Pinnacle is recognized as primary sharp anchor from real data.
5. Fallback Tier 1 sharp consensus works from existing tier config.
6. User-facing narratives use sport-native language.
7. No placeholder leaks occur.
8. No grouped player prop market is emitted as a bet.
9. Source metadata is present and explicit.
10. Docs and logs say Truth, not Anti Gravity.
