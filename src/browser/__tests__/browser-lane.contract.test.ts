import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectBrowserLaneBlocker,
  getBrowserLaneBlockerGuidance,
} from "../browser-lane.contract";

const root = resolve(__dirname, "../../..");

describe("Hybrid Browser Lane contract", () => {
  it("records the shared Chrome/CDP architecture contract", () => {
    const manifest = readFileSync(resolve(root, "config/contracts/hybrid-browser-lane.manifest.yaml"), "utf8");
    const feature = readFileSync(resolve(root, "features/browser-lane.feature"), "utf8");

    expect(manifest).toContain("name: hybrid-browser-lane");
    expect(manifest).toContain("AI operations must execute on the identical CDP target as the human viewport.");
    expect(manifest).toContain("Default web-page handling is a single normal browser page session");
    expect(manifest).toContain("Assistant clicks, typing, scrolling, retries, research, crawling, and multi-source fan-out require explicit user intent");
    expect(manifest).toContain("not a stealth, bot-detection bypass, or anti-challenge product");
    expect(manifest).toContain("webrtc_or_novnc");
    expect(manifest).toContain("cdp: 9222");
    expect(feature).toContain("AI and Human share the identical session");
    expect(feature).toContain("Human handles secure authentication");
    expect(feature).toContain("Browser core is not a hidden crawler");
  });

  it("keeps browser core separate from crawler and stealth language", () => {
    const browserTools = readFileSync(resolve(root, "src/tools/browser.tools.ts"), "utf8");
    const registry = readFileSync(resolve(root, "src/components/McpRegistry.tsx"), "utf8");
    const chatClient = readFileSync(resolve(root, "src/ChatClient.tsx"), "utf8");
    const browserPanel = readFileSync(resolve(root, "src/components/BrowserPanel.tsx"), "utf8");

    expect(browserTools).toContain("Browser core tool for navigating one Chromium page session");
    expect(browserTools).toContain("does not crawl, parallel-fetch, fan out, retry-loop, stealth, or bypass site challenges");
    expect(browserTools).not.toContain("StealthPlugin");
    expect(browserTools).not.toContain("bot-mitigation bypass");
    expect(browserTools).not.toContain("evades Cloudflare");
    expect(registry).not.toContain("bypasses anti-bot systems");
    expect(registry).toContain("Browser Core");
    expect(chatClient).toContain("Default = browser. Automation = explicit. Research/crawling = separate bounded mode only when the user asks for it.");
    expect(chatClient).toContain("const browserSurfaceActive = workspaceOpen && activeRightTab === 'browser';");
    expect(chatClient).toContain("const supportPanelWidth = browserSurfaceActive ? 'calc(100vw - 420px)' : 380;");
    expect(chatClient).toContain("Browser mode promotes this area into the primary surface.");
    expect(browserPanel).toContain("First-class browser");
    expect(browserPanel).toContain("min-h-[520px] xl:min-h-[640px]");
  });

  it("classifies public-site challenges as human-control blockers", () => {
    const blocker = detectBrowserLaneBlocker({
      url: "https://www.espn.com/",
      title: "",
      text: "Max challenge attempts exceeded. Please refresh the page to try again.",
    });

    expect(blocker).toEqual({
      kind: "BOT_CHALLENGE",
      status: "BLOCKED_FOR_AUTH",
      message: "Browser challenge requires human control",
      evidence: "Max challenge attempts exceeded",
    });
  });

  it("tells the agent not to retry browser-challenge loops", () => {
    const blocker = detectBrowserLaneBlocker({
      url: "https://www.espn.com/",
      text: "Max challenge attempts exceeded. Please refresh the page to try again.",
    });

    expect(blocker).not.toBeNull();
    const guidance = getBrowserLaneBlockerGuidance(blocker!, "https://www.espn.com/");
    expect(guidance.title).toBe("espn.com blocked automated Chromium");
    expect(guidance.agentAction).toContain("Stop retrying this browser page");
    expect(guidance.agentAction).toContain("official APIs");
  });

  it("classifies login and MFA pages as human-only surfaces", () => {
    expect(detectBrowserLaneBlocker({ text: "Sign in with your password" })?.kind).toBe("AUTH");
    expect(detectBrowserLaneBlocker({ text: "Enter your one-time code from the authenticator app" })?.kind).toBe("MFA");
  });
});
