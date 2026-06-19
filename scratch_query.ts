import { edgeDb } from './src/db/spanner.js';

async function audit() {
  try {
    const [crosswalkCount] = await edgeDb.run(`SELECT COUNT(*) as c FROM EventIdCrosswalk`);
    console.log("EventIdCrosswalk total rows:", crosswalkCount[0][0].value);

    const [crosswalkSample] = await edgeDb.run(`SELECT * FROM EventIdCrosswalk LIMIT 5`);
    if(crosswalkSample.length > 0) {
      console.log("EventIdCrosswalk sample:", crosswalkSample.map(r => r.map(c => c.value)));
    }

    const [oddsSample] = await edgeDb.run(`SELECT ProviderEventId, HomeTeam, AwayTeam FROM CurrentOdds LIMIT 5`);
    console.log("CurrentOdds sample:");
    console.table(oddsSample.map(r => ({ProviderEventId: r[0].value, HomeTeam: r[1].value, AwayTeam: r[2].value})));

  } catch (err: any) {
    console.error("Error:", err.message);
  }
}

audit();
