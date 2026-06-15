// src/routes/linearMcpRoutes.ts
import { Router, Request, Response } from "express";
import { LinearClient } from "@linear/sdk";

const router = Router();

function getLinearClient(req: Request): LinearClient {
  const token = (req as any).user?.linearToken || process.env.LINEAR_ORG_API_KEY;
  if (!token) {
    throw new Error("Missing credentials: User has not authorized Linear OAuth access.");
  }
  return new LinearClient({ apiKey: token });
}

router.post("/", async (req: Request, res: Response) => {
  try {
    const client = getLinearClient(req);
    const { method, params, id } = req.body;

    if (method === "tools/list") {
      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "issue_list",
              description: "Fetch list of issues scoped to the active workspace project filter.",
              inputSchema: {
                type: "object",
                properties: {
                  projectId: { type: "string" },
                  limit: { type: "number", default: 20 }
                }
              }
            },
            {
              name: "issue_create",
              description: "Create a new issue inside the user's project.",
              inputSchema: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  description: { type: "string" },
                  teamId: { type: "string" }
                },
                required: ["title", "teamId"]
              }
            }
          ]
        }
      });
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments || {};

      if (toolName === "issue_list") {
        const issues = await client.issues({
          filter: args.projectId ? { project: { id: { eq: args.projectId } } } : undefined,
          first: args.limit || 20
        });

        const formatted = issues.nodes.map(node => ({
          id: node.id,
          identifier: node.identifier,
          title: node.title,
          status: node.state
        }));

        return res.json({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify(formatted) }] }
        });
      }

      if (toolName === "issue_create") {
        const issuePayload = await client.createIssue({
          title: args.title,
          description: args.description,
          teamId: args.teamId
        });

        const createdIssue = await issuePayload.issue;
        return res.json({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: `Issue created successfully: ${createdIssue?.identifier}` }] }
        });
      }
    }
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
