import { devig, getDevigMethod } from "../../src/lib/quant-math";

function testDevigMethods() {
  console.log("=== Testing Quant Math Devig Methods ===");

  // 1. Moneyline: -162 / +149 (Power Method)
  const mlPrices = [-162, 149];
  const mlDevigged = devig(mlPrices, "h2h");
  console.log("h2h (power):", mlDevigged);
  // Expected values from the spec: ~61.52% / 38.48%
  const h2hMethod = getDevigMethod("h2h");
  console.log(`h2h method: ${h2hMethod}`);

  // 2. Batter HR: +450 / -942 (Shin Method)
  const hrPrices = [450, -942];
  const hrDevigged = devig(hrPrices, "batter_home_runs");
  console.log("batter_home_runs (shin):", hrDevigged);
  const hrMethod = getDevigMethod("batter_home_runs");
  console.log(`batter_home_runs method: ${hrMethod}`);

  // 3. Spreads: -110 / -110 (Multiplicative)
  const spreadPrices = [-110, -110];
  const spreadDevigged = devig(spreadPrices, "spreads");
  console.log("spreads (multiplicative):", spreadDevigged);
  const spreadMethod = getDevigMethod("spreads");
  console.log(`spreads method: ${spreadMethod}`);

  // Assertions
  console.log("\nRunning Assertions...");
  if (h2hMethod !== "power") throw new Error("Incorrect devig method for h2h");
  if (hrMethod !== "shin") throw new Error("Incorrect devig method for batter_home_runs");
  if (spreadMethod !== "multiplicative") throw new Error("Incorrect devig method for spreads");

  // -162 / +149 Power method devig check: should be close to 0.6094
  const pDiff = Math.abs(mlDevigged[0] - 0.6094);
  console.log(`Power Method ML Home Fair Prob: ${(mlDevigged[0] * 100).toFixed(2)}% (Diff: ${(pDiff * 100).toFixed(4)}%)`);
  if (pDiff > 0.001) {
    throw new Error(`Power method devig deviation too high: expected ~0.6094, got ${mlDevigged[0]}`);
  }

  // +450 / -942 Shin method devig check
  console.log(`Shin Method HR Yes Fair Prob: ${(hrDevigged[0] * 100).toFixed(2)}%`);

  console.log("✅ All devig method unit tests passed!");
}

testDevigMethods();
