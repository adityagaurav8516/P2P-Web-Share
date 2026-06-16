# P2P Web Share

A browser-based peer-to-peer file sharing app that lets users send files directly to each other using **WebRTC Data Channels**. No file ever touches the server — the backend only handles WebRTC signaling.

🚀 **Live Demo:** [p2p-web-share-production-36ad.up.railway.app](https://p2p-web-share-production-36ad.up.railway.app)

---

## What It Does

P2P Web Share creates a temporary file-transfer room. The sender selects a file, gets a shareable link, and sends it to the receiver. When the receiver opens the link, both browsers connect via WebRTC and the file streams directly — browser to browser.

- Click-to-upload or drag-and-drop file selection
- Automatic room creation per file
- Shareable invite link with embedded room ID and encryption key
- AES-GCM 256-bit end-to-end encryption (in-browser)
- SHA-256 integrity verification
- Live transfer progress, speed, and ETA
- Automatic download after transfer completes
- Sender and receiver dashboards
- WebSocket and WebRTC event audit logs

---

## How It Works

```
Sender Browser  ──── WebSocket signaling only ────  Signaling Server  ────  Receiver Browser
      │                                                                              │
      └──────────────── Direct WebRTC Data Channel (encrypted chunks) ──────────────┘
```

The server coordinates the WebRTC handshake only. File data never passes through it.

---

## Tech Stack

**Frontend:** React 19, TypeScript, Vite, Tailwind CSS, Web Crypto API, WebRTC

**Backend:** Node.js, Express, WebSocket (`ws`)

---

## Getting Started

### Prerequisites

- Node.js 18+
- npm

### Installation

```bash
git clone https://github.com/adityagaurav8516/P2P-Web-Share.git
cd P2P-Web-Share
npm install
```

### Development

```bash
npm run dev
```

Open `http://localhost:3000`

### Production

```bash
npm run build
npm start
```

---

## Usage

**Sender**
1. Open the app and drag-and-drop a file (max 50 MB)
2. Copy the generated invite link
3. Send the link to the receiver
4. Click **Authorize Transfer Stream** once the peer connects

**Receiver**
1. Open the invite link
2. Wait for the WebRTC connection to go active
3. File downloads automatically after transfer and verification

---

## Security

- Encryption and decryption happen entirely in the browser
- AES-GCM 256-bit key is generated locally and placed only in the URL hash (`#key=...`) — never sent to the server
- SHA-256 integrity check after decryption ensures the file wasn't corrupted or tampered with

> This is a strong project-level security design. For production use with sensitive files, deploy over HTTPS (Railway provides this by default) and consider a full security audit.

---

## Project Structure

```
P2P-Web-Share/
├── src/
│   ├── App.tsx           # Main app, WebRTC logic, transfer UI
│   ├── cryptoUtils.ts    # AES-GCM encryption and SHA-256 helpers
│   ├── index.css
│   └── main.tsx
├── server.ts             # Express + WebSocket signaling server
├── index.html
├── vite.config.ts
├── tsconfig.json
├── package.json
└── .env.example
```

---

## Deployment

This project is deployed on **Railway**.

For your own deployment:

1. Push to GitHub
2. Create a new Railway project → Deploy from GitHub repo
3. Set build command: `npm run build`
4. Set start command: `npm start`
5. Railway auto-provisions HTTPS

> **Note:** This project requires a persistent Node.js process for the WebSocket server. Serverless platforms like Vercel will not work.

---

## Known Limitations

- One sender and one receiver per room
- Files are held in browser memory — 50 MB limit
- No TURN server configured; connections may fail on strict NATs
- Rooms are in-memory only and reset on server restart
- Sender and receiver tabs must stay open during transfer

---

## Roadmap

- TURN server for better NAT traversal
- Larger file support via streaming
- Multi-file transfers
- QR code invite sharing
- Room expiry timer
- Mobile layout improvements

---

## License

No license specified yet.
