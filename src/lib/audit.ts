export const logAuditAction = async (currentUser: any, action: string, details: any = {}) => {
  if (!currentUser) return;
  try {
    await fetch('/api/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: currentUser.uid,
        email: currentUser.email,
        action,
        details
      })
    });
  } catch (e) {
    console.error("Failed to log audit action", e);
  }
};
