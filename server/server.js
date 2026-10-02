const express = require('express');
const http = require('http');
const path = require('path');

const app = express();
app.use(express.json());

// Simple in-memory store
const rooms = new Map(); // callId -> { from, to, state, signaling }

// Generate ID
let nextId = 1;

// API routes first (before static file serving)
app.post('/api/register', (req, res) => {
  const { name } = req.body;
  const userId = nextId++;
  const socketId = userId.toString();
  rooms.set(socketId, { userId, name, connectedAt: Date.now() });
  console.log(`Registered: ${name} as user ${userId}`);
  res.json({ userId, socketId });
});

app.get('/api/users', (req, res) => {
  const userList = Array.from(rooms.values()).map(u => ({
    id: u.userId,
    name: u.name
  }));
  res.json(userList);
});

app.get('/api/rooms/:callId', (req, res) => {
  const room = rooms.get(req.params.callId);
  if (!room) return res.status(404).json({ error: 'Not found' });
  res.json(room);
});

app.post('/api/rooms/:callId/offer', (req, res) => {
  const { callId, offer, from, to } = req.body;
  const room = rooms.get(callId);
  if (!room) return res.status(404).json({ error: 'Not found' });
  room.from = from;
  room.to = to;
  room.offer = offer;
  room.state = 'offered';
  console.log(`Offer sent from ${from} to ${to} for room ${callId}`);
  res.json({ status: 'sent' });
});

app.get('/api/rooms/:callId/waiting', (req, res) => {
  // Check if there's an unanswered call
  const room = rooms.get(req.params.callId);
  if (!room || room.state !== 'offered') return res.json({ waiting: false });
  res.json({
    waiting: true,
    from: room.from,
    offer: room.offer
  });
});

app.post('/api/rooms/:callId/answer', (req, res) => {
  const { callId, answer, from, to } = req.body;
  const room = rooms.get(callId);
  if (!room) return res.status(404).json({ error: 'Not found' });
  room.answer = answer;
  room.state = 'answered';
  console.log(`Call answered for room ${callId}`);
  res.json({ status: 'answered' });
});

app.post('/api/rooms/:callId/ice', (req, res) => {
  const { callId, candidate, from, to } = req.body;
  const room = rooms.get(callId);
  if (!room) return res.status(404).json({ error: 'Not found' });
  room.iceCandidates = room.iceCandidates || [];
  room.iceCandidates.push({ candidate, from });
  res.json({ status: 'received' });
});

app.post('/api/rooms/:callId/end', (req, res) => {
  const { callId } = req.body;
  rooms.delete(callId);
  res.json({ status: 'ended' });
});

// Serve the built frontend
const distPath = path.join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(distPath));

// API error handler — log all 404s
app.use((req, res, next) => {
  console.log(`404: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: 'Not found', path: req.originalUrl });
});

// SPA routing — must be last
app.get('*', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

const PORT = process.env.PORT || 3001;
const server = http.createServer(app);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Voice call server running on port ${PORT}`);
});
