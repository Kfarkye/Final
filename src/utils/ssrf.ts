import dns from "dns";
import net from "net";
import http from "http";
import https from "https";

/**
 * 🛡️ Strictly checks if an IP address belongs to a private, local, or reserved range.
 * Thwarts Cloud Metadata attacks (169.254) and internal network probing.
 */
export function isPrivateIP(ip: string): boolean {
  if (!net.isIP(ip)) return false;

  // Normalize IPv4-mapped IPv6 addresses (e.g., ::ffff:127.0.0.1)
  if (ip.startsWith("::ffff:")) ip = ip.substring(7);

  // Handle IPv4
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;

    if (a === 0) return true; // 0.0.0.0/8 (Current network)
    if (a === 10) return true; // 10.0.0.0/8 (Private)
    if (a === 127) return true; // 127.0.0.0/8 (Loopback / Localhost)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (Private)
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 (Private)
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (AWS/GCP/Azure Metadata - CRITICAL)
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
    if (a >= 224) return true; // Multicast & Reserved
    return false;
  }

  // Handle IPv6 (Block Local, Link-Local, and Unique-Local)
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // Unique Local
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || 
        lower.startsWith("fe8") || lower.startsWith("fe9") ||
        lower.startsWith("fea") || lower.startsWith("feb")) return true; // Link-local
    return false;
  }
  return true;
}

/**
 * 🛡️ Custom DNS Lookup function to intercept and validate resolved IPs BEFORE the socket connects.
 * This completely eliminates Time-of-Check to Time-of-Use (TOCTOU) DNS Rebinding attacks.
 * It detects if the caller requested all resolved addresses (dual-stack Happy Eyeballs support)
 * and formats the callback arguments accordingly.
 */
export const ssrfSafeLookup = (
  hostname: string,
  options: dns.LookupOptions | number | null | undefined,
  callback: any
) => {
  const isAll = typeof options === "object" && options !== null && !!options.all;

  // Force all: true during validation to review all resolved IPs for safety
  const lookupOptions: dns.LookupOptions = 
    typeof options === "object" && options !== null 
      ? { ...options, all: true } 
      : { all: true };

  dns.lookup(hostname, lookupOptions, (err, addresses) => {
    if (err) {
      if (isAll) {
        return callback(err, []);
      } else {
        return callback(err, "", 0);
      }
    }

    const addrArray = Array.isArray(addresses) ? addresses : [addresses];
    const safeAddresses = addrArray.filter(addr => {
      if (!addr) return false;
      const ip = typeof addr === "string" ? addr : (addr as any).address;
      return !isPrivateIP(ip);
    });

    if (safeAddresses.length === 0) {
      const error = new Error(`SSRF Blocked: Hostname '${hostname}' resolves to a private or blocked IP range.`);
      (error as any).code = "ESSRF";
      if (isAll) {
        return callback(error, []);
      } else {
        return callback(error, "", 0);
      }
    }

    if (isAll) {
      return callback(null, safeAddresses);
    } else {
      const primary = safeAddresses[0];
      const address = typeof primary === "string" ? primary : (primary as any).address;
      const family = typeof primary === "string" ? (net.isIPv6(primary) ? 6 : 4) : (primary as any).family;
      return callback(null, address, family);
    }
  });
};

// Singleton Agents to be reused across all requests
export const safeHttpAgent = new http.Agent({ lookup: ssrfSafeLookup as any });
export const safeHttpsAgent = new https.Agent({ lookup: ssrfSafeLookup as any });
