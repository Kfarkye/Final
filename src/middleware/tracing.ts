import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { traceContext, logger } from "../utils/logger";

export const requestTracing = (req: Request, res: Response, next: NextFunction): void => {
  const traceId = (req.headers["x-request-id"] as string) || crypto.randomUUID();
  
  // Return the trace ID to the client so frontend support can report it for debugging
  res.setHeader("x-request-id", traceId);

  // Everything executed inside this callback runs inside the trace context!
  traceContext.run({ traceId }, () => {
    logger.info({
      msg: "Incoming HTTP Request",
      method: req.method,
      url: req.originalUrl,
      ip: req.ip,
    });

    const start = process.hrtime();

    res.on("finish", () => {
      const [seconds, nanoseconds] = process.hrtime(start);
      const durationMs = (seconds * 1000 + nanoseconds / 1e6).toFixed(2);
      
      const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
      
      logger[level]({
        msg: "HTTP Request Completed",
        statusCode: res.statusCode,
        durationMs: Number(durationMs),
      });
    });

    next();
  });
};
