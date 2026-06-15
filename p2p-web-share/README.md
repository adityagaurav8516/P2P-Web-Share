# P2P Web Share

A lightweight direct browser-to-browser file transfer web app built with **React**, **Node.js**, **Socket.IO**, and **WebRTC DataChannels**.

The signaling server only coordinates the WebRTC handshake. It never stores, reads, or relays file bytes. Files are transferred directly between browsers after the peer connection is established.

## Features

- Share room creation with a unique invite link
- Socket.IO signaling backend for WebRTC offers, answers, and ICE candidates
- Direct WebRTC DataChannel file transfer
- 64KB chunked transfer with browser backpressure handling
- SHA-256 hash verification per chunk
- Final SHA-256 full-file verification before download
- AES-GCM-256 encryption in the browser
- Decryption key passed through URL hash, not through the server
- Real-time progress, speed, and connection status
- Graceful peer disconnect messages
- Auto-download after successful verification

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React + Vite |
| Signaling | Node.js + Express + Socket.IO |
| P2P transport | WebRTC DataChannel |
| Integrity | Web Crypto API SHA-256 |
| Encryption | Web Crypto API AES-GCM |

## Project structure

```txt
p2p-web-share/
  client/
    src/
      App.jsx
      main.jsx
      styles.css
      lib/
        crypto.js
        format.js
    package.json
    .env.example
  server/
    src/
      index.js
    package.json
    .env.example
  package.json
  README.md
```

## How it works

1. Sender selects a file.
2. Sender creates a room on the signaling server.
3. Frontend generates a 256-bit AES key in the browser.
4. The invite link contains:
   - `?room=<roomId>` for the signaling server
   - `#key=<secret>` for the receiver browser only
5. Receiver opens the link.
6. Socket.IO exchanges WebRTC offer, answer, and ICE candidates.
7. Once the DataChannel opens, the sender:
   - computes the full-file SHA-256 hash
   - slices the file into 64KB chunks
   - computes chunk SHA-256
   - encrypts each chunk using AES-GCM
   - sends chunk metadata + encrypted binary chunk
8. Receiver:
   - decrypts each chunk
   - verifies each chunk hash
   - verifies the final file hash
   - triggers local download

## Setup

### 1. Install dependencies

From the root folder:

```bash
npm run install:all
```

Or install manually:

```bash
cd server
npm install

cd ../client
npm install
```

### 2. Configure environment variables

Server:

```bash
cd server
cp .env.example .env
```

Client:

```bash
cd client
cp .env.example .env
```

Defaults work locally:

```txt
Server: http://localhost:4000
Client: http://localhost:5173
```

### 3. Run the server

```bash
cd server
npm run dev
```

### 4. Run the client

Open a second terminal:

```bash
cd client
npm run dev
```

Then open:

```txt
http://localhost:5173
```

## Testing the transfer

1. Open `http://localhost:5173` in Chrome/Edge/Firefox.
2. Select or drop a file.
3. Click **Generate secure room link**.
4. Copy the invite link.
5. Open the link in another browser window, another browser profile, or another device on the same network.
6. Keep the sender tab open until transfer finishes.
7. The receiver should auto-download the verified file.

## Important local-network testing note

If you test on two different devices, use your machine's LAN IP instead of `localhost`.

Example:

```txt
VITE_SIGNALING_URL=http://192.168.1.5:4000
```

And open the frontend as:

```txt
http://192.168.1.5:5173
```

Make sure your firewall allows ports `4000` and `5173`.

## Deployment

Frontend options:

- Vercel
- Netlify
- Cloudflare Pages

Backend options:

- Render
- Railway
- Fly.io

Set these variables:

Server:

```txt
CLIENT_ORIGIN=https://your-frontend-domain.com
PORT=4000
```

Client:

```txt
VITE_SIGNALING_URL=https://your-backend-domain.com
```

## Browser/security notes

- Web Crypto and WebRTC work best on `localhost` or HTTPS origins.
- For real deployment, use HTTPS.
- The server does not receive file bytes.
- The server also does not receive the AES key because URL hash fragments are handled client-side.
- STUN is enough for many networks, but some strict NATs may require a TURN server.

## Limitations

Current MVP limitations:

- 1 sender to 1 receiver only
- Sender must keep tab open
- Receiver stores chunks in memory before download
- Recommended file size is under 50MB
- No resume support yet
- No multi-peer mesh swarming yet

## Resume-worthy improvements

If you want to make this project actually stand out, add these next:

1. Resume from last verified chunk after disconnect.
2. IndexedDB or OPFS-based streaming for files larger than 500MB.
3. Multi-peer mesh swarming where receivers can become seeders.
4. QR code invite link.
5. Password-protected rooms.
6. TURN server support with deployment docs.
7. Transfer history stored locally only.
8. Automated tests for signaling events and hash verification.

## Demo video checklist

Your 3-minute demo should show:

1. Sender opens app and selects a file.
2. Sender generates link.
3. Receiver opens link in another browser/device.
4. WebRTC connection status changes to connected.
5. Progress bar and speed update during transfer.
6. Receiver auto-downloads file.
7. Show same SHA-256 hash or open the downloaded file.
8. Mention that the server never stores file bytes.

