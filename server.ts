import express from "express";
import http from "http";
import path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { createServer as createViteServer } from "vite";

interface Peer {
  ws: WebSocket;
  peerId: string;
}

interface Room {
  sender?: Peer;
  receiver?: Peer;
}

const rooms = new Map<string, Room>();

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const PORT = 3000;

  // Configure WebSockets on the same server
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "", `http://${request.headers.host || "localhost"}`);
    if (url.pathname === "/ws-signaling") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    }
  });

  wss.on("connection", (ws) => {
    let currentRoomId: string | null = null;
    let currentRole: "sender" | "receiver" | null = null;
    let currentPeerId: string | null = null;

    ws.on("message", (messageData) => {
      try {
        const data = JSON.parse(messageData.toString());
        const { type } = data;

        if (type === "join") {
          const { roomId, role, peerId } = data;
          currentRoomId = roomId;
          currentRole = role;
          currentPeerId = peerId;

          let room = rooms.get(roomId);
          if (!room) {
            room = {};
            rooms.set(roomId, room);
          }

          if (role === "sender") {
            if (room.sender && room.sender.ws !== ws) {
              room.sender.ws.close();
            }
            room.sender = { ws, peerId };
          } else if (role === "receiver") {
            if (room.receiver && room.receiver.ws !== ws) {
              room.receiver.ws.close();
            }
            room.receiver = { ws, peerId };
          }

          const senderActive = !!room.sender;
          const receiverActive = !!room.receiver;

          // Notify sender and receiver about members in room
          if (room.sender) {
            room.sender.ws.send(JSON.stringify({
              type: "room_state",
              senderActive,
              receiverActive,
              peerRole: "sender",
            }));
          }
          if (room.receiver) {
            room.receiver.ws.send(JSON.stringify({
              type: "room_state",
              senderActive,
              receiverActive,
              peerRole: "receiver",
            }));
          }
        } else if (type === "signal") {
          const { roomId, signalData } = data;
          const room = rooms.get(roomId);
          if (!room) return;

          // Forward the signal to the opposite peer
          if (currentRole === "sender" && room.receiver) {
            room.receiver.ws.send(JSON.stringify({
              type: "signal",
              signalData,
            }));
          } else if (currentRole === "receiver" && room.sender) {
            room.sender.ws.send(JSON.stringify({
              type: "signal",
              signalData,
            }));
          }
        }
      } catch (err) {
        console.error("Error processing websocket message:", err);
      }
    });

    ws.on("close", () => {
      if (currentRoomId && currentRole) {
        const room = rooms.get(currentRoomId);
        if (room) {
          if (currentRole === "sender") {
            room.sender = undefined;
          } else {
            room.receiver = undefined;
          }

          // If room is empty, clear it
          if (!room.sender && !room.receiver) {
            rooms.delete(currentRoomId);
          } else {
            // Notify other peer of disconnect
            const remaining = room.sender || room.receiver;
            if (remaining) {
              remaining.ws.send(JSON.stringify({
                type: "peer_disconnected",
                message: "The peer has disconnected.",
              }));
              // Also sync new room state to the remaining peer
              remaining.ws.send(JSON.stringify({
                type: "room_state",
                senderActive: !room.sender,
                receiverActive: !room.receiver,
                peerRole: remaining === room.sender ? "sender" : "receiver"
              }));
            }
          }
        }
      }
    });
  });

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", wsPath: "/ws-signaling" });
  });

  // Vite integration
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
