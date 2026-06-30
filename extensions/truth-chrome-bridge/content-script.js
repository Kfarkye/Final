const CHANNEL = "truth-chrome-bridge";
const APP_SOURCE = "truth-app";
const BRIDGE_SOURCE = "truth-chrome-bridge";
const VERSION = "1.0.0";

const port = chrome.runtime.connect({ name: "truth-app" });

function postToApp(message) {
  window.postMessage(
    {
      channel: CHANNEL,
      source: BRIDGE_SOURCE,
      version: VERSION,
      ...message,
    },
    window.location.origin,
  );
}

port.onMessage.addListener((message) => {
  postToApp(message);
});

port.onDisconnect.addListener(() => {
  postToApp({
    type: "DISCONNECTED",
    payload: {
      reason: chrome.runtime.lastError?.message || "Extension service worker disconnected",
    },
  });
});

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;

  const message = event.data;
  if (!message || message.channel !== CHANNEL || message.source !== APP_SOURCE) return;

  port.postMessage({
    ...message,
    appOrigin: window.location.origin,
    appHref: window.location.href,
  });
});

postToApp({
  type: "READY",
  payload: {
    version: VERSION,
    href: window.location.href,
    transport: "content-script-runtime-port",
  },
});

port.postMessage({
  channel: CHANNEL,
  source: APP_SOURCE,
  type: "HELLO",
  payload: {
    version: VERSION,
    href: window.location.href,
  },
});
