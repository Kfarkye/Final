import { edgeDb, spannerClient } from "../../src/db/spanner";

async function main() {
  console.log("=== Prediction Market Real-Data Live Audit ===");

  try {
    console.log("1. Querying live Spanner database for active/resolved market events...");
    
    // First attempt: Get active events with non-expired contracts
    let [rows] = await edgeDb.run({
      sql: `
        SELECT DISTINCT m.CanonicalEventId
        FROM PmResolvedMarket m
        JOIN PmRawMarket rm ON m.Platform = rm.Platform AND m.MarketId = rm.MarketId
        WHERE rm.CloseTimeUtc IS NULL OR rm.CloseTimeUtc >= CURRENT_TIMESTAMP()
        LIMIT 5
      `
    });

    if (rows.length === 0) {
      console.log("⚠️ No active markets found. Falling back to any resolved market event ID...");
      [rows] = await edgeDb.run({
        sql: `
          SELECT DISTINCT CanonicalEventId
          FROM PmResolvedMarket
          LIMIT 5
        `
      });
    }

    if (rows.length === 0) {
      console.error("❌ Error: No events found in PmResolvedMarket database table. Cannot audit.");
      process.exit(1);
    }

    const eventIds = rows.map((r: any) => r.toJSON().CanonicalEventId);
    console.log(`Found event IDs to test: ${eventIds.join(", ")}`);

    const targetEventId = eventIds[0];
    const endpointUrl = `https://reverie-70323048967.us-central1.run.app/api/pm/markets/${targetEventId}`;
    
    console.log(`2. Executing fetch request against live endpoint: ${endpointUrl}`);
    const response = await fetch(endpointUrl);
    
    if (!response.ok) {
      console.error(`❌ Endpoint returned HTTP error: ${response.status} - ${response.statusText}`);
      const text = await response.text();
      console.error("Response body:", text);
      process.exit(1);
    }

    const payload = await response.json();
    console.log("3. Deployed endpoint returned the following live JSON payload:");
    console.log(JSON.stringify(payload, null, 2));

    if (!Array.isArray(payload)) {
      console.error("❌ Error: Deployed endpoint response payload is not an array!");
      process.exit(1);
    }

    console.log(`\n✅ Verification successful! Successfully retrieved ${payload.length} contracts for Event ID: ${targetEventId}`);
    
  } catch (err: any) {
    console.error("❌ Error during live audit:", err);
    process.exit(1);
  } finally {
    await spannerClient.close();
  }
}

main();
