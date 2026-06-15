# P2P Web Share

A browser-based peer-to-peer file sharing app that lets one user send a file directly to another user using **WebRTC Data Channels**. The backend is only used for **signaling**: it helps the sender and receiver find each other, exchange WebRTC handshake messages, and then gets out of the file-transfer path.

The app is built with **React**, **Vite**, **TypeScript**, **Node.js**, **Express**, and **WebSockets**.

---

## What It Does

P2P Web Share creates a temporary file-transfer room. The sender selects a file, gets a share link, and sends that link to the receiver. When the receiver opens the link, both browsers connect through WebRTC and the file is streamed in chunks directly from sender to receiver.

The application includes:

- local file selection through click-to-upload or drag-and-drop
- automatic room creation for every selected file
- shareable invite link containing the room ID and secret key
- WebSocket-based signaling server
- WebRTC peer-to-peer data channel transfer
- local AES-GCM encryption before transfer
- local AES-GCM decryption after transfer
- SHA-256 file integrity verification
- automatic download after successful transfer
- live transfer progress, speed, and ETA
- sender and receiver dashboards
- connection state indicators for signaling and peer connection
- in-app audit logs for WebSocket and WebRTC events
- graceful session reset and disconnect handling

---

## Core Functionality

### 1. File Selection

The sender can select a file by clicking the upload area or dragging and dropping a file into the browser.

Current file limit:

```txt
50 MB per transfer session
```

The file is read into browser memory before encryption and transfer, so the size limit is intentional.

---

### 2. Automatic Room Creation

After the sender selects a file, the app automatically creates a unique room ID:

```txt
room-xxxxxx
```

It also generates a random 256-bit encryption key in the browser.

The sender gets a share link in this format:

```txt
http://localhost:3000/?room=<room-id>#key=<secret-key>
```

The `room` query parameter is used by the signaling server. The `key` is stored in the URL hash so it is not sent to the server during normal HTTP requests.

---

### 3. WebSocket Signaling

The server exposes a WebSocket signaling endpoint:

```txt
/ws-signaling
```

The signaling server handles:

- sender joining a room
- receiver joining a room
- room state updates
- WebRTC offer forwarding
- WebRTC answer forwarding
- ICE candidate forwarding
- peer disconnect notifications

The signaling server does **not** store, cache, or forward file data.

---

### 4. WebRTC Peer Connection

Once both users are in the same room, the app creates a WebRTC connection using public STUN servers:

```ts
stun:stun.l.google.com:19302
stun:stun1.l.google.com:19302
stun:stun2.l.google.com:19302
```

The sender creates an ordered WebRTC data channel named:

```txt
fileTransfer
```

The receiver listens for this data channel and receives file metadata and binary chunks through it.

---

### 5. End-to-End Local Encryption

Before transfer, the sender computes the original file hash and encrypts the file locally using the Web Crypto API.

Encryption details:

- algorithm: AES-GCM
- key size: 256-bit
- IV size: 12 bytes
- key generation: browser-side random bytes
- key format: 64-character hex string

The encryption key is included only in the URL hash:

```txt
#key=<secret-key>
```

This means the key is available to the sender and receiver browsers, but it is not sent to the WebSocket signaling server as part of the room registration payload.

---

### 6. SHA-256 Integrity Verification

The sender calculates a SHA-256 hash of the original file before encryption.

After the receiver gets all chunks and decrypts the payload, the receiver calculates SHA-256 again and compares both hashes.

If the hashes match, the file is considered valid and the download starts automatically.

If the hashes do not match, the app stops the transfer and shows an integrity error.

---

### 7. Chunked File Transfer

The encrypted payload is sent through the WebRTC data channel in fixed-size chunks.

Current chunk size:

```txt
16 KB
```

The sender uses basic flow control by checking the data channel buffer before sending more chunks:

```txt
bufferedAmount < 128 KB
```

This prevents the sender from flooding the WebRTC data channel too aggressively.

