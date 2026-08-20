const DELAY_SECONDS = 5;

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
const volumeSlider = document.getElementById('volume-slider');
const delaySlider = document.getElementById('delay-slider');
const delayValue = document.getElementById('delay-value');

let ws;
let pc;
let rawLocalStream;
let delayedOutgoingStream;
let audioCtx;
let frameLoopId;
let isMuted = false;
let isCameraOff = false;
let currentDelay = DELAY_SECONDS;

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

delaySlider.addEventListener('input', (e) => {
  const newDelay = parseInt(e.target.value);
  currentDelay = newDelay;
  delayValue.textContent = `${newDelay}s`;
  
  // Restart delay stream with new delay
  if (delayedOutgoingStream) {
    // Stop current delay stream
    if (frameLoopId) cancelAnimationFrame(frameLoopId);
    if (audioCtx) audioCtx.close();
    
    // Build new delay stream
    delayedOutgoingStream = buildDelayedStream(rawLocalStream, currentDelay);
    
    // Update peer connection with new stream
    delayedOutgoingStream.getTracks().forEach((track) => {
      const sender = pc.getSenders().find(s => s.track.kind === track.kind);
      if (sender) {
        sender.replaceTrack(track);
      } else {
        pc.addTrack(track, delayedOutgoingStream);
      }
    });
  }
});

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

  setStatus('Preparing 5-second delay buffer…');
  delayedOutgoingStream = buildDelayedStream(rawLocalStream, DELAY_SECONDS);

  setStatus('Connecting to signaling server…');
  connectSignaling(room);
}

// Builds a MediaStream that mirrors `sourceStream` but delayed by `seconds`.
// Video is delayed by buffering frames on a canvas; audio via a Web Audio DelayNode.
function buildDelayedStream(sourceStream, seconds) {
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
    while (frameQueue.length && frameQueue[0].t <= now - seconds * 1000) {
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
    const delayNode = audioCtx.createDelay(seconds + 1);
    delayNode.delayTime.value = seconds;
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
    ws.send(JSON.stringify({ type: 'join', room }));
  });

  ws.addEventListener('message', async (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case 'joined':
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
        setStatus('Peer joined. Negotiating connection…');
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
      setStatus(`Connected. Your peer sees you ${currentDelay} seconds behind real time.`);
    } else if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      setStatus(`Connection ${pc.connectionState}.`);
    }
  };
}
