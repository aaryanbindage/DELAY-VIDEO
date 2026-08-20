const roomInput = document.getElementById('room-input');
const joinBtn = document.getElementById('join-btn');
const statusEl = document.getElementById('status');
const shareRow = document.getElementById('share-row');
const shareLink = document.getElementById('share-link');
const copyBtn = document.getElementById('copy-btn');
const callSection = document.getElementById('call');
const controlsBar = document.getElementById('controls');
const localVideo = document.getElementById('local-video');
const delayCanvas = document.getElementById('delay-canvas');
const muteBtn = document.getElementById('mute-btn');
const cameraBtn = document.getElementById('camera-btn');
const screenShareBtn = document.getElementById('screen-share-btn');
const volumeSlider = document.getElementById('volume-slider');
const delaySlider = document.getElementById('delay-slider');
const delayValueEl = document.getElementById('delay-value');
const localLabel = document.getElementById('local-label');

const honeyContainer = document.getElementById('honey-container');

let ws;
let rawLocalStream;
let delayedOutgoingStream;
let audioCtx;
let delayNode;
let frameLoopId;
let isMuted = false;
let isCameraOff = false;
let screenStream = null;
let delaySourceVideoEl; // the hidden <video> that buildDelayedStream() reads frames from
let honeyDropInterval;
let selfId = null;
let masterVolume = parseFloat(volumeSlider.value);

// peerId -> RTCPeerConnection
const peerConnections = new Map();
// peerId -> { container, video, label, placeholder, delay }
const remotePeers = new Map();

// Mutable so the slider can change it live, mid-call.
const delayState = { value: parseFloat(delaySlider.value) };

function updateLocalLabel() {
  const activity = screenStream ? 'sharing screen' : 'live';
  localLabel.textContent = `You (${activity}) — others see you ${delayState.value}s delayed`;
}

function updateRemoteLabel(peerId) {
  const peer = remotePeers.get(peerId);
  if (!peer) return;
  if (!peer) return;
  peer.label.textContent = typeof peer.delay === 'number' ? `Peer (${peer.delay}s delayed)` : 'Peer';
}

updateLocalLabel();

delaySlider.addEventListener('input', () => {
  delayState.value = parseFloat(delaySlider.value);
  delayValueEl.textContent = delayState.value;
  updateLocalLabel();

  if (delayNode) {
    delayNode.delayTime.value = delayState.value;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'delay-change', delay: delayState.value }));
  }
  
  // Update honey drop frequency
  updateHoneyDropFrequency();
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
  masterVolume = parseFloat(e.target.value);
  for (const peer of remotePeers.values()) {
    peer.video.volume = masterVolume;
  }
});

function createHoneyDrop() {
  const drop = document.createElement('div');
  drop.className = 'honey-drop';
  
  // Random horizontal position
  const randomX = Math.random() * (window.innerWidth - 20);
  drop.style.left = `${randomX}px`;
  
  // Random fall duration (3-5 seconds)
  const duration = 3 + Math.random() * 2;
  drop.style.animationDuration = `${duration}s`;
  
  honeyContainer.appendChild(drop);
  
  // Remove drop after animation completes
  setTimeout(() => {
    drop.remove();
  }, duration * 1000);
}

function updateHoneyDropFrequency() {
  // Clear existing interval
  if (honeyDropInterval) {
    clearInterval(honeyDropInterval);
  }
  
  // Get delay value from slider (in seconds)
  const delaySeconds = delayState.value;
  
  // If delay is 0, don't create drops
  if (delaySeconds <= 0) {
    return;
  }
  
  // Create drops every X seconds based on delay slider
  // Using the delay value as the interval
  honeyDropInterval = setInterval(() => {
    createHoneyDrop();
  }, delaySeconds * 1000);
}

// Start honey drops when call is active
function startHoneyDrops() {
  updateHoneyDropFrequency();
}

