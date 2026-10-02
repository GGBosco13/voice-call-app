const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
    methods: ['GET', 'POST']
  },
  path: '/socket.io/',
  transports: ['polling'],
  allowEIO3: true
});

// Store connected users
const users = new Map(); // socketId -> { id, name }
let nextId = 1;

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  console.log(`  Transport: ${socket.conn.transport.name}`);
  console.log(`  Client IP: ${socket.handshake.headers['x-forwarded-for'] || socket.handshake.address}`);

  socket.on('register', (name) => {
    const userId = nextId++;
    users.set(socket.id, { id: userId, name });
    console.log(`  Registered: ${name} as user ${userId}`);
    broadcastUserList();
  });

  socket.on('disconnect', (reason) => {
    console.log(`Client disconnected: ${socket.id}, reason: ${reason}`);
    const user = users.get(socket.id);
    if (user) {
      users.delete(socket.id);
      broadcastUserList();
      io.emit('user-disconnected', { userId: user.id });
    }
  });

  socket.on('error', (err) => {
    console.error(`Socket error for ${socket.id}:`, err.message);
  });

  socket.on('call-user', ({ to, from, fromName }) => {
    const targetSocket = Array.from(users.entries())
      .find(([socketId, user]) => user.id === to)?.[0];
    if (targetSocket) {
      io.to(targetSocket).emit('incoming-call', {
        from, fromName, callId: Date.now().toString()
      });
    }
  });

  socket.on('answer-call', ({ to, callId }) => {
    const targetSocket = Array.from(users.entries())
      .find(([socketId, user]) => user.id === to)?.[0];
    if (targetSocket) {
      io.to(targetSocket).emit('call-answered', { callId });
    }
  });

  socket.on('decline-call', ({ to, callId }) => {
    const targetSocket = Array.from(users.entries())
      .find(([socketId, user]) => user.id === to)?.[0];
    if (targetSocket) {
      io.to(targetSocket).emit('call-declined', { callId });
    }
  });

  socket.on('end-call', ({ to }) => {
    const targetSocket = Array.from(users.entries())
      .find(([socketId, user]) => user.id === to)?.[0];
    if (targetSocket) {
      io.to(targetSocket).emit('call-ended');
    }
  });

  socket.on('send-offer', ({ to, offer, callId }) => {
    const targetSocket = Array.from(users.entries())
      .find(([socketId, user]) => user.id === to)?.[0];
    if (targetSocket) {
      io.to(targetSocket).emit('receive-offer', { from: socket.id, offer, callId });
    }
  });

  socket.on('send-answer', ({ to, answer, callId }) => {
    const targetSocket = Array.from(users.entries())
      .find(([socketId, user]) => user.id === to)?.[0];
    if (targetSocket) {
      io.to(targetSocket).emit('receive-answer', { from: socket.id, answer, callId });
    }
  });

  socket.on('send-ice', ({ to, iceCandidate, callId }) => {
    const targetSocket = Array.from(users.entries())
      .find(([socketId, user]) => user.id === to)?.[0];
    if (targetSocket) {
      io.to(targetSocket).emit('receive-ice', { from: socket.id, iceCandidate, callId });
    }
  });
});

function broadcastUserList() {
  const userList = Array.from(users.values()).map(u => ({ id: u.id, name: u.name }));
  io.emit('user-list', userList);
}

// Serve the built frontend in production
const distPath = path.join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(distPath));

// SPA routing - only catch routes that aren't socket.io paths
app.get(/^((?!(\/socket\.io\/)).)*$/, (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Voice call server running on port ${PORT}`);
});
