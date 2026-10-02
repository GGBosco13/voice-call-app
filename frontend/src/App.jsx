import { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';

const SOCKET_URL = window.location.origin;

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [myName, setMyName] = useState('');
  const [myId, setMyId] = useState(null);
  const [users, setUsers] = useState([]);
  const [callState, setCallState] = useState('idle'); // idle, calling, ringing, connected, ended
  const [currentCall, setCurrentCall] = useState(null);
  const [callTimer, setCallTimer] = useState(0);
  const [incomingCall, setIncomingCall] = useState(null);
  const [toast, setToast] = useState(null);
  
  const socketRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const callTimerRef = useRef(null);

  // Register user when name changes and socket is connected
  useEffect(() => {
    if (myName && socketRef.current && socketRef.current.connected) {
      socketRef.current.emit('register', myName);
    }
  }, [myName]);

  // Initialize socket connection
  useEffect(() => {
    const socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      path: '/socket.io/',
    });
    console.log('Connecting to:', SOCKET_URL);
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('Socket connected, ID:', socket.id);
      // Register if we already have a name (will also be caught by the effect above)
      if (myName) {
        socket.emit('register', myName);
      }
    });

    socket.on('disconnect', () => {
      console.log('Socket disconnected');
    });

    socket.on('connect_error', (err) => {
      console.error('Socket connect error:', err.message);
    });

    socket.on('user-list', (usersList) => {
      console.log('User list received:', usersList);
      setUsers(usersList.filter(u => u.id !== myId));
    });

    socket.on('incoming-call', (data) => {
      setIncomingCall(data);
    });

    socket.on('call-answered', (data) => {
      setCallState('connecting');
      showToast('Call answered! Connecting...', 'success');
    });

    socket.on('call-declined', (data) => {
      setCallState('idle');
      setCurrentCall(null);
      showToast('Call declined', 'error');
    });

    socket.on('call-ended', () => {
      endCall();
      showToast('Call ended', 'success');
    });

    socket.on('user-disconnected', (data) => {
      if (currentCall?.to === data.userId) {
        setCallState('idle');
        showToast('User went offline', 'error');
      }
    });

    socket.on('receive-offer', handleOffer);
    socket.on('receive-answer', handleAnswer);
    socket.on('receive-ice', handleIceCandidate);

    return () => {
      socket.disconnect();
      cleanupCall();
    };
  }, [myId, currentCall]);

  function showToast(message, type = '') {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  }

  function handleLogin(e) {
    e.preventDefault();
    if (!myName.trim()) return;
    // Generate a simple numeric ID from name
    const userId = myName.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % 1000 + 1;
    setMyId(userId);
    setIsLoggedIn(true);
  }

  async function startCall(targetUserId, targetUserName) {
    try {
      // Get user's microphone
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;

      setCallState('calling');
      setCurrentCall({ to: targetUserId, toName: targetUserName });

      // Create peer connection
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun.cloudflare.com:3478' },
          {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelay@metered.ca',
            credential: 'openrelayproject',
          },
        ],
      });
      peerConnectionRef.current = pc;

      // Add local stream
      stream.getTracks().forEach(track => pc.addTrack(track, stream));

      // Listen for ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate && socketRef.current) {
          socketRef.current.emit('send-ice', {
            to: targetUserId,
            iceCandidate: event.candidate,
            callId: Date.now().toString()
          });
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          setCallState('connected');
          startCallTimer();
        } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
          endCall();
        }
      };

      // Create and send offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Wait a moment for ICE gathering
      await new Promise(resolve => setTimeout(resolve, 500));

      socketRef.current.emit('send-offer', {
        to: targetUserId,
        offer: pc.localDescription,
        callId: Date.now().toString()
      });

      // Start ringing locally
      setTimeout(() => {
        if (callState === 'calling') {
          setCallState('ringing');
        }
      }, 1000);

    } catch (err) {
      console.error('Error starting call:', err);
      showToast('Microphone access denied', 'error');
    }
  }

  async function handleOffer({ from, offer, callId }) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;

      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun.cloudflare.com:3478' },
          {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelay@metered.ca',
            credential: 'openrelayproject',
          },
        ],
      });
      peerConnectionRef.current = pc;

      stream.getTracks().forEach(track => pc.addTrack(track, track, stream));

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socketRef.current.emit('send-ice', {
            to: from,
            iceCandidate: event.candidate,
            callId
          });
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          setCallState('connected');
          startCallTimer();
        } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
          endCall();
        }
      };

      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socketRef.current.emit('send-answer', {
        to: from,
        answer: pc.localDescription,
        callId
      });

      setCallState('connected');
      setCurrentCall({ to: from, toName: 'Caller' });

    } catch (err) {
      console.error('Error handling offer:', err);
      endCall();
    }
  }

  async function handleAnswer({ from, answer, callId }) {
    try {
      const pc = peerConnectionRef.current;
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        setCallState('connected');
        startCallTimer();
      }
    } catch (err) {
      console.error('Error handling answer:', err);
    }
  }

  async function handleIceCandidate({ from, iceCandidate, callId }) {
    try {
      const pc = peerConnectionRef.current;
      if (pc) {
        await pc.addIceCandidate(new RTCIceCandidate(iceCandidate));
      }
    } catch (err) {
      console.error('Error adding ICE candidate:', err);
    }
  }

  function acceptCall() {
    if (!incomingCall) return;
    
    // Find the caller's name from user list
    const caller = users.find(u => u.id === incomingCall.from) || 
                   { name: incomingCall.fromName || 'Unknown' };
    
    socketRef.current.emit('answer-call', {
      to: incomingCall.from,
      callId: incomingCall.callId
    });
    
    setIncomingCall(null);
    setCurrentCall({ to: incomingCall.from, toName: caller.name });
  }

  function declineCall() {
    if (!incomingCall) return;
    
    socketRef.current.emit('decline-call', {
      to: incomingCall.from,
      callId: incomingCall.callId
    });
    
    setIncomingCall(null);
  }

  function cancelCall() {
    if (currentCall) {
      socketRef.current.emit('end-call', { to: currentCall.to });
    }
    endCall();
  }

  function endCall() {
    if (currentCall) {
      socketRef.current.emit('end-call', { to: currentCall.to });
    }
    cleanupCall();
  }

  function cleanupCall() {
    if (callTimerRef.current) {
      clearInterval(callTimerRef.current);
      callTimerRef.current = null;
    }
    
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }
    
    setCallState('idle');
    setCallTimer(0);
    setCurrentCall(null);
  }

  function startCallTimer() {
    setCallTimer(0);
    callTimerRef.current = setInterval(() => {
      setCallTimer(prev => prev + 1);
    }, 1000);
  }

  function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  function handleLogout() {
    cleanupCall();
    setIsLoggedIn(false);
    setMyName('');
    setMyId(null);
    setUsers([]);
  }

  // Login Screen
  if (!isLoggedIn) {
    return (
      <div className="app">
        <div className="login-screen">
          <div className="icon">📞</div>
          <h1>Voice Call</h1>
          <p className="subtitle">Connect with friends instantly</p>
          <form onSubmit={handleLogin}>
            <input
              type="text"
              placeholder="Enter your name..."
              value={myName}
              onChange={(e) => setMyName(e.target.value)}
              autoFocus
            />
            <br />
            <button type="submit" disabled={!myName.trim()}>
              Start Calling
            </button>
          </form>
          <p style={{ marginTop: '30px', fontSize: '0.8rem', color: '#555' }}>
            Open this app in two browser windows with different names to test calling
          </p>
        </div>
        {toast && (
          <div className={`toast ${toast.type}`}>
            {toast.message}
          </div>
        )}
      </div>
    );
  }

  // Main App
  return (
    <div className="app">
      {/* Header */}
      <div className="header">
        <h2>📞 Voice Call</h2>
        <div className="user-info">
          <div className="avatar">{myName.charAt(0).toUpperCase()}</div>
          <span>{myName}</span>
          <button className="logout-btn" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </div>

      {/* Active Call / Calling State */}
      {(callState === 'calling' || callState === 'ringing' || callState === 'connecting') && (
        <div className="calling-message">
          <div className="spinner"></div>
          <p>
            {callState === 'calling' && `Calling ${currentCall?.toName}...`}
            {callState === 'ringing' && `Ringing ${currentCall?.toName}...`}
            {callState === 'connecting' && 'Connecting...'}
          </p>
          <button className="cancel-btn" onClick={cancelCall}>
            Cancel
          </button>
        </div>
      )}

      {callState === 'connected' && currentCall && (
        <div className="active-call">
          <div className="call-avatar">
            {currentCall.toName.charAt(0).toUpperCase()}
          </div>
          <div className="caller-name">{currentCall.toName}</div>
          <div className="call-status">● Connected</div>
          <div className="call-timer">{formatTime(callTimer)}</div>
          <button className="end-call-btn" onClick={endCall}>
            End Call
          </button>
        </div>
      )}

      {/* Users List */}
      <div className="users-section">
        <h3>
          {users.length > 0 ? `Online Users (${users.length})` : 'No Users Online'}
        </h3>
        
        {users.length > 0 ? (
          <div className="users-list">
            {users.map((user) => (
              <div key={user.id} className="user-card">
                <div className="user-details">
                  <div className="avatar">
                    {user.name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <div className="name">{user.name}</div>
                    <div className="status">● Online</div>
                  </div>
                </div>
                <button
                  className="call-btn"
                  onClick={() => startCall(user.id, user.name)}
                  disabled={callState !== 'idle'}
                >
                  📞 Call
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <div className="icon">👥</div>
            <p>No other users online yet</p>
            <p style={{ fontSize: '0.85rem', marginTop: '5px' }}>
              Open the same link in another browser/tab with a different name to see each other
            </p>
            <p style={{ fontSize: '0.8rem', marginTop: '10px', color: '#555' }}>
              💡 Tip: Open this page twice in your browser — once with name "Alice", once with "Bob"
            </p>
          </div>
        )}
      </div>

      {/* Incoming Call Modal */}
      {incomingCall && (
        <div className="modal-overlay">
          <div className="incoming-call-modal">
            <div className="caller-avatar">
              {(incomingCall.fromName || 'U').charAt(0).toUpperCase()}
            </div>
            <h3>Incoming Call</h3>
            <p>
              {incomingCall.fromName || 'Someone'} is calling you
            </p>
            <div className="modal-buttons">
              <button className="answer-btn" onClick={acceptCall}>
                ✓ Answer
              </button>
              <button className="decline-btn" onClick={declineCall}>
                ✕ Decline
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className={`toast ${toast.type}`}>
          {toast.message}
        </div>
      )}
    </div>
  );
}

export default App;