function stopHoneyDrops() {
  if (honeyDropInterval) {
    clearInterval(honeyDropInterval);
    honeyDropInterval = null;
  }
  // Clear any existing drops
  honeyContainer.innerHTML = '';
}

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
  
  // Start honey drops
  startHoneyDrops();

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

function addRemoteTile(peerId, delay) {
  if (remotePeers.has(peerId)) return remotePeers.get(peerId);

  const container = document.createElement('div');
  container.className = 'video-box';

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.volume = masterVolume;

  const label = document.createElement('span');
  label.className = 'label';

  const placeholder = document.createElement('div');
  placeholder.className = 'placeholder';
  placeholder.textContent = 'Connecting…';

  container.append(video, label, placeholder);
  callSection.insertBefore(container, controlsBar);

  const peer = { container, video, label, placeholder, delay };
  remotePeers.set(peerId, peer);
  updateRemoteLabel(peerId);
  return peer;
}

function removeRemoteTile(peerId) {
  const peer = remotePeers.get(peerId);
  if (peer) {
    peer.container.remove();
    remotePeers.delete(peerId);
  }
  const pc = peerConnections.get(peerId);
  if (pc) {
    pc.close();
    peerConnections.delete(peerId);
  }
  
  // Only stop honey drops if no peers remain
  if (remotePeers.size === 0) {
    stopHoneyDrops();
  }
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
      case 'joined': {
        selfId = msg.selfId;
        setStatus(
          msg.peers.length
            ? `Room joined. Connecting to ${msg.peers.length} peer(s)…`
            : 'Room joined. Waiting for others to connect…'
        );
        // We're the newcomer: initiate a connection to everyone already here.
        for (const { id, delay } of msg.peers) {
          addRemoteTile(id, delay);
          const pc = createPeerConnection(id);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          ws.send(JSON.stringify({ type: 'offer', to: id, sdp: offer.sdp }));
        }
        break;
      }

      case 'peer-joined':
        addRemoteTile(msg.id, msg.delay);
        setStatus('Peer joined. Negotiating connection…');
        break;

      case 'delay-change': {
        const peer = remotePeers.get(msg.from);
        if (peer) {
          peer.delay = msg.delay;
          updateRemoteLabel(msg.from);
        }
        break;
      }

      case 'offer': {
        const pc = peerConnections.get(msg.from) || createPeerConnection(msg.from);
        await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: 'answer', to: msg.from, sdp: answer.sdp }));
        break;
      }

      case 'answer': {
        const pc = peerConnections.get(msg.from);
        if (pc) await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
        break;
      }

      case 'ice-candidate': {
        const pc = peerConnections.get(msg.from);
        if (pc && msg.candidate) {
          try {
            await pc.addIceCandidate(msg.candidate);
          } catch {
            // Ignore late/invalid candidates.
          }
        }
        break;
      }

      case 'peer-left':
        removeRemoteTile(msg.id);
        setStatus('A peer disconnected.');
        break;

      case 'room-full':
        setStatus('That room is full. Try a different room code.');
        break;
    }
  });

  ws.addEventListener('close', () => {
    setStatus('Disconnected from signaling server.');
    stopHoneyDrops();
  });
}



function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });
  peerConnections.set(peerId, pc);

  delayedOutgoingStream.getTracks().forEach((track) => {
    pc.addTrack(track, delayedOutgoingStream);
  });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(JSON.stringify({ type: 'ice-candidate', to: peerId, candidate: event.candidate }));
    }
  };

  pc.ontrack = (event) => {
    const tile = remotePeers.get(peerId) || addRemoteTile(peerId, null);
    tile.placeholder.classList.add('hidden');
    tile.video.srcObject = event.streams[0];
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      setStatus(`Connected. Others see you ${delayState.value}s behind real time.`);
    } else if (['failed', 'closed'].includes(pc.connectionState)) {
      removeRemoteTile(peerId);
    }
  };

  return pc;
}
