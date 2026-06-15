import { logger } from "./logger";

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
  tool: string;
  args: any;
}

export const pendingApprovals = new Map<string, PendingApproval>();

export function waitForApproval(approvalId: string, tool: string, args: any): Promise<boolean> {
  return new Promise((resolve) => {
    logger.info({ msg: "Awaiting human UX approval for tool", approvalId, tool });
    
    const timer = setTimeout(() => {
      if (pendingApprovals.has(approvalId)) {
        logger.warn({ msg: "Approval request timed out", approvalId, tool });
        pendingApprovals.delete(approvalId);
        resolve(false);
      }
    }, 60000); // 1 minute timeout
    
    pendingApprovals.set(approvalId, { resolve, timer, tool, args });
  });
}

export function handleApproval(approvalId: string, approved: boolean): boolean {
  const pending = pendingApprovals.get(approvalId);
  if (pending) {
    logger.info({ msg: "Human UX approval action received", approvalId, tool: pending.tool, approved });
    clearTimeout(pending.timer);
    pending.resolve(approved);
    pendingApprovals.delete(approvalId);
    return true;
  }
  logger.warn({ msg: "Attempted to approve non-existent or expired request", approvalId });
  return false;
}
