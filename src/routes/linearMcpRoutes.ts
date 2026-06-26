import { Router, Request, Response } from "express";
import { proxyToMcpServer } from "../utils/mcp-proxy";

const router = Router();

router.post("/", async (req: Request, res: Response) => {
  try {
    const result = await proxyToMcpServer("mcp-linear-ts", req.body);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
