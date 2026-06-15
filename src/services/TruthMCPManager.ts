// src/services/TruthMCPManager.ts
import { TruthMCPClient } from "./TruthMCPClient.js"; // The client wrapper

export class TruthMCPManager {
  public git = new TruthMCPClient();     
  public linear = new TruthMCPClient();  
  public notebook = new TruthMCPClient();

  /**
   * Boots all capabilities for a specific user and project dynamically.
   */
  async connectSession(projectId: string, userLinearToken: string) {
    const mcpServersDir = "/opt/truth/mcp-servers";
    const workspace = `/var/truth/workspaces/${projectId}`;

    // Spawn 3 completely independent Node.js processes concurrently
    await Promise.all([
      this.git.connect(`${mcpServersDir}/mcp-git-ts/dist/index.js`, {
        MCP_GIT_REPO_PATH: workspace
      }),
      this.linear.connect(`${mcpServersDir}/mcp-linear-ts/dist/index.js`, {
        LINEAR_API_KEY: userLinearToken
      }),
      this.notebook.connect(`${mcpServersDir}/mcp-notebook-ts/dist/index.js`, {
        MCP_WORKSPACE_DIR: workspace
      })
    ]);
  }

  /**
   * Aggregates tools from all domains so Truth's LLM gets one massive master list
   */
  async getCombinedTools() {
    const [gitTools, linearTools, notebookTools] = await Promise.all([
      this.git.getAvailableTools(),
      this.linear.getAvailableTools(),
      this.notebook.getAvailableTools()
    ]);
    
    return [...gitTools, ...linearTools, ...notebookTools];
  }

  async shutdownSession() {
    await Promise.all([
      this.git.disconnect(),
      this.linear.disconnect(),
      this.notebook.disconnect()
    ]);
  }
}
