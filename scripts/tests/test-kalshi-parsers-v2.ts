/**
 * Extended test: Kalshi parser functions (Flash's v2 proposal)
 * Tests comparator extraction, spread/total line parsing, and subject extraction.
 * 
 * Run: npx tsx scripts/tests/test-kalshi-parsers-v2.ts
 */

// === Parser functions from Flash's v2 proposal ===

function extractSpreadSubject(title: string): string | null {
  const match = title.match(/^(.+?)\s+wins?\s+by\s+/i);
  return match ? match[1].trim() : null;
}

function extractSpreadFromTitle(title: string): { line: number; comparator: string } | null {
  // over/under N runs
  let m = title.match(/\b(over|under)\s+(\d+(?:\.\d+)?)\s+runs?\b/i);
  if (m) return { line: Number(m[2]), comparator: m[1].toLowerCase() };
  // "N or more runs" / "N+ runs" → treat as over
  m = title.match(/\b(\d+(?:\.\d+)?)\s*(?:\+|or\s+more)\s+runs?\b/i);
  if (m) return { line: Number(m[1]), comparator: "over" };
  // bare "by N runs" → exact-margin, default over
  m = title.match(/\bby\s+(\d+(?:\.\d+)?)\s+runs?\b/i);
  if (m) return { line: Number(m[1]), comparator: "over" };
  return null;
}

function extractTotalFromMarket(marketId: string, title: string): { line: number; comparator: string } | null {
  const compMatch = title.match(/\b(over|under)\b/i);
  const comparator = compMatch ? compMatch[1].toLowerCase() : "over";

  // ticker suffix: a bare number after the final dash
  const tickerMatch = marketId.match(/-(\d+(?:\.\d+)?)$/);
  if (tickerMatch) return { line: Number(tickerMatch[1]), comparator };

  // title: "over/under N runs" or "total ... N"
  let m = title.match(/\b(?:over|under)\s+(\d+(?:\.\d+)?)\b/i);
  if (m) return { line: Number(m[1]), comparator };
  m = title.match(/\btotal\b[^0-9]*(\d+(?:\.\d+)?)/i);
  if (m) return { line: Number(m[1]), comparator };
  return null;
}

function extractTeamFromTicker(ticker: string): string | null {
  const match = ticker.match(/-([A-Z]+)\d*$/);
  return match ? match[1] : null;
}

function extractSpreadLineGeneric(text: string): number | null {
  const m = text.match(/(?:^|\s)([-+]\d+(?:\.\d+)?)(?=\s|$)/);
  return m ? Number(m[1]) : null;
}

function extractTotalLineGeneric(text: string): number | null {
  const m = text.match(/\b(?:over|under|total)\b[^0-9]*(\d+(?:\.\d+)?)/i);
  return m ? Number(m[1]) : null;
}

// === Test runner ===

let passed = 0;
let failed = 0;

