import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const extensionRoot = resolve(root, "extensions/truth-chrome-bridge");
const serverExtensionRoot = resolve(root, "src/browser/extension");
const requiredFiles = [
  "manifest.json",
  "background.js",
  "content-script.js",
  "offscreen.html",
  "offscreen.js",
  "README.md",
];

function fail(message) {
  console.error(`✗ Truth Chrome Bridge validation failed: ${message}`);
  process.exit(1);
}

function assertContains(file, text, label = text) {
  const content = readFileSync(resolve(extensionRoot, file), "utf8");
  if (!content.includes(text)) {
    fail(`${file} is missing ${label}`);
  }
}

function assertFileContains(path, text, label = text) {
  const fullPath = resolve(root, path);
  if (!existsSync(fullPath)) fail(`missing ${path}`);
  const content = readFileSync(fullPath, "utf8");
  if (!content.includes(text)) {
    fail(`${path} is missing ${label}`);
  }
}

for (const file of requiredFiles) {
  if (!existsSync(resolve(extensionRoot, file))) {
    fail(`missing ${file}`);
  }
}

const manifest = JSON.parse(readFileSync(resolve(extensionRoot, "manifest.json"), "utf8"));
const permissions = new Set(manifest.permissions || []);
const matches = manifest.content_scripts?.flatMap((script) => script.matches || []) || [];

if (manifest.manifest_version !== 3) fail("manifest_version must be 3");
if (manifest.name !== "Truth Chrome Bridge") fail("manifest name must be Truth Chrome Bridge");

for (const permission of ["tabs", "tabCapture", "offscreen", "debugger", "scripting"]) {
  if (!permissions.has(permission)) fail(`missing ${permission} permission`);
}

for (const match of ["https://mcptruth.com/*", "http://localhost:3000/*", "http://127.0.0.1:3000/*"]) {
  if (!matches.includes(match)) fail(`missing content-script match ${match}`);
}

assertContains("background.js", "chrome.tabCapture.getMediaStreamId");
assertContains("background.js", "chrome.offscreen.createDocument");
assertContains("background.js", "chrome.action.onClicked.addListener", "toolbar click connect handler");
assertContains("background.js", "CAPTURE_PERMISSION_REQUIRED", "recoverable capture permission event");
assertContains("background.js", "chrome.debugger.sendCommand");
assertContains("background.js", "Input.dispatchMouseEvent");
assertContains("background.js", "NATIVE_DRAG", "native drag command support");
assertContains("background.js", "NATIVE_CONTEXT_MENU", "native context menu support");
assertContains("offscreen.js", "new RTCPeerConnection");
assertContains("offscreen.js", "navigator.mediaDevices.getUserMedia");
assertContains("content-script.js", "truth-chrome-bridge");
assertContains("README.md", "user-owned Chrome tab");

for (const file of ["manifest.json", "background.js", "offscreen.html", "offscreen.js"]) {
  if (!existsSync(resolve(serverExtensionRoot, file))) {
    fail(`missing server-bridge extension file src/browser/extension/${file}`);
  }
}

const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
if (!packageJson.dependencies?.ws) fail("package.json must declare direct ws dependency");
if (!packageJson.dependencies?.redis) fail("package.json must declare redis dependency for multi-instance bridge routing");
if (!packageJson.devDependencies?.["@types/ws"]) fail("package.json must declare @types/ws devDependency");

assertFileContains("server-runtime.ts", "browserBridgeRoutes", "browser bridge route mount");
assertFileContains("server-runtime.ts", "extensionBridge.attach(server)", "extension bridge HTTP upgrade hook");
assertFileContains("src/browser/extension-bridge.ts", "WebSocketServer", "WebSocket server bridge");
assertFileContains("src/browser/extension-bridge.ts", "createClient", "Redis backplane client");
assertFileContains("src/browser/extension-bridge.ts", "truth:browser-bridge:bus", "Redis backplane channel default");
assertFileContains("src/browser/extension-bridge.ts", "publishBackplane", "backplane publish path");
assertFileContains("src/browser/extension-bridge.ts", "onBackplaneMessage", "backplane subscribe path");
assertFileContains("src/browser/extension-bridge.ts", "WEBRTC_ANSWER", "server bridge WebRTC answer command");
assertFileContains("src/browser/extension-bridge.ts", "NATIVE_CLICK", "server bridge native click command");
assertFileContains("src/browser/extension-bridge.ts", "NATIVE_MOUSE_MOVE", "server bridge native mouse move command");
assertFileContains("src/browser/extension-bridge.ts", "NATIVE_DRAG", "server bridge native drag command");
assertFileContains("src/browser/extension-bridge.ts", "NATIVE_CONTEXT_MENU", "server bridge native context menu command");
assertFileContains("src/browser/browser-bridge.routes.ts", '"/bridge/stream"', "SSE bridge stream route");
assertFileContains("src/browser/browser-bridge.routes.ts", "backplaneStatus", "bridge status includes backplane telemetry");
assertFileContains("src/browser/browser-bridge.routes.ts", '"/bridge/webrtc/answer"', "WebRTC answer route");
assertFileContains("src/browser/browser-bridge.routes.ts", '"/bridge/native/click"', "native click route");
assertFileContains("src/browser/browser-bridge.routes.ts", '"/bridge/native/move"', "native move route");
assertFileContains("src/browser/browser-bridge.routes.ts", '"/bridge/native/drag"', "native drag route");
assertFileContains("src/browser/browser-bridge.routes.ts", '"/bridge/native/context-menu"', "native context menu route");
assertFileContains("src/browser/browser-bridge.routes.ts", "sseManager.addClient", "real SSEManager addClient API");
assertFileContains("src/components/BrowserPanel.tsx", "/api/browser/bridge/stream", "BrowserPanel server bridge stream");
assertFileContains("src/components/BrowserPanel.tsx", "webrtc/answer", "BrowserPanel server bridge WebRTC answer");
assertFileContains("src/components/BrowserPanel.tsx", "NATIVE_MOUSE_MOVE", "BrowserPanel native mouse move relay");
assertFileContains("src/components/BrowserPanel.tsx", "urlInputEditingRef", "BrowserPanel URL editing guard");
assertFileContains("src/components/BrowserPanel.tsx", "syncUrlInputFromRuntime", "BrowserPanel URL runtime sync guard");
assertFileContains("src/components/BrowserPanel.tsx", "clickServerBridgeFrame", "BrowserPanel interactive frame fallback");
assertFileContains("src/components/BrowserPanel.tsx", "sendBridgeDrag", "BrowserPanel drag relay helper");
assertFileContains("src/components/BrowserPanel.tsx", 'type="submit"', "BrowserPanel submit button");
assertFileContains("src/components/BrowserPanel.tsx", "!urlInput.trim()", "BrowserPanel submit disable guard");
assertFileContains("src/components/BrowserPanel.tsx", "Live preview syncing", "BrowserPanel labels fallback preview");
assertFileContains("src/components/BrowserPanel.tsx", "+ Tab", "BrowserPanel tab UX");
const browserPanelSource = readFileSync(resolve(root, "src/components/BrowserPanel.tsx"), "utf8");
if (browserPanelSource.includes("Truth Chrome Bridge")) {
  fail("BrowserPanel should not expose bridge wording in primary UX");
}

console.log("✓ Truth Chrome Bridge MV3/WebRTC/CDP + server bridge contract verified");
