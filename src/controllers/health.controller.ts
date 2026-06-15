import { Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/index";
import { logger } from "../utils/logger";
import { config } from "../config";

export const healthController = {
  /**
   * 🛡️ LIVENESS PROBE (/healthz)
   * Kubelet uses this to know if the application is dead and needs a pod restart.
   * This should be fast and NEVER check external dependencies.
   */
  liveness(req: Request, res: Response) {
    res.status(200).json({ 
      status: "ok", 
      uptimeSeconds: process.uptime(),
      timestamp: new Date().toISOString() 
    });
  },

  /**
   * 🛡️ READINESS PROBE (/readyz)
   * Kubelet uses this to know if the pod is ready to accept user traffic.
   * If this fails, the pod is temporarily removed from the Load Balancer.
   */
  async readiness(req: Request, res: Response) {
    try {
      // 1. Verify Database Connection
      await db.execute(sql`SELECT 1`);

      // 2. Verify AI configuration is loaded (do NOT make an actual API call)
      const isAiConfigured = 
        !!config.GCP_PROJECT || 
        !!config.OPENAI_API_KEY ||
        !!config.ANTHROPIC_API_KEY ||
        !!config.XAI_API_KEY;

      if (!isAiConfigured) {
        throw new Error("AI credentials are not configured in the environment");
      }

      res.status(200).json({ 
        status: "ready", 
        db: "connected",
        ai: "configured",
        timestamp: new Date().toISOString() 
      });
    } catch (error: any) {
      logger.error({ msg: "Readiness probe failed", error: error.message });
      // 503 Service Unavailable tells K8s to stop sending traffic to this pod
      res.status(503).json({ 
        status: "error", 
        message: "Service Dependencies Unavailable",
        error: error.message 
      });
    }
  }
};
