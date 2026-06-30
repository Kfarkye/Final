# Truth Chrome Bridge

Truth Chrome Bridge is the first-class browser runtime for Truth. It connects the Truth app to a real, user-owned Chrome tab instead of relying on hidden backend Chromium automation.

## Runtime Topology

```txt
Truth Web App
  → content-script command bridge
  → MV3 service worker
  → real Chrome tab
  → chrome.tabCapture stream
  → offscreen WebRTC peer
  → live video in Truth
```

## Capabilities

- Open or update a real Chrome tab from Truth's URL bar.
- Connect to the user's current active tab.
- Stream the tab into Truth through WebRTC.
- Dispatch native mouse, wheel, text, and key events through `chrome.debugger` CDP input.
- Read sanitized DOM/text/table state through `chrome.scripting`.
- Capture durable screenshots with `chrome.tabs.captureVisibleTab`.

## Safety Boundary

- The extension is user-installed and user-revocable.
- Sensitive credentials, MFA codes, payment fields, cookies, and auth tokens stay human-controlled.
- Agent actions must be explicit and auditable in Truth.
- The bridge is not a crawler, stealth engine, or anti-bot bypass product.

## Local Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder:

```txt
/Users/k.far.88/Developer/reverie/extensions/truth-chrome-bridge
```

5. Open Truth and use Browser mode.
6. The Browser panel should show **Chrome Bridge Connected**.

## Production Install

Ship this directory through the Chrome Web Store or enterprise extension distribution. The app already detects the content-script bridge on `https://mcptruth.com/*`, `http://localhost:3000/*`, and `http://127.0.0.1:3000/*`.
