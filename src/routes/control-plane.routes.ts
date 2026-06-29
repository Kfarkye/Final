import { Router, Request, Response } from "express";
import { controlPlaneService } from "../system/control-plane.service.js";
import { logger } from "../utils/logger.js";

export const controlPlaneRouter = Router();

// A. Publicly accessible System status endpoints (used by the control plane to verify live state)
controlPlaneRouter.get("/api/system/git-state", async (req: Request, res: Response) => {
  try {
    const workspace = await controlPlaneService.getWorkspaceState();
    return res.json({
      branch: workspace.branch,
      sha: workspace.localSha,
      buildTime: new Date().toISOString()
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

controlPlaneRouter.get("/api/system/infrastructure-state", async (req: Request, res: Response) => {
  try {
    const infra = await controlPlaneService.getInfrastructureState();
    return res.json(infra);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// B. Control Plane Admin Endpoints
controlPlaneRouter.get("/api/control-plane/status", async (req: Request, res: Response) => {
  try {
    const workspace = await controlPlaneService.getWorkspaceState();
    const live = await controlPlaneService.getLiveDeploymentState();
    const infra = await controlPlaneService.getInfrastructureState();

    let aggregatedStatus: "READY" | "SYNC_NEEDED" | "DIRTY" | "WRONG_BRANCH" | "LIVE_MISMATCH" = "READY";
    if (workspace.status !== "READY") {
      aggregatedStatus = workspace.status;
    } else if (live.status === "LIVE_MISMATCH") {
      aggregatedStatus = "LIVE_MISMATCH";
    }

    return res.json({
      status: aggregatedStatus,
      workspace,
      live,
      infra
    });
  } catch (err: any) {
    logger.error({ msg: "Control plane status fetch failed", error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

controlPlaneRouter.post("/api/control-plane/sync", async (req: Request, res: Response) => {
  const { action } = req.body; // 'pull' | 'stash' | 'discard'
  try {
    await controlPlaneService.syncWorkspace(action);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

controlPlaneRouter.post("/api/control-plane/prepare", async (req: Request, res: Response) => {
  try {
    const plan = await controlPlaneService.prepareDeploy();
    return res.json(plan);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

controlPlaneRouter.post("/api/control-plane/deploy", async (req: Request, res: Response) => {
  const { planId, approval } = req.body;
  try {
    await controlPlaneService.executeDeploy(planId, approval);
    return res.json({ success: true });
  } catch (err: any) {
    logger.error({ msg: "Control plane deployment execution failed", error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

controlPlaneRouter.post("/api/control-plane/canary", async (req: Request, res: Response) => {
  try {
    const passed = await controlPlaneService.runCanary();
    return res.json({ success: true, passed });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});
