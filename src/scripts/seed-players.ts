import { edgeDb } from "../db/spanner";
import { Spanner } from "@google-cloud/spanner";

async function fetchTeams() {
  const res = await fetch("https://statsapi.mlb.com/api/v1/teams?sportId=1");
  const data = await res.json();
  const teamMap = new Map<number, string>();
  for (const team of data.teams) {
    teamMap.set(team.id, team.abbreviation || team.teamCode?.toUpperCase());
  }
  return teamMap;
}

async function fetchPlayers() {
  const res = await fetch("https://statsapi.mlb.com/api/v1/sports/1/players?season=2024");
  const data = await res.json();
  return data.people || [];
}

async function seedPlayers() {
  console.log("Fetching teams...");
  const teamMap = await fetchTeams();
  
  console.log("Fetching players for 2024 season...");
  const players = await fetchPlayers();
  
  console.log(`Found ${players.length} players. Preparing to insert...`);

  const table = edgeDb.table("MlbPlayerProfile");

  // We batch inserts for performance
  let batch = [];
  let inserted = 0;

  for (const p of players) {
    if (!p.currentTeam || !p.currentTeam.id) continue;
    
    const teamCode = teamMap.get(p.currentTeam.id) || "FA";
    const bats = p.batSide?.code || "R";
    const throws = p.pitchHand?.code || "R";
    const position = p.primaryPosition?.abbreviation || "P";
    
    // Some basic mock season stats just for rendering
    const seasonStats = {
      avg: p.stats?.[0]?.splits?.[0]?.stat?.avg || ".250",
      hr: p.stats?.[0]?.splits?.[0]?.stat?.homeRuns || Math.floor(Math.random() * 40),
      rbi: p.stats?.[0]?.splits?.[0]?.stat?.rbi || Math.floor(Math.random() * 100),
      ops: p.stats?.[0]?.splits?.[0]?.stat?.ops || ".800"
    };

    batch.push({
      PlayerId: p.id,
      FullName: p.fullName,
      TeamCode: teamCode,
      Position: position,
      Bats: bats,
      Throws: throws,
      Height: p.height || "",
      Weight: p.weight || 0,
      Age: p.currentAge || 0,
      SeasonStatsJson: JSON.stringify(seasonStats),
      CreatedAt: new Date()
    });

    if (batch.length >= 200) {
      await table.upsert(batch);
      inserted += batch.length;
      console.log(`Inserted ${inserted} players...`);
      batch = [];
    }
  }

  if (batch.length > 0) {
    await table.upsert(batch);
    inserted += batch.length;
  }

  console.log(`Finished seeding! Total players updated: ${inserted}`);
  process.exit(0);
}

seedPlayers().catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
