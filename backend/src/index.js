require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const redis = require('redis');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

// ============================================================
// WHISPERWEB - Backend Server
// Privacy-first anonymous voice consultation platform
// NO PII is stored: no IP addresses, names, phone numbers
// All session data is ephemeral with TTL in Redis
// ============================================================

const app = express();
const server = http.createServer(app);

// Parse JSON bodies
app.use(express.json());

// CORS: Allow frontend origin only
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));

// Socket.IO with CORS
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000,
});

// ============================================================
// REDIS CLIENT — Ephemeral storage with TTL
// CRITICAL: No call recordings, transcripts, or PII stored.
// All keys have auto-expire (TTL) to prevent data accumulation.
// ============================================================
let redisClient;
let redisReady = false;

async function connectRedis() {
  try {
    // Set a connection timeout to avoid hanging
    redisClient = redis.createClient({
      url: process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`,
      socket: {
        connectTimeout: 2000,
      },
    });

    await Promise.race([
      redisClient.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Connection timeout')), 3000)
      ),
    ]);

    redisClient.on('error', () => {}); // Silence errors after successful connect
    redisReady = true;
    console.log('Connected to Redis (ephemeral store)');
  } catch (err) {
    console.warn('Redis unavailable — running in-memory mode');
    redisClient = null;
  }
}

// Ephemeral Redis helper: set with TTL in seconds
async function redisSet(key, value, ttlSeconds = 3600) {
  if (redisClient) {
    await redisClient.setEx(key, ttlSeconds, value);
  } else {
    // Fallback in-memory store (cleared on restart)
    if (!global._ephemeralStore) global._ephemeralStore = {};
    global._ephemeralStore[key] = value;
  }
}

async function redisGet(key) {
  if (redisClient) {
    return await redisClient.get(key);
  } else {
    return global._ephemeralStore?.[key] || null;
  }
}

async function redisDel(key) {
  if (redisClient) {
    await redisClient.del(key);
  } else {
    if (global._ephemeralStore) delete global._ephemeralStore[key];
  }
}

async function redisExists(key) {
  if (redisClient) {
    const result = await redisClient.exists(key);
    return result === 1;
  } else {
    return !!global._ephemeralStore?.[key];
  }
}

// In-memory fallback stores
const staffRooms = {};    // roomId -> { callerSocket, staffSocket, startTime }
const staffOnline = new Map();  // staffId -> { socketId, status, roomIds }
const callQueue = [];     // Array of { callerSocket, callerId, timestamp }

// ============================================================
// STAFF AUTH ROUTES
// ============================================================

// Hardcoded Super Admin credentials (from env or defaults)
const SUPER_ADMIN_ID = process.env.SUPER_ADMIN_ID || 'whisper-admin';
const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || 'admin-change-this-in-production';

// Staff accounts in-memory (in production, use a secure DB with hashed passwords)
// NOTE: We use bcrypt for password hashing. No plaintext passwords stored.
const staffAccounts = new Map();

// Initialize super admin
async function initAdmin() {
  const hashedPassword = await bcrypt.hash(SUPER_ADMIN_PASSWORD, 10);
  staffAccounts.set(SUPER_ADMIN_ID, {
    id: SUPER_ADMIN_ID,
    passwordHash: hashedPassword,
    role: 'super-admin',
    name: 'System Administrator',
  });
  console.log(`👤 Super admin initialized: ${SUPER_ADMIN_ID}`);
}

// POST /api/auth/login — Staff login
app.post('/api/auth/login', async (req, res) => {
  const { employeeId, password } = req.body;
  if (!employeeId || !password) {
    return res.status(400).json({ error: 'Employee ID and password required' });
  }

  const account = staffAccounts.get(employeeId);
  if (!account) {
    // Constant-time comparison would go here, but for simplicity:
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = await bcrypt.compare(password, account.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Issue a simple session token (in production, use JWT)
  const token = uuidv4();
  await redisSet(`session:${token}`, employeeId, 86400); // 24h TTL

  res.json({ token, employeeId, role: account.role });
});

// POST /api/admin/create-staff — Super Admin creates staff account
app.post('/api/admin/create-staff', async (req, res) => {
  const { authorization } = req.headers;

  // Verify admin token
  if (!authorization) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }

  const account = staffAccounts.get(authorization);
  if (!account || account.role !== 'super-admin') {
    return res.status(403).json({ error: 'Admin privileges required' });
  }

  const { employeeId, name, password } = req.body;
  if (!employeeId || !name || !password) {
    return res.status(400).json({ error: 'Employee ID, name, and password required' });
  }

  if (staffAccounts.has(employeeId)) {
    return res.status(409).json({ error: 'Employee ID already exists' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  staffAccounts.set(employeeId, {
    id: employeeId,
    passwordHash: hashedPassword,
    role: 'staff',
    name,
  });

  // Return the generated credentials to the admin
  res.status(201).json({
    message: 'Staff account created',
    employeeId,
    initialPassword: password, // Sent once during creation
  });
});

// GET /api/staff/status — Check if a staff member is online and available
app.get('/api/staff/status', async (req, res) => {
  // This is a REST endpoint for initial status check
  // Real-time status is via WebSocket
  const availableCount = [...staffOnline.values()].filter(
    (s) => s.status === 'available'
  ).length;
  res.json({ availableCount, queueLength: callQueue.length });
});

// ============================================================
// SOCKET.IO — Real-time signaling layer
// ============================================================

// Helper: generate a unique room for a call
function generateRoomId() {
  return `room-${uuidv4().substring(0, 8)}`;
}

// Helper: find next available staff member (round-robin via queue index)
function findAvailableStaff() {
  const available = [...staffOnline.entries()]
    .filter(([, info]) => info.status === 'available')
    .map(([id, info]) => ({ id, ...info }));

  if (available.length === 0) return null;

  // Least-busy: pick staff with fewest active rooms
  let leastBusy = available[0];
  for (const s of available) {
    const myRooms = (staffOnline.get(s.id)?.roomIds || []).length;
    const leastRooms = (staffOnline.get(leastBusy.id)?.roomIds || []).length;
    if (myRooms < leastRooms) {
      leastBusy = s;
    }
  }
  return leastBusy;
}

io.on('connection', (socket) => {
  console.log(`🔌 Socket connected: ${socket.id}`);

  // ---- Caller Events ----

  // Caller joins: generates a temporary session
  socket.on('caller:join', async () => {
    const callerId = uuidv4();
    // Store caller session with short TTL — no PII stored
    // The callerId is a random UUID, not tied to any identity
    await redisSet(`caller:${callerId}`, JSON.stringify({
      socketId: socket.id,
      joinedAt: Date.now(),
    }), 3600); // 1 hour TTL

    socket.data.role = 'caller';
    socket.data.callerId = callerId;

    // Emit the session ID back to the caller
    socket.emit('caller:session', { callerId });

    // Add to call queue
    callQueue.push({ callerId, socketId: socket.id, timestamp: Date.now() });
    console.log(`📞 Caller ${callerId} joined queue (queue size: ${callQueue.length})`);

    // Try to route the call
    tryRouteCall();
  });

  // Caller requests a call
  socket.on('caller:start-call', () => {
    if (socket.data.role !== 'caller') return;

    // Check if already in a call
    if (staffRooms[socket.data.roomId]) return;

    // Add to queue if not already
    if (!callQueue.find((c) => c.callerId === socket.data.callerId)) {
      callQueue.push({
        callerId: socket.data.callerId,
        socketId: socket.id,
        timestamp: Date.now(),
      });
    }
    console.log(`📞 Caller ${socket.data.callerId} started call request`);
    tryRouteCall();
  });

  // ---- Staff Events ----

  // Staff connects: registers online
  socket.on('staff:connect', async ({ employeeId, token }) => {
    // Verify token
    const sessionEmployeeId = await redisGet(`session:${token}`);
    if (!sessionEmployeeId) {
      socket.emit('staff:error', { message: 'Invalid session token' });
      socket.disconnect();
      return;
    }

    const account = staffAccounts.get(sessionEmployeeId);
    if (!account || account.role !== 'staff') {
      socket.emit('staff:error', { message: 'Staff privileges required' });
      socket.disconnect();
      return;
    }

    socket.data.role = 'staff';
    socket.data.employeeId = employeeId;
    socket.data.staffName = account.name;

    staffOnline.set(employeeId, {
      socketId: socket.id,
      status: 'available',
      roomIds: [],
      name: account.name,
    });

    console.log(`👨‍💼 Staff connected: ${employeeId} (${account.name})`);

    // Notify caller queue that staff is available
    socket.emit('staff:connected', { employeeId, name: account.name });
    tryRouteCall();
  });

  // Staff toggles status
  socket.on('staff:status-toggle', async ({ status }) => {
    if (socket.data.role !== 'staff') return;

    const info = staffOnline.get(socket.data.employeeId);
    if (info) {
      info.status = status;
      console.log(`🔄 Staff ${info.name} status: ${status}`);

      // Notify all callers of staff availability
      io.emit('staff:availability', {
        availableCount: [...staffOnline.values()].filter((s) => s.status === 'available').length,
      });

      // If became available, try routing queued calls
      if (status === 'available') {
        tryRouteCall();
      }
    }
  });

  // Staff accepts a call
  socket.on('staff:accept-call', async ({ callerId, roomId }) => {
    if (socket.data.role !== 'staff') return;

    const callerData = await redisGet(`caller:${callerId}`);
    if (!callerData) {
      socket.emit('call:error', { message: 'Caller session expired' });
      return;
    }

    const callerParsed = JSON.parse(callerData);
    const callerSocket = io.sockets.sockets.get(callerParsed.socketId);

    if (!callerSocket) {
      socket.emit('call:error', { message: 'Caller disconnected' });
      return;
    }

    // Create the room
    const room = {
      callerId,
      callerSocketId: callerParsed.socketId,
      staffId: socket.data.employeeId,
      staffSocketId: socket.id,
      startTime: Date.now(),
    };
    staffRooms[roomId] = room;

    // Track rooms for staff
    const info = staffOnline.get(socket.data.employeeId);
    if (info && !info.roomIds.includes(roomId)) {
      info.roomIds.push(roomId);
    }

    // Remove from queue
    const queueIndex = callQueue.findIndex((c) => c.callerId === callerId);
    if (queueIndex !== -1) callQueue.splice(queueIndex, 1);

    // Notify both parties
    callerSocket.emit('call:connected', { roomId, staffName: info.name });
    socket.emit('call:connected', { roomId, callerId });

    console.log(`✅ Call connected: ${roomId}`);
  });

  // Staff declines a call
  socket.on('staff:decline-call', async ({ callerId }) => {
    if (socket.data.role !== 'staff') return;

    // Remove from queue
    const queueIndex = callQueue.findIndex((c) => c.callerId === callerId);
    if (queueIndex !== -1) callQueue.splice(queueIndex, 1);

    // Notify caller
    const callerData = await redisGet(`caller:${callerId}`);
    if (callerData) {
      const callerParsed = JSON.parse(callerData);
      const callerSocket = io.sockets.sockets.get(callerParsed.socketId);
      if (callerSocket) {
        callerSocket.emit('call:declined');
      }
    }

    console.log(`📞 Staff declined call for ${callerId}`);
  });

  // ---- WebRTC Signaling ----

  // Relay SDP offers/answers between caller and staff
  socket.on('webrtc:offer', ({ roomId, targetRoomId }) => {
    const room = staffRooms[roomId] || staffRooms[targetRoomId];
    if (!room) return;

    if (socket.id === room.callerSocketId) {
      io.sockets.sockets.get(room.staffSocketId)?.emit('webrtc:offer', { roomId, sdp: room._pendingOffer });
      room._pendingOffer = room._pendingOffer || null; // will be overwritten
    } else {
      io.sockets.sockets.get(room.callerSocketId)?.emit('webrtc:offer', { roomId });
    }
  });

  // Forward the actual SDP offer
  socket.on('webrtc:sdp-offer', ({ roomId, sdp }) => {
    const room = staffRooms[roomId];
    if (!room) return;
    room._pendingOffer = sdp;
    io.sockets.sockets.get(room.staffSocketId)?.emit('webrtc:sdp-offer', { roomId, sdp });
  });

  socket.on('webrtc:sdp-answer', ({ roomId, sdp }) => {
    const room = staffRooms[roomId];
    if (!room) return;
    io.sockets.sockets.get(room.callerSocketId)?.emit('webrtc:sdp-answer', { roomId, sdp });
  });

  // Forward ICE candidates
  socket.on('webrtc:ice-candidate', ({ roomId, candidate }) => {
    const room = staffRooms[roomId];
    if (!room) return;

    if (socket.id === room.callerSocketId) {
      io.sockets.sockets.get(room.staffSocketId)?.emit('webrtc:ice-candidate', { roomId, candidate });
    } else {
      io.sockets.sockets.get(room.callerSocketId)?.emit('webrtc:ice-candidate', { roomId, candidate });
    }
  });

  // ---- Call End / Cleanup ----

  socket.on('call:end', async ({ roomId }) => {
    const room = staffRooms[roomId];
    if (!room) return;

    console.log(`📴 Call ended: ${roomId}`);

    // End call for both parties
    io.sockets.sockets.get(room.callerSocketId)?.emit('call:ended', { roomId });
    io.sockets.sockets.get(room.staffSocketId)?.emit('call:ended', { roomId });

    // Clean up room
    delete staffRooms[roomId];

    // Remove room ID from staff tracking
    const info = staffOnline.get(room.staffId);
    if (info) {
      info.roomIds = (info.roomIds || []).filter((r) => r !== roomId);
    }

    // ============================================================
    // PRIVACY: Ephemeral cleanup
    // NO recordings, transcripts, or caller details persisted
    // ============================================================
    // Do NOT store: callerId, roomId, startTime, socket IDs
    // These are only used in-memory during the active call
  });

  // ---- STUN/TURN Config Request ----
  socket.on('webrtc:config-request', () => {
    const stunServers = process.env.STUN_SERVERS
      ? JSON.parse(process.env.STUN_SERVERS)
      : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

    const turnServers = process.env.TURN_SERVERS
      ? JSON.parse(process.env.TURN_SERVERS)
      : [];

    socket.emit('webrtc:config', {
      iceServers: [...stunServers, ...turnServers],
    });
  });

  // ---- Disconnect Cleanup ----
  socket.on('disconnect', async (reason) => {
    console.log(`🔌 Socket disconnected: ${socket.id} (${reason})`);

    if (socket.data.role === 'caller') {
      // Remove from queue
      const queueIndex = callQueue.findIndex((c) => c.socketId === socket.id);
      if (queueIndex !== -1) callQueue.splice(queueIndex, 1);

      // If in an active call, end it
      for (const [roomId, room] of Object.entries(staffRooms)) {
        if (room.callerSocketId === socket.id) {
          io.sockets.sockets.get(room.staffSocketId)?.emit('call:ended', { roomId });
          delete staffRooms[roomId];
          console.log(`📴 Caller disconnected — call ended: ${roomId}`);
          break;
        }
      }

      // Clear caller session — ephemeral data removed
      if (socket.data.callerId) {
        await redisDel(`caller:${socket.data.callerId}`);
        console.log(`🗑️  Caller session cleared: ${socket.data.callerId}`);
      }
    }

    if (socket.data.role === 'staff') {
      const info = staffOnline.get(socket.data.employeeId);
      if (info) {
        // End all active calls for this staff
        for (const roomId of (info.roomIds || [])) {
          const room = staffRooms[roomId];
          if (room) {
            io.sockets.sockets.get(room.callerSocketId)?.emit('call:ended', { roomId });
            delete staffRooms[roomId];
          }
        }
        delete staffOnline.get(socket.data.employeeId);
        console.log(`👨‍💼 Staff disconnected: ${socket.data.employeeId}`);
      }
    }
  });

  // ---- Heartbeat ----
  socket.on('ping', () => socket.emit('pong'));
});

// ============================================================
// TRY ROUTE: Match queued callers with available staff
// ============================================================
function tryRouteCall() {
  if (callQueue.length === 0) return;

  let routed = true;
  while (routed && callQueue.length > 0) {
    const caller = callQueue[0];
    const staffInfo = findAvailableStaff();

    if (!staffInfo) {
      routed = false;
      // Notify the caller no agents are available
      const callerSocket = io.sockets.sockets.get(caller.socketId);
      if (callerSocket) {
        callerSocket.emit('call:no-agents', { message: 'No agents available. Please try again.' });
      }
      break;
    }

    // Create a room
    const roomId = generateRoomId();
    staffRooms[roomId] = {
      callerId: caller.callerId,
      callerSocketId: caller.socketId,
      staffId: staffInfo.id,
      staffSocketId: staffInfo.socketId,
      startTime: Date.now(),
    };

    // Remove from queue
    callQueue.shift();

    // Notify the staff member
    io.sockets.sockets.get(staffInfo.socketId)?.emit('call:incoming', {
      callerId: caller.callerId,
      roomId,
    });

    // Notify the caller they're being connected
    io.sockets.sockets.get(caller.socketId)?.emit('call:ringing', { roomId });

    console.log(`🔔 Call ringing: ${roomId} (${staffInfo.name} ← anonymous caller)`);
  }
}

const path = require('path');
const fs = require('fs');

// Serve built React SPA (for production/mobile access on single port)
app.use(express.static(path.join(__dirname, '../../frontend/dist')));

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, '../../frontend/dist/index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Build not found. Run: cd frontend && npm run build');
  }
});

// ============================================================
// START SERVER
// ============================================================
async function start() {
  await connectRedis();
  await initAdmin();

  const PORT = process.env.PORT || 3001;

  // Listen on all interfaces (0.0.0.0) so phone can connect
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🎙️  WhisperWeb Backend running on port ${PORT}`);
    console.log(`   Role: Anonymous Voice Consultation Server`);
    console.log(`   Privacy: No PII stored, all sessions ephemeral`);
    console.log(`   STUN: ${process.env.STUN_SERVERS ? 'Configured' : 'Google public STUN only'}`);
  });
}

start().catch(console.error);

// Export for testing
module.exports = { app, server, io, staffOnline, staffRooms };
