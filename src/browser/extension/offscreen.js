/**
 * Truth Browser Bridge — Offscreen Document (offscreen.js)
 * --------------------------------------------------------
 * Redeems a tabCapture stream id into a real MediaStream and publishes it to
 * Truth over WebRTC. This is intentionally live video, not a canvas/JPEG frame
 * pump: the human browser surface should feel like a browser tab, not a
 * periodically refreshed screenshot.
 */

let stream = null;
let peerConnection = null;

function sendToBackground(type, payload = {}) {
  chrome.runtime.sendMessage({
    target: "background",
    type: "RTC_SIGNAL",
    payload: {
      type,
      ...payload,
    },
  });
}

async function stopStream() {
  if (peerConnection) {
    peerConnection.getSenders().forEach((sender) => {
      try {
        sender.track?.stop();
      } catch {
        // Best-effort cleanup.
      }
    });
    peerConnection.close();
    peerConnection = null;
  }

  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  sendToBackground("STREAM_STOPPED");
}

async function startStream({ streamId, sessionId }) {
  await stopStream();

  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        minWidth: 1280,
        maxWidth: 1920,
        minHeight: 720,
        maxHeight: 1080,
        minFrameRate: 30,
        maxFrameRate: 60,
      },
    },
  });

  peerConnection = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

  peerConnection.onicecandidate = (event) => {
    if (!event.candidate) return;
    sendToBackground("ICE_CANDIDATE", {
      candidate: event.candidate.toJSON(),
      sessionId,
    });
  };

  peerConnection.onconnectionstatechange = () => {
    sendToBackground("RTC_STATE", {
      state: peerConnection?.connectionState || "closed",
      sessionId,
    });
  };

  stream.getTracks().forEach((track) => {
    peerConnection?.addTrack(track, stream);
  });

  const offer = await peerConnection.createOffer({
    offerToReceiveAudio: false,
    offerToReceiveVideo: false,
  });
  await peerConnection.setLocalDescription(offer);

  sendToBackground("SDP_OFFER", {
    sdp: peerConnection.localDescription?.toJSON(),
    sessionId,
  });
}

async function applyAnswer({ sdp }) {
  if (!peerConnection) throw new Error("No active peer connection");
  await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
}

async function addIceCandidate({ candidate }) {
  if (!peerConnection || !candidate) return;
  await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== "offscreen") return false;

  (async () => {
    if (message.type === "START_STREAM") {
      await startStream(message.payload || {});
    } else if (message.type === "WEBRTC_ANSWER") {
      await applyAnswer(message.payload || {});
    } else if (message.type === "ICE_CANDIDATE") {
      await addIceCandidate(message.payload || {});
    } else if (message.type === "STOP_STREAM") {
      await stopStream();
    }

    sendResponse({ ok: true });
  })().catch((error) => {
    sendToBackground("STREAM_ERROR", {
      message: error.message || String(error),
    });
    sendResponse({ ok: false, error: error.message || String(error) });
  });

  return true;
});