---

### 8. Receiver-Side Reassembly and Download

The receiver:

1. receives file metadata
2. receives encrypted binary chunks
3. stores chunks in memory
4. concatenates chunks into one payload
5. decrypts the payload locally
6. verifies the SHA-256 hash
7. creates a browser Blob
8. triggers an automatic file download

---

### 9. Real-Time Transfer Metrics

Both sender and receiver dashboards show:

- transfer progress percentage
- bytes sent or received
- current transfer speed
- estimated time remaining
- transfer state
- connection state

Transfer states include:

- idle
- preparing
- encrypting
- ready
- transferring
- decrypting
- verifying
- completed
- error

---

### 10. Audit Logs

The UI includes a signaling audit log that displays recent room, WebSocket, and WebRTC events.

Examples of logged events:

- room joined
- signaling server connected
- sender or receiver active
- WebRTC offer sent
- WebRTC answer received
- data channel opened
- metadata received
- encryption completed
- verification completed
- peer disconnected

---

## Architecture

```txt
+------------------+                 +----------------------+                 +--------------------+
|  Sender Browser  |                 |  Signaling Server    |                 |  Receiver Browser  |
|                  |                 |  Express + WebSocket |                 |                    |
| Selects file     |                 |                      |                 | Opens invite link |
| Generates key    |                 | Relays offer/answer  |                 | Gets room + key   |
| Encrypts file    |                 | Relays ICE candidates|                 | Waits for channel |
+--------+---------+                 +----------+-----------+                 +----------+---------+
         |                                      |                                      |
         |        WebSocket signaling only      |                                      |
         +--------------------------------------+--------------------------------------+
                                                |
                                                |
         +--------------------------------------------------------------------------+
         |                                                                          |
         |                Direct WebRTC Data Channel Transfer                        |
         |                                                                          |
         |        encrypted chunks + metadata sent browser-to-browser                |
         |                                                                          |
         +--------------------------------------------------------------------------+
```

The server is not a file server. It only coordinates the WebRTC handshake.

---

## Tech Stack

### Frontend

- React 19
- TypeScript
- Vite
- Tailwind CSS
- Motion
- Lucide React
- Web Crypto API
- WebRTC Data Channels

### Backend

- Node.js
- Express
- WebSocket server using `ws`
- Vite middleware in development
- Static file serving in production

---

## Project Structure

```txt
p2p-web-share/
├── src/
│   ├── App.tsx           # Main React app, room flow, WebRTC logic, transfer UI
│   ├── cryptoUtils.ts    # AES-GCM encryption/decryption and SHA-256 helpers
│   ├── index.css         # Tailwind and font setup
│   └── main.tsx          # React app entry point
├── server.ts             # Express server and WebSocket signaling server
├── index.html            # Vite HTML entry
├── vite.config.ts        # Vite + React + Tailwind configuration
├── tsconfig.json         # TypeScript configuration
├── package.json          # Scripts and dependencies
├── package-lock.json     # Locked dependency versions
├── .env.example          # Example environment file
└── README.md             # Project documentation
```

---

## Getting Started

### Prerequisites

Install:

- Node.js 18 or newer
- npm

Check your versions:

```bash
node -v
npm -v
```

---

## Installation

Clone or extract the project, then open a terminal inside the actual project folder:

```bash
cd p2p-web-share
npm install
```

Do not run npm commands from the parent folder unless the `package.json` file is present there.

---

## Running in Development

Start the development server:

```bash
npm run dev
```

Open the app:

```txt
http://localhost:3000
```

In development, the Express server runs on port `3000` and uses Vite middleware to serve the React app.

---

## Production Build

Create a production build:

```bash
npm run build
```

Start the production server:

```bash
npm start
```

The production server serves the compiled frontend from the `dist` folder and exposes the same WebSocket signaling endpoint.

---

## Available Scripts

```bash
npm run dev
```

Starts the Express server with Vite middleware for development.

