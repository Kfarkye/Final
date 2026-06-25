import {
  ApprovalDecision,
  ApprovalPolicy,
  TenantContext,
  Telemetry,
} from "./types.js";

/**
 * Deny-by-default approval policy.
 *
 * Server-initiated requests (command/exec, fs/read, fs/write, mcpServer/*, …)
 * are REJECTED unless a rule explicitly allows them. Rules are evaluated in
 * order; the first match wins. No match → deny.
 *
 * This is the SOC2-aligned safe default: a misconfiguration fails closed.
 */
export interface ApprovalRule {
  /** Exact method or prefix match if it ends with "/*". */
  method: string;
  /**
   * Optional predicate for fine-grained allow (e.g. command allowlist).
   * Receives raw params — must NOT log them.
   */
  predicate?: (params: unknown, tenant: TenantContext) => boolean;
  /** Optional canned result returned to the server on allow. */
  result?: unknown;
}

export class DenyByDefaultApprovalPolicy implements ApprovalPolicy {
  private readonly rules: ApprovalRule[];
  private readonly telemetry: Telemetry;

  constructor(rules: ApprovalRule[], telemetry: Telemetry) {
    this.rules = rules;
    this.telemetry = telemetry;
  }

  evaluate(
    method: string,
    params: unknown,
    tenant: TenantContext,
  ): ApprovalDecision {
    for (const rule of this.rules) {
      if (!this.methodMatches(rule.method, method)) continue;
      if (rule.predicate && !rule.predicate(params, tenant)) {
        // A matching rule whose predicate fails → explicit deny, stop searching.
        this.audit(method, tenant, false, "predicate_rejected");
        return { allow: false, reason: "predicate_rejected" };
      }
      this.audit(method, tenant, true);
      return { allow: true, result: rule.result };
    }
    this.audit(method, tenant, false, "no_matching_rule");
    return { allow: false, reason: "no_matching_rule (deny-by-default)" };
  }

  private methodMatches(pattern: string, method: string): boolean {
    if (pattern.endsWith("/*")) {
      return method.startsWith(pattern.slice(0, -1)); // keep trailing "/"
    }
    return pattern === method;
  }

  /** PII-safe audit: logs method + decision + tenant, NEVER params. */
  private audit(
    method: string,
    tenant: TenantContext,
    allowed: boolean,
    reason?: string,
  ): void {
    this.telemetry.counterAdd("codex.approval.decision", 1, {
      method,
      decision: allowed ? "allow" : "deny",
    });
    this.telemetry.log(allowed ? "info" : "warn", "approval.decision", {
      method,
      decision: allowed ? "allow" : "deny",
      reason,
      tenantId: tenant.tenantId,
      requestId: tenant.requestId,
    });
  }
}

/**
 * Convenience factory for the locked policy: deny-by-default for command/exec
 * and fs/*, with an optional command allowlist for read-only introspection.
 */
export function createDefaultApprovalPolicy(
  telemetry: Telemetry,
  opts: { readOnlyCommandAllowlist?: string[] } = {},
): ApprovalPolicy {
  const allow = new Set(opts.readOnlyCommandAllowlist ?? []);
  const rules: ApprovalRule[] = [];

  if (allow.size > 0) {
    rules.push({
      method: "command/exec",
      predicate: (params) => {
        const cmd = extractCommand(params);
        return cmd !== null && allow.has(cmd);
      },
      result: { decision: "approved" },
    });
  }
  // command/exec and fs/* with no rule → denied by default. Nothing else added.
  return new DenyByDefaultApprovalPolicy(rules, telemetry);
}

/** Best-effort, schema-tolerant command extraction. Never throws. */
function extractCommand(params: unknown): string | null {
  if (params && typeof params === "object") {
    const p = params as Record<string, unknown>;
    if (typeof p.command === "string") return p.command;
    if (Array.isArray(p.command) && typeof p.command[0] === "string") {
      return p.command[0];
    }
    if (typeof p.cmd === "string") return p.cmd;
  }
  return null;
}
