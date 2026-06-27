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
import { profileTools } from './profile.tools';
import { gameStateTools } from './game_state.tools';
import { deepthinkTools } from './deepthink.tools';
import { dripTools } from './drip.tools';
import { gcpInfraTools } from './gcp-infra.tools';
import { entityTools } from './entity.tools';
import { spannerAdminTools } from './spanner-admin.tools.js';
import { runtimeTools, loadPersistedRuntimeTools } from './runtime.tools.js';
import { secretsTools } from './secrets.tools.js';
import { buildTools } from './build.tools.js';
import { npmTools } from './npm.tools.js';
import { appExecTools } from './app_exec.tools.js';
import { conversationalTools } from './conversational.tools';
import { sourceTools } from './source.tools';
import { githubTools } from './github.tools';
import { oddsAdminTools } from './odds_admin.tools.js';
import { gkeTools } from './gke.tools';
import { artifactRegistryTools } from './artifact-registry.tools';
import { youtubeMediaTools } from './youtube-media/index';
import { pubsubTools } from './pubsub.tools';
import { visionTools } from './vision.tools';
import { platformTools } from './platform.tools';
import { statmuseTools } from './statmuse.tools';

// Initialize the registry
toolRegistry.registerMany([
  ...scraperTools,
  ...gitTools,
  ...systemTools,
  ...workspaceTools,
  ...spannerTools,
  ...spannerAdminTools,
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
  ...profileTools,
  ...gameStateTools,
  ...deepthinkTools,
  ...dripTools,
  ...gcpInfraTools,
  ...entityTools,
  ...runtimeTools,
  ...secretsTools,
  ...buildTools,
  ...npmTools,
  ...appExecTools,
  ...conversationalTools,
  ...sourceTools,
  ...githubTools,
  ...oddsAdminTools,
  ...gkeTools,
  ...artifactRegistryTools,
  ...youtubeMediaTools,
  ...pubsubTools,
  ...visionTools,
  ...platformTools,
  ...statmuseTools,
]);

// Lock the built-in tool set before any runtime tools are restored.
// After this, any tool registered (via runtime or persistence) will NOT be
// classified as built-in, ensuring it can be safely unregistered later.
toolRegistry.sealBuiltins();

// Attempt to restore dynamically registered tools from the database
loadPersistedRuntimeTools().catch(err => {
  console.error("Failed to load persisted runtime tools:", err);
});

export { toolRegistry };