function expectEq(actual: any, expected: any, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}: expected ${e}, got ${a}`);
    failed++;
  }
}

// ===== SPREAD FROM TITLE (with comparator) =====
console.log("=== extractSpreadFromTitle ===");
expectEq(
  extractSpreadFromTitle("A's wins by over 3.5 runs?"),
  { line: 3.5, comparator: "over" },
  "A's over 3.5"
);
expectEq(
  extractSpreadFromTitle("Yankees wins by under 2 runs?"),
  { line: 2, comparator: "under" },
  "Yankees under 2"
);
expectEq(
  extractSpreadFromTitle("Mets wins by 3 or more runs?"),
  { line: 3, comparator: "over" },
  "Mets 3 or more → over"
);
expectEq(
  extractSpreadFromTitle("Pittsburgh wins by over 1.5 runs?"),
  { line: 1.5, comparator: "over" },
  "Pittsburgh over 1.5"
);
expectEq(
  extractSpreadFromTitle("Seattle wins by over 2.5 runs?"),
  { line: 2.5, comparator: "over" },
  "Seattle over 2.5"
);
expectEq(
  extractSpreadFromTitle("Baltimore wins by over 1.5 runs?"),
  { line: 1.5, comparator: "over" },
  "Baltimore over 1.5"
);
expectEq(
  extractSpreadFromTitle("Boston vs Seattle Winner?"),
  null,
  "Non-spread title → null"
);

// ===== TOTAL FROM MARKET (ticker + title) =====
console.log("\n=== extractTotalFromMarket ===");
expectEq(
  extractTotalFromMarket("KXMLBTOTAL-25X-8", "Over/Under total runs"),
  { line: 8, comparator: "over" },
  "Ticker -8, title 'Over' → over 8"
);
expectEq(
  extractTotalFromMarket("KX-noNum", "Under 8.5 total runs"),
  { line: 8.5, comparator: "under" },
  "No ticker num, title 'Under 8.5' → under 8.5"
);
expectEq(
  extractTotalFromMarket("KXMLBTOTAL-26JUN172140PITATH-8", "Pittsburgh vs A's Total Runs?"),
  { line: 8, comparator: "over" },
  "Real ticker -8, no over/under in title → defaults to over"
);
expectEq(
  extractTotalFromMarket("KXMLBTOTAL-26JUN172140PITATH-9", "Pittsburgh vs A's Total Runs?"),
  { line: 9, comparator: "over" },
  "Real ticker -9"
);
expectEq(
  extractTotalFromMarket("KXMLBTOTAL-26JUN172140PITATH-11", "Pittsburgh vs A's Total Runs?"),
  { line: 11, comparator: "over" },
  "Real ticker -11"
);

// ===== SPREAD SUBJECT =====
console.log("\n=== extractSpreadSubject ===");
expectEq(extractSpreadSubject("A's wins by over 3.5 runs?"), "A's", "A's");
expectEq(extractSpreadSubject("Pittsburgh wins by over 1.5 runs?"), "Pittsburgh", "Pittsburgh");
expectEq(extractSpreadSubject("Seattle wins by over 2.5 runs?"), "Seattle", "Seattle");
expectEq(extractSpreadSubject("Baltimore wins by over 1.5 runs?"), "Baltimore", "Baltimore");
expectEq(extractSpreadSubject("Los Angeles D wins by over 1.5 runs?"), "Los Angeles D", "LA Dodgers multi-word");

// ===== TEAM FROM TICKER =====
console.log("\n=== extractTeamFromTicker ===");
expectEq(extractTeamFromTicker("KXMLBGAME-26JUN192210BOSSEA-BOS"), "BOS", "BOS");
expectEq(extractTeamFromTicker("KXMLBGAME-26JUN192210BOSSEA-SEA"), "SEA", "SEA");
expectEq(extractTeamFromTicker("KXMLBGAME-26JUN192210BALLAD-LAD"), "LAD", "LAD");
expectEq(extractTeamFromTicker("KXMLBGAME-26JUN171305MIAPHI-PHI"), "PHI", "PHI");
expectEq(extractTeamFromTicker("KXMLBSPREAD-26JUN172140PITATH-PIT2"), "PIT", "PIT from spread (strips trailing digit)");
expectEq(extractTeamFromTicker("KXMLBTOTAL-26JUN172140PITATH-8"), null, "Total ticker (numeric) → null");

// ===== GENERIC GUARDS =====
console.log("\n=== Generic parsers (non-Kalshi) ===");
expectEq(extractTotalLineGeneric("2024 World Series total 8.5"), 8.5, "Grabs 8.5, not 2024");
expectEq(extractTotalLineGeneric("over 9.5 total"), 9.5, "over 9.5");
expectEq(extractTotalLineGeneric("Total runs: 7"), 7, "Total runs: 7");
expectEq(extractSpreadLineGeneric("Yankees -1.5 vs Red Sox +1.5"), -1.5, "Grabs -1.5 (first signed number)");
expectEq(extractSpreadLineGeneric("Run line +2.5"), 2.5, "Run line +2.5");
expectEq(extractSpreadLineGeneric("Spread: -3.0"), -3.0, "Spread: -3.0");

// ===== EDGE CASE: What the current resolver does with the new parsers =====
console.log("\n=== Integration simulation: Kalshi resolver branch ===");

function simulateKalshiResolver(series_ticker: string, marketId: string, title: string) {
  let marketType = "moneyline";
  let line = 0;
  let comparator = "yes";
  let subject = "unknown";

  const st = series_ticker;
  if (st.includes("KXMLBGAME")) {
    marketType = "moneyline";
    subject = extractTeamFromTicker(marketId) ?? subject;
    comparator = "win";
  } else if (st.includes("KXMLBSPREAD")) {
    marketType = "spread";
    subject = extractSpreadSubject(title) ?? subject;
    const sp = extractSpreadFromTitle(title);
    if (sp) { line = sp.line; comparator = sp.comparator; }
  } else if (st.includes("KXMLBTOTAL")) {
    marketType = "total";
    const tot = extractTotalFromMarket(marketId, title);
    if (tot) { line = tot.line; comparator = tot.comparator; }
  }

  return { marketType, line, comparator, subject };
}

// Moneyline
expectEq(
  simulateKalshiResolver("KXMLBGAME-26JUN192210BOSSEA", "KXMLBGAME-26JUN192210BOSSEA-BOS", "Boston vs Seattle Winner?"),
  { marketType: "moneyline", line: 0, comparator: "win", subject: "BOS" },
  "Moneyline: BOS"
);
expectEq(
  simulateKalshiResolver("KXMLBGAME-26JUN192210BOSSEA", "KXMLBGAME-26JUN192210BOSSEA-SEA", "Boston vs Seattle Winner?"),
  { marketType: "moneyline", line: 0, comparator: "win", subject: "SEA" },
  "Moneyline: SEA"
);

// Spread
expectEq(
  simulateKalshiResolver("KXMLBSPREAD-26JUN172140PITATH", "KXMLBSPREAD-26JUN172140PITATH-PIT2", "Pittsburgh wins by over 1.5 runs?"),
  { marketType: "spread", line: 1.5, comparator: "over", subject: "Pittsburgh" },
  "Spread: Pittsburgh over 1.5"
);
expectEq(
  simulateKalshiResolver("KXMLBSPREAD-26JUN172140PITATH", "KXMLBSPREAD-26JUN172140PITATH-ATH3", "A's wins by over 2.5 runs?"),
  { marketType: "spread", line: 2.5, comparator: "over", subject: "A's" },
  "Spread: A's over 2.5"
);

// Total
expectEq(
  simulateKalshiResolver("KXMLBTOTAL-26JUN172140PITATH", "KXMLBTOTAL-26JUN172140PITATH-8", "Pittsburgh vs A's Total Runs?"),
  { marketType: "total", line: 8, comparator: "over", subject: "unknown" },
  "Total: line 8 (from ticker)"
);
expectEq(
  simulateKalshiResolver("KXMLBTOTAL-26JUN172140PITATH", "KXMLBTOTAL-26JUN172140PITATH-11", "Pittsburgh vs A's Total Runs?"),
  { marketType: "total", line: 11, comparator: "over", subject: "unknown" },
  "Total: line 11 (from ticker)"
);

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
