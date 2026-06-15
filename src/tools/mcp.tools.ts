import { z } from "zod";
import { RegisteredTool } from "./types";

export const mcpTools: RegisteredTool<any>[] = [
  // Linear Tools
  {
    definition: {
      name: "issue_list",
      description: "Fetch list of issues scoped to the active workspace project filter.",
      schema: z.object({
        projectId: z.string().optional(),
        limit: z.number().int().optional().default(20)
      })
    },
    handler: () => {
      throw new Error("Local execution not supported. Routed via HTTP gateway.");
    }
  },
  {
    definition: {
      name: "issue_create",
      description: "Create a new issue inside the user's project.",
      schema: z.object({
        title: z.string().min(1, "Title is required"),
        description: z.string().optional(),
        teamId: z.string().min(1, "Team ID is required")
      })
    },
    handler: () => {
      throw new Error("Local execution not supported. Routed via HTTP gateway.");
    }
  },
  // Stripe Tools
  {
    definition: {
      name: "balance_read",
      description: "Retrieve platform balance detail metrics.",
      schema: z.object({})
    },
    handler: () => {
      throw new Error("Local execution not supported. Routed via HTTP gateway.");
    }
  },
  {
    definition: {
      name: "customers_search",
      description: "Query customers using standard Stripe search syntax. Caution: Eventually consistent.",
      schema: z.object({
        query: z.string().min(1, "Query string is required")
      })
    },
    handler: () => {
      throw new Error("Local execution not supported. Routed via HTTP gateway.");
    }
  },
  {
    definition: {
      name: "subscriptions_cancel",
      description: "Terminate an active user subscription. Requires administrative verification.",
      schema: z.object({
        subscriptionId: z.string().min(1, "Subscription ID is required"),
        confirm: z.boolean().default(false)
      })
    },
    handler: () => {
      throw new Error("Local execution not supported. Routed via HTTP gateway.");
    }
  },
  // Notebook Tools
  {
    definition: {
      name: "execute_javascript",
      description: "Run code snippets dynamically in an isolated environment. Heavy standard libraries and remote networks are blocked.",
      schema: z.object({
        code: z.string().min(1, "Valid JS code context to compile is required.")
      })
    },
    handler: () => {
      throw new Error("Local execution not supported. Routed via HTTP gateway.");
    }
  }
];
