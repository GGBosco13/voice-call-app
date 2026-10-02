const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ['GET', 'POST']
  },
  path: '/socket.io/'
});

// Store connected users
const users = new Map(); // socketId -> { id, name }
let nextId = 1;

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on('register', (name) => {
    const userId = nextId++;
    users.set(socket.id, { id: userId, name });
    broadcastUserList();
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

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      console.log(`${user.name} disconnected`);
      users.delete(socket.id);
      broadcastUserList();
      io.emit('user-disconnected', { userId: user.id });
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
