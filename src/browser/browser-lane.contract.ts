export type BrowserLaneEnvironment = "local" | "gcp";

export type SessionState =
  | "INITIALIZING"
  | "AWAITING_HUMAN_AUTH"
  | "ACTIVE"
  | "TERMINATED";

export type ToolTraceActor = "HUMAN" | "AI";

export type ToolTraceBrowserAction =
  | "NAVIGATE"
  | "CLICK"
  | "INPUT"
  | "SCROLL"
  | "EXTRACT";

export type ToolTraceBrowserStatus =
  | "SUCCESS"
  | "FAILED"
  | "BLOCKED_FOR_AUTH";

export type BrowserLaneBlockerKind =
  | "AUTH"
  | "CAPTCHA"
  | "MFA"
  | "PAYMENT"
  | "BOT_CHALLENGE"
  | "SESSION_LOCK"
  | "FORBIDDEN";

export interface BrowserLaneConfig {
  sessionId: string;
  targetUrl?: string;
  environment: BrowserLaneEnvironment;
  headless: false;
}

export interface BrowserLaneSession {
  sessionId: string;
  state: SessionState;
  endpoints: {
    frontendStreamUrl: string;
    cdpDebuggerUrl: string;
  };
  pauseForHumanAuth(): void;
  resumeAIOperations(): void;
  terminate(): Promise<void>;
}

export interface AIBrowserTools {
  attachToSession(cdpUrl: string): Promise<void>;
  navigate(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  extractTable(selector?: string): Promise<Record<string, unknown>[]>;
  screenshot(fullPage: boolean): Promise<Buffer>;
  evaluate<T>(script: string): Promise<T>;
}

export interface ToolTraceLog {
  timestamp: string;
  sessionId: string;
  actor: ToolTraceActor;
  action: ToolTraceBrowserAction;
  target: string;
  status: ToolTraceBrowserStatus;
}

export interface BrowserLaneBlocker {
  kind: BrowserLaneBlockerKind;
  status: Extract<ToolTraceBrowserStatus, "BLOCKED_FOR_AUTH">;
  message: string;
  evidence: string;
}

export interface BrowserLanePageSignal {
  url?: string | null;
  title?: string | null;
  text?: string | null;
  error?: string | null;
}

export interface BrowserLaneBlockerGuidance {
  title: string;
  humanAction: string;
  agentAction: string;
}

const BLOCKER_PATTERNS: Array<{
  kind: BrowserLaneBlockerKind;
  label: string;
  pattern: RegExp;
}> = [
  {
    kind: "BOT_CHALLENGE",
    label: "Browser challenge requires human control",
    pattern: /\b(max challenge attempts exceeded|cloudflare|checking your browser|verify you are human|unusual traffic|bot detection|challenge attempts|press refresh.*try again)\b/i,
  },
  {
    kind: "CAPTCHA",
    label: "CAPTCHA requires human control",
    pattern: /\b(captcha|recaptcha|hcaptcha|prove you.?re human)\b/i,
  },
  {
    kind: "MFA",
    label: "MFA requires human control",
    pattern: /\b(mfa|2fa|two-factor|verification code|one-time code|authenticator app)\b/i,
  },
  {
    kind: "AUTH",
    label: "Login requires human control",
    pattern: /\b(sign in|log in|login required|oauth|authorize application|credentials?|password)\b/i,
  },
  {
    kind: "PAYMENT",
    label: "Payment step requires human control",
    pattern: /\b(payment|credit card|billing|checkout|card number|cvv)\b/i,
  },
  {
    kind: "SESSION_LOCK",
    label: "Session lock requires human control",
    pattern: /\b(session expired|session locked|account locked|reauthenticate)\b/i,
  },
  {
    kind: "FORBIDDEN",
    label: "Access barrier requires human control",
    pattern: /\b(forbidden|access denied|unauthorized|401|403)\b/i,
  },
];

export function detectBrowserLaneBlocker(signal: BrowserLanePageSignal): BrowserLaneBlocker | null {
  const haystack = [
    signal.title,
    signal.url,
    signal.text,
    signal.error,
  ].filter(Boolean).join("\n").slice(0, 8000);

  if (!haystack) return null;

  for (const candidate of BLOCKER_PATTERNS) {
    const match = haystack.match(candidate.pattern);
    if (!match) continue;
    return {
      kind: candidate.kind,
      status: "BLOCKED_FOR_AUTH",
      message: candidate.label,
      evidence: match[0].slice(0, 180),
    };
  }

  return null;
}

export function getBrowserLaneBlockerGuidance(
  blocker: BrowserLaneBlocker,
  url?: string | null,
): BrowserLaneBlockerGuidance {
  const host = (() => {
    try {
      return url ? new URL(url).hostname.replace(/^www\./, "") : "this site";
    } catch {
      return "this site";
    }
  })();

  if (blocker.kind === "BOT_CHALLENGE") {
    return {
      title: `${host} blocked automated Chromium`,
      humanAction: "Use a real human-controlled browser session/profile for the site challenge. Do not type credentials or solve anti-bot checks through the agent.",
      agentAction: "Stop retrying this browser page. Use official APIs, existing sports data tools, search, or another public source until the live Chrome streaming lane is available.",
    };
  }

  if (blocker.kind === "CAPTCHA" || blocker.kind === "MFA" || blocker.kind === "AUTH") {
    return {
      title: "Human authentication checkpoint",
      humanAction: "Complete login, CAPTCHA, or MFA directly as the human. The agent must not capture credentials, one-time codes, cookies, or sensitive form values.",
      agentAction: "Pause browser automation. Resume only after the human confirms the page is past the checkpoint and a fresh screenshot/DOM snapshot is captured.",
    };
  }

  if (blocker.kind === "PAYMENT") {
    return {
      title: "Payment checkpoint",
      humanAction: "Keep all payment fields human-controlled.",
      agentAction: "Do not fill, quote, store, or replay payment data. Resume only on non-sensitive page state.",
    };
  }

  return {
    title: "Human browser checkpoint",
    humanAction: "Review the visible page directly before continuing.",
    agentAction: "Pause automation and resume only from a fresh visible page snapshot.",
  };
}
