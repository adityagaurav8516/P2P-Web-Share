import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Upload,
  Download,
  Shield,
  ShieldCheck,
  Copy,
  Check,
  RefreshCw,
  AlertCircle,
  Wifi,
  WifiOff,
  Clock,
  ArrowRight,
  Lock,
  ExternalLink,
  FileText,
  CheckCircle2,
  LockKeyhole,
} from "lucide-react";
import {
  generateKeyHex,
  importKeyFromHex,
  encryptBuffer,
  decryptBuffer,
  computeSHA256,
} from "./cryptoUtils";

const CHUNK_SIZE = 16384; // 16KB chunk size (highly robust for RTC data channels)

export default function App() {
  // Navigation & Role states
  const [role, setRole] = useState<"sender" | "receiver" | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [secretKey, setSecretKey] = useState<string | null>(null);

  // File states
  const [file, setFile] = useState<File | null>(null);
  const [fileMeta, setFileMeta] = useState<{
    name: string;
    size: number;
    type: string;
    hash?: string;
  } | null>(null);

  // Connection & Handshake status states
  const [wsState, setWsState] = useState<"disconnected" | "connecting" | "connected">("disconnected");
  const [peerState, setPeerState] = useState<"disconnected" | "connecting" | "connected">("disconnected");
  const [signalLog, setSignalLog] = useState<string[]>([]);

  // Transfer states
  const [transferState, setTransferState] = useState<
    | "idle"
    | "preparing"
    | "encrypting"
    | "ready"
    | "transferring"
    | "decrypting"
    | "verifying"
    | "completed"
    | "error"
  >("idle");
  const [transferBytesCompleted, setTransferBytesCompleted] = useState<number>(0);
  const [transferSpeed, setTransferSpeed] = useState<number>(0); // Bytes per second
  const [transferEta, setTransferEta] = useState<number | null>(null); // Seconds remaining
  const [originalHash, setOriginalHash] = useState<string | null>(null);
  const [receivedHash, setReceivedHash] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Drag and drop interaction state
  const [isDragging, setIsDragging] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  // Connection/Transfer references
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const iceQueueRef = useRef<RTCIceCandidateInit[]>([]);
  const encryptedBufferRef = useRef<ArrayBuffer | null>(null);

  // Receiver accumulation references
  const receivedChunksRef = useRef<ArrayBuffer[]>([]);
  const bytesAccumulatedRef = useRef<number>(0);
  const metadataRef = useRef<any>(null);

  // Metrics intervals and telemetry states
  const speedIntervalRef = useRef<number | null>(null);
  const lastBytesRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);

  // Add message helper for logs
  const addLog = useCallback((msg: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setSignalLog((prev) => [...prev, `[${timestamp}] ${msg}`].slice(-30));
  }, []);

  // Format Helper: Size
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  // Format Helper: Time
  const formatEta = (seconds: number | null): string => {
    if (seconds === null || !isFinite(seconds)) return "--:--";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  // Safe Close Helper for RTCPeerConnection and DC
  const closePeerConnection = useCallback(() => {
    if (speedIntervalRef.current) {
      clearInterval(speedIntervalRef.current);
      speedIntervalRef.current = null;
    }

    if (channelRef.current) {
      try {
        channelRef.current.close();
      } catch (e) {}
      channelRef.current = null;
    }
    if (pcRef.current) {
      try {
        pcRef.current.close();
      } catch (e) {}
      pcRef.current = null;
    }
    setPeerState("disconnected");
    iceQueueRef.current = [];
  }, []);

  // Safe disconnect helper
  const disconnectAll = useCallback(() => {
    closePeerConnection();
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch (e) {}
      wsRef.current = null;
    }
    setWsState("disconnected");
  }, [closePeerConnection]);

  // Telemetry computation trigger
  const startTelemetry = useCallback((totalBytes: number) => {
    if (speedIntervalRef.current) {
      clearInterval(speedIntervalRef.current);
    }
    lastBytesRef.current = 0;
    lastTimeRef.current = Date.now();
    setTransferSpeed(0);
    setTransferEta(null);

    speedIntervalRef.current = window.setInterval(() => {
      const currentTime = Date.now();
      const currentBytes = bytesAccumulatedRef.current || transferBytesCompleted;
      const timeDiff = (currentTime - lastTimeRef.current) / 1000; // seconds

      if (timeDiff > 0.1) {
        const bytesDiff = currentBytes - lastBytesRef.current;
        const currentSpeedBytes = bytesDiff / timeDiff;

        setTransferSpeed(currentSpeedBytes);

        if (currentSpeedBytes > 0) {
          const remainingBytes = totalBytes - currentBytes;
          const eta = remainingBytes / currentSpeedBytes;
          setTransferEta(eta);
        } else {
          setTransferEta(null);
        }

        lastBytesRef.current = currentBytes;
        lastTimeRef.current = currentTime;
      }
    }, 1000);
  }, [transferBytesCompleted]);

  // Clean WebSockets & RTC setup on parameters change (room lifecycle)
  useEffect(() => {
    const handleNavigationQueryAndHash = async () => {
      const params = new URLSearchParams(window.location.search);
      const queryRoom = params.get("room");

      if (queryRoom) {
        // Extract secret crypto key from hash parameter safely
        const hash = window.location.hash;
        const keyMatch = hash.match(/#?key=([0-9a-fA-F]{64})/);
        const extractedKey = keyMatch ? keyMatch[1] : null;

        setRoomId(queryRoom);
        setSecretKey(extractedKey);
        setRole("receiver");
        addLog(`Joined room: ${queryRoom} via invite link.`);
        if (extractedKey) {
          addLog("Found Zero-Knowledge decryption key in hash parameter.");
        } else {
          addLog("Warning: Decryption key is missing in invite URL.");
        }
      }
    };

    handleNavigationQueryAndHash();
  }, [addLog]);

  // WebSocket signaling receiver and state engine hook
  useEffect(() => {
    if (!roomId || !role) return;

    setWsState("connecting");
    addLog(`Establishing connection to signaling hub...`);

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws-signaling`;
    const socket = new WebSocket(wsUrl);
    wsRef.current = socket;

    socket.onopen = () => {
      setWsState("connected");
      addLog("WebSocket link active. Sending room registration payload...");
      socket.send(
        JSON.stringify({
          type: "join",
          roomId,
          role,
          peerId: role + "_" + Math.random().toString(36).substring(2, 6),
        })
      );
    };

    socket.onerror = () => {
      setWsState("disconnected");
      addLog("Signal server link error. Retrying connected instance...");
      setErrorMessage("Signaling server connection failed. Please reload.");
    };

    socket.onclose = () => {
      setWsState("disconnected");
      addLog("WebSocket disconnected from signaling hub.");
    };

    socket.onmessage = async (evt) => {
      try {
        const msg = JSON.parse(evt.data);

        if (msg.type === "room_state") {
          const { senderActive, receiverActive } = msg;
          addLog(`Room status sync - Sender: ${senderActive ? "ON" : "OFF"}, Receiver: ${receiverActive ? "ON" : "OFF"}`);

          if (senderActive && receiverActive) {
            setupRTCPeer();
          } else if (role === "sender" && !receiverActive) {
            addLog("Waiting for receiver to join...");
            closePeerConnection();
          } else if (role === "receiver" && !senderActive) {
            addLog("Waiting for sender to get active...");
            closePeerConnection();
          }
        } else if (msg.type === "signal") {
          const { signalData } = msg;

          if (signalData.type === "offer") {
            handleOfferSignal(signalData.offer);
          } else if (signalData.type === "answer") {
            handleAnswerSignal(signalData.answer);
          } else if (signalData.type === "candidate") {
            handleIceCandidateSignal(signalData.candidate);
          }
        } else if (msg.type === "peer_disconnected") {
          addLog(`Immediate: ${msg.message}`);
          closePeerConnection();
          setTransferState("error");
          setErrorMessage("The direct WebRTC link was severed. Peer closed tab or disconnected.");
        }
      } catch (err: any) {
        console.error("Signal parsing err:", err);
      }
    };

    return () => {
      socket.close();
      closePeerConnection();
    };
  }, [roomId, role, addLog, closePeerConnection]);

  // Setup Peer Connection (1-to-1 WebRTC)
  const setupRTCPeer = async () => {
    addLog(`Configuring local RTCPeerConnection node...`);
    closePeerConnection();

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },
      ],
    });
    pcRef.current = pc;
    setPeerState("connecting");

    pc.onicecandidate = (event) => {
      if (event.candidate && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: "signal",
            roomId,
            signalData: { type: "candidate", candidate: event.candidate },
          })
        );
      }
    };

    pc.onconnectionstatechange = () => {
      addLog(`WebRTC connection state: ${pc.connectionState}`);
      if (pc.connectionState === "connected") {
        setPeerState("connected");
      } else if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
        setPeerState("disconnected");
        closePeerConnection();
        setTransferState("error");
        setErrorMessage("WebRTC Direct Link failed. Connecting peer disappeared.");
      }
    };

    if (role === "sender") {
      addLog(`Sender: creating outgoing WebRTC data channel ('fileTransfer')...`);
      const channel = pc.createDataChannel("fileTransfer", { ordered: true });
      channelRef.current = channel;
      setupDataChannelEvents(channel);

      // Create WebRTC Offer
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        addLog("Sender: Dispatching WebRTC Offer to receiver via signaling server.");
        wsRef.current?.send(
          JSON.stringify({
            type: "signal",
            roomId,
            signalData: { type: "offer", offer },
          })
        );
      } catch (err: any) {
        addLog(`Offer creation error: ${err.message}`);
      }
    } else {
      // Receiver: Wait for data channel callback
      pc.ondatachannel = (event) => {
        addLog("Receiver: Received active file path channel from sender node.");
        setupDataChannelEvents(event.channel);
      };
    }
  };

  const handleOfferSignal = async (offer: RTCSessionDescriptionInit) => {
    const pc = pcRef.current;
    if (!pc) return;

    addLog("Receiver: Received Offer. Configuring remote description as hook.");
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));

      // Apply buffered candidates
      for (const cand of iceQueueRef.current) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(cand));
        } catch (e) {}
      }
      iceQueueRef.current = [];

      // Create Answer
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      addLog("Receiver: Dispatching WebRTC Answer response back...");
      wsRef.current?.send(
        JSON.stringify({
          type: "signal",
          roomId,
          signalData: { type: "answer", answer },
        })
      );
    } catch (err: any) {
      addLog(`Offering set Error: ${err.message}`);
    }
  };

  const handleAnswerSignal = async (answer: RTCSessionDescriptionInit) => {
    const pc = pcRef.current;
    if (!pc) return;

    addLog("Sender: Answer acknowledged. Attaching web schema...");
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));

      // Apply buffered candidates
      for (const cand of iceQueueRef.current) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(cand));
        } catch (e) {}
      }
      iceQueueRef.current = [];
    } catch (err: any) {
      addLog(`Answer set error: ${err.message}`);
    }
  };

  const handleIceCandidateSignal = async (candidate: RTCIceCandidateInit) => {
    const pc = pcRef.current;
    if (!pc) return;

    if (pc.remoteDescription) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {}
    } else {
      iceQueueRef.current.push(candidate);
    }
  };

  // Setup callbacks on the active Data Channel
  const setupDataChannelEvents = (channel: RTCDataChannel) => {
    channel.binaryType = "arraybuffer";
    channelRef.current = channel;

    channel.onopen = () => {
      addLog("Direct P2P Data Channel opened securely.");
      if (role === "sender" && file) {
        setTransferState("ready");
      }
    };

    channel.onclose = () => {
      addLog("Direct P2P Data Channel has been closed.");
      setPeerState("disconnected");
    };

    channel.onmessage = async (event) => {
      if (typeof event.data === "string") {
        // Text payload (metadata information)
        try {
          const info = JSON.parse(event.data);
          if (info.type === "meta") {
            addLog(`Received file manifest: ${info.name} [${formatBytes(info.size)}]`);
            metadataRef.current = info;
            setFileMeta({
              name: info.name,
              size: info.size,
              type: info.mimeType,
              hash: info.hash,
            });

            // Prepare buffer states
            receivedChunksRef.current = [];
            bytesAccumulatedRef.current = 0;
            setTransferBytesCompleted(0);
            setTransferState("transferring");

            // Setup speed estimation
            startTelemetry(info.size);
          }
        } catch (err) {}
      } else {
        // Binary payload (file chunks)
        const chunk = event.data as ArrayBuffer;
        receivedChunksRef.current.push(chunk);
        bytesAccumulatedRef.current += chunk.byteLength;
        setTransferBytesCompleted(bytesAccumulatedRef.current);

        const meta = metadataRef.current;
        if (meta && bytesAccumulatedRef.current >= meta.size) {
          // Finished receiving intermediate payload!
          if (speedIntervalRef.current) {
            clearInterval(speedIntervalRef.current);
          }

          setTransferState("decrypting");
          addLog("All chunks arrived. Concatenating payload...");

          // Concatenate all chunks
          const finalBuffer = new Uint8Array(bytesAccumulatedRef.current);
          let offset = 0;
          for (const c of receivedChunksRef.current) {
            finalBuffer.set(new Uint8Array(c), offset);
            offset += c.byteLength;
          }

          let decryptedPayload: ArrayBuffer = finalBuffer.buffer;

          // Perform Zero-Knowledge AES-GCM Decryption if a key is present
          if (secretKey) {
            addLog("Zero-Knowledge key found. Decrypting array buffer locally...");
            try {
              const activeKey = await importKeyFromHex(secretKey);
              decryptedPayload = await decryptBuffer(finalBuffer.buffer, meta.ivHex, activeKey);
              addLog("Local decryption successful. Clear text recovered.");
            } catch (decErr) {
              setTransferState("error");
              setErrorMessage("Decryption failed. The secret key might be invalid or the payload is mangled.");
              addLog("Error: Cryptographic payload integrity failed to match decipher check.");
              return;
            }
          }

          // Verification Phase (SHA-256)
          setTransferState("verifying");
          addLog("Running SHA-256 cryptographic verification pass...");

          const resultingHash = await computeSHA256(decryptedPayload);
          setReceivedHash(resultingHash);
          setOriginalHash(meta.hash);

          if (meta.hash && resultingHash !== meta.hash) {
            setTransferState("error");
            setErrorMessage("Hash verification failed. The file is corrupt or altered.");
            addLog(`Mismatch error! Expected ${meta.hash} but calculated ${resultingHash}`);
            return;
          }

          addLog("SHA-256 verification succeeded. Triggering auto-download stream.");
          setTransferState("completed");

          // Auto-download Trigger
          const blob = new Blob([decryptedPayload], { type: meta.mimeType });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = meta.name;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }
      }
    };
  };

  // Initiates the chunk sender stream with strict RTC flow-control
  const startFileTransferFlow = async () => {
    if (!file || !channelRef.current || channelRef.current.readyState !== "open") {
      setErrorMessage("Channel is not solid. Re-connect.");
      return;
    }

    setTransferState("preparing");
    addLog("Reading local file array into cache memory...");

    try {
      const originalBuffer = await file.arrayBuffer();

      // Compute original file hash (SHA-256)
      addLog("Calculating SHA-256 verification hash...");
      const hash = await computeSHA256(originalBuffer);
      setOriginalHash(hash);

      let dataToSend = originalBuffer;
      let ivHex = "";

      // Perform local encryption if a secret key exists
      if (secretKey) {
        setTransferState("encrypting");
        addLog("Zero-Knowledge Encryption active. Wrapping payload using AES-GCM 256...");
        const activeKey = await importKeyFromHex(secretKey);
        const encrypted = await encryptBuffer(originalBuffer, activeKey);
        dataToSend = encrypted.encryptedBuffer;
        ivHex = encrypted.ivHex;
        addLog("Local encryption completed instantly.");
      }

      setTransferState("transferring");
      addLog(`Sending metadata descriptor: ${file.name} (${formatBytes(dataToSend.byteLength)})`);

      // Dispatch metadata to notify receiver first
      channelRef.current.send(
        JSON.stringify({
          type: "meta",
          name: file.name,
          size: dataToSend.byteLength,
          mimeType: file.type || "application/octet-stream",
          hash: hash,
          ivHex: ivHex,
        })
      );

      // Start the transfer loop with flow control
      let offset = 0;
      setTransferBytesCompleted(0);
      startTelemetry(dataToSend.byteLength);

      const sendChunkLoop = () => {
        const chan = channelRef.current;
        if (!chan || chan.readyState !== "open") {
          addLog("Transfer interrupted. Data channel disconnected.");
          setTransferState("error");
          setErrorMessage("Data channel severed in midst of transmission.");
          return;
        }

        // Send chunks as long as buffer capacity is safe (< 256KB)
        while (offset < dataToSend.byteLength && chan.bufferedAmount < 128 * 1024) {
          const size = Math.min(CHUNK_SIZE, dataToSend.byteLength - offset);
          const slice = dataToSend.slice(offset, offset + size);
          chan.send(slice);
          offset += size;
          setTransferBytesCompleted(offset);
        }

        if (offset < dataToSend.byteLength) {
          // If buffered amount matches the threshold limit, postpone additional sends
          setTimeout(sendChunkLoop, 15);
        } else {
          // Finished sending all items
          if (speedIntervalRef.current) {
            clearInterval(speedIntervalRef.current);
          }
          addLog("File transfer dispatched fully over WebRTC.");
          setTransferState("completed");
        }
      };

      sendChunkLoop();
    } catch (e: any) {
      setTransferState("error");
      setErrorMessage(`Transfer startup error: ${e.message}`);
    }
  };

  // File drag & drop processors
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const processFile = (selectedFile: File) => {
    if (selectedFile.size > 50 * 1024 * 1024) {
      setErrorMessage("File exceeds 50MB restriction. High-density RAM checks are strictly bound.");
      setTransferState("error");
      return;
    }

    setFile(selectedFile);
    setFileMeta({
      name: selectedFile.name,
      size: selectedFile.size,
      type: selectedFile.type,
    });
    setErrorMessage(null);

    // Automatically transition to a room creator on drag selection
    const generatedRoom = "room-" + Math.random().toString(36).substring(2, 8);
    const generatedKey = generateKeyHex();

    setRoomId(generatedRoom);
    setSecretKey(generatedKey);
    setRole("sender");
    setTransferState("idle");

    // Push state parameter to URL without page refresh so it can be copy pasted directly
    const inviteUrl = `${window.location.origin}/?room=${generatedRoom}#key=${generatedKey}`;
    // Replace current address bar state
    window.history.pushState({}, "", `/?room=${generatedRoom}#key=${generatedKey}`);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      processFile(e.target.files[0]);
    }
  };

  // Copy share path helper
  const copyShareLink = () => {
    if (!roomId || !secretKey) return;
    const url = `${window.location.origin}/?room=${roomId}#key=${secretKey}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    });
  };

  // Reset the general state to initiate a clean session
  const resetApp = () => {
    disconnectAll();
    setRole(null);
    setRoomId(null);
    setSecretKey(null);
    setFile(null);
    setFileMeta(null);
    setTransferBytesCompleted(0);
    setTransferSpeed(0);
    setTransferEta(null);
    setOriginalHash(null);
    setReceivedHash(null);
    setTransferState("idle");
    setErrorMessage(null);
    setSignalLog([]);
    // Remove query parameters
    window.history.pushState({}, "", "/");
  };

  return (
    <div id="app-container" className="min-h-screen bg-neutral-950 text-white font-sans flex flex-col selection:bg-teal-500 selection:text-black">
      {/* Dynamic Network / Signal Header Banner */}
      <header id="app-header" className="border-b border-neutral-900 bg-neutral-950/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-teal-500/10 border border-teal-500/20 flex items-center justify-center">
              <Lock className="h-4.5 w-4.5 text-teal-400" />
            </div>
            <div>
              <h1 className="font-display font-medium text-lg leading-tight tracking-tight text-white flex items-center gap-1.5">
                P2P Web Share
              </h1>
              <p className="text-[10px] sm:text-xs text-neutral-400 font-mono">Decentralized Direct Transfer</p>
            </div>
          </div>

          {/* Connection badge clusters */}
          <div className="flex items-center gap-2">
            <span
              id="ws-badge"
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono border ${
                wsState === "connected"
                  ? "bg-teal-500/10 text-teal-400 border-teal-500/20 animate-pulse"
                  : wsState === "connecting"
                  ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                  : "bg-red-500/10 text-red-400 border-red-500/20"
              }`}
            >
              {wsState === "connected" ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
              Signaling: {wsState === "connected" ? "Online" : wsState === "connecting" ? "Handshake..." : "Offline"}
            </span>

            {role && (
              <span
                id="peer-badge"
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono border ${
                  peerState === "connected"
                    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                    : peerState === "connecting"
                    ? "bg-amber-500/10 text-amber-400 border-amber-500/20 animate-pulse"
                    : "bg-neutral-800 text-neutral-400 border-neutral-700"
                }`}
              >
                P2P Link: {peerState === "connected" ? "Active" : peerState === "connecting" ? "Linking..." : "Idle"}
              </span>
            )}
          </div>
        </div>
      </header>

      {/* Main Container Layout */}
      <main id="app-main" className="flex-1 max-w-4xl w-full mx-auto px-4 py-8 flex flex-col justify-center">
        <AnimatePresence mode="wait">
          {/* Landing State Screen: Choose or Drag File */}
          {!role && !roomId && (
            <motion.div
              id="landing-screen"
              key="landing"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              className="space-y-6"
            >
              {/* Introduction Card */}
              <div className="text-center space-y-3 max-w-2xl mx-auto py-4">
                <span className="text-xs font-mono bg-neutral-900 border border-neutral-800 text-teal-400 px-3 py-1 rounded-full">
                  Zero-Knowledge Cryptography
                </span>
                <h2 className="font-display text-3xl sm:text-4xl font-semibold tracking-tight text-white leading-tight">
                  Direct, Decentralized File Transfer
                </h2>
                <span className="block text-sm text-neutral-400 max-w-lg mx-auto">
                  Stream files directly from your browser to a designated receiver. No intermediate databases, no bandwidth restrictions, backed by local AES-GCM encryption.
                </span>
              </div>

              {/* Drag and Drop Zone Container */}
              <div
                id="dropzone"
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => document.getElementById("file-input")?.click()}
                className={`border border-dashed rounded-3xl p-10 cursor-pointer transition-all duration-300 relative group flex flex-col items-center justify-center min-h-[300px] overflow-hidden ${
                  isDragging
                    ? "border-teal-500 bg-teal-500/5 shadow-2xl shadow-teal-500/5 rotate-[-0.5deg]"
                    : "border-neutral-800 bg-neutral-950 hover:bg-neutral-900/50 hover:border-neutral-700"
                }`}
              >
                <input
                  id="file-input"
                  type="file"
                  className="hidden"
                  onChange={handleFileInputChange}
                />
                
                {/* Background ambient radial gradients */}
                <div className="absolute inset-0 bg-radial-gradient from-teal-500/5 via-transparent to-transparent pointer-events-none opacity-50" />

                <div className="relative z-10 flex flex-col items-center text-center space-y-4">
                  <div className="p-4 rounded-2xl bg-neutral-900 border border-neutral-800 text-teal-400 transition-transform group-hover:scale-105 group-hover:bg-neutral-800 duration-300">
                    <Upload className="h-8 w-8" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-lg text-neutral-200">Drag &amp; drop a file to transfer</h3>
                    <p className="text-xs text-neutral-500 mt-1.5 font-mono">Limit: 50MB per session for rapid RAM streaming</p>
                  </div>
                  <span className="text-xs bg-neutral-900 text-neutral-400 px-4 py-1.5 rounded-xl border border-neutral-800 group-hover:border-neutral-700 transition-colors duration-300">
                    Select File
                  </span>
                </div>
              </div>

              {/* Explanatory security blocks */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4">
                <div className="bg-neutral-950 border border-neutral-900 rounded-2xl p-4 flex gap-3.5 items-start">
                  <div className="p-2.5 rounded-xl bg-teal-500/10 border border-teal-500/20 text-teal-400">
                    <LockKeyhole className="h-4 w-4" />
                  </div>
                  <div>
                    <h4 className="font-medium text-sm text-neutral-200">Zero-Knowledge encryption</h4>
                    <p className="text-[12px] text-neutral-500 mt-1 leading-relaxed">Files are locked in memory before transmission. Encryption keys never leave your URL address bar hash.</p>
                  </div>
                </div>

                <div className="bg-neutral-950 border border-neutral-900 rounded-2xl p-4 flex gap-3.5 items-start">
                  <div className="p-2.5 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
                    <ShieldCheck className="h-4 w-4" />
                  </div>
                  <div>
                    <h4 className="font-medium text-sm text-neutral-200">Automatic Hash Audit</h4>
                    <p className="text-[12px] text-neutral-500 mt-1 leading-relaxed">Performs real-time local SHA-256 validation to secure absolute bite-by-bite byte alignment without leaks.</p>
                  </div>
                </div>

                <div className="bg-neutral-950 border border-neutral-900 rounded-2xl p-4 flex gap-3.5 items-start">
                  <div className="p-2.5 rounded-xl bg-teal-500/10 border border-teal-500/20 text-teal-400">
                    <ArrowRight className="h-4 w-4" />
                  </div>
                  <div>
                    <h4 className="font-medium text-sm text-neutral-200">Direct Socket Stream</h4>
                    <p className="text-[12px] text-neutral-500 mt-1 leading-relaxed">Initializes client-to-client stream without external servers storing or caching data, maximizing speeds.</p>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {/* Active Session View: Sender Control Dashboard */}
          {role === "sender" && roomId && fileMeta && (
            <motion.div
              id="sender-dashboard"
              key="sender"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              className="space-y-6"
            >
              {/* Top Level controls bar */}
              <div className="flex items-center justify-between border-b border-neutral-900 pb-4">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-teal-400 animate-pulse" />
                  <span className="text-xs font-mono uppercase tracking-wider text-teal-400">Sender Hub active</span>
                </div>
                <button
                  onClick={resetApp}
                  className="text-xs px-3 py-1.5 bg-neutral-900 hover:bg-neutral-800 text-neutral-300 rounded-xl border border-neutral-800 transition-colors"
                >
                  Cancel Session
                </button>
              </div>

              {/* Shared Metadata Card & Link copy panel */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Information Node */}
                <div className="bg-neutral-950 border border-neutral-900 rounded-3xl p-6 space-y-4">
                  <h3 className="font-display font-medium text-lg leading-tight text-neutral-200">Active File Payload</h3>
                  <div className="flex items-center gap-3.5 p-3.5 rounded-2xl bg-neutral-900/50 border border-neutral-905">
                    <div className="p-3 rounded-xl bg-teal-500/10 border border-teal-500/20 text-teal-400">
                      <FileText className="h-6 w-6" />
                    </div>
                    <div className="overflow-hidden min-w-0">
                      <p className="font-medium text-sm text-white truncate">{fileMeta.name}</p>
                      <p className="text-xs text-neutral-500 font-mono mt-0.5">{formatBytes(fileMeta.size)}</p>
                    </div>
                  </div>

                  {/* Active telemetry parameters */}
                  <div className="grid grid-cols-2 gap-3 pt-2 font-mono text-[11px]">
                    <div className="bg-neutral-900 px-3.5 py-2.5 rounded-xl border border-neutral-800">
                      <p className="text-neutral-500">MIME TYPE</p>
                      <p className="text-neutral-300 mt-1 truncate">{fileMeta.type || "application/octet-stream"}</p>
                    </div>
                    <div className="bg-neutral-900 px-3.5 py-2.5 rounded-xl border border-neutral-800">
                      <p className="text-neutral-500">AES-GCM SHIELD</p>
                      <p className="text-emerald-400 mt-1 flex items-center gap-1">
                        <Lock className="h-3 w-3" /> Active
                      </p>
                    </div>
                  </div>
                </div>

                {/* Receiver Invite Link copy card */}
                <div className="bg-neutral-950 border border-neutral-900 rounded-3xl p-6 flex flex-col justify-between">
                  <div className="space-y-2">
                    <h3 className="font-display font-medium text-lg text-neutral-200">Dispatch Invites</h3>
                    <p className="text-xs text-neutral-550 leading-relaxed text-neutral-400">
                      Share this unique direct web transfer link. The recipient will connect straight to your hardware stream with no login required.
                    </p>
                  </div>

                  {/* Copy Link container panel */}
                  <div className="space-y-3 mt-4">
                    <div className="flex bg-neutral-900 rounded-2xl p-2 border border-neutral-800 items-center justify-between gap-2 overflow-hidden">
                      <span className="text-xs font-mono text-neutral-400 truncate px-2 select-all leading-5">
                        {`${window.location.origin}/?room=${roomId}`}...
                      </span>
                      <button
                        onClick={copyShareLink}
                        className={`inline-flex items-center gap-1 px-3.5 py-2 rounded-xl text-xs font-medium cursor-pointer transition-all duration-200 ${
                          copiedLink
                            ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                            : "bg-teal-500 text-black hover:bg-teal-400 hover:scale-[1.02]"
                        }`}
                      >
                        {copiedLink ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                        {copiedLink ? "Copied" : "Copy Path"}
                      </button>
                    </div>
                    <p className="text-[10px] text-neutral-500 font-mono text-center">
                      * Decryption key is attached via URL location hash (#) for security.
                    </p>
                  </div>
                </div>
              </div>

              {/* Progress & Connection Audit Panel */}
              <div className="bg-neutral-950 border border-neutral-900 rounded-3xl p-6 space-y-6">
                <div>
                  <h3 className="font-display font-medium text-lg leading-tight text-neutral-200">Transfer Metrics &amp; Flow</h3>
                  <p className="text-xs text-neutral-500 mt-1">Real-time peer communication status &amp; progress</p>
                </div>

                {peerState === "connected" && (transferState === "idle" || transferState === "ready") && (
                  <div className="flex flex-col items-center justify-center py-6 space-y-4">
                    <div className="p-4 rounded-full bg-teal-500/10 border border-teal-500/20 text-teal-400 animate-pulse">
                      <ShieldCheck className="h-10 w-10" />
                    </div>
                    <div className="text-center space-y-1">
                      <p className="font-medium text-sm text-neutral-200">P2P Channel Established successfully</p>
                      <p className="text-xs text-neutral-500">Receiver joined and ready to acquire payload data.</p>
                    </div>
                    <button
                      onClick={startFileTransferFlow}
                      className="px-6 py-2.5 bg-teal-500 text-black hover:bg-teal-400 rounded-2xl text-xs font-semibold hover:scale-[1.02] active:scale-95 transition-all duration-200 shadow-lg shadow-teal-500/10 cursor-pointer"
                    >
                      Authorize Transfer Stream
                    </button>
                  </div>
                )}

                {peerState !== "connected" && (
                  <div className="flex flex-col items-center justify-center py-8 space-y-4 border border-dashed border-neutral-900 rounded-2xl bg-neutral-950/20">
                    <div className="p-3.5 rounded-full bg-neutral-900 border border-neutral-800 text-neutral-400 animate-pulse">
                      <RefreshCw className="h-6 w-6 animate-spin text-teal-500" />
                    </div>
                    <div className="text-center space-y-1 px-4">
                      <p className="font-medium text-sm text-neutral-350">Awaiting direct P2P connection...</p>
                      <p className="text-xs text-neutral-500 max-w-sm mx-auto leading-relaxed">
                        Establish connection by loading the generated invite link in a secondary secure browser window.
                      </p>
                    </div>
                  </div>
                )}

                {/* Transferring progress metrics display */}
                {(transferState === "transferring" ||
                  transferState === "completed" ||
                  transferState === "preparing" ||
                  transferState === "encrypting") && (
                  <div className="space-y-4 pt-1">
                    <div className="flex items-center justify-between text-xs font-mono text-neutral-400">
                      <span className="flex items-center gap-1.5 uppercase font-semibold text-teal-400">
                        {transferState === "completed" && "Transmission Completed"}
                        {transferState === "transferring" && "Direct Streaming active"}
                        {transferState === "preparing" && "Caching file chunks..."}
                        {transferState === "encrypting" && "Running local AES-GCM wrap..."}
                      </span>
                      <span>
                        {Math.floor((transferBytesCompleted / (fileMeta.size || 1)) * 100)}%
                      </span>
                    </div>

                    {/* Progress track bars */}
                    <div className="h-2 w-full bg-neutral-900 rounded-full overflow-hidden border border-neutral-800">
                      <motion.div
                        className="h-full bg-teal-400 rounded-full"
                        style={{
                          width: `${Math.min(
                            100,
                            (transferBytesCompleted / (fileMeta.size || 1)) * 100
                          )}%`,
                        }}
                        transition={{ ease: "easeInOut" }}
                      />
                    </div>

                    {/* Info rows: speeds, remaining size */}
                    <div className="grid grid-cols-3 gap-2 text-center pt-2">
                      <div className="bg-neutral-900/65 border border-neutral-850 p-2.5 rounded-2xl font-mono text-[11px]">
                        <p className="text-neutral-500">COMPLETED</p>
                        <p className="text-neutral-200 mt-1 font-semibold">
                          {formatBytes(transferBytesCompleted)} / {formatBytes(fileMeta.size)}
                        </p>
                      </div>
                      <div className="bg-neutral-900/65 border border-neutral-850 p-2.5 rounded-2xl font-mono text-[11px]">
                        <p className="text-neutral-500">TRANSFER SPEED</p>
                        <p className="text-teal-400 mt-1 font-semibold">
                          {formatBytes(transferSpeed)}/s
                        </p>
                      </div>
                      <div className="bg-neutral-900/65 border border-neutral-850 p-2.5 rounded-2xl font-mono text-[11px]">
                        <p className="text-neutral-500">ESTIMATED ETA</p>
                        <p className="text-neutral-200 mt-1 font-semibold">
                          {transferState === "completed" ? "Done" : formatEta(transferEta)}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          )}

          {/* Receiver Dashboard View */}
          {role === "receiver" && roomId && (
            <motion.div
              id="receiver-dashboard"
              key="receiver"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              className="space-y-6"
            >
              {/* Top controls header */}
              <div className="flex items-center justify-between border-b border-neutral-900 pb-4">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="text-xs font-mono uppercase tracking-wider text-emerald-400">Receiver Hub Active</span>
                </div>
                <button
                  onClick={resetApp}
                  className="text-xs px-3 py-1.5 bg-neutral-900 hover:bg-neutral-800 text-neutral-300 rounded-xl border border-neutral-800 transition-colors"
                >
                  Exit Room
                </button>
              </div>

              {/* Connected details cards */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Peer file info metadata container */}
                <div className="bg-neutral-950 border border-neutral-900 rounded-3xl p-6 space-y-4">
                  <h3 className="font-display font-medium text-lg leading-tight text-neutral-200">Incoming file details</h3>
                  
                  {fileMeta ? (
                    <div className="flex items-center gap-3.5 p-3.5 rounded-2xl bg-neutral-900/50 border border-neutral-850">
                      <div className="p-3 rounded-xl bg-emerald-500/15 border border-emerald-500/20 text-emerald-400">
                        <FileText className="h-6 w-6" />
                      </div>
                      <div className="overflow-hidden min-w-0">
                        <p className="font-medium text-sm text-white truncate">{fileMeta.name}</p>
                        <p className="text-xs text-neutral-500 font-mono mt-0.5">{formatBytes(fileMeta.size)}</p>
                      </div>
                    </div>
                  ) : (
                    <div className="p-4 rounded-2xl bg-neutral-900/20 border border-dashed border-neutral-850 text-center text-xs text-neutral-550 py-8 text-neutral-550">
                      Waiting for sender to dispatch file metadata...
                    </div>
                  )}

                  {fileMeta && (
                    <div className="grid grid-cols-2 gap-3 pt-1 font-mono text-[11px]">
                      <div className="bg-neutral-900 px-3.5 py-2.5 rounded-xl border border-neutral-800">
                        <p className="text-neutral-500">CIPHER ALIGNED</p>
                        <p className={`mt-1 font-semibold ${secretKey ? "text-emerald-400" : "text-amber-400"}`}>
                          {secretKey ? "AES-GCM Local" : "Clear stream (No Hash)"}
                        </p>
                      </div>
                      <div className="bg-neutral-900 px-3.5 py-2.5 rounded-xl border border-neutral-800">
                        <p className="text-neutral-500">MIME GROUP</p>
                        <p className="text-neutral-250 mt-1 truncate">{fileMeta.type || "application/octet-stream"}</p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Handshake security context */}
                <div className="bg-neutral-950 border border-neutral-900 rounded-3xl p-6 flex flex-col justify-between">
                  <div className="space-y-2">
                    <h3 className="font-display font-medium text-lg text-neutral-200">Zero-Knowledge Trust Shield</h3>
                    <p className="text-xs text-neutral-450 leading-relaxed text-neutral-400">
                      The signaling server coordinates the peer linking handshake. Data is decrypted strictly on your local browser using the hash parameter decryption key.
                    </p>
                  </div>

                  <div className="p-3.5 bg-neutral-900 rounded-2xl mt-4 border border-neutral-850 flex gap-3 items-center">
                    <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/15 text-emerald-400">
                      <Lock className="h-4 w-4" />
                    </div>
                    <div>
                      <p className="text-xs font-mono text-neutral-250">Decryption Key State</p>
                      <p className="text-[10px] text-neutral-500 font-mono mt-0.5 truncate max-w-[200px]">
                        {secretKey ? `SHA Key *${secretKey.substring(0, 8)}...` : "Absent (Plaintext Transfer)"}
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Progress Panel for Recipient */}
              <div className="bg-neutral-950 border border-neutral-900 rounded-3xl p-6 space-y-6">
                <div>
                  <h3 className="font-display font-medium text-lg text-neutral-200">Reception stream progress</h3>
                  <p className="text-xs text-neutral-500 mt-1">Status of chunks reassembling locally in memory buffer</p>
                </div>

                {peerState !== "connected" && (
                  <div className="flex flex-col items-center justify-center py-8 space-y-4 border border-dashed border-neutral-900 bg-neutral-950/20 rounded-2xl">
                    <div className="p-3 rounded-full bg-neutral-900 text-teal-400 border border-neutral-800 animate-spin">
                      <RefreshCw className="h-6 w-6" />
                    </div>
                    <div className="text-center px-4">
                      <p className="text-sm font-medium text-neutral-300">Linking with sender node...</p>
                      <p className="text-xs text-neutral-500 max-w-sm mx-auto leading-relaxed mt-1">
                        Ensuring local stun handshake completes. High capacity direct communication takes a brief instance.
                      </p>
                    </div>
                  </div>
                )}

                {peerState === "connected" && transferState === "idle" && (
                  <div className="flex flex-col items-center justify-center py-8 border border-dashed border-neutral-850 bg-neutral-950/10 rounded-2xl">
                    <div className="p-4 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 animate-pulse">
                      <ShieldCheck className="h-10 w-10" />
                    </div>
                    <p className="font-medium text-sm text-neutral-200 mt-4">Linked Directly with Sender</p>
                    <p className="text-xs text-neutral-500 mt-1">Awaiting sender authorization to begin transmission...</p>
                  </div>
                )}

                {/* Transfer process active states */}
                {(transferState === "transferring" ||
                  transferState === "decrypting" ||
                  transferState === "verifying" ||
                  transferState === "completed") &&
                  fileMeta && (
                    <div className="space-y-4 pt-1 animate-fadeIn">
                      <div className="flex items-center justify-between text-xs font-mono text-neutral-400">
                        <span className="flex items-center gap-1.5 uppercase font-semibold text-emerald-400">
                          {transferState === "transferring" && "Acquiring direct data chunks..."}
                          {transferState === "decrypting" && "Applying local AES decipher..."}
                          {transferState === "verifying" && "Auditing SHA-250 integrity..."}
                          {transferState === "completed" && "Download Stream triggered"}
                        </span>
                        <span>
                          {Math.floor((transferBytesCompleted / fileMeta.size) * 100)}%
                        </span>
                      </div>

                      {/* Bar tracks */}
                      <div className="h-2 w-full bg-neutral-900 rounded-full border border-neutral-800 overflow-hidden">
                        <motion.div
                          className="h-full bg-emerald-400 rounded-full"
                          style={{
                            width: `${Math.min(
                              100,
                              (transferBytesCompleted / fileMeta.size) * 100
                            )}%`,
                          }}
                          transition={{ ease: "easeInOut" }}
                        />
                      </div>

                      {/* Speed Metrics row */}
                      <div className="grid grid-cols-3 gap-2 pt-2">
                        <div className="bg-neutral-900/60 border border-neutral-850 p-2.5 rounded-2xl text-center font-mono text-[11px]">
                          <p className="text-neutral-500">ACQUIRED</p>
                          <p className="text-neutral-250 mt-1 font-semibold">
                            {formatBytes(transferBytesCompleted)} / {formatBytes(fileMeta.size)}
                          </p>
                        </div>
                        <div className="bg-neutral-900/60 border border-neutral-850 p-2.5 rounded-2xl text-center font-mono text-[11px]">
                          <p className="text-neutral-500">RATE</p>
                          <p className="text-emerald-400 mt-1 font-semibold">{formatBytes(transferSpeed)}/s</p>
                        </div>
                        <div className="bg-neutral-900/60 border border-neutral-850 p-2.5 rounded-2xl text-center font-mono text-[11px]">
                          <p className="text-neutral-500">ESTIMATED ETA</p>
                          <p className="text-neutral-255 mt-1 font-semibold">
                            {transferState === "completed" ? "Done" : formatEta(transferEta)}
                          </p>
                        </div>
                      </div>

                      {transferState === "completed" && (
                        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-2xl p-4 flex gap-3 items-center text-xs text-emerald-400 animate-fadeIn font-mono">
                          <CheckCircle2 className="h-5 w-5 text-emerald-400 flex-shrink-0" />
                          <div>
                            <p className="font-semibold text-neutral-100">File verified &amp; acquired successfully!</p>
                            <p className="text-[11px] text-emerald-500 mt-1 text-emerald-400 select-all font-mono leading-tight truncate">
                              SHA-256: {receivedHash}
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Global Error notifications panels */}
        {transferState === "error" && errorMessage && (
          <div className="mt-6 bg-red-500/10 border border-red-500/20 text-red-405 p-4 rounded-3xl flex gap-3 text-xs leading-relaxed text-red-450 text-red-400 select-none">
            <AlertCircle className="h-5 w-5 text-red-505 flex-shrink-0" />
            <div className="space-y-1">
              <span className="font-semibold block text-white">Transfer stream issue highlighted</span>
              <span>{errorMessage}</span>
              <div className="pt-2">
                <button
                  onClick={resetApp}
                  className="px-3 py-1.5 bg-neutral-900 hover:bg-neutral-850 text-white border border-neutral-800 rounded-xl"
                >
                  Restart session
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Handshake Signal Audit Logs logs panel */}
        {role && (
          <div className="mt-8 bg-neutral-950 border border-neutral-900 rounded-3xl p-6">
            <h3 className="font-display font-medium text-sm text-neutral-200 mb-3 flex items-center justify-between">
              <span>Signaling Hub Audit Trails</span>
              <span className="text-[10px] font-mono font-normal text-neutral-500 uppercase tracking-widest">
                WebRTC logs
              </span>
            </h3>
            <div
              id="signal-log"
              className="bg-black/40 border border-neutral-900/50 rounded-xl p-3.5 font-mono text-[10px] sm:text-xs text-neutral-450 select-all overflow-y-auto max-h-[140px] space-y-1 text-neutral-400"
            >
              {signalLog.map((log, idx) => (
                <div key={idx} className="truncate">
                  {log}
                </div>
              ))}
              {signalLog.length === 0 && (
                <div className="text-neutral-600 text-center py-2 italic">Waiting for room messages to register...</div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Footer copyright */}
      <footer id="app-footer" className="py-6 border-t border-neutral-900/60 bg-neutral-950 text-center text-xs text-neutral-600 font-mono">
        <p>&copy; 2026 P2P Web Share &bull; Decentralized &bull; Zero-Knowledge AES-GCM 256</p>
      </footer>
    </div>
  );
}
