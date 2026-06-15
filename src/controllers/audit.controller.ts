import { Request, Response } from "express";
import { z } from "zod";
import { db } from "../db/index";
import { auditLogs } from "../db/schema";
import { catchAsync } from "../middleware/catchAsync";
import { NotFoundError } from "../utils/errors";

export const AuditPayloadSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
  email: z.string().email("Invalid email format"),
  action: z.string().min(1, "Action is required"),
  details: z.record(z.string(), z.any()).optional(), 
});

export const auditController = {
  createAuditLog: catchAsync(async (req: Request, res: Response) => {
    const data = req.body as z.infer<typeof AuditPayloadSchema>;

    await db.insert(auditLogs).values({
      userId: data.userId,
      email: data.email,
      action: data.action,
      details: data.details ? JSON.stringify(data.details) : null,
    });

    res.status(201).json({ success: true });
  }),

  getAuditLogs: catchAsync(async (req: Request, res: Response) => {
    const logs = await db.select().from(auditLogs);
    
    if (!logs || logs.length === 0) {
      throw new NotFoundError("No audit logs have been recorded yet.");
    }
    
    res.json(logs.reverse());
  })
};
