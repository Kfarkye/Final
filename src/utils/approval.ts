import { logger } from "./logger";

/**
 * Approval Response Types (v2)
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
}

export const pendingApprovals = new Map<string, PendingApproval>();

/**
 * Wait for a human decision on an approval request.
 * Returns a structured ApprovalDecision instead of a bare boolean.
 * Backwards-compatible: callers that expect boolean can check .decision === "approved".
 */
export function waitForApproval(
  approvalId: string,
  tool: string,
  args: any,
  timeoutMs: number = 120_000 // 2 minutes — longer for complex reviews
): Promise<ApprovalDecision> {
  return new Promise((resolve) => {
    logger.info({
      msg: "Awaiting human UX approval for tool",
      approvalId,
      tool,
      timeoutMs,
    });

    const timer = setTimeout(() => {
      if (pendingApprovals.has(approvalId)) {
        logger.warn({
          msg: "Approval request timed out",
          approvalId,
          tool,
          timeoutMs,
        });
        pendingApprovals.delete(approvalId);
        resolve({ decision: "denied", reason: `Approval timed out after ${timeoutMs / 1000}s` });
      }
    }, timeoutMs);

    pendingApprovals.set(approvalId, { resolve, timer, tool, args });
  });
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

  logger.info({
    msg: "Human UX approval action received",
    approvalId,
    tool: pending.tool,
    decision: decision.decision,
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