```bash
npm run build
```

Builds the React frontend and bundles the TypeScript server.

```bash
npm start
```

Runs the built production server.

```bash
npm run preview
```

Runs Vite preview for the frontend build.

```bash
npm run clean
```

Removes generated build files.

```bash
npm run lint
```

Runs TypeScript checking without emitting files.

---

## How to Use

### Sender

1. Open the app in the browser.
2. Drag and drop a file or click the upload area.
3. Copy the generated invite link.
4. Send the invite link to the receiver.
5. Wait for the receiver to join.
6. Click **Authorize Transfer Stream** once the peer connection is active.

### Receiver

1. Open the invite link shared by the sender.
2. Wait for the WebRTC connection to become active.
3. Wait for the sender to start the transfer.
4. The file is received, decrypted, verified, and downloaded automatically.

---

## API Endpoint

### Health Check

```txt
GET /api/health
```

Response:

```json
{
  "status": "ok",
  "wsPath": "/ws-signaling"
}
```

---

## WebSocket Message Flow

### Join Room

```json
{
  "type": "join",
  "roomId": "room-abc123",
  "role": "sender",
  "peerId": "sender_xxxx"
}
```

### Room State

```json
{
  "type": "room_state",
  "senderActive": true,
  "receiverActive": true,
  "peerRole": "sender"
}
```

### Signal Forwarding

```json
{
  "type": "signal",
  "roomId": "room-abc123",
  "signalData": {
    "type": "offer"
  }
}
```

Signal payloads are used for WebRTC offers, answers, and ICE candidates.

---

## Security Model

This project is designed so the server does not receive file contents.

Security-related behavior:

- file encryption happens inside the sender browser
- file decryption happens inside the receiver browser
- the AES key is generated locally
- the AES key is placed in the URL hash
- the signaling server receives the room ID and WebRTC signaling messages
- the signaling server does not receive the file payload
- file integrity is verified using SHA-256 after decryption

Important note: this is a strong project-level security design, but it is not a full audited security product. For real-world sensitive file sharing, the app should be reviewed, tested, deployed over HTTPS, and hardened further.

---

## Current Limitations

- Only one sender and one receiver are supported per room.
- Files are stored in browser memory during processing.
- The current file size limit is 50 MB.
- No TURN server is configured, so connections may fail on restrictive networks or symmetric NATs.
- The sender tab must stay open until the transfer completes.
- The receiver tab must stay open until the download is triggered.
- There is no persistent transfer history.
- There is no user authentication.
- Rooms are temporary and stored only in server memory.

---

## Troubleshooting

### `npm install` or `npm run dev` fails with `package.json` not found

You are probably running the command from the wrong directory.

Run:

```bash
cd p2p-web-share
npm install
npm run dev
```

### Receiver is stuck at 0%

Check the following:

- both sender and receiver tabs are open
- both users are using the same invite link
- the sender clicked **Authorize Transfer Stream**
- the WebRTC peer status says active
- browser permissions or network restrictions are not blocking WebRTC
- both users are not behind networks that block peer-to-peer traffic

### WebRTC connection fails

The app currently uses STUN servers only. Some networks require a TURN relay server. Add TURN server configuration if you want more reliable connections across strict NATs.

### Decryption fails

Possible causes:

- invite link is missing the `#key=` hash
- key was modified while copying the link
- transfer was interrupted
- encrypted payload was corrupted

### Hash verification fails

The received file does not match the sender's original file. Restart the session and transfer again.

---

## Possible Improvements

Useful future upgrades:

- TURN server support for better connection reliability
- larger file support through streaming instead of full memory buffering
- multi-file transfers
- resumable transfers
- QR-code sharing
- password-protected rooms
- room expiry timer
- transfer cancellation
- better mobile layout
- multiple receivers per room
- deployment guide for Render, Railway, Fly.io, or VPS

---

## License

No license has been specified yet. Add a license before publishing this project publicly.
