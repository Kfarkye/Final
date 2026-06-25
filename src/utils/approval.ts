import { logger } from "./logger";

/**
 * Approval Response Types (v3)
 *
 * Beyond simple approve/deny, the human can now:
 *   - "audit"      → agent re-examines its own proposed change before human approves
 *   - "fetch_docs" → trigger a web search to verify approach against current docs
 *   - "undo"       → revert the last approved operation from the ledger
 */
export type ApprovalDecision =
  | { decision: "approved" }
  | { decision: "denied"; reason?: string }
  | { decision: "audit"; instruction?: string }
  | { decision: "fetch_docs"; query?: string }
  | { decision: "undo"; targetId?: string };

interface PendingApproval {
  resolve: (result: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
  tool: string;
  args: any;
  /** Whether the human has acknowledged seeing the approval request */
  seen: boolean;
  /** How many re-ping attempts have been sent */
  rePingCount: number;
  /** The re-ping interval timer */
  rePingTimer?: NodeJS.Timeout;
  /** The connectionId to send re-pings to */
  connectionId?: string;
  /** Callback to send SSE re-pings */
  onRePing?: (approvalId: string) => void;
  /** Timestamp when the approval was created */
  createdAt: number;
}

export const pendingApprovals = new Map<string, PendingApproval>();

/** How long to wait for the human to even SEE the approval (before re-pinging) */
const INITIAL_VISIBILITY_TIMEOUT_MS = 30_000; // 30s
/** How long to wait after the human has SEEN the approval */
const SEEN_EXTENDED_TIMEOUT_MS = 300_000; // 5 minutes — they're actively reviewing
/** How often to re-ping if the human hasn't seen the approval */
const RE_PING_INTERVAL_MS = 15_000; // 15s
/** Maximum number of re-pings before giving up */
const MAX_RE_PINGS = 3;

/**
 * Wait for a human decision on an approval request.
 * 
 * v3 behavior:
 * 1. Initial phase (30s): Wait for "seen" acknowledgment from frontend.
 *    If not seen, re-ping every 15s up to 3 times.
 * 2. Once seen: Extend timeout to 5 minutes (human is actively reviewing).
 * 3. If never seen after all re-pings: Timeout as denied with clear message.
 */
export function waitForApproval(
  approvalId: string,
  tool: string,
  args: any,
  timeoutMs?: number, // ignored in v3 — managed internally
  options?: {
    connectionId?: string;
    onRePing?: (approvalId: string) => void;
  }
): Promise<ApprovalDecision> {
  return new Promise((resolve) => {
    logger.info({
      msg: "Awaiting human UX approval for tool (v3 — visibility-aware)",
      approvalId,
      tool,
      initialTimeoutMs: INITIAL_VISIBILITY_TIMEOUT_MS,
      extendedTimeoutMs: SEEN_EXTENDED_TIMEOUT_MS,
    });

    // Phase 1: Start the initial visibility timer
    const timer = setTimeout(() => {
      const pending = pendingApprovals.get(approvalId);
      if (!pending) return;

      if (pending.seen) {
        // Human saw it but hasn't decided — this shouldn't fire because
        // acknowledgeApproval replaces the timer. Safety fallback.
        return;
      }

      // Human hasn't seen it — start re-pinging
      startRePingCycle(approvalId);
    }, INITIAL_VISIBILITY_TIMEOUT_MS);

    pendingApprovals.set(approvalId, {
      resolve,
      timer,
      tool,
      args,
      seen: false,
      rePingCount: 0,
      connectionId: options?.connectionId,
      onRePing: options?.onRePing,
      createdAt: Date.now(),
    });
  });
}

/**
 * Re-ping cycle: sends SSE re-ping events every RE_PING_INTERVAL_MS
 * to attract the human's attention. Gives up after MAX_RE_PINGS.
 */
function startRePingCycle(approvalId: string): void {
  const pending = pendingApprovals.get(approvalId);
  if (!pending) return;

  logger.warn({
    msg: "Approval not seen — starting re-ping cycle",
    approvalId,
    tool: pending.tool,
  });

  const rePingTimer = setInterval(() => {
    const p = pendingApprovals.get(approvalId);
    if (!p) {
      clearInterval(rePingTimer);
      return;
    }

    if (p.seen) {
      // Human saw it between pings
      clearInterval(rePingTimer);
      return;
    }

    p.rePingCount++;
    logger.info({
      msg: `Re-ping ${p.rePingCount}/${MAX_RE_PINGS}`,
      approvalId,
      tool: p.tool,
    });

    // Fire re-ping callback (sends SSE event to frontend)
    if (p.onRePing) {
      try { p.onRePing(approvalId); } catch { /* best effort */ }
    }

    if (p.rePingCount >= MAX_RE_PINGS) {
      clearInterval(rePingTimer);
      // Final timeout — human never engaged
      const totalWaitSec = Math.round((Date.now() - p.createdAt) / 1000);
      logger.warn({
        msg: "Approval timed out — human never acknowledged",
        approvalId,
        tool: p.tool,
        totalWaitSec,
        rePingsSent: p.rePingCount,
      });
      pendingApprovals.delete(approvalId);
      p.resolve({
        decision: "denied",
        reason: `Approval timed out after ${totalWaitSec}s (${MAX_RE_PINGS} notification pings sent, no human response). Ensure the Truth app tab is visible.`,
      });
    }
  }, RE_PING_INTERVAL_MS);

  pending.rePingTimer = rePingTimer;
}

/**
 * Called when the frontend sends an "I've seen this" acknowledgment.
 * Extends the timeout significantly since the human is now actively looking.
 */
export function acknowledgeApproval(approvalId: string): boolean {
  const pending = pendingApprovals.get(approvalId);
  if (!pending) {
    logger.warn({
      msg: "Acknowledge for non-existent or expired approval",
      approvalId,
    });
    return false;
  }

  if (pending.seen) return true; // Already acknowledged

  pending.seen = true;

  // Clear the initial timer and any re-ping cycle
  clearTimeout(pending.timer);
  if (pending.rePingTimer) {
    clearInterval(pending.rePingTimer);
  }

  // Set a generous extended timer — human is actively reviewing
  const extendedTimer = setTimeout(() => {
    if (pendingApprovals.has(approvalId)) {
      const totalWaitSec = Math.round((Date.now() - pending.createdAt) / 1000);
      logger.warn({
        msg: "Approval timed out after human acknowledged but didn't decide",
        approvalId,
        tool: pending.tool,
        totalWaitSec,
      });
      pendingApprovals.delete(approvalId);
      pending.resolve({
        decision: "denied",
        reason: `Approval seen but no decision after ${totalWaitSec}s. The approval modal was visible but no action was taken.`,
      });
    }
  }, SEEN_EXTENDED_TIMEOUT_MS);

  pending.timer = extendedTimer;

  logger.info({
    msg: "Approval acknowledged by human — extended timeout",
    approvalId,
    tool: pending.tool,
    newTimeoutMs: SEEN_EXTENDED_TIMEOUT_MS,
  });

  return true;
}

/**
 * Handle an incoming approval response from the frontend.
 *
 * Simple approve/deny (backwards compat):
 *   handleApprovalResponse(id, true)
 *   handleApprovalResponse(id, false)
 *
 * Rich decision:
 *   handleApprovalResponse(id, { decision: "audit", instruction: "check the import" })
 *   handleApprovalResponse(id, { decision: "fetch_docs", query: "node execFile security" })
 *   handleApprovalResponse(id, { decision: "undo" })
 */
export function handleApprovalResponse(
  approvalId: string,
  response: boolean | ApprovalDecision
): boolean {
  const pending = pendingApprovals.get(approvalId);
  if (!pending) {
    logger.warn({
      msg: "Attempted to approve non-existent or expired request",
      approvalId,
    });
    return false;
  }

  clearTimeout(pending.timer);
  if (pending.rePingTimer) {
    clearInterval(pending.rePingTimer);
  }
  pendingApprovals.delete(approvalId);

  // Normalise boolean responses to ApprovalDecision
  let decision: ApprovalDecision;
  if (typeof response === "boolean") {
    decision = response
      ? { decision: "approved" }
      : { decision: "denied" };
  } else {
    decision = response;
  }

  const totalWaitSec = Math.round((Date.now() - pending.createdAt) / 1000);
  logger.info({
    msg: "Human UX approval action received",
    approvalId,
    tool: pending.tool,
    decision: decision.decision,
    totalWaitSec,
    wasSeen: pending.seen,
  });

  pending.resolve(decision);
  return true;
}

/**
 * @deprecated Use handleApprovalResponse instead. Kept for backwards compat.
 */
export function handleApproval(approvalId: string, approved: boolean): boolean {
  return handleApprovalResponse(approvalId, approved);
}
