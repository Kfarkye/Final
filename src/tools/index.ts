import { toolRegistry } from './registry';
import { scraperTools } from './scraper.tools';
import { gitTools } from './git.tools';
import { systemTools } from './system.tools';
import { workspaceTools } from './workspace.tools';
import { spannerTools } from './spanner.tools';

// Initialize the registry
toolRegistry.registerMany([
  ...scraperTools,
  ...gitTools,
  ...systemTools,
  ...workspaceTools,
  ...spannerTools
]);

export { toolRegistry };
