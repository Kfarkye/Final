import crypto from "crypto";
import { logger } from "./logger";

/**
 * Native Kalshi V2 Authenticated Fetch Wrapper
 * Uses KALSHI_API_UUID and KALSHI_PRIVATE_KEY_BASE64 from process.env.
 * If credentials are not present, it will log a warning and fall back to standard fetch.
 */
export async function fetchKalshi(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const method = (options.method || "GET").toUpperCase();
  const uuid = process.env.KALSHI_API_UUID;
  const privateKeyBase64 = process.env.KALSHI_PRIVATE_KEY_BASE64;

  const newOptions = { ...options };
  newOptions.headers = new Headers(newOptions.headers || {});
  
  if (!newOptions.headers.has("Accept")) {
    newOptions.headers.set("Accept", "application/json");
  }

  if (uuid && privateKeyBase64) {
    try {
      const privateKeyPem = Buffer.from(privateKeyBase64, "base64").toString("utf-8");
      const timestamp = Date.now().toString();
      
      // Path must be exactly what follows the domain, without query params or fragment
      // e.g., url = https://api.elections.kalshi.com/trade-api/v2/events?limit=50
      const urlObj = new URL(url);
      const pathOnly = urlObj.pathname;

      const msgString = timestamp + method + pathOnly;
      
      const signature = crypto.sign(
        "sha256",
        Buffer.from(msgString),
        {
          key: privateKeyPem,
          padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
          saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
        }
      ).toString("base64");

      newOptions.headers.set("KALSHI-ACCESS-KEY", uuid);
      newOptions.headers.set("KALSHI-ACCESS-SIGNATURE", signature);
      newOptions.headers.set("KALSHI-ACCESS-TIMESTAMP", timestamp);
      
    } catch (err: any) {
      logger.error({ msg: "Failed to generate Kalshi RSA signature", error: err.message });
      // Proceed without auth if signing fails, or throw. We proceed to let Kalshi reject it.
    }
  } else {
    // Note: Do not spam logs on every request if missing keys, just once or debug.
    // logger.debug({ msg: "Missing KALSHI_API_UUID or KALSHI_PRIVATE_KEY_BASE64, using unauthenticated public fetch" });
  }

  return fetch(url, newOptions);
}
