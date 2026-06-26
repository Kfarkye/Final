import { Router, Request, Response } from "express";
import { proxyToMcpServer } from "../utils/mcp-proxy";

const router = Router();

router.post("/", async (req: Request, res: Response) => {
  try {
    const result = await proxyToMcpServer("mcp-design-system-ts", req.body);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Backward compatibility for existing /status GET requests
router.get("/status", (req, res) => {
  res.json({ status: "active", message: "Design System proxy is online." });
});

export default router;
