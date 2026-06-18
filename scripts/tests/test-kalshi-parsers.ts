/**
 * Test: Kalshi parser functions
 * Validates line extraction from tickers and subject extraction from titles.
 * 
 * Run: npx tsx scripts/tests/test-kalshi-parsers.ts
 */

// === Parser functions (what the resolver SHOULD use) ===

function extractLineFromTicker(ticker: string): number | null {
  // KXMLBTOTAL-26JUN172140PITATH-8  → 8
  // KXMLBSPREAD-26JUN172140PITATH-PIT2  → 2 (but this has letters, so won't match)
  // KXMLBTOTAL-26JUN172140PITATH-9  → 9
  const match = ticker.match(/-(-?\d+(?:\.\d+)?)$/);
  return match ? Number(match[1]) : null;
}

function extractSpreadSubject(title: string): string | null {
  // "A's wins by over 3.5 runs?" → "A's"
  // "Pittsburgh wins by over 1.5 runs?" → "Pittsburgh"
  const match = title.match(/^(.+?)\s+wins?\s+by\s+/i);
  return match ? match[1].trim() : null;
}

function extractMoneylineSubject(title: string): string | null {
  // "Boston vs Seattle Winner?" → null (this is the event title, not market title)
  // But individual market titles look like: same title for both sides
  // Kalshi moneyline market tickers: KXMLBGAME-26JUN192210BOSSEA-BOS
  // The team abbrev is the ticker suffix
  const match = title.match(/^(.+?)\s+wins?\??$/i);
  return match ? match[1].trim() : null;
}

function extractTeamFromTicker(ticker: string): string | null {
  // KXMLBGAME-26JUN192210BOSSEA-BOS → BOS
  // KXMLBGAME-26JUN192210BOSSEA-SEA → SEA
  // KXMLBSPREAD-26JUN172140PITATH-PIT2 → PIT (strip trailing digits)
  const match = ticker.match(/-([A-Z]+)\d*$/);
  return match ? match[1] : null;
}

// === Test runner ===

let passed = 0;
let failed = 0;

