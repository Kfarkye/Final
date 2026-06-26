import { spawn } from "child_process";
import path from "path";

export async function proxyToMcpServer(serverDir: string, reqBody: any): Promise<any> {
  return new Promise((resolve, reject) => {
    // We assume the server has been built, or we run via tsx/ts-node. 
    // Here we run tsx on src/index.ts.
    const serverPath = path.resolve(process.cwd(), "mcp-servers", serverDir, "src", "index.ts");
    
    const child = spawn("npx", ["tsx", serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, MCP_WORKSPACE_DIR: process.cwd() }
    });

    let stdoutData = "";
    let stderrData = "";

    child.stdout.on("data", (chunk) => {
      stdoutData += chunk.toString();
      try {
        // Try to parse out the JSON-RPC response
        const lines = stdoutData.split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.jsonrpc === "2.0" && parsed.id === reqBody.id) {
              child.kill();
              resolve(parsed);
              return;
            }
          } catch (e) {
            // Not a valid JSON line, skip
          }
        }
      } catch (err) {
        // Continue buffering
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrData += chunk.toString();
      console.error(`[MCP ${serverDir}] ${chunk}`);
    });

    child.on("close", (code) => {
      if (code !== 0 && !stdoutData.includes(reqBody.id)) {
        reject(new Error(`MCP server exited with code ${code}. Stderr: ${stderrData}`));
      }
    });

    // Write the JSON-RPC request to stdin
    child.stdin.write(JSON.stringify(reqBody) + "\n");
  });
}
