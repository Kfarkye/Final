const BRIDGE_SOURCE = "truth-chrome-bridge-offscreen";

let peerConnection = null;
let tabStream = null;
let audioContext = null;

function sendToBackground(type, payload = {}) {
  chrome.runtime.sendMessage({
    source: BRIDGE_SOURCE,
    type,
    payload,
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

  if (tabStream) {
    tabStream.getTracks().forEach((track) => track.stop());
    tabStream = null;
  }

  if (audioContext) {
    await audioContext.close().catch(() => null);
    audioContext = null;
  }

  sendToBackground("STREAM_STOPPED");
}

async function startStream({ streamId, sessionId }) {
  await stopStream();

  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
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

  tabStream.getTracks().forEach((track) => {
    peerConnection.addTrack(track, tabStream);
  });

  try {
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(tabStream);
    source.connect(audioContext.destination);
  } catch {
    sendToBackground("AUDIO_MONITOR_BLOCKED", { sessionId });
  }

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
  if (!message || message.target !== "truth-offscreen") return false;

  (async () => {
    if (message.type === "START_STREAM") {
      await startStream(message.payload);
    } else if (message.type === "WEBRTC_ANSWER") {
      await applyAnswer(message.payload);
    } else if (message.type === "ICE_CANDIDATE") {
      await addIceCandidate(message.payload);
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
