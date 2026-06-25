import fs from 'fs';

const filePath = 'src/workers/odds-ingestor.ts';
let content = fs.readFileSync(filePath, 'utf8');

// Replace process.env.GOOGLE_CLOUD_PROJECT with env.GCP_PROJECT
if (content.includes("process.env.GOOGLE_CLOUD_PROJECT || 'clearspace-dev'")) {
  content = content.replace(
    "process.env.GOOGLE_CLOUD_PROJECT || 'clearspace-dev'",
    "process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || 'gen-lang-client-0281999829'"
  );
  fs.writeFileSync(filePath, content);
  console.log("Fixed Spanner projectId in odds-ingestor");
}
