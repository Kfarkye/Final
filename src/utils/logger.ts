import pino from "pino";
import { AsyncLocalStorage } from "async_hooks";
import { env } from "../config/env";

export const traceContext = new AsyncLocalStorage<{ traceId: string }>();

export const logger = pino({
  level: env.LOG_LEVEL,
  formatters: {
    level: (label) => ({ level: label.toUpperCase() }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin() {
    const store = traceContext.getStore();
    return store ? { traceId: store.traceId } : {};
  },
  redact: {
    paths: ["req.headers.authorization", "headers.authorization", "googleAccessToken"],
    censor: "[REDACTED]"
  },
  transport: env.NODE_ENV !== "production" ? {
    target: "pino-pretty",
    options: {
      colorize: true
    }
  } : undefined
});
