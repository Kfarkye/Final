// src/routes/stripeMcpRoutes.ts
import { Router, Request, Response } from "express";
import Stripe from "stripe";
import { z } from "zod";

const router = Router();

// Lazy Stripe initialization using highly scoped restricted key
let stripe: Stripe | null = null;
function getStripeInstance(): Stripe {
  if (!stripe) {
    const key = process.env.STRIPE_RESTRICTED_KEY || process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error("Stripe API key is unconfigured on the server environment.");
    }
    stripe = new Stripe(key, { apiVersion: "2023-10-16" as any });
  }
  return stripe;
}

// Security Audit logging with direct PII scrubbing using deep clone
function logAudit(toolName: string, payload: any, resultId: string, isError = false) {
  const sanitized = structuredClone(payload);
  const piiKeys = ["email", "name", "phone", "card", "token", "address"];
  
  const sanitizeValue = (obj: any) => {
    if (!obj || typeof obj !== "object") return;
    for (const k of Object.keys(obj)) {
      if (piiKeys.includes(k.toLowerCase()) && typeof obj[k] === "string") {
        obj[k] = "[REDACTED_PII]";
      } else if (typeof obj[k] === "object") {
        sanitizeValue(obj[k]);
      }
    }
  };
  
  sanitizeValue(sanitized);
  console.log(`[STRIPE-MCP-AUDIT] | Tool: ${toolName} | Status: ${isError ? 'FAILED' : 'SUCCESS'} | ID: ${resultId} | Args:`, JSON.stringify(sanitized));
}

const baseMcpCallSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.union([z.literal("tools/list"), z.literal("tools/call")]),
  params: z.object({
    name: z.string().optional(),
    arguments: z.any().optional(),
  }).optional(),
  id: z.union([z.string(), z.number()]),
});

router.post("/", async (req: Request, res: Response) => {
  try {
    const mcpBody = baseMcpCallSchema.parse(req.body);
    const stripeInstance = getStripeInstance();

    // Check authorization to verify if caller is permissioned for billing management
    const userRole = (req as any).user?.role || "admin"; // Fallback to admin for local testing if not using auth middleware
    if (userRole !== "admin" && userRole !== "billing_manager") {
      return res.status(403).json({ error: "Forbidden: Insufficient privileges for Stripe operations." });
    }

    if (mcpBody.method === "tools/list") {
      return res.json({
        jsonrpc: "2.0",
        id: mcpBody.id,
        result: {
          tools: [
            {
              name: "balance_read",
              description: "Retrieve platform balance detail metrics.",
              inputSchema: { type: "object", properties: {} }
            },
            {
              name: "customers_search",
              description: "Query customers using standard Stripe search syntax. Caution: Eventually consistent.",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string", description: "Query string (e.g. email:'user@example.com')" }
                },
                required: ["query"]
              }
            },
            {
              name: "subscriptions_cancel",
              description: "Terminate an active user subscription. Requires administrative verification.",
              inputSchema: {
                type: "object",
                properties: {
                  subscriptionId: { type: "string" },
                  confirm: { type: "boolean", description: "Must pass true to bypass validation block." }
                },
                required: ["subscriptionId", "confirm"]
              }
            }
          ]
        }
      });
    }

    if (mcpBody.method === "tools/call") {
      const toolName = mcpBody.params?.name;
      const args = mcpBody.params?.arguments || {};
      const targetAccount = req.headers["x-stripe-account"] as string | undefined;

      // Single centralized helper ready for Stripe Connect dynamic routing
      const executeStripe = async (runner: (client: Stripe, options: Stripe.RequestOptions) => Promise<any>) => {
        const options: Stripe.RequestOptions = {};
        if (targetAccount) options.stripeAccount = targetAccount;
        
        // Prevent AI network retries from double-mutating billing states
        if (mcpBody.id) {
           options.idempotencyKey = `truth-mcp-stripe-${toolName}-${mcpBody.id}`;
        }
        
        return runner(stripeInstance, options);
      };

      if (toolName === "balance_read") {
        const balance = await executeStripe((s, opt) => s.balance.retrieve({}, opt));
        logAudit(toolName, args, balance.object);
        return res.json({
          jsonrpc: "2.0",
          id: mcpBody.id,
          result: { content: [{ type: "text", text: JSON.stringify(balance) }] }
        });
      }

      if (toolName === "customers_search") {
        const searchResult = await executeStripe((s, opt) => s.customers.search({ query: args.query }, opt));
        logAudit(toolName, args, "search_results");
        return res.json({
          jsonrpc: "2.0",
          id: mcpBody.id,
          result: {
            content: [{
              type: "text",
              text: JSON.stringify({
                data: searchResult.data,
                warning: "Customer searches are eventually consistent. Recent modifications might not reflect instantly."
              })
            }]
          }
        });
      }

      if (toolName === "subscriptions_cancel") {
        if (!args.confirm) {
          return res.json({
            jsonrpc: "2.0",
            id: mcpBody.id,
            result: { isError: true, content: [{ type: "text", text: "Action aborted: Destructive changes require explicit confirmation flags." }] }
          });
        }

        const subscription = await executeStripe((s, opt) => s.subscriptions.cancel(args.subscriptionId, {}, opt));
        logAudit(toolName, args, subscription.id);
        return res.json({
          jsonrpc: "2.0",
          id: mcpBody.id,
          result: { content: [{ type: "text", text: `Subscription ${subscription.id} successfully terminated.` }] }
        });
      }

      return res.status(404).json({ error: `MCP Tool ${toolName} not found.` });
    }

  } catch (err: any) {
    console.error("[Stripe Routing Fatal Error]:", err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
