import { Request, Response, NextFunction } from "express";
import { AppError, ValidationError, NotFoundError } from "../utils/errors";
import { logger, traceContext } from "../utils/logger";
import { env } from "../config/env";

export const globalErrorHandler = (
  err: Error,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
): void => {
  // Retrieve the correlation ID from the AsyncLocalStorage context
  const store = traceContext?.getStore();
  const traceId = store?.traceId || req.headers["x-request-id"] || "unknown";

  // 1. Determine if it's a known, operational error
  if (err instanceof AppError) {
    logger.warn({ 
      msg: "Operational error occurred", 
      err: err.message, 
      statusCode: err.statusCode,
      traceId
    });

    // Construct RFC 7807 Problem Details Object
    const problemDetails: any = {
      type: err.type,
      title: err.title,
      status: err.statusCode,
      detail: err.detail,
      instance: req.originalUrl,
      traceId, // Extension property: Highly useful for frontend debugging
    };

    // Append validation issues if it's a ValidationError
    if (err instanceof ValidationError && err.issues) {
      problemDetails.extensions = { issues: err.issues };
    }

    // Set standard content type and send
    res.status(err.statusCode).type("application/problem+json").json(problemDetails);
    return;
  }

  // 2. Handle unexpected programming bugs (e.g., TypeError, SyntaxError, Database crashes)
  logger.error({ 
    msg: "Unhandled internal exception", 
    err: err.message, 
    stack: err.stack,
    url: req.originalUrl,
    traceId
  });

  // Protect internal details: Only leak error details if NOT in production
  const isProd = env.NODE_ENV === "production";
  
  res.status(500).type("application/problem+json").json({
    type: "about:blank",
    title: "Internal Server Error",
    status: 500,
    detail: isProd 
      ? "An unexpected system error occurred. Please contact support." 
      : err.message,
    instance: req.originalUrl,
    traceId,
    // Safely append stack trace only in dev environments
    ...(isProd ? {} : { extensions: { stack: err.stack } })
  });
};

export const notFoundHandler = (req: Request, res: Response, next: NextFunction) => {
  next(new NotFoundError(`The path ${req.originalUrl} does not exist on this server.`));
};
