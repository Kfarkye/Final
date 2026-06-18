import { toolRegistry } from './registry';
import { scraperTools } from './scraper.tools';
import { gitTools } from './git.tools';
import { systemTools } from './system.tools';
import { workspaceTools } from './workspace.tools';
import { spannerTools } from './spanner.tools';
import { mcpTools } from './mcp.tools';
import { gcpTools } from './gcp.tools';
import { artifactTools } from './artifact.tools';
import { bettingTools } from './betting.tools';
import { espnTools } from './espn.tools';
import { mlbTools } from './mlb.tools';
import { nbaTools } from './nba.tools';
import { nflTools } from './nfl.tools';
import { nhlTools } from './nhl.tools';
import { modelRegistryTools } from './modelRegistry.tools';
import { forgeTools } from './forge.tools';
import { knowledgeTools } from './knowledge.tools';
import { oracleTools } from './oracle.tools';
import { statsTools } from './stats.tools';
import { slateTools } from './slate.tools';
import { repoTools } from './repo.tools';
import { engineeringTools } from './engineering.tools';
import { browserTools } from './browser.tools';
import { intelligenceTools } from './intelligence.tools';
import { soccerTools } from './soccer.tools';

// Initialize the registry
toolRegistry.registerMany([
  ...scraperTools,
  ...gitTools,
  ...systemTools,
  ...workspaceTools,
  ...spannerTools,
  ...mcpTools,
  ...gcpTools,
  ...artifactTools,
  ...bettingTools,
  ...espnTools,
  ...mlbTools,
  ...nbaTools,
  ...nflTools,
  ...nhlTools,
  ...modelRegistryTools,
  ...forgeTools,
  ...knowledgeTools,
  ...oracleTools,
  ...statsTools,
  ...slateTools,
  ...repoTools,
  ...engineeringTools,
  ...browserTools,
  ...intelligenceTools,
  ...soccerTools,
]);

export { toolRegistry };

