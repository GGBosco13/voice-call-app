const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();

// Allow requests from the frontend (different domain on Render)
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:5173'];

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST'],
  credentials: true
}));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Store connected users
const users = new Map(); // socketId -> { id, name }

// Generate a simple ID
let nextId = 1;

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // User registers with their name
  socket.on('register', (name) => {
    const userId = nextId++;
    users.set(socket.id, { id: userId, name });
    console.log(`${name} registered as user ${userId}`);
    
    // Broadcast updated user list
    broadcastUserList();
  });

  // Handle call initiation
  socket.on('call-user', ({ to, from, fromName }) => {
    const targetSocket = Array.from(users.entries())
      .find(([socketId, user]) => user.id === to)?.[0];
    
    if (targetSocket) {
      io.to(targetSocket).emit('incoming-call', {
        from: from,
        fromName: fromName,
        callId: Date.now().toString()
      });
    }
  });

  // Answer call
  socket.on('answer-call', ({ to, callId }) => {
    const targetSocket = Array.from(users.entries())
      .find(([socketId, user]) => user.id === to)?.[0];
    
    if (targetSocket) {
      io.to(targetSocket).emit('call-answered', {
        callId
      });
    }
  });

  // Decline call
  socket.on('decline-call', ({ to, callId }) => {
    const targetSocket = Array.from(users.entries())
      .find(([socketId, user]) => user.id === to)?.[0];
    
    if (targetSocket) {
      io.to(targetSocket).emit('call-declined', {
        callId
      });
    }
  });

  // End call
  socket.on('end-call', ({ to }) => {
    const targetSocket = Array.from(users.entries())
      .find(([socketId, user]) => user.id === to)?.[0];
    
    if (targetSocket) {
      io.to(targetSocket).emit('call-ended');
    }
  });

  // Send WebRTC signaling - offer
  socket.on('send-offer', ({ to, offer, callId }) => {
    const targetSocket = Array.from(users.entries())
      .find(([socketId, user]) => user.id === to)?.[0];
    
    if (targetSocket) {
      io.to(targetSocket).emit('receive-offer', {
        from: socket.id,
        offer,
        callId
      });
    }
  });

  // Send WebRTC signaling - answer
  socket.on('send-answer', ({ to, answer, callId }) => {
    const targetSocket = Array.from(users.entries())
      .find(([socketId, user]) => user.id === to)?.[0];
    
    if (targetSocket) {
      io.to(targetSocket).emit('receive-answer', {
        from: socket.id,
        answer,
        callId
      });
    }
  });

  // Send ICE candidate
  socket.on('send-ice', ({ to, iceCandidate, callId }) => {
    const targetSocket = Array.from(users.entries())
      .find(([socketId, user]) => user.id === to)?.[0];
    
    if (targetSocket) {
      io.to(targetSocket).emit('receive-ice', {
        from: socket.id,
        iceCandidate,
        callId
      });
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      console.log(`${user.name} disconnected`);
      users.delete(socket.id);
      broadcastUserList();
      
      // Notify all users that this user disconnected
      io.emit('user-disconnected', { userId: user.id });
    }
  });
});

function broadcastUserList() {
  const userList = Array.from(users.values()).map(u => ({
    id: u.id,
    name: u.name
  }));
  io.emit('user-list', userList);
}

// Serve the built frontend in production
const distPath = path.join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(distPath));

// Handle SPA routing - serve index.html for all routes
app.get('*', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Voice call server running on port ${PORT}`);
});
