import { ZodIssue } from "zod";

/**
 * 🛡️ Base Application Error
 * All operational errors must extend this class to ensure RFC 7807 compliance.
 */
export class AppError extends Error {
  public readonly isOperational = true;

  constructor(
    public readonly statusCode: number,
    public readonly title: string,
    public readonly detail: string,
    public readonly type: string = "about:blank"
  ) {
    super(detail);
    // Restore prototype chain when extending built-in classes in TypeScript
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * 400 Bad Request - Used for Zod schema validation failures
 */
export class ValidationError extends AppError {
  constructor(detail: string, public readonly issues?: ZodIssue[]) {
    super(
      400,
      "Validation Error",
      detail,
      "https://api.yourdomain.com/errors/validation-error"
    );
  }
}

/**
 * 404 Not Found - Used when a requested resource or route doesn't exist
 */
export class NotFoundError extends AppError {
  constructor(detail: string = "The requested resource could not be found.") {
    super(
      404,
      "Resource Not Found",
      detail,
      "https://api.yourdomain.com/errors/not-found"
    );
  }
}

/**
 * 502 Bad Gateway / 503 Service Unavailable - Used when external APIs fail
 */
export class UpstreamServiceError extends AppError {
  constructor(detail: string, statusCode: number = 502, public readonly retryAfter?: number) {
    super(
      statusCode,
      "Upstream Service Failure",
      detail,
      "https://api.yourdomain.com/errors/upstream-failure"
    );
  }
}

// Keep UpstreamError alias for backwards compatibility with resilience code
export class UpstreamError extends UpstreamServiceError {
  constructor(detail: string, status: number = 502, retryAfter?: number) {
    super(detail, status, retryAfter);
    this.name = "UpstreamError";
  }
  
  get status(): number {
    return this.statusCode;
  }
}
