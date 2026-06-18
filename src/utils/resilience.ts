import CircuitBreaker from "opossum";
import { logger } from "./logger";
import { UpstreamError } from "./errors";

// Re-export UpstreamError for backward compatibility in downstream files
export { UpstreamError };

/**
 * 🛡️ Exponential Backoff Retry mechanism.
 * Automatically retries 429 Rate Limits and 5xx Server Errors.
 */
export async function withRetry<T>(
  contextName: string,
  operation: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 500
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error: any) {
      attempt++;
      
      const isTransient = 
        (error instanceof UpstreamError && (error.statusCode === 429 || error.statusCode >= 500)) ||
        ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE'].includes(error.code);

      // If we exhausted retries or it's not transient, bubble the error up
      if (!isTransient || attempt > maxRetries) throw error;

      // Calculate exponential backoff, respecting the 'Retry-After' header if provided
      let delay = baseDelayMs * Math.pow(2, attempt - 1);
      if (error instanceof UpstreamError && error.retryAfter) {
        delay = error.retryAfter * 1000;
      }
      
      // Jitter prevents multiple requests from retrying at the exact same millisecond
      const jitter = Math.floor(Math.random() * 200);
      const waitTime = delay + jitter;

      logger.warn({ msg: "Transient error, retrying...", contextName, attempt, waitTime, err: error.message });
      await new Promise(res => setTimeout(res, waitTime));
    }
  }
}

// Registry to track circuit breakers per external domain
const breakers = new Map<string, CircuitBreaker>();

// A generic execution block that Opossum will wrap
const executeGenericTask = async <T>(task: () => Promise<T>): Promise<T> => await task();

/**
 * 🛡️ Circuit Breaker Factory
 * Prevents cascading failures when a downstream service is completely unreachable.
 */
export function getCircuitBreaker(name: string): CircuitBreaker {
  if (!breakers.has(name)) {
    const breaker = new CircuitBreaker(executeGenericTask, {
      timeout: 45000,               // If operation takes > 45s (including retries), count as failure
      errorThresholdPercentage: 50, // Trip the breaker if 50% of requests fail
      resetTimeout: 30000,          // Wait 30s before attempting a probe request
    });

    breaker.fallback((_err: any, task: any) => {
      throw new Error(`[Service Unavailable] The service '${name}' is currently offline. Fast-failing.`);
    });

    breaker.on("open", () => logger.error({ msg: `🚨 Circuit Breaker OPENED`, service: name }));
    breaker.on("halfOpen", () => logger.warn({ msg: `⏳ Circuit Breaker HALF-OPEN`, service: name }));
    breaker.on("close", () => logger.info({ msg: `✅ Circuit Breaker CLOSED`, service: name }));

    breakers.set(name, breaker);
  }
  return breakers.get(name)!;
}
