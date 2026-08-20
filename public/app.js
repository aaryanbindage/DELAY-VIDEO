const roomInput = document.getElementById('room-input');
const joinBtn = document.getElementById('join-btn');
const statusEl = document.getElementById('status');
const shareRow = document.getElementById('share-row');
const shareLink = document.getElementById('share-link');
const copyBtn = document.getElementById('copy-btn');
const setupPanel = document.getElementById('setup');
const callSection = document.getElementById('call');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const remotePlaceholder = document.getElementById('remote-placeholder');
const delayCanvas = document.getElementById('delay-canvas');
const muteBtn = document.getElementById('mute-btn');
const cameraBtn = document.getElementById('camera-btn');
const screenShareBtn = document.getElementById('screen-share-btn');
const volumeSlider = document.getElementById('volume-slider');
const delaySlider = document.getElementById('delay-slider');
const delayValueEl = document.getElementById('delay-value');
const localLabel = document.getElementById('local-label');
const remoteLabel = document.getElementById('remote-label');

let ws;
let pc;
let rawLocalStream;
let delayedOutgoingStream;
let audioCtx;
let delayNode;
let frameLoopId;
let isMuted = false;
let isCameraOff = false;
let screenStream = null;
let delaySourceVideoEl; // the hidden <video> that buildDelayedStream() reads frames from

// Mutable so the slider can change it live, mid-call.
const delayState = { value: parseFloat(delaySlider.value) };
let peerDelay = null;

function updateLocalLabel() {
  const activity = screenStream ? 'sharing screen' : 'live';
  localLabel.textContent = `You (${activity}) — peer sees you ${delayState.value}s delayed`;
}

function updateRemoteLabel() {
  remoteLabel.textContent = peerDelay === null ? 'Peer' : `Peer (${peerDelay}s delayed)`;
}
updateLocalLabel();
updateRemoteLabel();

delaySlider.addEventListener('input', () => {
  delayState.value = parseFloat(delaySlider.value);
  delayValueEl.textContent = delayState.value;
  updateLocalLabel();

  if (delayNode) {
    delayNode.delayTime.value = delayState.value;
  }
  if (ws && ws.readyState === WebSocket.OPEN && pc) {
    ws.send(JSON.stringify({ type: 'delay-change', delay: delayState.value }));
  }
});

function setStatus(text) {
  statusEl.textContent = text;
}

function randomRoomCode() {
  return Math.random().toString(36).slice(2, 8);
}

// Prefill room code from ?room= in the URL, if present.
const params = new URLSearchParams(window.location.search);
if (params.get('room')) {
  roomInput.value = params.get('room');
}

joinBtn.addEventListener('click', () => {
  const room = (roomInput.value || randomRoomCode()).trim().toLowerCase().replace(/\s+/g, '-');
  roomInput.value = room;
  joinCall(room);
});

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(shareLink.href);
    copyBtn.textContent = 'Copied!';
    setTimeout(() => (copyBtn.textContent = 'Copy'), 1500);
  } catch {
    // Clipboard API unavailable; user can select the link text manually.
  }
});

muteBtn.addEventListener('click', () => {
  if (!rawLocalStream) return;
  
  const audioTrack = rawLocalStream.getAudioTracks()[0];
  if (audioTrack) {
    isMuted = !isMuted;
    audioTrack.enabled = !isMuted;
    muteBtn.classList.toggle('active', isMuted);
    muteBtn.querySelector('.status').textContent = isMuted ? 'Unmute' : 'Mute';
    muteBtn.querySelector('.icon').textContent = isMuted ? '🔇' : '🎤';
  }
});

cameraBtn.addEventListener('click', () => {
  if (!rawLocalStream) return;
  
  const videoTrack = rawLocalStream.getVideoTracks()[0];
  if (videoTrack) {
    isCameraOff = !isCameraOff;
    videoTrack.enabled = !isCameraOff;
    cameraBtn.classList.toggle('active', isCameraOff);
    cameraBtn.querySelector('.status').textContent = isCameraOff ? 'Camera On' : 'Camera Off';
    cameraBtn.querySelector('.icon').textContent = isCameraOff ? '📷' : '📹';
  }
});

volumeSlider.addEventListener('input', (e) => {
  remoteVideo.volume = e.target.value;
});

// Swaps what the delay pipeline reads frames from (camera vs. screen).
// The outgoing WebRTC track is always the canvas capture, so this needs no renegotiation.
function setDelaySource(stream) {
  delaySourceVideoEl.srcObject = stream;
  delaySourceVideoEl.play().catch(() => {});
}

screenShareBtn.addEventListener('click', () => {
  if (!delaySourceVideoEl) return;
  if (screenStream) {
    stopScreenShare();
  } else {
    startScreenShare();
  }
});

async function startScreenShare() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  } catch (err) {
    setStatus(`Could not start screen share: ${err.message}`);
    return;
  }

  screenStream = stream;
  setDelaySource(screenStream);
  localVideo.srcObject = screenStream;
  updateLocalLabel();

  screenShareBtn.classList.add('active');
  screenShareBtn.querySelector('.status').textContent = 'Stop Sharing';
  screenShareBtn.querySelector('.icon').textContent = '🛑';

  // The browser's own "Stop sharing" control also needs to revert us to the camera.
  screenStream.getVideoTracks()[0].addEventListener('ended', stopScreenShare);
}

function stopScreenShare() {
  if (!screenStream) return;
  screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null;

  setDelaySource(rawLocalStream);
  localVideo.srcObject = rawLocalStream;
  updateLocalLabel();

  screenShareBtn.classList.remove('active');
  screenShareBtn.querySelector('.status').textContent = 'Share Screen';
  screenShareBtn.querySelector('.icon').textContent = '🖥️';
}

