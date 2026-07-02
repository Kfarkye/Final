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
    expect(manifest).toContain("Truth Chrome Bridge");
    expect(manifest).toContain("Chrome MV3 extension");
    expect(manifest).toContain("chrome.tabCapture + offscreen document + WebRTC PeerConnection");
    expect(manifest).toContain("chrome.debugger CDP Input domain");
    expect(manifest).toContain("AI operations must execute on the identical CDP target as the human viewport.");
    expect(manifest).toContain("Default web-page handling is a single normal browser page session");
    expect(manifest).toContain("Assistant clicks, typing, scrolling, retries, research, crawling, and multi-source fan-out require explicit user intent");
    expect(manifest).toContain("not a stealth, bot-detection bypass, or anti-challenge product");
    expect(manifest).toContain("webrtc_or_novnc");
    expect(manifest).toContain("cdp: 9222");
    expect(feature).toContain("AI and Human share the identical session");
    expect(feature).toContain("Human handles secure authentication");
    expect(feature).toContain("Browser core is not a hidden crawler");
    expect(feature).toContain("Truth Chrome Bridge is the first-class human browser");
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
    expect(chatClient).toContain("const supportPanelWidth = browserSurfaceActive ? 'calc(100vw - 320px)' : 380;");
    expect(chatClient).toContain("sidebarOpen && !browserSurfaceActive");
    expect(chatClient).toContain("Browser mode promotes this area into the primary surface.");
    expect(browserPanel).toContain("Start browsing");
    expect(browserPanel).toContain("+ Tab");
    expect(browserPanel).toContain("urlInputEditingRef");
    expect(browserPanel).toContain("syncUrlInputFromRuntime");
    expect(browserPanel).toContain("onFocus={() => {");
    expect(browserPanel).toContain("onBlur={() => {");
    expect(browserPanel).toContain("Live preview syncing");
    expect(browserPanel).not.toContain("Truth Chrome Bridge");
  });

  it("ships a first-class MV3 Chrome Bridge with WebRTC streaming and CDP input", () => {
    const extensionRoot = resolve(root, "extensions/truth-chrome-bridge");
    const extensionManifest = JSON.parse(readFileSync(resolve(extensionRoot, "manifest.json"), "utf8"));
    const background = readFileSync(resolve(extensionRoot, "background.js"), "utf8");
    const offscreen = readFileSync(resolve(extensionRoot, "offscreen.js"), "utf8");
    const contentScript = readFileSync(resolve(extensionRoot, "content-script.js"), "utf8");
    const readme = readFileSync(resolve(extensionRoot, "README.md"), "utf8");
    const browserPanel = readFileSync(resolve(root, "src/components/BrowserPanel.tsx"), "utf8");
    const serverExtension = readFileSync(resolve(root, "src/browser/extension/offscreen.js"), "utf8");
    const bridgeRoutes = readFileSync(resolve(root, "src/browser/browser-bridge.routes.ts"), "utf8");

    expect(extensionManifest.manifest_version).toBe(3);
    expect(extensionManifest.name).toBe("Truth Chrome Bridge");
    expect(extensionManifest.permissions).toEqual(expect.arrayContaining([
      "debugger",
      "offscreen",
      "scripting",
      "tabCapture",
      "tabs",
    ]));
    expect(extensionManifest.content_scripts[0].matches).toEqual(expect.arrayContaining([
      "https://mcptruth.com/*",
      "http://localhost:3000/*",
      "http://127.0.0.1:3000/*",
    ]));

    expect(background).toContain("chrome.tabCapture.getMediaStreamId");
    expect(background).toContain("chrome.offscreen.createDocument");
    expect(background).toContain("chrome.debugger.sendCommand");
    expect(background).toContain("Input.dispatchMouseEvent");
    expect(background).toContain("Input.insertText");
    expect(offscreen).toContain("navigator.mediaDevices.getUserMedia");
    expect(offscreen).toContain("new RTCPeerConnection");
    expect(contentScript).toContain("truth-chrome-bridge");
    expect(readme).toContain("real, user-owned Chrome tab");

    expect(browserPanel).toContain("sendChromeBridgeCommand('NAVIGATE'");
    expect(browserPanel).toContain("NATIVE_CLICK");
    expect(browserPanel).toContain("NATIVE_MOUSE_MOVE");
    expect(browserPanel).toContain("chromeBridgeVideoRef");
    expect(browserPanel).toContain("webrtc/answer");
    expect(browserPanel).toContain("native/click");
    expect(browserPanel).toContain("native/move");
    expect(browserPanel).toContain("clickServerBridgeFrame");
    expect(serverExtension).toContain("startStream");
    expect(serverExtension).toContain("canvas.toDataURL");
    expect(bridgeRoutes).toContain('"/bridge/webrtc/answer"');
    expect(bridgeRoutes).toContain('"/bridge/native/click"');
    expect(bridgeRoutes).toContain('"/bridge/native/move"');
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
