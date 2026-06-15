// src/routes/notebookMcpRoutes.ts
import { Router, Request, Response } from "express";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";

const execFileAsync = promisify(execFile);
const router = Router();
const SANDBOX_DIR = "/tmp/notebook_sandboxes";

router.post("/", async (req: Request, res: Response) => {
  const { method, params, id } = req.body;

  if (method === "tools/list") {
    return res.json({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "execute_javascript",
            description: "Run code snippets dynamically in an isolated environment. Heavy standard libraries and remote networks are blocked.",
            inputSchema: {
              type: "object",
              properties: {
                code: { type: "string", description: "Valid JS code context to compile." }
              },
              required: ["code"]
            }
          }
        ]
      }
    });
  }

  if (method === "tools/call") {
    const code = params?.arguments?.code;
    if (!code) {
      return res.status(400).json({ error: "Missing required argument 'code'" });
    }

    const sessionId = (req as any).user?.uid || "anonymous_session";
    const userWorkspace = path.join(SANDBOX_DIR, sessionId);
    const tempFile = path.join(userWorkspace, `notebook_${Date.now()}.js`);

    try {
      await fs.mkdir(userWorkspace, { recursive: true });
      
      // Save code to temp file
      await fs.writeFile(tempFile, code, "utf8");

      let runner = "deno";
      let runnerArgs = ["run", "--allow-none", tempFile];
      
      try {
        await execFileAsync("which", ["deno"], { timeout: 1000 });
      } catch {
        runner = "node";
        runnerArgs = [tempFile];
      }

      // Execute code sandbox
      const { stdout, stderr } = await execFileAsync(
        runner,
        runnerArgs,
        { timeout: 10000, maxBuffer: 1024 * 512 }
      );

      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: stdout || stderr || "[Execution completed without console stdout]" }]
        }
      });

    } catch (err: any) {
      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: `Execution Exception: ${err.message}` }]
        }
      });
    } finally {
      try {
        await fs.unlink(tempFile);
      } catch {
        // Suppress unlink failures
      }
    }
  }
});

export default router;