async function joinCall(room) {
  joinBtn.disabled = true;
  roomInput.disabled = true;
  setStatus('Requesting camera and microphone…');

  try {
    rawLocalStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    setStatus(`Could not access camera/microphone: ${err.message}`);
    joinBtn.disabled = false;
    roomInput.disabled = false;
    return;
  }

  localVideo.srcObject = rawLocalStream;
  callSection.classList.remove('hidden');

  const url = new URL(window.location.href);
  url.searchParams.set('room', room);
  shareLink.href = url.toString();
  shareLink.textContent = url.toString();
  shareRow.classList.remove('hidden');

  setStatus('Preparing delay buffer…');
  delayedOutgoingStream = buildDelayedStream(rawLocalStream, delayState);

  setStatus('Connecting to signaling server…');
  connectSignaling(room);
}

// Builds a MediaStream that mirrors `sourceStream` but delayed by `delayState.value` seconds.
// `delayState` is read live each frame, so the delay can change mid-call.
// Video is delayed by buffering frames on a canvas; audio via a Web Audio DelayNode.
function buildDelayedStream(sourceStream, delayState) {
  const videoTrack = sourceStream.getVideoTracks()[0];
  const settings = videoTrack ? videoTrack.getSettings() : {};
  delayCanvas.width = settings.width || 640;
  delayCanvas.height = settings.height || 480;
  const ctx = delayCanvas.getContext('2d', { alpha: false });

  const sourceVideoEl = document.createElement('video');
  sourceVideoEl.srcObject = sourceStream;
  sourceVideoEl.muted = true;
  sourceVideoEl.playsInline = true;
  sourceVideoEl.play().catch(() => {});
  sourceVideoEl.addEventListener('loadedmetadata', () => {
    if (sourceVideoEl.videoWidth) {
      delayCanvas.width = sourceVideoEl.videoWidth;
      delayCanvas.height = sourceVideoEl.videoHeight;
    }
  });
  delaySourceVideoEl = sourceVideoEl;

  const frameQueue = [];

  async function tick() {
    const now = performance.now();

    if (sourceVideoEl.readyState >= 2) {
      try {
        const bitmap = await createImageBitmap(sourceVideoEl);
        frameQueue.push({ bitmap, t: now });
      } catch {
        // Source not ready this tick; skip.
      }
    }

    let latestDue = null;
    while (frameQueue.length && frameQueue[0].t <= now - delayState.value * 1000) {
      const frame = frameQueue.shift();
      if (latestDue) latestDue.bitmap.close();
      latestDue = frame;
    }
    if (latestDue) {
      ctx.drawImage(latestDue.bitmap, 0, 0, delayCanvas.width, delayCanvas.height);
      latestDue.bitmap.close();
    }

    frameLoopId = requestAnimationFrame(tick);
  }
  frameLoopId = requestAnimationFrame(tick);

  const canvasStream = delayCanvas.captureStream(30);
  const outStream = new MediaStream();
  canvasStream.getVideoTracks().forEach((t) => outStream.addTrack(t));

  const audioTrack = sourceStream.getAudioTracks()[0];
  if (audioTrack) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(new MediaStream([audioTrack]));
    delayNode = audioCtx.createDelay(31); // covers the full 0-30s slider range
    delayNode.delayTime.value = delayState.value;
    const dest = audioCtx.createMediaStreamDestination();
    source.connect(delayNode).connect(dest);
    dest.stream.getAudioTracks().forEach((t) => outStream.addTrack(t));
  }

  return outStream;
}

function connectSignaling(room) {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${protocol}://${window.location.host}`);

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'join', room, delay: delayState.value }));
  });

  ws.addEventListener('message', async (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case 'joined':
        if (typeof msg.peerDelay === 'number') {
          peerDelay = msg.peerDelay;
          updateRemoteLabel();
        }
        setStatus(
          msg.initiator
            ? 'Room joined. Connecting to peer…'
            : 'Room joined. Waiting for the other person to connect…'
        );
        setupPeerConnection();
        if (msg.initiator) {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          ws.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }));
        }
        break;

      case 'peer-joined':
        peerDelay = msg.peerDelay;
        updateRemoteLabel();
        setStatus('Peer joined. Negotiating connection…');
        break;

      case 'delay-change':
        peerDelay = msg.delay;
        updateRemoteLabel();
        break;

      case 'offer':
        if (!pc) setupPeerConnection();
        await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: 'answer', sdp: answer.sdp }));
        break;

      case 'answer':
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
        break;

      case 'ice-candidate':
        if (msg.candidate) {
          try {
            await pc.addIceCandidate(msg.candidate);
          } catch {
            // Ignore late/invalid candidates.
          }
        }
        break;

      case 'peer-left':
        setStatus('The other person disconnected.');
        remotePlaceholder.classList.remove('hidden');
        remoteVideo.srcObject = null;
        break;

      case 'room-full':
        setStatus('That room already has two people in it. Try a different room code.');
        break;
    }
  });

  ws.addEventListener('close', () => {
    setStatus('Disconnected from signaling server.');
  });
}

function setupPeerConnection() {
  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });

  delayedOutgoingStream.getTracks().forEach((track) => {
    pc.addTrack(track, delayedOutgoingStream);
  });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(JSON.stringify({ type: 'ice-candidate', candidate: event.candidate }));
    }
  };

  pc.ontrack = (event) => {
    remotePlaceholder.classList.add('hidden');
    remoteVideo.srcObject = event.streams[0];
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      setStatus(`Connected. Your peer sees you ${delayState.value}s behind real time.`);
    } else if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      setStatus(`Connection ${pc.connectionState}.`);
    }
  };
}
