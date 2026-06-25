import { Request, Response } from "express";
import { z } from "zod";
import { edgeDb } from "../db/spanner";
import { catchAsync } from "../middleware/catchAsync";
import { NotFoundError } from "../utils/errors";
import { randomUUID } from "crypto";

export const AuditPayloadSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
  email: z.string().email("Invalid email format"),
  action: z.string().min(1, "Action is required"),
  details: z.record(z.string(), z.any()).optional(), 
});

export const auditController = {
  createAuditLog: catchAsync(async (req: Request, res: Response) => {
    const data = req.body as z.infer<typeof AuditPayloadSchema>;

    await edgeDb.table('AuditLogs').insert({
      Id: randomUUID(),
      UserId: data.userId,
      Email: data.email,
      Action: data.action,
      Details: data.details ? JSON.stringify(data.details) : null,
    });

    res.status(201).json({ success: true });
  }),

  getAuditLogs: catchAsync(async (req: Request, res: Response) => {
    const [logs] = await edgeDb.run({
      sql: 'SELECT * FROM AuditLogs ORDER BY CreatedAt DESC'
    });
    
    if (!logs || logs.length === 0) {
      throw new NotFoundError("No audit logs have been recorded yet.");
    }
    
    // Map Spanner rows to camelCase for the frontend
    const mappedLogs = logs.map((row: any) => ({
      id: row.Id,
      userId: row.UserId,
      email: row.Email,
      action: row.Action,
      details: row.Details ? JSON.parse(row.Details) : null,
      createdAt: row.CreatedAt
    }));

    res.json(mappedLogs);
  })
};
