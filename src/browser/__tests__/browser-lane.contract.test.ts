import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { detectBrowserLaneBlocker } from "../browser-lane.contract";

const root = resolve(__dirname, "../../..");

describe("Hybrid Browser Lane contract", () => {
  it("records the shared Chrome/CDP architecture contract", () => {
    const manifest = readFileSync(resolve(root, "config/contracts/hybrid-browser-lane.manifest.yaml"), "utf8");
    const feature = readFileSync(resolve(root, "features/browser-lane.feature"), "utf8");

    expect(manifest).toContain("name: hybrid-browser-lane");
    expect(manifest).toContain("AI operations must execute on the identical CDP target as the human viewport.");
    expect(manifest).toContain("webrtc_or_novnc");
    expect(manifest).toContain("cdp: 9222");
    expect(feature).toContain("AI and Human share the identical session");
    expect(feature).toContain("Human handles secure authentication");
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

  it("classifies login and MFA pages as human-only surfaces", () => {
    expect(detectBrowserLaneBlocker({ text: "Sign in with your password" })?.kind).toBe("AUTH");
    expect(detectBrowserLaneBlocker({ text: "Enter your one-time code from the authenticator app" })?.kind).toBe("MFA");
  });
});
