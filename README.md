# P2P Web Share – Direct Browser-to-Browser File Transfer

A lightweight, decentralized, peer-to-peer file-sharing web application built with **React**, **Node.js/Express**, **WebSockets**, and **WebRTC**. 

This platform allows users to instantly share files up to **50MB** securely and directly from browser to browser. Recipients who open the unique share room link connect directly to the sender's hardware stream to download the file, skipping third-party cloud-storage intermediaries entirely.

---

## ✦ Key Features

- 📂 **Share Room Creation**: Drop files directly onto the browser to set up a transient, unique peer room session.
- 🤝 **Direct P2P Transfer (WebRTC)**: Chunks are transferred securely over dedicated WebRTC data channels, achieving maximum raw network speeds.
- 🔒 **Zero-Knowledge Encryption**: File chunks are encrypted locally in the browser using the **Web Crypto API (AES-GCM)** prior to transmission. Decryption keys are stored purely in the URL hash parameter and are never shared with or sent to the signaling server.
- 🛡️ **Cryptographic Verification**: Computes a local **SHA-256** hash of the file chunks before transmission and performs local post-transfer reassembly verification.
- ⚡ **Real-Time Telemetry Panels**: Accurate progress bars, active speeds (MB/s), Estimated Time of Arrival (ETA), and direct connection indicators.
- ☁️ **Lightweight Signaling Server**: Built on Node.js/WebSockets to coordinate WebRTC handshakes (offers, answers, candidates) without caching or persisting any user files.

---

## 🛠️ Tech Stack & Architecture

- **Frontend**: React (v19), Tailwind CSS, Motion (Animations), Lucide React
- **Backend/Signaling**: Node.js + Express + WS (WebSockets)
- **Peer-to-Peer**: Native WebRTC Data Channels
- **Cryptographic Engine**: Web Crypto API (AES-GCM-256 / SHA-256)

### How It Works

```
[ Sender Browser ]                                           [ Receiver Browser ]
       |                                                              |
       |----- (1) Register room & establish connection ------> [ WebSocket Server ]
       |                                                              |
       |                          [ Handshake ]                       |
       |<==== (2) Signal WebRTC Offer / ICE Candidates / Metadata ===>|
       |                                                              |
       v                                                              v
 [ Read & Encrypt ] ----- (3) Stream Direct ArrayBuffer Chunks ----> [ Decrypt & Verify ]
 (Local Memory Cache)           (Local P2P WebRTC Link)            (Auto triggering Download)
```

1. **Upload & Room Lock**: Senders select or drag a file to load it into memory. A unique cryptographic pairing key is generated and attached to the URL hash: `/#key=...`.
2. **WebSocket Signaling Hook**: The app establishes a lightweight websocket link to coordinate WebRTC STUN handshakes.
3. **P2P Channel Handshake**: Peer connections lock down direct client-to-client pipes.
4. **Local Encrypt & Deliver**: As the file streams, blocks are encrypted locally on-the-fly and parsed over WebRTC. The recipient reassembles, decrypts, runs a hash audit, and triggers an auto-download.

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** (v18 or higher)
- **NPM** (v10 or higher)

### Installation

1. Clone or extract the project repository.
2. Install the necessary dependencies:
   ```bash
   npm install
   ```

### Running Locally

To boot both the Express signaling backend server and the Vite development asset server in tandem:

```bash
npm run dev
```

The application will be accessible at: **`http://localhost:3000`**

### Production Build

To bundle the client-side single page app and compile the Node.js TypeScript server into production-ready artifacts:

```bash
npm run build
```

The application can then be executed via:

```bash
npm start
```