function expect(actual: any, expected: any, label: string) {
  if (actual === expected) {
    console.log(`  ✅ ${label}: ${JSON.stringify(actual)}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  }
}

console.log("=== Line Extraction from Ticker ===");
expect(extractLineFromTicker("KXMLBTOTAL-26JUN172140PITATH-8"), 8, "Total line 8");
expect(extractLineFromTicker("KXMLBTOTAL-26JUN172140PITATH-9"), 9, "Total line 9");
expect(extractLineFromTicker("KXMLBTOTAL-26JUN172140PITATH-5"), 5, "Total line 5");
expect(extractLineFromTicker("KXMLBTOTAL-26JUN172140BALSEA-11"), 11, "Total line 11");
expect(extractLineFromTicker("KXMLBTOTAL-26JUN172140BALSEA-2"), 2, "Total line 2");

console.log("\n=== Spread Line from Ticker ===");
// Spread tickers: KXMLBSPREAD-26JUN172140PITATH-PIT2 → suffix has letters, not pure number
expect(extractLineFromTicker("KXMLBSPREAD-26JUN172140PITATH-PIT2"), null, "Spread ticker with letters → null");
expect(extractLineFromTicker("KXMLBSPREAD-26JUN172140PITATH-ATH3"), null, "Spread ticker ATH3 → null");

console.log("\n=== Spread Subject from Title ===");
expect(extractSpreadSubject("A's wins by over 3.5 runs?"), "A's", "A's spread subject");
expect(extractSpreadSubject("Pittsburgh wins by over 1.5 runs?"), "Pittsburgh", "Pittsburgh spread subject");
expect(extractSpreadSubject("Seattle wins by over 2.5 runs?"), "Seattle", "Seattle spread subject");
expect(extractSpreadSubject("Baltimore wins by over 1.5 runs?"), "Baltimore", "Baltimore spread subject");
expect(extractSpreadSubject("Boston vs Seattle Winner?"), null, "Non-spread title → null");

console.log("\n=== Spread Line from Title (fallback) ===");
function extractSpreadLineFromTitle(title: string): number | null {
  const match = title.match(/over\s+(\d+(?:\.\d+)?)\s+runs/i);
  return match ? Number(match[1]) : null;
}
expect(extractSpreadLineFromTitle("A's wins by over 3.5 runs?"), 3.5, "Spread line 3.5");
expect(extractSpreadLineFromTitle("Pittsburgh wins by over 1.5 runs?"), 1.5, "Spread line 1.5");
expect(extractSpreadLineFromTitle("Seattle wins by over 2.5 runs?"), 2.5, "Spread line 2.5");

console.log("\n=== Moneyline Subject from Title ===");
expect(extractMoneylineSubject("Pittsburgh wins?"), "Pittsburgh", "Pittsburgh moneyline");
expect(extractMoneylineSubject("A's win?"), "A's", "A's moneyline (singular win)");
// But Kalshi actual moneyline titles are: "Boston vs Seattle Winner?"
expect(extractMoneylineSubject("Boston vs Seattle Winner?"), null, "Event-style title → null");

console.log("\n=== Team from Ticker (alternative approach) ===");
expect(extractTeamFromTicker("KXMLBGAME-26JUN192210BOSSEA-BOS"), "BOS", "BOS from game ticker");
expect(extractTeamFromTicker("KXMLBGAME-26JUN192210BOSSEA-SEA"), "SEA", "SEA from game ticker");
expect(extractTeamFromTicker("KXMLBGAME-26JUN192210BALLAD-LAD"), "LAD", "LAD from game ticker");
expect(extractTeamFromTicker("KXMLBSPREAD-26JUN172140PITATH-PIT2"), "PIT", "PIT from spread ticker");
expect(extractTeamFromTicker("KXMLBSPREAD-26JUN172140PITATH-ATH3"), "ATH", "ATH from spread ticker");
expect(extractTeamFromTicker("KXMLBTOTAL-26JUN172140PITATH-8"), null, "Total ticker (numeric) → null");

console.log("\n=== Now test what Flash's resolver ACTUALLY does ===");
console.log("Flash uses: marketId.match(/-(-?\\d+(?:\\.\\d+)?)$/)");
console.log("Flash uses: subject = subtitle (for Kalshi)");

// Simulate Flash's current line extraction
function flashLineExtraction(marketId: string): number {
  const match = marketId.match(/-(-?\d+(?:\.\d+)?)$/);
  return match ? parseFloat(match[1]) : 0;
}

expect(flashLineExtraction("KXMLBTOTAL-26JUN172140PITATH-8"), 8, "Flash total line 8");
expect(flashLineExtraction("KXMLBTOTAL-26JUN172140PITATH-9"), 9, "Flash total line 9");
expect(flashLineExtraction("KXMLBSPREAD-26JUN172140PITATH-PIT2"), 2, "Flash spread PIT2 → 2 (wrong! captures trailing 2)");
expect(flashLineExtraction("KXMLBSPREAD-26JUN172140PITATH-ATH3"), 3, "Flash spread ATH3 → 3 (wrong! captures trailing 3)");
expect(flashLineExtraction("KXMLBSPREAD-26JUN172140PITATH-ATH4"), 4, "Flash spread ATH4 → 4 (coincidentally right value, wrong source)");

// Simulate Flash's subject extraction (uses subtitle)
function flashSubjectExtraction(subtitle: string): string {
  return subtitle || "yes";
}

console.log("\n=== Flash subject extraction (subtitle-based) ===");
// From Kalshi API probe, sub_title was empty/null for most markets
expect(flashSubjectExtraction(""), "yes", "Empty subtitle → defaults to 'yes'");
expect(flashSubjectExtraction(""), "yes", "Null subtitle → defaults to 'yes'");

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
