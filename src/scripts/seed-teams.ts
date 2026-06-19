import { edgeDb } from "../db/spanner";
import { Spanner } from "@google-cloud/spanner";

async function fetchTeams() {
  const res = await fetch("https://statsapi.mlb.com/api/v1/teams?sportId=1");
  const data = await res.json();
  return data.teams || [];
}

async function seedTeams() {
  console.log("Fetching MLB teams...");
  const teams = await fetchTeams();
  
  console.log(`Found ${teams.length} teams. Preparing to insert...`);

  const table = edgeDb.table("MlbTeamProfile");
  const batch = [];

  for (const t of teams) {
    batch.push({
      TeamId: t.id,
      TeamCode: t.teamCode?.toUpperCase() || t.abbreviation || "UNK",
      FullName: t.name,
      ShortName: t.shortName || t.name,
      LocationName: t.locationName || "",
      DivisionId: t.division?.id || 0,
      LeagueId: t.league?.id || 0,
      VenueName: t.venue?.name || "",
      CreatedAt: new Date()
    });
  }

  if (batch.length > 0) {
    await table.upsert(batch);
  }

  console.log(`Finished seeding! Total teams updated: ${batch.length}`);
  process.exit(0);
}

seedTeams().catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
