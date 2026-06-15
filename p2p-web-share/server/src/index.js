import express from "express";
import cors from "cors";
import http from "http";
import { randomBytes } from "node:crypto";
import { Server } from "socket.io";

const PORT = Number(process.env.PORT || 4000);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "p2p-web-share-signaling" });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ["GET", "POST"]
  }
});

/**
 * room shape:
 * {
 *   senderId: string,
 *   receiverId: string | null,
 *   createdAt: number
 * }
 */
const rooms = new Map();
const socketToRoom = new Map();

function createRoomId() {
  let id;
  do {
    id = randomBytes(4).toString("hex");
  } while (rooms.has(id));
  return id;
}

function safeCallback(cb, payload) {
  if (typeof cb === "function") cb(payload);
}

io.on("connection", (socket) => {
  console.log(`[socket] connected ${socket.id}`);

  socket.on("sender:create-room", (_payload, cb) => {
    const roomId = createRoomId();

    rooms.set(roomId, {
      senderId: socket.id,
      receiverId: null,
      createdAt: Date.now()
    });

    socket.join(roomId);
    socketToRoom.set(socket.id, roomId);

    safeCallback(cb, { ok: true, roomId, socketId: socket.id });
    console.log(`[room] created ${roomId} by sender ${socket.id}`);
  });

  socket.on("receiver:join-room", ({ roomId } = {}, cb) => {
    const room = rooms.get(roomId);

    if (!room) {
      safeCallback(cb, { ok: false, error: "Room not found. Check the link or ask sender to create a new room." });
      return;
    }

    if (room.receiverId && room.receiverId !== socket.id) {
      safeCallback(cb, { ok: false, error: "Room already has one receiver. MVP supports 1-to-1 transfers." });
      return;
    }

    room.receiverId = socket.id;
    socket.join(roomId);
    socketToRoom.set(socket.id, roomId);

    safeCallback(cb, { ok: true, roomId, socketId: socket.id, senderId: room.senderId });
    io.to(room.senderId).emit("room:receiver-joined", { roomId, receiverId: socket.id });

    console.log(`[room] receiver ${socket.id} joined ${roomId}`);
  });

  socket.on("webrtc:signal", ({ roomId, to, signal } = {}, cb) => {
    const room = rooms.get(roomId);

    if (!room) {
      safeCallback(cb, { ok: false, error: "Room not found." });
      return;
    }

    const allowed = [room.senderId, room.receiverId].filter(Boolean);
    if (!allowed.includes(socket.id) || !allowed.includes(to)) {
      safeCallback(cb, { ok: false, error: "Invalid signaling target for this room." });
      return;
    }

    io.to(to).emit("webrtc:signal", {
      from: socket.id,
      signal
    });

    safeCallback(cb, { ok: true });
  });

  socket.on("room:leave", () => {
    cleanupSocket(socket.id, "left");
  });

  socket.on("disconnect", () => {
    cleanupSocket(socket.id, "disconnected");
  });
});

function cleanupSocket(socketId, reason) {
  const roomId = socketToRoom.get(socketId);
  if (!roomId) return;

  const room = rooms.get(roomId);
  socketToRoom.delete(socketId);

  if (!room) return;

  const otherPeerId = room.senderId === socketId ? room.receiverId : room.senderId;
  if (otherPeerId) {
    io.to(otherPeerId).emit("room:peer-left", { roomId, peerId: socketId, reason });
  }

  // If sender leaves, destroy room. If receiver leaves, keep room alive so sender can create/retry.
  if (room.senderId === socketId) {
    if (room.receiverId) socketToRoom.delete(room.receiverId);
    rooms.delete(roomId);
    console.log(`[room] deleted ${roomId}; sender ${reason}`);
    return;
  }

  if (room.receiverId === socketId) {
    room.receiverId = null;
    console.log(`[room] receiver ${reason} in ${roomId}`);
  }
}

// Remove abandoned rooms after 1 hour.
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    if (now - room.createdAt > 60 * 60 * 1000) {
      rooms.delete(roomId);
      socketToRoom.delete(room.senderId);
      if (room.receiverId) socketToRoom.delete(room.receiverId);
      io.to(room.senderId).emit("room:expired", { roomId });
      if (room.receiverId) io.to(room.receiverId).emit("room:expired", { roomId });
      console.log(`[room] expired ${roomId}`);
    }
  }
}, 10 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`Signaling server running on http://localhost:${PORT}`);
  console.log(`Allowed client origin: ${CLIENT_ORIGIN}`);
});
