import fs from 'fs';

const filePath = 'src/tools/odds_admin.tools.ts';
let content = fs.readFileSync(filePath, 'utf8');

content = content.replace(
  "SELECT Provider, RequestCount, QuotaLimit, ResetsAt, PollingMode",
  "SELECT Provider, QuotaRemaining, QuotaUsed, PollingMode"
);

fs.writeFileSync(filePath, content);
console.log("Fixed audit query");
