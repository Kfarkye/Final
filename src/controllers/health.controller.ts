import { Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/index";
import { edgeDb } from "../db/spanner";
import { logger } from "../utils/logger";
import { config } from "../config";

/**
 * Build-time SHA injected by esbuild via --define:__BUILD_SHA__='"abc1234"'
 * Falls back to 'local-dev' when running directly from TypeScript (tsx watch).
 * ship.sh step [4/4] polls /healthz for this value to prove the deploy is live.
 */
declare const __BUILD_SHA__: string;
const BUILD_SHA = typeof __BUILD_SHA__ !== "undefined" ? __BUILD_SHA__ : "local-dev";

export const healthController = {
  /**
   * 🛡️ LIVENESS PROBE (/healthz)
   * Kubelet uses this to know if the application is dead and needs a pod restart.
   * This should be fast and NEVER check external dependencies.
   * Also surfaces the build SHA so ship.sh can verify deploys independently.
   */
  liveness(req: Request, res: Response) {
    res.status(200).json({ 
      status: "ok",
      sha: BUILD_SHA,
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
      const hasSqlConfig = Boolean(
        config.DATABASE_URL ||
        (config.SQL_HOST && config.SQL_USER && config.SQL_DB_NAME)
      );
      if (hasSqlConfig) {
        await db.execute(sql`SELECT 1`);
      } else {
        await edgeDb.run("SELECT 1");
      }

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
        db: hasSqlConfig ? "sql-connected" : "spanner-connected",
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
