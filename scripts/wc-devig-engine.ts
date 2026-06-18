/**
 * World Cup 3-Way Devig Engine
 *
 * Takes Pinnacle 3-way moneylines (Home / Draw / Away), removes the vig
 * to derive "fair" probabilities, then compares every soft-book price
 * against the Pinnacle fair line to find edges.
 *
 * Edge = (SoftBookImpliedProb - PinnacleFairProb)
 *   Positive edge = soft book is underpricing the outcome → bet opportunity
 *   Negative edge = soft book is overpricing → avoid
 */

import { Spanner } from "@google-cloud/spanner";

const PROJECT = "gen-lang-client-0281999829";
const INSTANCE = "clearspace";
const DB = "sports-worldcup-db";

const spanner = new Spanner({ projectId: PROJECT });
const db = spanner.instance(INSTANCE).database(DB);

// ── Math helpers ─────────────────────────────────────────────────────────────

/** American odds → implied probability (0–1) */
function americanToImplied(odds: number): number {
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

/** Implied probability (0–1) → American odds (rounded) */
function impliedToAmerican(prob: number): number {
  if (prob <= 0 || prob >= 1) return 0;
  if (prob >= 0.5) return Math.round(-(prob / (1 - prob)) * 100);
  return Math.round(((1 - prob) / prob) * 100);
}

/**
 * 3-way multiplicative devig (Pinnacle standard)
 * Given raw implied probs that sum to > 1 (due to vig),
 * divide each by the total to get fair probs summing to 1.
 */
function devig3Way(homeRaw: number, drawRaw: number, awayRaw: number): { home: number; draw: number; away: number; vig: number } {
  const total = homeRaw + drawRaw + awayRaw;
  return {
    home: homeRaw / total,
    draw: drawRaw / total,
    away: awayRaw / total,
    vig: total - 1, // overround / vig margin
  };
}

// ── Data types ───────────────────────────────────────────────────────────────

interface OddsRow {
  MatchId: string;
  HomeTeamCode: string;
  AwayTeamCode: string;
  Kickoff: string;
  TeamCode: string;
  Source: string;
  AmericanOdds: number;
}

interface MatchFair {
  matchId: string;
  home: string;
  away: string;
  kickoff: string;
  pinnacleVig: number;
  fairHome: number;
  fairDraw: number;
  fairAway: number;
  fairHomeAmerican: number;
  fairDrawAmerican: number;
  fairAwayAmerican: number;
}

interface Edge {
  matchId: string;
  home: string;
  away: string;
  kickoff: string;
  outcome: string; // HOME, DRAW, AWAY
  source: string;
  softOdds: number;
  softImplied: number;
  pinFair: number;
  edgePct: number; // positive = bet-worthy
  fairAmerican: number;
}

async function run() {
  // Pull all scheduled match odds
  const [rows] = await db.run({
    sql: `SELECT o.MatchId, m.HomeTeamCode, m.AwayTeamCode, m.Kickoff,
                 o.TeamCode, o.Source, o.AmericanOdds
          FROM WorldCupOdds o
          JOIN WorldCupMatches m ON o.MatchId = m.MatchId
          WHERE m.Status = 'scheduled'
          ORDER BY m.Kickoff, o.MatchId, o.Source, o.TeamCode`,
  });

  const data: OddsRow[] = rows.map((r: any) => {
    const j = r.toJSON();
    return {
      MatchId: j.MatchId,
      HomeTeamCode: j.HomeTeamCode,
      AwayTeamCode: j.AwayTeamCode,
      Kickoff: j.Kickoff?.value || j.Kickoff,
      TeamCode: j.TeamCode,
      Source: j.Source,
      AmericanOdds: Number(j.AmericanOdds),
    };
  });

  console.log(`Loaded ${data.length} odds rows for scheduled matches\n`);

  // Group by match
  const byMatch = new Map<string, OddsRow[]>();
  for (const row of data) {
    if (!byMatch.has(row.MatchId)) byMatch.set(row.MatchId, []);
    byMatch.get(row.MatchId)!.push(row);
  }

  // ── Phase 1: Compute Pinnacle fair prices ────────────────────────────────

  const fairPrices = new Map<string, MatchFair>();

  for (const [matchId, matchRows] of byMatch) {
    const pinRows = matchRows.filter(r => r.Source === "pinnacle");
    const homeRow = pinRows.find(r => r.TeamCode === matchRows[0].HomeTeamCode);
    const drawRow = pinRows.find(r => r.TeamCode === "DRAW");
    const awayRow = pinRows.find(r => r.TeamCode === matchRows[0].AwayTeamCode);

    if (!homeRow || !drawRow || !awayRow) {
      console.warn(`[SKIP] ${matchId}: Missing Pinnacle 3-way (H=${!!homeRow} D=${!!drawRow} A=${!!awayRow})`);
      continue;
    }

    const homeImp = americanToImplied(homeRow.AmericanOdds);
    const drawImp = americanToImplied(drawRow.AmericanOdds);
    const awayImp = americanToImplied(awayRow.AmericanOdds);

    const fair = devig3Way(homeImp, drawImp, awayImp);

    fairPrices.set(matchId, {
      matchId,
      home: homeRow.HomeTeamCode,
      away: homeRow.AwayTeamCode,
      kickoff: homeRow.Kickoff,
      pinnacleVig: fair.vig,
      fairHome: fair.home,
      fairDraw: fair.draw,
      fairAway: fair.away,
      fairHomeAmerican: impliedToAmerican(fair.home),
      fairDrawAmerican: impliedToAmerican(fair.draw),
      fairAwayAmerican: impliedToAmerican(fair.away),
    });
  }

  console.log(`═══ PINNACLE FAIR PRICES (${fairPrices.size} matches) ═══\n`);
  console.log("Match".padEnd(20) + "Home".padEnd(6) + "Away".padEnd(6) + "FairH%".padEnd(9) + "FairD%".padEnd(9) + "FairA%".padEnd(9) + "Vig%".padEnd(8) + "FairH".padEnd(9) + "FairD".padEnd(9) + "FairA");

  for (const fp of fairPrices.values()) {
    console.log(
      `${fp.home} v ${fp.away}`.padEnd(20) +
      fp.home.padEnd(6) +
      fp.away.padEnd(6) +
      (fp.fairHome * 100).toFixed(1).padStart(5).padEnd(9) +
      (fp.fairDraw * 100).toFixed(1).padStart(5).padEnd(9) +
      (fp.fairAway * 100).toFixed(1).padStart(5).padEnd(9) +
      (fp.pinnacleVig * 100).toFixed(2).padStart(5).padEnd(8) +
      String(fp.fairHomeAmerican).padEnd(9) +
      String(fp.fairDrawAmerican).padEnd(9) +
      String(fp.fairAwayAmerican)
    );
  }

  // ── Phase 2: Compute edges ───────────────────────────────────────────────

  const edges: Edge[] = [];

  for (const [matchId, matchRows] of byMatch) {
    const fp = fairPrices.get(matchId);
    if (!fp) continue;

    const softRows = matchRows.filter(r => r.Source !== "pinnacle");

    for (const row of softRows) {
      const softImplied = americanToImplied(row.AmericanOdds);

      let pinFair: number;
      let outcome: string;

      if (row.TeamCode === fp.home) {
        pinFair = fp.fairHome;
        outcome = "HOME";
      } else if (row.TeamCode === "DRAW") {
        pinFair = fp.fairDraw;
        outcome = "DRAW";
      } else if (row.TeamCode === fp.away) {
        pinFair = fp.fairAway;
        outcome = "AWAY";
      } else {
        continue; // Unknown team code
      }

      // Edge = PinnacleFairProb - SoftBookImpliedProb
      // Positive = soft book implies lower prob → the odds are better than fair → edge
      const edgePct = pinFair - softImplied;

      edges.push({
        matchId,
        home: fp.home,
        away: fp.away,
        kickoff: fp.kickoff,
        outcome,
        source: row.Source,
        softOdds: row.AmericanOdds,
        softImplied,
        pinFair,
        edgePct,
        fairAmerican: outcome === "HOME" ? fp.fairHomeAmerican :
                      outcome === "DRAW" ? fp.fairDrawAmerican : fp.fairAwayAmerican,
      });
    }
  }

  // Sort by edge (largest positive first)
  edges.sort((a, b) => b.edgePct - a.edgePct);

  // ── Phase 3: Report ──────────────────────────────────────────────────────

  const positiveEdges = edges.filter(e => e.edgePct > 0.01); // > 1% edge

  console.log(`\n═══ TOP EDGES (> 1%) — ${positiveEdges.length} found ═══\n`);
  console.log(
    "Match".padEnd(16) +
    "Outcome".padEnd(8) +
    "Book".padEnd(14) +
    "BookOdds".padEnd(10) +
    "BookImpl%".padEnd(10) +
    "PinFair%".padEnd(10) +
    "FairOdds".padEnd(10) +
    "Edge%"
  );

  for (const e of positiveEdges.slice(0, 40)) {
    console.log(
      `${e.home}v${e.away}`.padEnd(16) +
      e.outcome.padEnd(8) +
      e.source.padEnd(14) +
      String(e.softOdds).padEnd(10) +
      (e.softImplied * 100).toFixed(1).padStart(6).padEnd(10) +
      (e.pinFair * 100).toFixed(1).padStart(6).padEnd(10) +
      String(e.fairAmerican).padEnd(10) +
      `+${(e.edgePct * 100).toFixed(2)}%`
    );
  }

  // Summary stats
  console.log(`\n═══ SUMMARY ═══`);
  console.log(`Total scheduled matches analyzed: ${fairPrices.size}`);
  console.log(`Total soft-book comparisons: ${edges.length}`);
  console.log(`Edges > 1%: ${positiveEdges.length}`);
  console.log(`Edges > 3%: ${edges.filter(e => e.edgePct > 0.03).length}`);
  console.log(`Edges > 5%: ${edges.filter(e => e.edgePct > 0.05).length}`);

  // Average vig by book
  console.log(`\n═══ AVERAGE VIG BY BOOK ═══`);
  const vigByBook = new Map<string, number[]>();
  for (const [matchId, matchRows] of byMatch) {
    const bookGroups = new Map<string, OddsRow[]>();
    for (const r of matchRows) {
      if (!bookGroups.has(r.Source)) bookGroups.set(r.Source, []);
      bookGroups.get(r.Source)!.push(r);
    }
    for (const [source, sRows] of bookGroups) {
      if (sRows.length === 3) {
        const total = sRows.reduce((s, r) => s + americanToImplied(r.AmericanOdds), 0);
        if (!vigByBook.has(source)) vigByBook.set(source, []);
        vigByBook.get(source)!.push((total - 1) * 100);
      }
    }
  }
  for (const [source, vigs] of [...vigByBook.entries()].sort((a, b) => avg(a[1]) - avg(b[1]))) {
    console.log(`  ${source.padEnd(14)} avg vig: ${avg(vigs).toFixed(2)}% (${vigs.length} markets)`);
  }

  db.close();
}

function avg(nums: number[]): number {
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
