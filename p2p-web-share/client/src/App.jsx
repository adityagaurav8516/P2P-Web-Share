import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import {
  base64UrlEncode,
  decryptChunk,
  encryptChunk,
  generateIv,
  generateKeyString,
  importAesKey,
  sha256Hex,
  supportsRequiredCrypto
} from "./lib/crypto.js";
import { formatBytes, formatSpeed, percentage } from "./lib/format.js";

const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL || "http://localhost:4000";
const CHUNK_SIZE = 64 * 1024;
const MAX_BUFFERED_AMOUNT = 4 * 1024 * 1024;
const BUFFERED_LOW_THRESHOLD = 512 * 1024;

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" }
];

function getRoomFromUrl() {
  return new URLSearchParams(window.location.search).get("room");
}

function getKeyFromHash() {
  const raw = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(raw);
  return params.get("key");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename || "download.bin";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function waitForBufferedAmount(channel) {
  if (channel.bufferedAmount <= MAX_BUFFERED_AMOUNT) return;

  await new Promise((resolve) => {
    const done = () => {
      channel.removeEventListener("bufferedamountlow", done);
      resolve();
    };
    channel.addEventListener("bufferedamountlow", done, { once: true });
  });
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export default function App() {
  const initialRoomId = useMemo(() => getRoomFromUrl(), []);
  const initialKey = useMemo(() => getKeyFromHash(), []);

  const [mode] = useState(initialRoomId ? "receive" : "send");
  const [socketStatus, setSocketStatus] = useState("Connecting to signaling server...");
  const [connectionStatus, setConnectionStatus] = useState("Idle");
  const [roomId, setRoomId] = useState(initialRoomId || "");
  const [shareLink, setShareLink] = useState("");
  const [selectedFile, setSelectedFile] = useState(null);
  const [remoteFile, setRemoteFile] = useState(null);
  const [sendProgress, setSendProgress] = useState({ bytes: 0, total: 0, speed: 0 });
  const [receiveProgress, setReceiveProgress] = useState({ bytes: 0, total: 0, speed: 0 });
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState("");
  const [isTransferring, setIsTransferring] = useState(false);

  const socketRef = useRef(null);
  const peerRef = useRef(null);
  const channelRef = useRef(null);
  const remotePeerIdRef = useRef(null);
  const selectedFileRef = useRef(null);
  const aesKeyRef = useRef(null);
  const receiverStateRef = useRef({
    meta: null,
    chunks: [],
    chunkMeta: null,
    receivedBytes: 0,
    startedAt: 0
  });

  function addLog(message) {
    setLogs((current) => [`${new Date().toLocaleTimeString()}  ${message}`, ...current].slice(0, 12));
  }

  function fail(message) {
    setError(message);
    addLog(`ERROR: ${message}`);
  }

  useEffect(() => {
    if (!supportsRequiredCrypto()) {
      fail("This browser does not support the Web Crypto APIs required for hashing/encryption.");
      return undefined;
    }

    const socket = io(SIGNALING_URL, {
      transports: ["websocket"]
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setSocketStatus("Connected to signaling server");
      addLog(`Socket connected: ${socket.id}`);

      if (mode === "receive") {
        joinRoom(socket, initialRoomId, initialKey);
      }
    });

    socket.on("connect_error", (err) => {
      setSocketStatus("Signaling server unavailable");
      fail(`Cannot connect to signaling server: ${err.message}`);
    });

    socket.on("room:receiver-joined", async ({ receiverId }) => {
      remotePeerIdRef.current = receiverId;
      addLog("Receiver joined. Creating WebRTC offer...");
      await createSenderPeer(receiverId);
    });

    socket.on("webrtc:signal", async ({ from, signal }) => {
      remotePeerIdRef.current = from;
      await handleSignal(from, signal);
    });

    socket.on("room:peer-left", ({ reason }) => {
      setConnectionStatus("Peer disconnected");
      fail(`The other peer ${reason}. Transfer stopped.`);
      closePeer();
    });

    socket.on("room:expired", () => {
      fail("This room expired. Create a fresh link and try again.");
      closePeer();
    });

    return () => {
      socket.emit("room:leave");
      socket.disconnect();
      closePeer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    selectedFileRef.current = selectedFile;
  }, [selectedFile]);

  async function joinRoom(socket, joinedRoomId, keyString) {
    if (!joinedRoomId) {
      fail("Missing room ID in the URL.");
      return;
    }
    if (!keyString) {
      fail("Missing decryption key in the URL hash. Ask sender to copy the full link.");
      return;
    }

    try {
      aesKeyRef.current = await importAesKey(keyString);
    } catch (err) {
      fail(err.message);
      return;
    }

    socket.emit("receiver:join-room", { roomId: joinedRoomId }, async (res) => {
      if (!res?.ok) {
        fail(res?.error || "Could not join room.");
        return;
      }

      remotePeerIdRef.current = res.senderId;
      setConnectionStatus("Joined room. Waiting for sender offer...");
      addLog(`Joined room ${joinedRoomId}`);
      await createReceiverPeer(res.senderId);
    });
  }

  async function createShareRoom(file) {
    setError("");
    if (!file) {
      fail("Select a file first.");
      return;
    }

    if (file.size > 50 * 1024 * 1024) {
      addLog("Warning: MVP target is <50MB. This may still work, but the full-file hash uses browser memory.");
    }

    const keyString = generateKeyString();
    aesKeyRef.current = await importAesKey(keyString);

    socketRef.current.emit("sender:create-room", {}, (res) => {
      if (!res?.ok) {
        fail(res?.error || "Could not create room.");
        return;
      }

      const url = new URL(window.location.origin);
      url.searchParams.set("room", res.roomId);
      url.hash = new URLSearchParams({ key: keyString }).toString();

      setRoomId(res.roomId);
      setShareLink(url.toString());
      setConnectionStatus("Room ready. Send this link to receiver.");
      addLog(`Room created: ${res.roomId}`);
    });
  }

  async function createSenderPeer(receiverId) {
    closePeer();
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peerRef.current = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate) sendSignal(receiverId, { type: "candidate", candidate: event.candidate });
    };

    pc.onconnectionstatechange = () => {
      setConnectionStatus(`WebRTC: ${pc.connectionState}`);
      addLog(`Peer connection state: ${pc.connectionState}`);
    };

    const channel = pc.createDataChannel("encrypted-file", { ordered: true });
    setupSenderChannel(channel);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal(receiverId, { type: "offer", sdp: offer });
  }

  async function createReceiverPeer(senderId) {
    closePeer();
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peerRef.current = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate) sendSignal(senderId, { type: "candidate", candidate: event.candidate });
    };

    pc.onconnectionstatechange = () => {
      setConnectionStatus(`WebRTC: ${pc.connectionState}`);
      addLog(`Peer connection state: ${pc.connectionState}`);
    };

    pc.ondatachannel = (event) => {
      addLog("Data channel received from sender.");
      setupReceiverChannel(event.channel);
    };
  }

  function setupSenderChannel(channel) {
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = BUFFERED_LOW_THRESHOLD;
    channelRef.current = channel;

    channel.onopen = () => {
      setConnectionStatus("P2P channel open. Starting encrypted transfer...");
      addLog("Data channel open.");
      sendSelectedFile().catch((err) => fail(err.message));
    };

    channel.onclose = () => {
      setConnectionStatus("Data channel closed");
      addLog("Data channel closed.");
    };

    channel.onerror = () => {
      fail("Data channel error.");
    };

    channel.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const message = safeJsonParse(event.data);
      if (!message) return;
      if (message.type === "receiver-error") fail(message.message || "Receiver reported an error.");
      if (message.type === "receiver-ready") addLog("Receiver is ready for transfer.");
      if (message.type === "receiver-complete") addLog("Receiver verified and downloaded the file.");
    };
  }

  function setupReceiverChannel(channel) {
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = BUFFERED_LOW_THRESHOLD;
    channelRef.current = channel;

    channel.onopen = () => {
      setConnectionStatus("P2P channel open. Waiting for file metadata...");
      channel.send(JSON.stringify({ type: "receiver-ready" }));
      addLog("Data channel open.");
    };

    channel.onclose = () => {
      setConnectionStatus("Data channel closed");
      addLog("Data channel closed.");
    };

    channel.onerror = () => {
      fail("Data channel error.");
    };

    channel.onmessage = (event) => {
      handleReceiverMessage(event).catch((err) => {
        fail(err.message);
        try {
          channel.send(JSON.stringify({ type: "receiver-error", message: err.message }));
        } catch {
          // ignore
        }
      });
    };
  }

  async function handleSignal(from, signal) {
    const pc = peerRef.current;
    if (!pc) {
      addLog("Received signal before peer was ready. Ignoring stale signal.");
      return;
    }

    if (signal.type === "offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal(from, { type: "answer", sdp: answer });
      addLog("Received offer and sent answer.");
      return;
    }

    if (signal.type === "answer") {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      addLog("Received answer.");
      return;
    }

    if (signal.type === "candidate" && signal.candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
      } catch (err) {
        addLog(`ICE candidate warning: ${err.message}`);
      }
    }
  }

  function sendSignal(to, signal) {
    const activeRoomId = roomId || initialRoomId;
    socketRef.current?.emit("webrtc:signal", { roomId: activeRoomId, to, signal });
  }

  async function sendSelectedFile() {
    const file = selectedFileRef.current;
    const channel = channelRef.current;
    const aesKey = aesKeyRef.current;

    if (!file || !channel || !aesKey) return;
    if (channel.readyState !== "open") throw new Error("Data channel is not open.");

    setIsTransferring(true);
    setSendProgress({ bytes: 0, total: file.size, speed: 0 });

    addLog("Computing full-file SHA-256 hash...");
    const fileHash = await sha256Hex(await file.arrayBuffer());
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    channel.send(JSON.stringify({
      type: "file-meta",
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      chunkSize: CHUNK_SIZE,
      totalChunks,
      fileHash,
      encrypted: true,
      cipher: "AES-GCM-256",
      hash: "SHA-256"
    }));

    addLog(`Sending ${file.name} in ${totalChunks} encrypted chunks...`);
    const startedAt = performance.now();
    let sentBytes = 0;

    for (let index = 0; index < totalChunks; index += 1) {
      if (channel.readyState !== "open") throw new Error("Connection closed during transfer.");

      const start = index * CHUNK_SIZE;
      const end = Math.min(file.size, start + CHUNK_SIZE);
      const plainBuffer = await file.slice(start, end).arrayBuffer();
      const plainHash = await sha256Hex(plainBuffer);
      const iv = generateIv();
      const encryptedBuffer = await encryptChunk(aesKey, plainBuffer, iv);

      channel.send(JSON.stringify({
        type: "chunk-meta",
        index,
        plainSize: plainBuffer.byteLength,
        cipherSize: encryptedBuffer.byteLength,
        iv: base64UrlEncode(iv),
        plainHash
      }));

      channel.send(encryptedBuffer);
      sentBytes += plainBuffer.byteLength;

      const seconds = Math.max((performance.now() - startedAt) / 1000, 0.001);
      setSendProgress({ bytes: sentBytes, total: file.size, speed: sentBytes / seconds });

      await waitForBufferedAmount(channel);
      await sleep(0);
    }

    channel.send(JSON.stringify({ type: "transfer-done" }));
    setIsTransferring(false);
    setConnectionStatus("Transfer sent. Waiting for receiver verification...");
    addLog("All chunks sent.");
  }

  async function handleReceiverMessage(event) {
    const channel = channelRef.current;
    const aesKey = aesKeyRef.current;
    const state = receiverStateRef.current;

    if (typeof event.data === "string") {
      const message = safeJsonParse(event.data);
      if (!message) return;

      if (message.type === "file-meta") {
        receiverStateRef.current = {
          meta: message,
          chunks: new Array(message.totalChunks),
          chunkMeta: null,
          receivedBytes: 0,
          startedAt: performance.now()
        };
        setRemoteFile(message);
        setReceiveProgress({ bytes: 0, total: message.size, speed: 0 });
        setConnectionStatus("Receiving encrypted file...");
        addLog(`Receiving ${message.name} (${formatBytes(message.size)})`);
        return;
      }

      if (message.type === "chunk-meta") {
        receiverStateRef.current.chunkMeta = message;
        return;
      }

      if (message.type === "transfer-done") {
        await finishReceive();
        channel?.send(JSON.stringify({ type: "receiver-complete" }));
        return;
      }

      return;
    }

    if (!aesKey) throw new Error("Missing AES key. Cannot decrypt chunk.");
    if (!state.meta) throw new Error("Received binary chunk before file metadata.");
    if (!state.chunkMeta) throw new Error("Received binary chunk before chunk metadata.");

    const meta = state.chunkMeta;
    state.chunkMeta = null;

    const decryptedBuffer = await decryptChunk(aesKey, event.data, meta.iv);
    const actualHash = await sha256Hex(decryptedBuffer);
    if (actualHash !== meta.plainHash) {
      throw new Error(`Chunk ${meta.index} failed SHA-256 verification.`);
    }

    const bytes = new Uint8Array(decryptedBuffer);
    state.chunks[meta.index] = bytes;
    state.receivedBytes += bytes.byteLength;

    const seconds = Math.max((performance.now() - state.startedAt) / 1000, 0.001);
    setReceiveProgress({ bytes: state.receivedBytes, total: state.meta.size, speed: state.receivedBytes / seconds });
  }

  async function finishReceive() {
    const state = receiverStateRef.current;
    if (!state.meta) throw new Error("No file metadata available.");

    const missing = state.chunks.findIndex((chunk) => !chunk);
    if (missing !== -1) throw new Error(`Missing chunk ${missing}. Transfer incomplete.`);

    const blob = new Blob(state.chunks, { type: state.meta.mimeType || "application/octet-stream" });
    const actualFileHash = await sha256Hex(await blob.arrayBuffer());

    if (actualFileHash !== state.meta.fileHash) {
      throw new Error("Final file hash mismatch. Download blocked.");
    }

    setReceiveProgress({ bytes: state.meta.size, total: state.meta.size, speed: receiveProgress.speed });
    setConnectionStatus("File verified. Download started.");
    addLog("Final SHA-256 verified. Triggering download.");
    downloadBlob(blob, state.meta.name);
  }

  function closePeer() {
    try {
      channelRef.current?.close();
    } catch {
      // ignore
    }
    try {
      peerRef.current?.close();
    } catch {
      // ignore
    }
    channelRef.current = null;
    peerRef.current = null;
  }

  function onFileInput(event) {
    const file = event.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      setSendProgress({ bytes: 0, total: file.size, speed: 0 });
      setError("");
    }
  }

  function onDrop(event) {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file) {
      setSelectedFile(file);
      setSendProgress({ bytes: 0, total: file.size, speed: 0 });
      setError("");
    }
  }

  async function copyLink() {
    await navigator.clipboard.writeText(shareLink);
    addLog("Invite link copied to clipboard.");
  }

  const progress = mode === "send" ? sendProgress : receiveProgress;
  const progressPercent = percentage(progress.bytes, progress.total);

  return (
    <main className="app-shell">
      <section className="hero-card">
        <div>
          <p className="eyebrow">WebRTC · Node.js · React</p>
          <h1>P2P Web Share</h1>
          <p className="subtitle">
            Direct browser-to-browser encrypted file transfer. The server only handles signaling; file bytes move over a WebRTC DataChannel.
          </p>
        </div>
        <div className={`mode-pill ${mode}`}>{mode === "send" ? "Sender" : "Receiver"}</div>
      </section>

      <section className="grid">
        <div className="panel">
          <h2>{mode === "send" ? "Create share room" : "Receive file"}</h2>

          {mode === "send" ? (
            <>
              <label
                className="drop-zone"
                onDrop={onDrop}
                onDragOver={(event) => event.preventDefault()}
              >
                <input type="file" onChange={onFileInput} />
                <span className="drop-title">Drop a file or click to choose</span>
                <span className="drop-subtitle">Recommended MVP limit: &lt;50MB</span>
              </label>

              {selectedFile && (
                <div className="file-card">
                  <strong>{selectedFile.name}</strong>
                  <span>{formatBytes(selectedFile.size)} · {selectedFile.type || "unknown type"}</span>
                </div>
              )}

              <button
                className="primary-btn"
                disabled={!selectedFile || !socketRef.current?.connected || Boolean(shareLink)}
                onClick={() => createShareRoom(selectedFile)}
              >
                Generate secure room link
              </button>

              {shareLink && (
                <div className="link-box">
                  <label>Invite link</label>
                  <textarea readOnly value={shareLink} />
                  <button onClick={copyLink}>Copy link</button>
                </div>
              )}
            </>
          ) : (
            <div className="receive-box">
              <p><strong>Room:</strong> {roomId || "Missing"}</p>
              <p><strong>URL key:</strong> {initialKey ? "Found in hash" : "Missing"}</p>
              {remoteFile && (
                <div className="file-card">
                  <strong>{remoteFile.name}</strong>
                  <span>{formatBytes(remoteFile.size)} · encrypted chunks</span>
                </div>
              )}
            </div>
          )}

          <div className="progress-area">
            <div className="progress-header">
              <span>{progressPercent}%</span>
              <span>{formatBytes(progress.bytes)} / {formatBytes(progress.total)}</span>
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
            </div>
            <div className="progress-footer">
              <span>{formatSpeed(progress.speed)}</span>
              <span>{isTransferring ? "Transferring" : connectionStatus}</span>
            </div>
          </div>
        </div>

        <div className="panel status-panel">
          <h2>Status</h2>
          <div className="status-row">
            <span>Signaling</span>
            <strong>{socketStatus}</strong>
          </div>
          <div className="status-row">
            <span>P2P</span>
            <strong>{connectionStatus}</strong>
          </div>
          <div className="status-row">
            <span>Room ID</span>
            <strong>{roomId || "Not created"}</strong>
          </div>
          <div className="notice">
            <strong>Security note:</strong> AES key is stored in the URL hash. Browsers do not send URL hash fragments to the server, so the signaling server does not receive the decryption key.
          </div>
          {error && <div className="error-box">{error}</div>}
        </div>
      </section>

      <section className="panel log-panel">
        <h2>Event log</h2>
        {logs.length === 0 ? <p className="muted">No events yet.</p> : (
          <ul>
            {logs.map((log, index) => <li key={`${log}-${index}`}>{log}</li>)}
          </ul>
        )}
      </section>
    </main>
  );
}
