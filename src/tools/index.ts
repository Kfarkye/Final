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
]);

export { toolRegistry };

