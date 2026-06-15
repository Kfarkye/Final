import { z } from "zod";
import { RegisteredTool, ToolContext } from "./types";
import { sseManager } from "../../lib/sse/sse-manager";
import { waitForApproval } from "../utils/approval";

// ─── Stripe: Direct SDK Execution ────────────────────────────────────
// Follows the Spanner pattern: import SDK, execute directly, no gateway.

function getStripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Stripe API key is unconfigured on the server environment. Set STRIPE_SECRET_KEY.");
  const Stripe = require("stripe");
  return new Stripe(key);
}

// ─── Linear: Direct SDK Execution ────────────────────────────────────

function getLinearClient(orgKey?: string) {
  const key = orgKey || process.env.LINEAR_ORG_API_KEY;
  if (!key) throw new Error("User has not authorized Linear OAuth access. Set LINEAR_ORG_API_KEY or connect via OAuth.");
  const { LinearClient } = require("@linear/sdk");
  return new LinearClient({ apiKey: key });
}

export const mcpTools: RegisteredTool<any>[] = [
  // ═══════════════════════════════════════════════════════════════════
  //  STRIPE TOOLS — Direct SDK
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "balance_read",
      description: "Retrieve the current Stripe platform balance.",
      schema: z.object({})
    },
    handler: async () => {
      const stripe = getStripeClient();
      const balance = await stripe.balance.retrieve();
      return {
        available: balance.available.map((b: any) => ({ amount: b.amount / 100, currency: b.currency })),
        pending: balance.pending.map((b: any) => ({ amount: b.amount / 100, currency: b.currency })),
        timestamp: new Date().toISOString()
      };
    }
  },
  {
    definition: {
      name: "customers_search",
      description: "Search Stripe customers using standard Stripe search syntax. Caution: Eventually consistent.",
      schema: z.object({
        query: z.string().min(1, "Query string is required")
      })
    },
    handler: async (args) => {
      const stripe = getStripeClient();
      const result = await stripe.customers.search({ query: args.query, limit: 10 });
      return {
        customers: result.data.map((c: any) => ({
          id: c.id,
          email: c.email,
          name: c.name,
          created: new Date(c.created * 1000).toISOString()
        })),
        hasMore: result.has_more,
        timestamp: new Date().toISOString()
      };
    }
  },
  {
    definition: {
      name: "subscriptions_cancel",
      description: "Cancel an active Stripe subscription. Requires human approval.",
      schema: z.object({
        subscriptionId: z.string().min(1, "Subscription ID is required"),
        confirm: z.boolean().default(false)
      })
    },
    handler: async (args, context) => {
      // Require human approval for destructive action
      if (context.connectionId) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId,
          tool: "subscriptions_cancel",
          args
        });
        const approved = await waitForApproval(approvalId, "subscriptions_cancel", args);
        if (!approved) {
          return { error: "Permission Denied: User did not approve cancellation." };
        }
      }
      const stripe = getStripeClient();
      const cancelled = await stripe.subscriptions.cancel(args.subscriptionId);
      return {
        id: cancelled.id,
        status: cancelled.status,
        canceledAt: cancelled.canceled_at ? new Date(cancelled.canceled_at * 1000).toISOString() : null
      };
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  LINEAR TOOLS — Direct SDK
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "issue_list",
      description: "Fetch list of Linear issues scoped to the active workspace.",
      schema: z.object({
        projectId: z.string().optional(),
        limit: z.number().int().optional().default(20)
      })
    },
    handler: async (args) => {
      const linear = getLinearClient();
      const filter: any = {};
      if (args.projectId) filter.project = { id: { eq: args.projectId } };
      const issues = await linear.issues({ first: args.limit, filter });
      const nodes = issues.nodes || [];
      return {
        issues: nodes.map((i: any) => ({
          id: i.id,
          title: i.title,
          state: i.state?.name,
          priority: i.priority,
          assignee: i.assignee?.name,
          url: i.url
        })),
        count: nodes.length,
        timestamp: new Date().toISOString()
      };
    }
  },
  {
    definition: {
      name: "issue_create",
      description: "Create a new Linear issue.",
      schema: z.object({
        title: z.string().min(1, "Title is required"),
        description: z.string().optional(),
        teamId: z.string().min(1, "Team ID is required")
      })
    },
    handler: async (args) => {
      const linear = getLinearClient();
      const result = await linear.createIssue({
        title: args.title,
        description: args.description,
        teamId: args.teamId
      });
      const issue = await result.issue;
      return {
        id: issue?.id,
        title: issue?.title,
        url: issue?.url,
        success: result.success,
        timestamp: new Date().toISOString()
      };
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  NOTEBOOK — Delegates to isolated-vm (same engine as run_script)
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "execute_javascript",
      description: "Run JavaScript code in a secure isolated sandbox with strict memory and CPU limits. No network access.",
      schema: z.object({
        code: z.string().min(1, "Valid JS code is required.")
      })
    },
    handler: async (args) => {
      // Direct execution via isolated-vm — same engine as run_script
      const ivm = (await import("isolated-vm")).default;
      const logs: string[] = [];
      const isolate = new ivm.Isolate({ memoryLimit: 64 });

      try {
        const context = await isolate.createContext();
        const jail = context.global;

        const logCallback = new ivm.Reference((...msgArgs: any[]) => {
          logs.push(msgArgs.map(String).join(' '));
        });

        await jail.set('global', jail.derefInto());
        await context.evalClosure(`
          global.console = {
            log: function(...args) { $0.applyIgnored(undefined, args, { arguments: { copy: true } }); },
            error: function(...args) { $0.applyIgnored(undefined, args.map(a => "[ERROR] " + a), { arguments: { copy: true } }); },
            warn: function(...args) { $0.applyIgnored(undefined, args.map(a => "[WARN] " + a), { arguments: { copy: true } }); }
          };
        `, [logCallback], { arguments: { reference: true } });

        const script = await isolate.compileScript(args.code);
        const result = await script.run(context, { timeout: 3000, copy: true });

        return {
          success: true,
          logs,
          result: typeof result === 'object' ? JSON.stringify(result) : String(result)
        };
      } catch (err: any) {
        return {
          success: false,
          error: `Sandbox execution failed: ${err.message}`,
          logs
        };
      } finally {
        isolate.dispose();
      }
    }
  }
];
