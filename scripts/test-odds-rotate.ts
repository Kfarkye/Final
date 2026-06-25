import { oddsAdminTools } from "../src/tools/odds_admin.tools";
import { env } from "../src/config/env";

async function main() {
  console.log("Demonstrating secure key rotation tool execution locally...");
  
  const tool = oddsAdminTools.find(t => t.definition.name === "rotate_odds_key");
  if (!tool) {
    throw new Error("rotate_odds_key tool not found in oddsAdminTools");
  }

  const args = {
    newApiKey: process.env.ODDS_API_KEY,
    secretId: "tenant_default_ODDS_API_KEY",
    cloudRunService: "reverie" // We will update reverie for the test
  };

  console.log(`Executing tool with args:`, args);

  // Provide empty context to bypass SSE approval for the local demo script
  const result = await tool.handler(args, {} as any);

  console.log("Tool execution result:", JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error("Execution failed:", err);
  process.exit(1);
});
