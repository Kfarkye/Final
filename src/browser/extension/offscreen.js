/**
 * Truth Browser Bridge — Offscreen Document (offscreen.js)
 * --------------------------------------------------------
 * Redeems a tabCapture stream id into a live MediaStream and pumps frames to
 * the service worker, which relays them to the Truth bridge as BROWSER_FRAME.
 *
 * Transport today: canvas -> JPEG dataURL @ ~15fps (the "Good" tier). This is
 * what the server bridge + BrowserPanel consume right now.
 *
 * ELITE UPGRADE SEAM (tracked follow-up): replace the canvas pump with an
 * RTCPeerConnection that sends getTracks() over WebRTC for hardware-accelerated,
 * sub-50ms streaming. The SDP/ICE signaling would flow over the same bridge
 * channel via new BRIDGE_EVENT subtypes (SDP_OFFER/SDP_ANSWER/ICE). Until that
 * lands, the JPEG pump keeps the lane fully functional end-to-end.
 */

const FPS = 15;
const JPEG_QUALITY = 0.55;
const MAX_WIDTH = 1280;

let stream = null;
let rafTimer = null;

const video = document.getElementById("cap");
const canvas = document.getElementById("frame");
const ctx = canvas.getContext("2d", { alpha: false });

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.target !== "offscreen") return;
  if (message.type === "START_STREAM") {
    startStream(message.streamId).catch((err) => {
      chrome.runtime.sendMessage({
        target: "background",
        type: "OFFSCREEN_ERROR",
        error: String(err && err.message ? err.message : err),
      });
    });
  } else if (message.type === "STOP_STREAM") {
    stopStream();
  }
});

async function startStream(streamId) {
  stopStream();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 30,
      },
    },
  });
  video.srcObject = stream;
  await video.play().catch(() => {});
  beginPump();
}

function beginPump() {
  const interval = Math.round(1000 / FPS);
  rafTimer = setInterval(() => {
    if (!video.videoWidth || !video.videoHeight) return;
    const scale = Math.min(1, MAX_WIDTH / video.videoWidth);
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    chrome.runtime.sendMessage({ target: "background", type: "FRAME", dataUrl });
  }, interval);
}

function stopStream() {
  if (rafTimer) {
    clearInterval(rafTimer);
    rafTimer = null;
  }
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  if (video) video.srcObject = null;
}
