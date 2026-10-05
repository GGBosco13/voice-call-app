import { io } from 'socket.io-client';

// ============================================================
// Socket.IO connection to WhisperWeb backend
// All communication is anonymous — no PII sent over socket
// ============================================================

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

let socket = null;

export function getSocket() {
  return socket;
}

export function connectSocket(role, token = null) {
  if (socket) {
    socket.disconnect();
  }

  const auth = token ? { auth: { token } } : {};

  socket = io(BACKEND_URL, {
    ...auth,
    transports: ['websocket', 'polling'],
  });

  socket.on('connect', () => {
    console.log(`✅ Socket connected (role: ${role})`);
  });

  socket.on('disconnect', () => {
    console.log('🔌 Socket disconnected');
  });

  socket.on('connect_error', (err) => {
    console.error('Socket connection error:', err.message);
  });

  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

// ============================================================
// Caller socket helpers
// ============================================================

export function callerJoin() {
  socket?.emit('caller:join');
}

export function callerStartCall() {
  socket?.emit('caller:start-call');
}

export function callerEndCall(roomId) {
  socket?.emit('call:end', { roomId });
}

// WebRTC signaling helpers
export function sendSdpOffer(roomId, sdp) {
  socket?.emit('webrtc:sdp-offer', { roomId, sdp });
}

export function sendSdpAnswer(roomId, sdp) {
  socket?.emit('webrtc:sdp-answer', { roomId, sdp });
}

export function sendIceCandidate(roomId, candidate) {
  socket?.emit('webrtc:ice-candidate', { roomId, candidate });
}

export function requestWebrtcConfig() {
  socket?.emit('webrtc:config-request');
}

// ============================================================
// Staff socket helpers
// ============================================================

export function staffConnect(employeeId, token) {
  socket?.emit('staff:connect', { employeeId, token });
}

export function staffToggleStatus(status) {
  socket?.emit('staff:status-toggle', { status });
}

export function staffAcceptCall(callerId, roomId) {
  socket?.emit('staff:accept-call', { callerId, roomId });
}

export function staffDeclineCall(callerId) {
  socket?.emit('staff:decline-call', { callerId });
}

export { BACKEND_URL };
